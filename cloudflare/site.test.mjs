import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestD1,createTestAuthNamespace} from './test-d1.mjs';
import {createCloudflareSite,readFeed} from './site.mjs';
import {createD1Bucket} from './storage.mjs';
const origin='https://play-pulse.example.workers.dev';
const secrets={PLAY_PULSE_PUBLIC_ORIGIN:origin,PLAY_PULSE_OWNER_ID:'owner_'+'o'.repeat(40),PP_PASSWORD_PEPPER:'a'.repeat(64),PLAY_PULSE_READ_TOKEN:'read_'+'r'.repeat(40),PLAY_PULSE_WRITE_TOKEN:'write_'+'w'.repeat(40),PLAY_PULSE_SETUP_TOKEN:'setup_'+'s'.repeat(40)};
const row=(id='imported')=>({id,date:'2026-11-23',category:'API',title:'Повна жива новина '+id,summary:'Приватний матеріал',source:'https://developer.android.com/news',sourceLabel:'Android'});
async function fixture(t){
  assert.equal(typeof createCloudflareSite,'function','Cloudflare site gateway must be exported');
  const {db,sqlite}=await createTestD1(t),bucket=createD1Bucket(db),assetRequests=[];
  await bucket.put('news/updates-v1.json',JSON.stringify([row()]));
  const env={...secrets,DB:db,ASSETS:{fetch:async request=>{
    assetRequests.push(request);
    const path=new URL(request.url).pathname;
    const assets={'/':'private page','/index.html':'private page','/account.html':'owner login','/account.css':'login style','/account.js':'login script','/mark.svg':'logo','/assets/scene-5.webp':'login wallpaper','/style.css':'private style'};
    return new Response(request.method==='HEAD'?null:assets[path]||'missing',{status:Object.hasOwn(assets,path)?200:404,headers:{'content-type':'text/html','cache-control':'public, max-age=3600'}});
  }}};
  env.AUTH=createTestAuthNamespace(env);
  const handler=createCloudflareSite({env,bucket,origin});
  const call=(path,{method='GET',headers={},body}={})=>handler(new Request(origin+path,{method,headers,...(body===undefined?{}:{body:JSON.stringify(body)})}));
  const post=(path,body,headers={})=>call(path,{method:'POST',headers:{origin,'content-type':'application/json',...headers},body});
  const credentials={username:'pulse.owner',password:'fixture long private owner password'};
  const setup=()=>post('/api/account/setup',credentials,{'X-Play-Pulse-Setup-Token':secrets.PLAY_PULSE_SETUP_TOKEN});
  return {db,sqlite,bucket,env,handler,call,post,setup,credentials,assetRequests};
}

test('Cloudflare gateway requires explicit secure configuration with distinct scoped credentials',()=>{
  assert.equal(typeof createCloudflareSite,'function');
  const bucket={get:async()=>null,put:async()=>null},ASSETS={fetch:async()=>new Response('asset')};
  assert.equal(typeof createCloudflareSite({env:{...secrets,ASSETS},bucket,origin}),'function');
  for(const changes of [{PLAY_PULSE_READ_TOKEN:''},{PLAY_PULSE_WRITE_TOKEN:secrets.PLAY_PULSE_READ_TOKEN},{PLAY_PULSE_SETUP_TOKEN:secrets.PLAY_PULSE_WRITE_TOKEN},{PP_PASSWORD_PEPPER:'bad'},{PLAY_PULSE_OWNER_ID:''}])assert.throws(()=>createCloudflareSite({env:{...secrets,...changes,ASSETS},bucket,origin}));
  assert.throws(()=>createCloudflareSite({env:{...secrets,ASSETS},bucket,origin:'http://insecure.example'}));
});

test('public login resources preserve design while all private assets and feed require access',async t=>{
  const f=await fixture(t);
  assert.deepEqual(await (await f.call('/healthz')).json(),{ok:true});
  assert.deepEqual(await (await f.call('/api/runtime')).json(),{platform:'cloudflare'});
  for(const path of ['/account.html','/account.css','/account.js','/mark.svg','/assets/scene-5.webp'])assert.equal((await f.call(path)).status,200);
  const root=await f.call('/');assert.equal(root.status,302);assert.equal(root.headers.get('location'),'/account.html?next=%2F');
  const count=f.assetRequests.length;
  for(const path of ['/news.json','/style.css','/server/index.js'])assert.equal((await f.call(path,{headers:{'oai-authenticated-user-id':secrets.PLAY_PULSE_OWNER_ID}})).status,401);
  assert.equal(f.assetRequests.length,count);
  assert.equal((await f.post('/api/news',[row('attack')])).status,401);
});

test('read-only and writer credentials stay confined to the exact feed and publication routes',async t=>{
  const f=await fixture(t),read={authorization:'Bearer '+secrets.PLAY_PULSE_READ_TOKEN},write={authorization:'Bearer '+secrets.PLAY_PULSE_WRITE_TOKEN};
  assert.deepEqual(await (await f.call('/news.json',{headers:read})).json(),[row()]);
  const head=await f.call('/news.json',{method:'HEAD',headers:read});assert.equal(head.status,200);assert.equal(await head.text(),'');
  assert.equal((await f.post('/api/news',[row('published')],write)).status,200);
  assert.equal((await f.call('/news.json',{headers:write})).status,401);
  assert.equal((await f.post('/api/news',[row('bad')],read)).status,401);
  for(const path of ['/style.css','/api/admin/news'])assert.equal((await f.call(path,{headers:read})).status,401);
  assert.equal((await f.post('/api/news',[row('cross-origin')],{...write,origin:'https://attacker.invalid'})).status,403);
  assert.equal(f.assetRequests.length,0);
});

