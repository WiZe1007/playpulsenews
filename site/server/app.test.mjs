import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readdir,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSiteHandler} from './app.mjs';
import {createBucket} from './bucket.mjs';
import {config} from './config.mjs';
const origin='https://private.example';
const base={PLAY_PULSE_PUBLIC_ORIGIN:origin,PLAY_PULSE_DATA_DIR:'/var/data/play-pulse',PLAY_PULSE_SEED_FILE:'/var/data/play-pulse/news.json',PLAY_PULSE_OWNER_ID:'owner_'+'a'.repeat(40),PP_PASSWORD_PEPPER:'a'.repeat(64),PLAY_PULSE_READ_TOKEN:'read_'+'r'.repeat(40),PLAY_PULSE_WRITE_TOKEN:'write_'+'w'.repeat(40),PLAY_PULSE_SETUP_TOKEN:'setup_'+'s'.repeat(40)};
const row=id=>({id,date:'2026-11-23',category:'API',title:'Новина '+id,summary:'Приватний матеріал',source:'https://developer.android.com/news',sourceLabel:'Android'});
const asset=text=>({type:'text/html; charset=utf-8',base64:Buffer.from(text).toString('base64'),size:Buffer.byteLength(text)});
async function fixture(t){
  assert.equal(typeof createSiteHandler,'function');
  const directory=await mkdtemp(join(tmpdir(),'play-pulse-gateway-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const cfg=config({...base,PLAY_PULSE_DATA_DIR:directory}),bucket=createBucket(directory);
  const assets={'/index.html':asset('private news page'),'/account.html':asset('owner login'),'/account.css':asset('login CSS'),'/account.js':asset('login JS'),'/style.css':asset('private CSS'),'/mark.svg':asset('logo')};
  const handler=await createSiteHandler({config:cfg,bucket,assets,seed:[row('seed')]});
  const call=(path,{method='GET',headers={},body}={})=>handler(new Request(origin+path,{method,headers,...(body!==undefined?{body:JSON.stringify(body)}:{})}));
  const post=(path,body,headers={})=>call(path,{method:'POST',body,headers:{origin,'content-type':'application/json',...headers}});
  const credentials={username:'site.owner',password:'fixture long owner password'};
  const setup=()=>post('/api/account/setup',credentials,{'x-play-pulse-setup-token':base.PLAY_PULSE_SETUP_TOKEN});
  return {directory,cfg,bucket,assets,handler,call,post,credentials,setup};
}

test('configuration requires a private origin, independent service tokens and secure account keys',()=>{
  assert.equal(typeof config,'function');assert.equal(config(base).origin,origin);
  for(const override of [{PLAY_PULSE_READ_TOKEN:''},{PLAY_PULSE_WRITE_TOKEN:base.PLAY_PULSE_READ_TOKEN},{PLAY_PULSE_SETUP_TOKEN:base.PLAY_PULSE_WRITE_TOKEN},{PP_PASSWORD_PEPPER:'bad'},{PLAY_PULSE_OWNER_ID:''},{PLAY_PULSE_PUBLIC_ORIGIN:'http://private.example'},{PLAY_PULSE_PUBLIC_ORIGIN:'https://private.example/path'},{PLAY_PULSE_SEED_FILE:''}])assert.throws(()=>config({...base,...override}),error=>!error.message.includes(base.PLAY_PULSE_READ_TOKEN));
});

test('the gateway exposes login resources and health while protecting every private route',async t=>{
  const f=await fixture(t);
  assert.deepEqual(await (await f.call('/healthz')).json(),{ok:true});
  assert.deepEqual(await (await f.call('/api/runtime')).json(),{platform:'render'});
  for(const path of ['/account.html','/account.css','/account.js','/mark.svg'])assert.equal((await f.call(path)).status,200);
  const homepage=await f.call('/');assert.equal(homepage.status,302);assert.equal(homepage.headers.get('location'),'/account.html?next=%2F');
  for(const path of ['/news.json','/style.css','/api/admin/news'])assert.ok([401,403,405].includes((await f.call(path,{headers:{'oai-authenticated-user-id':base.PLAY_PULSE_OWNER_ID,'x-forwarded-user':base.PLAY_PULSE_OWNER_ID}})).status));
  assert.equal((await f.post('/api/news',[row('attack')])).status,401);
  assert.equal((await f.post('/api/account/setup',f.credentials)).status,403);
});

test('read and writer tokens have distinct narrow scopes and never grant cabinet access',async t=>{
  const f=await fixture(t),read={authorization:'Bearer '+base.PLAY_PULSE_READ_TOKEN},write={authorization:'Bearer '+base.PLAY_PULSE_WRITE_TOKEN};
  assert.deepEqual((await (await f.call('/news.json',{headers:read})).json()).map(x=>x.id),['seed']);
  assert.equal((await f.call('/news.json',{method:'HEAD',headers:read})).status,200);
  assert.equal((await f.post('/api/news',[row('new')],write)).status,200);
  assert.equal((await f.call('/news.json',{headers:write})).status,401);
  assert.equal((await f.post('/api/news',[row('attack')],read)).status,401);
  for(const path of ['/style.css','/api/account','/api/admin/news']){
    const response=await f.call(path,{headers:read});
    if(path==='/api/account')assert.equal((await response.json()).authenticated,false);else assert.equal(response.status,401);
  }
  assert.equal((await f.post('/api/news',[row('cross-origin')],{...write,origin:'https://attacker.example'})).status,403);
});

test('owner setup, login, private feed, cabinet edits and logout survive a storage restart',async t=>{
  const f=await fixture(t),response=await f.setup();assert.equal(response.status,200);
  const cookie=response.headers.get('set-cookie').split(';')[0];assert.match(response.headers.get('set-cookie'),/Secure; HttpOnly; SameSite=Strict/);
  assert.equal((await f.call('/',{headers:{cookie}})).status,200);
  assert.equal((await f.post('/api/admin/news',[row('admin')],{cookie})).status,200);
  assert.equal((await f.post('/api/admin/news',[row('csrf')],{cookie,origin:'https://attacker.example'})).status,403);
  assert.equal((await f.post('/api/account/setup',f.credentials,{'x-play-pulse-setup-token':base.PLAY_PULSE_SETUP_TOKEN})).status,409);
  const restarted=await createSiteHandler({config:f.cfg,bucket:createBucket(f.directory),assets:f.assets,seed:[row('seed')]});
  assert.equal((await restarted(new Request(origin+'/',{headers:{cookie}}))).status,200);
  const loggedOut=await f.post('/api/account/logout',{}, {cookie});assert.equal(loggedOut.status,200);
  assert.equal((await f.call('/news.json',{headers:{cookie}})).status,401);
  const login=await f.post('/api/account/login',f.credentials);assert.equal(login.status,200);
  const otherCookie=login.headers.get('set-cookie').split(';')[0];assert.notEqual(otherCookie,cookie);
});

test('persisted feed corruption returns 503 instead of falling back to the seed',async t=>{
  const f=await fixture(t),write={authorization:'Bearer '+base.PLAY_PULSE_WRITE_TOKEN},read={authorization:'Bearer '+base.PLAY_PULSE_READ_TOKEN};
  await f.post('/api/news',[row('saved')],write);
  const files=await readdir(f.directory);
  for(const file of files){const data=await readFile(join(f.directory,file),'utf8');if(data.includes('news/updates-v1.json'))await writeFile(join(f.directory,file),'private corrupt data');}
  const response=await f.call('/news.json',{headers:read});assert.equal(response.status,503);assert.doesNotMatch(await response.text(),/private corrupt|seed/);
});

test('the original account wallpaper is available as a login resource without revealing private scenes',async t=>{
  const f=await fixture(t);
  f.assets['/assets/scene-5.webp']=asset('decorative login wallpaper');
  f.assets['/assets/scene-1.webp']=asset('private background');
  const handler=await createSiteHandler({config:f.cfg,bucket:f.bucket,assets:f.assets,seed:[row('seed')]});
  assert.equal((await handler(new Request(origin+'/assets/scene-5.webp'))).status,200);
  assert.equal((await handler(new Request(origin+'/assets/scene-1.webp'))).status,401);
});

test('cross-origin account setup and login are refused even with valid credentials or a spoofed host',async t=>{
  const f=await fixture(t);
  const response=await f.post('/api/account/setup',f.credentials,{'x-play-pulse-setup-token':base.PLAY_PULSE_SETUP_TOKEN,origin:'https://attacker.example',host:'attacker.example'});
  assert.equal(response.status,403);
  assert.equal((await f.setup()).status,200);
  assert.equal((await f.post('/api/account/login',f.credentials,{origin:'https://attacker.example'})).status,403);
});
