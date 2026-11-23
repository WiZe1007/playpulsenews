import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,stat,mkdir,rm,symlink,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {restoreNotificationState} from './migration.mjs';

const checkpoint=(ids=['old','backdated'])=>({version:1,owners:{
  '111':{baselineAt:'2026-11-23T08:30:00.000Z',seenIds:ids}
}});
async function fixture(t){
  const directory=await mkdtemp(join(tmpdir(),'play-pulse-migration-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const statePath=join(directory,'state.json'),bootstrapPath=join(directory,'bootstrap.json');
  await writeFile(bootstrapPath,JSON.stringify(checkpoint()),{mode:0o600});
  return {directory,statePath,bootstrapPath,allowed:new Set(['111'])};
}

test('first restore preserves all checkpoint metadata and creates a private normal file',async t=>{
  const f=await fixture(t);
  assert.equal(await restoreNotificationState(f),true);
  assert.deepEqual(JSON.parse(await readFile(f.statePath,'utf8')),checkpoint());
  assert.equal((await stat(f.statePath)).mode&0o777,0o600);
  assert.deepEqual((await readdir(f.directory)).sort(),['bootstrap.json','state.json']);
});

test('restore creates a missing parent with owner-only directory permissions',async t=>{
  const f=await fixture(t),parent=join(f.directory,'runtime');
  assert.equal(await restoreNotificationState({...f,statePath:join(parent,'state.json')}),true);
  assert.equal((await stat(parent)).mode&0o777,0o700);
});

test('an existing valid destination is retained byte for byte without needing a bootstrap',async t=>{
  const f=await fixture(t),existing=JSON.stringify(checkpoint(['old','newer']))+'\n';
  await writeFile(f.statePath,existing,{mode:0o600});
  await rm(f.bootstrapPath);
  assert.equal(await restoreNotificationState({...f,bootstrapPath:undefined}),false);
  assert.equal(await readFile(f.statePath,'utf8'),existing);
  assert.equal(await restoreNotificationState(f),false);
});

test('a valid existing checkpoint permits the notifier to baseline a newly allowed owner',async t=>{
  const f=await fixture(t),existing=JSON.stringify(checkpoint(['old','newer']));
  await writeFile(f.statePath,existing,{mode:0o600});
  let restored;
  await assert.doesNotReject(async()=>{
    restored=await restoreNotificationState({...f,allowed:new Set(['111','222'])});
  });
  assert.equal(restored,false);
  assert.equal(await readFile(f.statePath,'utf8'),existing);
});

test('a corrupt destination never falls through to a valid bootstrap',async t=>{
  const f=await fixture(t),bad='private fixture corrupt destination';
  await writeFile(f.statePath,bad);
  await assert.rejects(restoreNotificationState(f),error=>{
    assert.equal(error.code,'STATE_INVALID');
    assert.ok(!error.stack.includes(bad));return true;
  });
  assert.equal(await readFile(f.statePath,'utf8'),bad);
});

for(const bad of ['private fixture malformed bootstrap',JSON.stringify({version:2,owners:{}})]){
  test('invalid bootstrap contents are refused without creating a destination',async t=>{
    const f=await fixture(t);
    await writeFile(f.bootstrapPath,bad);
    await assert.rejects(restoreNotificationState(f),error=>{
      assert.equal(error.code,'BOOTSTRAP_INVALID');
      assert.ok(!error.stack.includes(bad));assert.ok(!JSON.stringify(error).includes(bad));return true;
    });
    await assert.rejects(stat(f.statePath),{code:'ENOENT'});
  });
}

test('bootstrap must contain delivery metadata for every allowed owner',async t=>{
  const f=await fixture(t);
  await assert.rejects(restoreNotificationState({...f,allowed:new Set(['111','222'])}),{code:'BOOTSTRAP_INVALID'});
  await assert.rejects(stat(f.statePath),{code:'ENOENT'});
});

test('an explicitly requested restore fails safely if its bootstrap is absent',async t=>{
  const f=await fixture(t);
  await rm(f.bootstrapPath);
  await assert.rejects(restoreNotificationState(f),{code:'BOOTSTRAP_INVALID'});
  await assert.rejects(restoreNotificationState({...f,bootstrapPath:undefined}),{code:'BOOTSTRAP_INVALID'});
  await assert.rejects(stat(f.statePath),{code:'ENOENT'});
});

test('a source symlink is refused without changing its target',async t=>{
  const f=await fixture(t),target=join(f.directory,'source-target.json');
  await writeFile(target,JSON.stringify(checkpoint()));
  await rm(f.bootstrapPath);await symlink(target,f.bootstrapPath);
  await assert.rejects(restoreNotificationState(f),{code:'BOOTSTRAP_INVALID'});
  assert.deepEqual(JSON.parse(await readFile(target,'utf8')),checkpoint());
  await assert.rejects(stat(f.statePath),{code:'ENOENT'});
});

test('a destination symlink is refused even when its target is valid',async t=>{
  const f=await fixture(t),target=join(f.directory,'destination-target.json');
  await writeFile(target,JSON.stringify(checkpoint(['already-delivered'])));
  await symlink(target,f.statePath);
  await assert.rejects(restoreNotificationState(f),{code:'STATE_INVALID'});
  assert.deepEqual(JSON.parse(await readFile(target,'utf8')),checkpoint(['already-delivered']));
});

for(const which of ['source','destination'])test(`a ${which} directory cannot masquerade as checkpoint data`,async t=>{
  const f=await fixture(t),path=which==='source'?f.bootstrapPath:f.statePath;
  await rm(path,{force:true});await mkdir(path);
  await assert.rejects(restoreNotificationState(f),{code:which==='source'?'BOOTSTRAP_INVALID':'STATE_INVALID'});
});

test('a bootstrap larger than sixteen MiB is refused',async t=>{
  const f=await fixture(t);
  await writeFile(f.bootstrapPath,' '.repeat(16*1024*1024+1));
  await assert.rejects(restoreNotificationState(f),{code:'BOOTSTRAP_INVALID'});
  await assert.rejects(stat(f.statePath),{code:'ENOENT'});
});

test('concurrent restores create the destination once and never overwrite the winner',async t=>{
  const f=await fixture(t);
  const results=await Promise.all([restoreNotificationState(f),restoreNotificationState(f)]);
  assert.deepEqual(results.sort(),[false,true]);
  assert.deepEqual(JSON.parse(await readFile(f.statePath,'utf8')),checkpoint());
  assert.deepEqual((await readdir(f.directory)).sort(),['bootstrap.json','state.json']);
});

for(const which of ['source','destination'])test(`a ${which} FIFO is safely refused without waiting for a writer`,async t=>{
  const f=await fixture(t),path=which==='source'?f.bootstrapPath:f.statePath;
  await rm(path,{force:true});
  assert.equal(spawnSync('mkfifo',[path]).status,0);
  const script=`
    import {restoreNotificationState} from ${JSON.stringify(new URL('./migration.mjs',import.meta.url).href)};
    try{await restoreNotificationState(${JSON.stringify({...f,allowed:['111']})});process.send({restored:true});}
    catch(error){process.send({code:error.code});}
  `;
  const child=spawn(process.execPath,['--input-type=module','-e',script],{env:{},stdio:['ignore','ignore','ignore','ipc']});
  const exited=new Promise(resolve=>child.once('close',resolve));
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exited;});
  let timer;
  const result=await Promise.race([
    new Promise(resolve=>child.once('message',resolve)),
    new Promise(resolve=>{timer=setTimeout(()=>resolve({timedOut:true}),1000);})
  ]);
  clearTimeout(timer);
  assert.deepEqual(result,{code:which==='source'?'BOOTSTRAP_INVALID':'STATE_INVALID'});
});
