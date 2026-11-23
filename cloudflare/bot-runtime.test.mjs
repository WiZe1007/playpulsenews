import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestD1} from './test-d1.mjs';
import {createD1Bucket} from './storage.mjs';

const module=await import('./bot-runtime.mjs').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return {};throw error;});
const origin='https://play-pulse.example.workers.dev',source='https://play-pulse-news.nemofresh.chatgpt.site/news.json';
const keys={PLAY_PULSE_PUBLIC_ORIGIN:origin,PLAY_PULSE_OWNER_ID:'owner_'+'o'.repeat(40),PP_PASSWORD_PEPPER:'a'.repeat(64),PLAY_PULSE_READ_TOKEN:'read_'+'r'.repeat(40),PLAY_PULSE_WRITE_TOKEN:'write_'+'w'.repeat(40),PLAY_PULSE_SETUP_TOKEN:'setup_'+'s'.repeat(40),TELEGRAM_BOT_TOKEN:'123456:'+'t'.repeat(40),TELEGRAM_WEBHOOK_SECRET:'webhook_'+'h'.repeat(40),TELEGRAM_ALLOWED_USER_IDS:'123',PLAY_PULSE_NOTIFICATIONS_ENABLED:'1',PLAY_PULSE_UPSTREAM_SITES_TOKEN:'fixture-private-source-token'};
const row=id=>({id,date:'2026-11-23',category:'API',title:'Новина '+id,summary:'Перевірений матеріал',source:'https://developer.android.com/news',sourceLabel:'Android'});
async function fixture(t,{records=[row('old')],sourceRecords=[row('old'),row('fresh')],override={}}={}){
 assert.equal(typeof module.PlayPulseBot,'function');
 const {db}=await createTestD1(t),bucket=createD1Bucket(db),calls=[];
 await bucket.put('news/updates-v1.json',JSON.stringify(records));
 await bucket.put('telegram/notifications-v1.json',JSON.stringify({version:1,owners:{'123':{baselineAt:'2026-11-22T10:00:00Z',seenIds:['old']}}}));
 const env={...keys,DB:db,ASSETS:{fetch:async()=>new Response('private asset')},...override};
 const fetchFn=async(url,options)=>{
  calls.push({url,options});assert.equal(options.redirect,'manual');
  if(url===source){assert.equal(new Headers(options.headers).get('oai-sites-authorization'),'Bearer '+keys.PLAY_PULSE_UPSTREAM_SITES_TOKEN);return Response.json(sourceRecords);}
  assert.ok(url.startsWith('https://api.telegram.org/bot'+keys.TELEGRAM_BOT_TOKEN+'/'));assert.equal(new Headers(options.headers).get('oai-sites-authorization'),null);
  return Response.json({ok:true,result:{message_id:100}});
 };
 const object=new module.PlayPulseBot({},env,{fetchFn});
 const delivery=()=>object.fetch(new Request(origin+'/internal/telegram-delivery',{method:'POST'}));
 const webhook=(id=1,owner=123,secret=keys.TELEGRAM_WEBHOOK_SECRET)=>new Request(origin+'/telegram/webhook',{method:'POST',headers:{'content-type':'application/json','x-telegram-bot-api-secret-token':secret},body:JSON.stringify({update_id:id,message:{message_id:1,from:{id:owner,is_bot:false},chat:{id:owner,type:'private'},text:'/news'}})});
 return {env,bucket,calls,object,delivery,webhook,fetchFn};
}

test('Bot DO processes the owner webhook with durable deduplication and no source polling',async t=>{
 const f=await fixture(t);assert.equal((await f.object.fetch(f.webhook())).status,200);
 assert.equal(f.calls.length,1);assert.match(JSON.parse(f.calls[0].options.body).text,/Новина old/);
 assert.equal((await f.object.fetch(f.webhook())).status,200);assert.equal(f.calls.length,1);
 assert.equal((await f.object.fetch(f.webhook(2,456))).status,200);assert.equal(f.calls.length,1);
 assert.equal((await f.object.fetch(f.webhook(3,123,'wrong'))).status,403);assert.equal(f.calls.length,1);
 assert.equal((await (await f.bucket.get('telegram/update-1-v1.json')).json()).completed,true);
});

