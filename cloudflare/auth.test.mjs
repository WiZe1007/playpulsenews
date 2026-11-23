import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestD1} from './test-d1.mjs';
import {createD1Bucket} from './storage.mjs';
import {createCloudflareSite} from './site.mjs';
import {PlayPulseAuth} from './auth.mjs';
const origin='https://play-pulse.example.workers.dev';
const keys={PLAY_PULSE_PUBLIC_ORIGIN:origin,PLAY_PULSE_OWNER_ID:'owner_'+'o'.repeat(40),PP_PASSWORD_PEPPER:'a'.repeat(64),PLAY_PULSE_READ_TOKEN:'read_'+'r'.repeat(40),PLAY_PULSE_WRITE_TOKEN:'write_'+'w'.repeat(40),PLAY_PULSE_SETUP_TOKEN:'setup_'+'s'.repeat(40)};
const credentials={username:'pulse.owner',password:'fixture original private password'};
async function fixture(t){
  const {db}=await createTestD1(t),bucket=createD1Bucket(db),calls=[];
  const env={...keys,DB:db,ASSETS:{fetch:async()=>new Response('private asset')}};
  // Namespace boundary dispatches the actual production class and its real D1 SQL.
  let object;
  env.AUTH={idFromName:name=>name,get(id){
    assert.equal(id,'play-pulse-owner-auth-v1');
    return {fetch:async request=>{
      assert.equal(typeof PlayPulseAuth,'function','Auth Durable Object must be exported');
      object??=new PlayPulseAuth({},env);calls.push(request);
      return object.fetch(request);
    }};
  }};
  const handler=createCloudflareSite({env,bucket,origin});
  const post=(path,body,headers={})=>handler(new Request(origin+path,{method:'POST',headers:{origin,'content-type':'application/json',...headers},body:JSON.stringify(body)}));
  const setup=()=>post('/api/account/setup',credentials,{'x-play-pulse-setup-token':keys.PLAY_PULSE_SETUP_TOKEN});
  return {env,bucket,calls,handler,post,setup};
}

test('heavy password operations run through Auth DO while the existing verifier and sessions remain in D1',async t=>{
  const f=await fixture(t),setup=await f.setup();assert.equal(setup.status,200);
  assert.deepEqual(f.calls.map(request=>new URL(request.url).pathname),['/api/account/setup']);
  const saved=await (await f.bucket.get('account/admin-v1.json')).json();
  assert.equal(saved.iterations,100000);assert.equal(saved.algorithm,'HMAC-PEPPER-PBKDF2-SHA256-v1');
  const cookie=setup.headers.get('set-cookie').split(';')[0];
  assert.equal((await f.post('/api/account/login',credentials)).status,200);
  const changed=await f.post('/api/account/password',{currentPassword:credentials.password,password:'fixture changed private password'},{cookie});
  assert.equal(changed.status,200);
  assert.deepEqual(f.calls.map(request=>new URL(request.url).pathname),['/api/account/setup','/api/account/login','/api/account/password']);
  for(const request of f.calls){
    assert.equal(new URL(request.url).origin,origin);
    assert.equal(request.headers.get('oai-authenticated-user-id'),keys.PLAY_PULSE_OWNER_ID);
    assert.equal(request.headers.get('x-play-pulse-setup-token'),null);
  }
  const oldSession=await f.handler(new Request(origin+'/api/account',{headers:{cookie}}));
  assert.equal((await oldSession.json()).authenticated,false);
  assert.equal(f.calls.length,3,'cheap session checks must not invoke the password object');
  assert.equal((await f.post('/api/account/login',credentials)).status,401);
  assert.equal((await f.post('/api/account/login',{...credentials,password:'fixture changed private password'})).status,200);
});

test('gateway rejects bad setup guards, cross-origin posts and unauthenticated password changes before Auth DO',async t=>{
  const f=await fixture(t);
  assert.equal((await f.post('/api/account/setup',credentials)).status,403);
  assert.equal((await f.post('/api/account/setup',credentials,{'x-play-pulse-setup-token':keys.PLAY_PULSE_SETUP_TOKEN,origin:'https://attacker.invalid'})).status,403);
  assert.equal((await f.post('/api/account/login',credentials,{origin:'https://attacker.invalid'})).status,403);
  assert.equal((await f.post('/api/account/password',{currentPassword:credentials.password,password:'fixture changed private password'})).status,401);
  assert.equal(f.calls.length,0);
});

test('missing or unavailable Auth binding fails closed instead of hashing in the main Worker',async t=>{
  const f=await fixture(t);
  delete f.env.AUTH;
  const response=await f.setup();assert.equal(response.status,503);
  assert.equal(await f.bucket.get('account/admin-v1.json'),null);
  f.env.AUTH={idFromName:name=>name,get:()=>({fetch:async()=>{throw Error(keys.PP_PASSWORD_PEPPER);}})};
  const unavailable=await f.setup();assert.equal(unavailable.status,503);assert.ok(!(await unavailable.text()).includes(keys.PP_PASSWORD_PEPPER));
});

test('Auth object accepts only the three guarded canonical private POST operations',async t=>{
  assert.equal(typeof PlayPulseAuth,'function');
  const f=await fixture(t),object=new PlayPulseAuth({},f.env);
  const call=(path,{method='POST',owner=keys.PLAY_PULSE_OWNER_ID,requestOrigin=origin,urlOrigin=origin}={})=>object.fetch(new Request(urlOrigin+path,{method,headers:{origin:requestOrigin,'oai-authenticated-user-id':owner,'content-type':'application/json'},...(method==='POST'?{body:JSON.stringify(credentials)}:{})}));
  assert.equal((await call('/news.json')).status,404);
  assert.equal((await call('/api/account/login',{method:'GET'})).status,405);
  assert.equal((await call('/api/account/setup',{owner:'forged'})).status,403);
  assert.equal((await call('/api/account/setup',{requestOrigin:'https://attacker.invalid'})).status,403);
  assert.equal((await call('/api/account/setup',{urlOrigin:'https://attacker.invalid'})).status,403);
  assert.equal(await f.bucket.get('account/admin-v1.json'),null);
});