test('private article links retain only validated feed navigation through owner login',async t=>{
  const f=await fixture(t);
  for(const [path,location] of [
    ['/?article=retained-news','/account.html?next=%2F%3Farticle%3Dretained-news%23news'],
    ['/?topic=gambling&article=retained-news','/account.html?next=%2F%3Farticle%3Dretained-news%26topic%3Dgambling%23news'],
    ['/?topic=gambling','/account.html?next=%2F%3Ftopic%3Dgambling%23news']
  ]){
    const target=await f.call(path,{headers:{host:'attacker.invalid'}});
    assert.equal(target.status,302);
    assert.equal(target.headers.get('location'),location);
  }
  assert.equal(f.assetRequests.length,0);
  assert.equal((await f.call('/news.json?article=retained-news')).status,401);
  const setup=await f.setup(),cookie=setup.headers.get('set-cookie').split(';')[0];
  assert.equal((await f.call('/?article=retained-news',{headers:{cookie}})).status,200);
  assert.equal(new URL(f.assetRequests.at(-1).url).search,'?article=retained-news');
});

test('untrusted article navigation is never reflected into the login return target',async t=>{
  const f=await fixture(t);
  for(const path of ['/?article=%2F%2Fevil.example','/?article=%5Cevil.example','/?article=good&article=other','/?topic=gambling&topic=api','/?article=good&token=private-value','/?article=good&next=https%3A%2F%2Fevil.example','/?topic=unknown','/private.html?article=good']){
    const response=await f.call(path);
    assert.equal(response.status,302,path);
    assert.equal(response.headers.get('location'),'/account.html?next=%2F',path);
  }
});

test('D1-backed owner sessions protect private pages and admin writes and logout revokes them',async t=>{
  const f=await fixture(t);
  assert.equal((await f.post('/api/account/setup',f.credentials)).status,403);
  const setup=await f.setup();assert.equal(setup.status,200);
  const cookie=setup.headers.get('set-cookie').split(';')[0];assert.match(setup.headers.get('set-cookie'),/Secure; HttpOnly; SameSite=Strict/);
  assert.equal((await f.call('/',{headers:{cookie}})).status,200);
  assert.equal((await f.post('/api/admin/news',[row('owner-edit')],{cookie})).status,200);
  assert.equal((await f.post('/api/admin/news',[row('csrf')],{cookie,origin:'https://attacker.invalid'})).status,403);
  const restarted=createCloudflareSite({env:f.env,bucket:createD1Bucket(f.db),origin});
  assert.equal((await restarted(new Request(origin+'/',{headers:{cookie}}))).status,200);
  assert.equal((await f.post('/api/account/logout',{}, {cookie})).status,200);
  assert.equal((await f.call('/news.json',{headers:{cookie}})).status,401);
  const login=await f.post('/api/account/login',f.credentials);assert.equal(login.status,200);
  assert.notEqual(login.headers.get('set-cookie').split(';')[0],cookie);
});

test('untrusted identity and Host headers never reach assets or replace the canonical owner',async t=>{
  const f=await fixture(t),headers={host:'attacker.invalid','x-forwarded-host':'attacker.invalid','oai-authenticated-user-id':'forged-owner',authorization:'Bearer '+secrets.PLAY_PULSE_READ_TOKEN};
  assert.equal((await f.call('/account.html',{headers})).status,200);
  const forwarded=f.assetRequests[0];assert.equal(new URL(forwarded.url).origin,origin);
  for(const key of ['oai-authenticated-user-id','x-forwarded-host','host','authorization'])assert.equal(forwarded.headers.get(key),null);
  assert.equal((await f.post('/api/account/setup',f.credentials,{'x-play-pulse-setup-token':secrets.PLAY_PULSE_SETUP_TOKEN,origin:'https://attacker.invalid',...headers})).status,403);
  const foreign=await f.handler(new Request('https://attacker.invalid/news.json',{headers:{authorization:'Bearer '+secrets.PLAY_PULSE_READ_TOKEN}}));
  assert.equal(foreign.status,403);
});

test('missing or malformed imported D1 feed fails closed instead of returning an empty archive',async t=>{
  const f=await fixture(t),headers={authorization:'Bearer '+secrets.PLAY_PULSE_READ_TOKEN};
  f.sqlite.prepare('UPDATE objects SET body = ? WHERE key = ?').run('{"private":"invalid archive"}','news/updates-v1.json');
  const invalid=await f.call('/news.json',{headers});assert.equal(invalid.status,503);assert.doesNotMatch(await invalid.text(),/invalid archive/);
  f.sqlite.prepare('DELETE FROM objects WHERE key = ?').run('news/updates-v1.json');
  assert.equal((await f.call('/news.json',{headers})).status,503);
  assert.equal((await f.post('/api/news',[row('accidental-reset')],{authorization:'Bearer '+secrets.PLAY_PULSE_WRITE_TOKEN})).status,503);
});

test('the internal feed API returns full D1 records and insert-only publication preserves owner edits',async t=>{
  const f=await fixture(t);
  assert.deepEqual(await readFeed(f.bucket),[row()]);
  const edited={...row(),title:'Правка власника'},write={authorization:'Bearer '+secrets.PLAY_PULSE_WRITE_TOKEN};
  await f.post('/api/news',[edited],write);
  const result=await f.post('/api/news',[row(),row('new')],{...write,'x-play-pulse-insert-only':'1'});
  assert.deepEqual((await result.json()).ids,['new']);
  const items=await readFeed(f.bucket);assert.equal(items.find(item=>item.id==='imported').title,'Правка власника');
});
