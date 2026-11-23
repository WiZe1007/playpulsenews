import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestD1} from './test-d1.mjs';
import {createD1Bucket} from './storage.mjs';

const module=await import('./index.mjs').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return {};throw error;});
const origin='https://play-pulse.example';
const article={id:'live-news',date:'2026-11-23',category:'API',title:'Новина',summary:'Повний текст новини.',source:'https://developer.android.com/news',sourceLabel:'Android'};
async function fixture(t,{fetchFn}={}){
 assert.equal(typeof module.createWorker,'function');
 const {db}=await createTestD1(t),bucket=createD1Bucket(db);
 await bucket.put('news/updates-v1.json',JSON.stringify([article]));
 const env={DB:db,ASSETS:{fetch:async request=>new Response(new URL(request.url).pathname)},PLAY_PULSE_PUBLIC_ORIGIN:origin,PLAY_PULSE_OWNER_ID:'owner_'+'a'.repeat(40),PP_PASSWORD_PEPPER:'b'.repeat(64),PLAY_PULSE_READ_TOKEN:'read_'+'r'.repeat(40),PLAY_PULSE_WRITE_TOKEN:'write_'+'w'.repeat(40),PLAY_PULSE_SETUP_TOKEN:'setup_'+'s'.repeat(40),TELEGRAM_BOT_TOKEN:'123456789:'+ 'T'.repeat(35),TELEGRAM_ALLOWED_USER_IDS:'123456789',TELEGRAM_WEBHOOK_SECRET:'webhook_'+'h'.repeat(40),PLAY_PULSE_NOTIFICATIONS_ENABLED:'1',PLAY_PULSE_UPSTREAM_SITES_TOKEN:'fixture-sites-source-token'};
 let object;
 env.BOT={idFromName:name=>{assert.equal(name,'play-pulse-telegram-v1');return name;},get:()=>({fetch:request=>{
  assert.equal(typeof module.PlayPulseBot,'function');object??=new module.PlayPulseBot({},env,{fetchFn});return object.fetch(request);
 }})};
 return {env,bucket};
}

test('the Worker retains private site access and isolates webhook authentication',async t=>{
 let outgoing=0;const {env}=await fixture(t,{fetchFn:async()=>{outgoing++;throw Error('unexpected');}});
 const worker=module.createWorker();
 assert.equal((await worker.fetch(new Request(origin+'/news.json'),env,{})).status,401);
 const response=await worker.fetch(new Request(origin+'/news.json',{headers:{authorization:'Bearer '+env.PLAY_PULSE_READ_TOKEN}}),env,{});
 assert.equal(response.status,200);assert.deepEqual(await response.json(),[article]);
 const denied=await worker.fetch(new Request(origin+'/telegram/webhook',{method:'POST',body:'{}'}),env,{});
 assert.ok([401,403].includes(denied.status));assert.equal(outgoing,0);
 assert.equal((await worker.fetch(new Request(origin+'/account.html'),env,{})).status,200);
});

test('missing or invalid canonical configuration fails closed without secrets in errors',async t=>{
 const {env}=await fixture(t),worker=module.createWorker();
 for(const value of ['', 'http://insecure.example','https://private.example/path']){
  const response=await worker.fetch(new Request(origin+'/news.json'),{...env,PLAY_PULSE_PUBLIC_ORIGIN:value},{});
  assert.equal(response.status,503);const text=await response.text();assert.ok(!text.includes(env.PLAY_PULSE_READ_TOKEN));
 }
});

test('the scheduled bridge inserts fresh source news before delivery and preserves delivery baseline',async t=>{
 const calls=[];let env,bucket;
 ({env,bucket}=await fixture(t,{fetchFn:async(url,options)=>{
  calls.push(String(url));assert.equal(url,'https://play-pulse-news.nemofresh.chatgpt.site/news.json');
  assert.equal(new Headers(options.headers).get('oai-sites-authorization'),'Bearer '+env.PLAY_PULSE_UPSTREAM_SITES_TOKEN);
  return Response.json([article,{...article,id:'fresh-news',title:'Нова публікація'}]);
 }}));
 const worker=module.createWorker();
 await worker.scheduled({cron:'* * * * *'},env,{});
 const saved=await (await bucket.get('news/updates-v1.json')).json();assert.deepEqual(new Set(saved.map(row=>row.id)),new Set(['live-news','fresh-news']));
 const checkpoint=await (await bucket.get('telegram/notifications-v1.json')).json();
 assert.equal(checkpoint.owners['123456789'].seenIds.length,2);assert.equal(calls.length,1);
 await worker.scheduled({cron:'* * * * *'},env,{});assert.equal(calls.length,2);
});

test('source failure remains observable and still initializes delivery from the durable feed',async t=>{
 let env,bucket;({env,bucket}=await fixture(t,{fetchFn:async()=>{throw Error(env.PLAY_PULSE_UPSTREAM_SITES_TOKEN);}}));const worker=module.createWorker();
 await assert.rejects(worker.scheduled({cron:'* * * * *'},env,{}),error=>!error.message.includes(env.PLAY_PULSE_UPSTREAM_SITES_TOKEN));
 assert.ok(await bucket.get('telegram/notifications-v1.json'));
});

test('the public Worker delegates bot work to the private CPU-capable namespace only',async t=>{
 const {env}=await fixture(t),paths=[];
 env.BOT={idFromName:name=>{assert.equal(name,'play-pulse-telegram-v1');return name;},get:()=>({fetch:async request=>{paths.push(new URL(request.url).pathname);return Response.json({ok:true});}})};
 const worker=module.createWorker();
 const request=new Request(origin+'/telegram/webhook',{method:'POST',headers:{'content-type':'application/json','x-telegram-bot-api-secret-token':env.TELEGRAM_WEBHOOK_SECRET},body:JSON.stringify({update_id:998,message:{from:{id:123456789},chat:{id:123456789,type:'private'},text:'/start'}})});
 assert.equal((await worker.fetch(request,env,{})).status,200);
 await worker.scheduled({cron:'* * * * *'},env,{});
 assert.deepEqual(paths,['/telegram/webhook','/internal/telegram-delivery']);
 const internal=await worker.fetch(new Request(origin+'/internal/telegram-delivery',{method:'POST'}),env,{});
 assert.ok([401,404,405].includes(internal.status));assert.equal(paths.length,2);
});
