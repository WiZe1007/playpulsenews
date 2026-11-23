import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,stat,rm,symlink,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createNotifier} from './notifications.mjs';
import * as notificationModule from './notifications.mjs';

const article=(id,date='2026-11-23')=>({id,date,category:'Магазин',title:'Private fixture headline '+id,
  summary:'Українська новина '+id,status:'',detail:'',links:[{label:'Google',url:'https://developer.android.com/news'}]});
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
async function within(promise,ms=1500){
  let timer;
  try{return await Promise.race([promise,new Promise((_,reject)=>{
    timer=setTimeout(()=>reject(new assert.AssertionError({message:'Expected operation did not finish'})),ms);
  })]);}finally{clearTimeout(timer);}
}
async function fixture(t){
  const directory=await mkdtemp(join(tmpdir(),'play-pulse-notify-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const statePath=join(directory,'state.json'),calls=[];
  let items=[article('old')],nextId=1;
  const options={statePath,allowed:new Set(['111']),siteURL:'https://play-pulse.example',now:()=>new Date('2026-11-23T08:30:00Z'),
    getFeed:async()=>items,api:async(method,args)=>{
      calls.push({method,args});return {result:{message_id:nextId++}};
    }};
  return {directory,statePath,calls,options,setItems:next=>{items=next;},
    readState:async()=>JSON.parse(await readFile(statePath,'utf8'))};
}

test('the first owner baseline is silent, private and metadata only',async t=>{
  const f=await fixture(t),notifier=createNotifier(f.options);
  assert.deepEqual(await notifier.initialize(),{initializedOwners:1,sentMessages:0,sentArticles:0});
  assert.equal(f.calls.length,0);
  const stored=await readFile(f.statePath,'utf8');
  assert.ok(stored.includes('old'));
  assert.ok(!stored.includes('Private fixture headline'));
  assert.ok(!stored.includes('developer.android.com'));
  assert.equal((await stat(f.statePath)).mode&0o777,0o600);
  assert.deepEqual(await notifier.check(),{initializedOwners:0,sentMessages:0,sentArticles:0});
  assert.equal(f.calls.length,0);
});

test('new and backdated IDs deliver once across restart and feed removal',async t=>{
  const f=await fixture(t);
  await createNotifier(f.options).initialize();
  f.setItems([article('old'),article('late','2025-01-01')]);
  const notifier=createNotifier(f.options);
  assert.deepEqual(await notifier.check(),{initializedOwners:0,sentMessages:1,sentArticles:1});
  assert.equal(f.calls.length,1);
  assert.equal(f.calls[0].method,'sendMessage');
  assert.equal(f.calls[0].args.chat_id,111);
  assert.match(f.calls[0].args.text,/headline late/);
  assert.doesNotMatch(f.calls[0].args.text,/headline old/);
  assert.equal(f.calls[0].args.protect_content,true);
  f.setItems([article('old')]);
  await notifier.check();
  f.setItems([article('late','2025-01-01'),article('old')]);
  await createNotifier(f.options).check();
  assert.equal(f.calls.length,1);
});

test('a newly added owner gets a baseline without hiding pending news from existing owners',async t=>{
  const f=await fixture(t);
  await createNotifier(f.options).initialize();
  f.setItems([article('old'),article('fresh')]);
  const notifier=createNotifier({...f.options,allowed:new Set(['111','222'])});
  assert.equal((await notifier.initialize()).initializedOwners,1);
  await notifier.check();
  assert.deepEqual(f.calls.map(call=>call.args.chat_id),[111]);
});

test('a failed second chunk resumes only unconfirmed articles after restart',async t=>{
  const f=await fixture(t);
  await createNotifier(f.options).initialize();
  f.setItems([article('old'),...Array.from({length:7},(_,i)=>article('new-'+i))]);
  let sends=0;
  const notifier=createNotifier({...f.options,api:async()=>{
    if(++sends===2)throw Error('private fixture transport secret');
    return {result:{message_id:30}};
  }});
  await assert.rejects(notifier.check(),error=>{
    assert.equal(error.code,'SEND_FAILED');
    assert.ok(!error.stack.includes('private fixture transport secret'));
    return true;
  });
  const seen=(await f.readState()).owners['111'].seenIds;
  assert.equal(seen.length,6,'baseline and first five articles must already be committed');
  assert.equal((await createNotifier(f.options).check()).sentArticles,2);
  assert.equal(f.calls.length,1);
  for(const id of seen.filter(id=>id!=='old'))assert.ok(!f.calls[0].args.text.includes('headline '+id));
  assert.equal((await f.readState()).owners['111'].seenIds.length,8);
});

test('an unconfirmed Telegram result never marks news as delivered',async t=>{
  const f=await fixture(t);
  await createNotifier(f.options).initialize();
  f.setItems([article('old'),article('fresh')]);
  for(const reply of [{result:{}},{result:{message_id:0}},{result:{message_id:'42'}}]){
    await assert.rejects(createNotifier({...f.options,api:async()=>reply}).check(),{code:'SEND_FAILED'});
    assert.deepEqual((await f.readState()).owners['111'].seenIds,['old']);
  }
});

test('corrupt state is refused without resetting the baseline or exposing its contents',async t=>{
  const f=await fixture(t),bad='{private fixture secret invalid json';
  await writeFile(f.statePath,bad,{mode:0o600});
  await assert.rejects(createNotifier(f.options).initialize(),error=>{
    assert.equal(error.code,'STATE_INVALID');
    assert.ok(!error.stack.includes(bad));return true;
  });
  assert.equal(await readFile(f.statePath,'utf8'),bad);
  assert.equal(f.calls.length,0);
});

test('an established state cannot disappear and silently baseline pending news again',async t=>{
  const f=await fixture(t),notifier=createNotifier(f.options);
  await notifier.initialize();
  await rm(f.statePath);
  f.setItems([article('old'),article('fresh')]);
  await assert.rejects(notifier.check(),{code:'STATE_INVALID'});
  await assert.rejects(stat(f.statePath),{code:'ENOENT'});
  assert.equal(f.calls.length,0);
});

test('state symlinks are refused without changing their target',async t=>{
  const f=await fixture(t),target=join(f.directory,'other.json');
  await writeFile(target,'private fixture target');
  await symlink(target,f.statePath);
  await assert.rejects(createNotifier(f.options).initialize(),{code:'STATE_INVALID'});
  assert.equal(await readFile(target,'utf8'),'private fixture target');
});

test('fatal Telegram metadata survives wrapping without raw response details',async t=>{
  const f=await fixture(t);
  await createNotifier(f.options).initialize();
  f.setItems([article('old'),article('fresh')]);
  for(const status of [401,409]){
    const error=Object.assign(Error('private fixture secret'),{status,fatal:true,retryable:false});
    await assert.rejects(createNotifier({...f.options,api:async()=>{throw error;}}).check(),actual=>{
      assert.equal(actual.code,'SEND_FAILED');
      assert.equal(actual.status,status);assert.equal(actual.fatal,true);assert.equal(actual.retryable,false);
      assert.ok(!JSON.stringify(actual).includes('private fixture secret'));
      assert.ok(!actual.stack.includes('private fixture secret'));return true;
    });
  }
});

test('non-Error transport failures are safely wrapped and remain pending',async t=>{
  const f=await fixture(t);
  await createNotifier(f.options).initialize();
  f.setItems([article('old'),article('fresh')]);
  for(const failure of [null,undefined,'private fixture secret']){
    await assert.rejects(createNotifier({...f.options,api:async()=>{throw failure;}}).check(),error=>{
      assert.equal(error.code,'SEND_FAILED');
      assert.ok(!error.stack.includes('private fixture secret'));return true;
    });
  }
  assert.deepEqual((await f.readState()).owners['111'].seenIds,['old']);
});

test('overlapping notifier instances cannot deliver the same pending news',async t=>{
  const f=await fixture(t),started=deferred(),release=deferred();
  await createNotifier(f.options).initialize();
  f.setItems([article('old'),article('fresh')]);
  const first=createNotifier({...f.options,api:async()=>{
    started.resolve();await release.promise;return {result:{message_id:10}};
  }});
  const work=first.check();
  t.after(()=>release.resolve());
  await within(started.promise);
  await assert.rejects(first.check(),{code:'BUSY'});
  await assert.rejects(createNotifier(f.options).check(),{code:'LOCKED'});
  release.resolve();await work;
  await createNotifier(f.options).check();
  assert.equal(f.calls.length,0);
});

test('a crashed process leaves a recoverable delivery lock',async t=>{
  const f=await fixture(t);
  const source=`
    import {createNotifier} from ${JSON.stringify(new URL('./notifications.mjs',import.meta.url).href)};
    const notifier=createNotifier({statePath:${JSON.stringify(f.statePath)},allowed:new Set(['111']),
      getFeed:async()=>{process.send('locked');await new Promise(()=>{setInterval(()=>{},10000);});},
      api:async()=>{throw Error('No delivery allowed');}});
    await notifier.initialize();
  `;
  const child=spawn(process.execPath,['--input-type=module','-e',source],{env:{},stdio:['ignore','ignore','ignore','ipc']});
  const exited=new Promise(resolve=>child.once('close',resolve));
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exited;});
  await within(new Promise(resolve=>child.once('message',resolve)));
  child.kill('SIGKILL');await exited;
  assert.equal((await createNotifier(f.options).initialize()).initializedOwners,1);
  assert.equal(f.calls.length,0);
});