test('internal delivery imports one bounded source batch before notifying the owner',async t=>{
 const fresh=Array.from({length:12},(_,index)=>row('fresh-'+index)),f=await fixture(t,{sourceRecords:[row('old'),...fresh]});
 const reply=await f.delivery();assert.equal(reply.status,200);assert.deepEqual(await reply.json(),{ok:true});
 const saved=await (await f.bucket.get('news/updates-v1.json')).json();assert.equal(saved.length,11);
 assert.equal(f.calls[0].url,source);assert.ok(f.calls.slice(1).every(call=>call.url.includes('/sendMessage')));
 assert.equal(f.calls.filter(call=>call.url===source).length,1);assert.ok(f.calls.length<=4);
 const checkpoint=await (await f.bucket.get('telegram/notifications-v1.json')).json();assert.equal(checkpoint.owners['123'].seenIds.length,11);
});

test('source failure still delivers durable pending news and returns a sanitized failure',async t=>{
 const f=await fixture(t,{records:[row('old'),row('pending')]}),calls=[];
 const fetchFn=async(url,options)=>{calls.push(url);if(url===source)throw Error(keys.PLAY_PULSE_UPSTREAM_SITES_TOKEN);return f.fetchFn(url,options);};
 const object=new module.PlayPulseBot({},f.env,{fetchFn});
 const reply=await object.fetch(new Request(origin+'/internal/telegram-delivery',{method:'POST'}));
 assert.equal(reply.status,503);assert.deepEqual(await reply.json(),{ok:false});assert.equal(calls.length,2);
 assert.deepEqual((await (await f.bucket.get('telegram/notifications-v1.json')).json()).owners['123'].seenIds,['old','pending']);
 assert.deepEqual((await (await f.bucket.get('news/updates-v1.json')).json()).map(item=>item.id),['old','pending']);
});

test('Telegram failure retains unconfirmed IDs and the newly imported canonical news',async t=>{
 const f=await fixture(t),fetchFn=async(url,options)=>url===source?f.fetchFn(url,options):Response.json({ok:false,error_code:429,parameters:{retry_after:120}},{status:429});
 const object=new module.PlayPulseBot({},f.env,{fetchFn}),reply=await object.fetch(new Request(origin+'/internal/telegram-delivery',{method:'POST'}));
 assert.equal(reply.status,503);assert.deepEqual(await reply.json(),{ok:false});
 assert.deepEqual((await (await f.bucket.get('telegram/notifications-v1.json')).json()).owners['123'].seenIds,['old']);
 assert.equal((await (await f.bucket.get('news/updates-v1.json')).json()).some(item=>item.id==='fresh'),true);
});

test('delivery without an upstream credential uses only the existing private D1 feed',async t=>{
 const f=await fixture(t,{records:[row('old'),row('pending')],override:{PLAY_PULSE_UPSTREAM_SITES_TOKEN:undefined}});
 assert.equal((await f.delivery()).status,200);assert.equal(f.calls.length,1);assert.ok(f.calls[0].url.includes('/sendMessage'));
});

test('unknown routes, methods and noncanonical origins cannot trigger bot work',async t=>{
 const f=await fixture(t);
 for(const [url,method,status] of [[origin+'/news.json','POST',404],[origin+'/internal/telegram-delivery','GET',405],['https://attacker.invalid/internal/telegram-delivery','POST',403]])assert.equal((await f.object.fetch(new Request(url,{method}))).status,status);
 assert.equal(f.calls.length,0);
 const broken=new module.PlayPulseBot({},{...f.env,PLAY_PULSE_UPSTREAM_SITES_TOKEN:undefined,DB:{prepare(){throw Error(keys.TELEGRAM_BOT_TOKEN);}}},{fetchFn:f.fetchFn});
 const reply=await broken.fetch(new Request(origin+'/internal/telegram-delivery',{method:'POST'}));assert.equal(reply.status,503);assert.deepEqual(await reply.json(),{ok:false});
});
