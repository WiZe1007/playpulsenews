import test from 'node:test';
import assert from 'node:assert/strict';
import {createD1Bucket,MAX_OBJECT_BYTES} from './storage.mjs';
import {createTestD1} from './test-d1.mjs';

test('D1 bucket persists JSON and its returned etag across instances',async t=>{
  const {db}=await createTestD1(t),bucket=createD1Bucket(db);
  assert.equal(await bucket.get('missing'),null);
  const written=await bucket.put('news/updates-v1.json','[{"id":"new","title":"Українська новина"}]');
  assert.ok(written,'an unconditional write must confirm persistence');
  assert.equal(typeof written.etag,'string');
  const saved=await createD1Bucket(db).get('news/updates-v1.json');
  assert.equal(saved.etag,written.etag);
  assert.deepEqual(await saved.json(),[{id:'new',title:'Українська новина'}]);
});

test('only one competing create-if-absent write can succeed',async t=>{
  const {db}=await createTestD1(t),a=createD1Bucket(db),b=createD1Bucket(db);
  const results=await Promise.all([
    a.put('telegram/lease','{"owner":"a"}',{onlyIf:{etagDoesNotMatch:'*'}}),
    b.put('telegram/lease','{"owner":"b"}',{onlyIf:{etagDoesNotMatch:'*'}})
  ]);
  assert.equal(results.filter(Boolean).length,1);
  assert.equal((await (await a.get('telegram/lease')).json()).owner,results[0]?'a':'b');
});

test('etag compare-and-set admits one concurrent update and rejects stale versions',async t=>{
  const {db}=await createTestD1(t),a=createD1Bucket(db),b=createD1Bucket(db);
  const initial=await a.put('account/sessions-v1.json','{"version":0}');
  assert.ok(initial);
  const results=await Promise.all([
    a.put('account/sessions-v1.json','{"version":1}',{onlyIf:{etagMatches:initial.etag}}),
    b.put('account/sessions-v1.json','{"version":2}',{onlyIf:{etagMatches:initial.etag}})
  ]);
  assert.equal(results.filter(Boolean).length,1);
  assert.equal((await (await a.get('account/sessions-v1.json')).json()).version,results[0]?1:2);
  assert.equal(await a.put('account/sessions-v1.json','{"version":3}',{onlyIf:{etagMatches:initial.etag}}),null);
  assert.equal(await a.put('not-created','{}',{onlyIf:{etagMatches:initial.etag}}),null);
  assert.equal(await a.get('not-created'),null);
});

test('conditional not-equal writes and combined conditions preserve the stored value',async t=>{
  const {db}=await createTestD1(t),bucket=createD1Bucket(db);
  const one=await bucket.put('value','1');
  assert.ok(one);
  assert.equal(await bucket.put('value','2',{onlyIf:{etagDoesNotMatch:one.etag}}),null);
  const two=await bucket.put('value','2',{onlyIf:{etagDoesNotMatch:'another-etag'}});
  assert.ok(two);
  assert.equal(await bucket.put('value','3',{onlyIf:{etagMatches:two.etag,etagDoesNotMatch:two.etag}}),null);
  assert.equal(await bucket.put('value','3',{onlyIf:{etagMatches:two.etag,etagDoesNotMatch:'*'}}),null);
  assert.equal(await (await bucket.get('value')).json(),2);
  assert.ok(await bucket.put('absent','null',{onlyIf:{etagDoesNotMatch:'other'}}));
});

test('prefixes isolate metadata namespaces and SQL-looking keys remain literal',async t=>{
  const {db,sqlite}=await createTestD1(t),site=createD1Bucket(db,{prefix:'site/'}),telegram=createD1Bucket(db,{prefix:'telegram/'});
  const key="state'); DROP TABLE objects; --";
  await site.put(key,'{"site":true}');await telegram.put(key,'{"telegram":true}');
  const siteRow=await site.get(key),telegramRow=await telegram.get(key);
  assert.ok(siteRow);assert.ok(telegramRow);
  assert.deepEqual(await siteRow.json(),{site:true});
  assert.deepEqual(await telegramRow.json(),{telegram:true});
  assert.equal(sqlite.prepare('SELECT count(*) AS count FROM objects').get().count,2);
});

test('invalid or oversized JSON is rejected without exposing its contents',async t=>{
  const {db}=await createTestD1(t),bucket=createD1Bucket(db),secret='private fixture secret';
  for(const body of [secret,undefined,'"'+ 'я'.repeat(Math.ceil(MAX_OBJECT_BYTES/2))+'"']){
    await assert.rejects(bucket.put('bad',body),error=>{
      assert.equal(error.code,'STORAGE_UNAVAILABLE');
      assert.ok(!error.stack.includes(secret));assert.ok(!JSON.stringify(error).includes(secret));return true;
    });
  }
  assert.equal(await bucket.get('bad'),null);
});

test('keys and conditions fail closed instead of broadening writes',async t=>{
  const {db}=await createTestD1(t),bucket=createD1Bucket(db);
  await bucket.put('protected','{"original":true}');
  for(const onlyIf of [null,{etagMatches:null},{etagDoesNotMatch:''},{unexpected:'condition'}])
    await assert.rejects(bucket.put('protected','{}',{onlyIf}),{code:'STORAGE_UNAVAILABLE'});
  for(const key of ['',null,'x'.repeat(1025),'bad\0key'])
    await assert.rejects(bucket.put(key,'{}'),{code:'STORAGE_UNAVAILABLE'});
  assert.deepEqual(await (await bucket.get('protected')).json(),{original:true});
});

test('D1 failures and corrupt persisted rows never expose raw details',async t=>{
  const {db,sqlite}=await createTestD1(t),bucket=createD1Bucket(db),secret='private fixture database secret';
  const failed=createD1Bucket({prepare(){throw Error(secret);}});
  for(const operation of [()=>failed.get('secret'),()=>failed.put('secret','{}')])
    await assert.rejects(operation(),error=>{assert.equal(error.code,'STORAGE_UNAVAILABLE');assert.ok(!error.stack.includes(secret));return true;});
  sqlite.exec('PRAGMA ignore_check_constraints = ON');
  sqlite.prepare('INSERT INTO objects(key,body,etag) VALUES(?,?,?)').run('corrupt',secret,'fixture-etag');
  await assert.rejects(bucket.get('corrupt'),{code:'STORAGE_UNAVAILABLE'});
});