test('shutdown leaves pending news unconfirmed without a fallback message',async t=>{
  const f=await fixture(t),controller=new AbortController();
  await createNotifier(f.options).initialize();
  f.setItems([article('old'),article('fresh')]);
  const notifier=createNotifier({...f.options,signal:controller.signal,api:async()=>{
    controller.abort();throw Error('private fixture secret');
  }});
  await assert.rejects(notifier.check(),{name:'AbortError'});
  assert.deepEqual((await f.readState()).owners['111'].seenIds,['old']);
  assert.equal(f.calls.length,0);
});

test('a failed post-send checkpoint is retried before sending anything again',async t=>{
  const f=await fixture(t);
  await createNotifier(f.options).initialize();
  f.setItems([article('old'),article('fresh')]);
  let sends=0;
  const notifier=createNotifier({...f.options,api:async()=>{
    sends++;
    await rm(f.statePath);await mkdir(f.statePath);
    return {result:{message_id:10}};
  }});
  await assert.rejects(notifier.check(),{code:'STATE_WRITE_FAILED'});
  await rm(f.statePath,{recursive:true});
  await notifier.check();
  assert.equal(sends,1);
  assert.deepEqual((await f.readState()).owners['111'].seenIds,['old','fresh']);
});

test('a retried checkpoint merges progress saved by another notifier',async t=>{
  const f=await fixture(t),backup=join(f.directory,'backup.json');
  await createNotifier(f.options).initialize();
  f.setItems([article('old'),article('fresh')]);
  let sends=0;
  const notifier=createNotifier({...f.options,api:async()=>{
    if(++sends===1){await rename(f.statePath,backup);await mkdir(f.statePath);}
    return {result:{message_id:10}};
  }});
  await assert.rejects(notifier.check(),{code:'STATE_WRITE_FAILED'});
  await rm(f.statePath,{recursive:true});await rename(backup,f.statePath);
  f.setItems([article('old'),article('fresh'),article('newer')]);
  const peer=createNotifier({...f.options,allowed:new Set(['111','222'])});
  await peer.initialize();await peer.check();
  await notifier.check();
  assert.equal(sends,1,'a stale checkpoint must not erase already-confirmed newer IDs');
  const state=await f.readState();
  assert.deepEqual(new Set(state.owners['111'].seenIds),new Set(['old','fresh','newer']));
  assert.ok(state.owners['222'],'a stale checkpoint must retain another owner baseline');
});

