import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createBucket} from './bucket.mjs';

async function fixture(t){const dir=await mkdtemp(join(tmpdir(),'play-pulse-site-store-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}

test('bucket writes durable private JSON objects with conditional etags',async t=>{
  assert.equal(typeof createBucket,'function');
  const dir=await fixture(t),bucket=createBucket(dir);
  assert.equal(await bucket.get('news/updates-v1.json'),null);
  const first=await bucket.put('news/updates-v1.json','[{"id":"one"}]',{onlyIf:{etagDoesNotMatch:'*'}});
  assert.equal(typeof first.etag,'string');
  assert.equal(await bucket.put('news/updates-v1.json','[]',{onlyIf:{etagDoesNotMatch:'*'}}),null);
  assert.equal(await bucket.put('news/updates-v1.json','[]',{onlyIf:{etagMatches:'wrong'}}),null);
  const second=await bucket.put('news/updates-v1.json','[{"id":"two"}]',{onlyIf:{etagMatches:first.etag}});
  assert.notEqual(second.etag,first.etag);
  const restored=await createBucket(dir).get('news/updates-v1.json');
  assert.equal(restored.etag,second.etag);assert.deepEqual(await restored.json(),[{id:'two'}]);
});

test('parallel writers sharing a directory cannot both win the same etag',async t=>{
  assert.equal(typeof createBucket,'function');
  const dir=await fixture(t),first=createBucket(dir),second=createBucket(dir);
  const initial=await first.put('account/sessions-v1.json','[]');
  const writes=await Promise.all([first.put('account/sessions-v1.json','[1]',{onlyIf:{etagMatches:initial.etag}}),second.put('account/sessions-v1.json','[2]',{onlyIf:{etagMatches:initial.etag}})]);
  assert.equal(writes.filter(Boolean).length,1);
  const stored=await (await first.get('account/sessions-v1.json')).json();
  assert.ok([[1],[2]].some(expected=>JSON.stringify(expected)===JSON.stringify(stored)));
});

test('corrupt persisted objects fail closed and are never replaced by a write',async t=>{
  assert.equal(typeof createBucket,'function');
  const dir=await fixture(t),bucket=createBucket(dir);
  await bucket.put('account/admin-v1.json','{"role":"admin"}');
  const [file]=await readdir(dir);await writeFile(join(dir,file),'secret malformed object');
  await assert.rejects(bucket.get('account/admin-v1.json'),error=>!error.message.includes('secret'));
  await assert.rejects(bucket.put('account/admin-v1.json','{}'));
  assert.equal(await readFile(join(dir,file),'utf8'),'secret malformed object');
});

test('oversized serialized envelopes are rejected before replacing a durable object',async t=>{
  const dir=await fixture(t),bucket=createBucket(dir);
  const saved=await bucket.put('news/updates-v1.json','[{"id":"preserved"}]');
  const escaped=JSON.stringify('\\'.repeat(4.5*1024*1024));
  assert.ok(Buffer.byteLength(escaped)<12*1024*1024);
  await assert.rejects(bucket.put('news/updates-v1.json',escaped,{onlyIf:{etagMatches:saved.etag}}));
  const restored=await bucket.get('news/updates-v1.json');
  assert.equal(restored.etag,saved.etag);
  assert.deepEqual(await restored.json(),[{id:'preserved'}]);
});