for(const status of [400,403])test(`a permanent ${status} chat rejection cannot prevent delivery to the other owner`,async t=>{
  const f=await fixture(t),options={...f.options,allowed:new Set(['111','222'])};
  await createNotifier(options).initialize();
  f.setItems([article('old'),article('fresh')]);
  const delivered=[];
  const notifier=createNotifier({...options,api:async(_method,args)=>{
    if(args.chat_id===111)throw Object.assign(Error('Rejected private fixture'),{status,fatal:false,retryable:false});
    delivered.push(args.chat_id);return {result:{message_id:20}};
  }});
  await assert.rejects(notifier.check(),{code:'SEND_FAILED',status,fatal:false});
  assert.deepEqual(delivered,[222]);
  const state=await f.readState();
  assert.deepEqual(state.owners['111'].seenIds,['old']);
  assert.deepEqual(state.owners['222'].seenIds,['old','fresh']);
});

const BOOT='11111111-1111-4111-8111-111111111111';
const identity='linux:'+BOOT+':987654321';
async function storedLock(f,contents){
  const directory=f.statePath+'.lock';
  await mkdir(directory,{mode:0o700});
  const path=join(directory,'owner-'+process.pid+'-'+randomUUID());
  await writeFile(path,contents,{mode:0o600});
  return path;
}

test('Linux process identity uses boot ID and field 22 despite parentheses in the command name',async t=>{
  const f=await fixture(t),procRoot=join(f.directory,'proc');
  await mkdir(join(procRoot,'sys/kernel/random'),{recursive:true});
  await mkdir(join(procRoot,'123'));
  await writeFile(join(procRoot,'sys/kernel/random/boot_id'),BOOT+'\n');
  await writeFile(join(procRoot,'123/stat'),'123 (node (worker)) S 1 1 1 0 -1 4194560 10 11 12 13 14 15 16 17 18 19 20 21 987654321 23 24\n');
  assert.equal(typeof notificationModule.readProcessIdentity,'function');
  assert.equal(await notificationModule.readProcessIdentity(123,{platform:'linux',procRoot}),identity);
  assert.equal(await notificationModule.readProcessIdentity(123,{platform:'darwin',procRoot}),null);
  await writeFile(join(procRoot,'123/stat'),'123 (truncated) S 1 2 3\n');
  assert.equal(await notificationModule.readProcessIdentity(123,{platform:'linux',procRoot}),null);
  assert.equal(await notificationModule.readProcessIdentity(999,{platform:'linux',procRoot}),null);
});

for(const staleIdentity of ['linux:'+BOOT+':1','linux:22222222-2222-4222-8222-222222222222:987654321']){
  test(`a reused live PID with stale process identity ${staleIdentity} does not wedge delivery`,async t=>{
    const f=await fixture(t);
    await storedLock(f,JSON.stringify({version:1,identity:staleIdentity}));
    const notifier=createNotifier({...f.options,getProcessIdentity:async()=>identity});
    let result;
    await assert.doesNotReject(async()=>{result=await notifier.initialize();});
    assert.equal(result.initializedOwners,1);
    assert.equal(f.calls.length,0);
    await assert.rejects(stat(f.statePath+'.lock'),{code:'ENOENT'});
  });
}

test('the same live process identity continues to exclude another notifier',async t=>{
  const f=await fixture(t),contents=JSON.stringify({version:1,identity});
  const marker=await storedLock(f,contents);
  await assert.rejects(createNotifier({...f.options,getProcessIdentity:async()=>identity}).initialize(),{code:'LOCKED'});
  assert.equal(await readFile(marker,'utf8'),contents);
  assert.equal(f.calls.length,0);
});

for(const contents of ['',JSON.stringify({version:1,identity})]){
  test('unavailable process identity never steals a legacy or unidentified live lock',async t=>{
    const f=await fixture(t),marker=await storedLock(f,contents);
    await assert.rejects(createNotifier({...f.options,getProcessIdentity:async()=>null}).initialize(),{code:'LOCKED'});
    assert.equal(await readFile(marker,'utf8'),contents);
  });
}
