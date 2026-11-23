import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestD1} from './test-d1.mjs';

const optional=path=>import(path).catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return {};throw error;});
const bot=await optional('./telegram.mjs'),storage=await optional('./storage.mjs'),core=await optional('../bot/core.mjs');
const env={TELEGRAM_BOT_TOKEN:'123456:'+'t'.repeat(40),TELEGRAM_ALLOWED_USER_IDS:'123',TELEGRAM_WEBHOOK_SECRET:'fixture_'+'w'.repeat(40),PLAY_PULSE_NOTIFICATIONS_ENABLED:'1'};
const siteURL='https://private.example';
const checkpoint='telegram/notifications-v1.json';
const row=(id,title='Новина '+id)=>({id,title,date:'2026-11-23',category:'API',summary:'Перевірений матеріал',source:'https://developer.android.com/news',sourceLabel:'Android'});
const command=(id,text='/start',owner=123)=>({update_id:id,message:{message_id:22,from:{id:owner,is_bot:false},chat:{id:owner,type:'private'},text}});
const callback=(id,data)=>({update_id:id,callback_query:{id:'callback-'+id,from:{id:123,is_bot:false},message:{message_id:22,chat:{id:123,type:'private'}},data}});
const request=(update,{secret=env.TELEGRAM_WEBHOOK_SECRET,method='POST',type='application/json'}={})=>new Request(siteURL+'/api/telegram/webhook',{method,headers:{'content-type':type,'x-telegram-bot-api-secret-token':secret},...(method==='POST'?{body:typeof update==='string'?update:JSON.stringify(update)}:{})});
const confirmed=(method,id=1)=>Response.json({ok:true,result:method==='answerCallbackQuery'?true:{message_id:id}});
const safe=error=>error instanceof Error&&!error.message.includes(env.TELEGRAM_BOT_TOKEN)&&!error.message.includes(env.TELEGRAM_WEBHOOK_SECRET)&&!error.message.includes('private network detail');
async function fixture(t,{records=[row('old')],settings=env}={}){
 assert.equal(typeof bot.processTelegramUpdate,'function');assert.equal(typeof bot.deliverFreshNews,'function');
 const {db,sqlite}=await createTestD1(t),bucket=storage.createD1Bucket(db),calls=[];
 let source=records;
 const fetchFn=async(url,options)=>{
  assert.ok(url.startsWith('https://api.telegram.org/bot'+env.TELEGRAM_BOT_TOKEN+'/'));assert.equal(options.redirect,'manual');assert.equal(options.method,'POST');
  const method=url.split('/').at(-1),args=JSON.parse(options.body);calls.push({method,args});return confirmed(method,calls.length);
 };
 const options={env:settings,bucket,getFeed:async()=>source,siteURL,fetchFn};
 return {db,sqlite,bucket,calls,options,source:records,setFeed:items=>{source=items;},process:(update,overrides={})=>bot.processTelegramUpdate(request(update),{...options,...overrides}),deliver:(overrides={})=>bot.deliverFreshNews({...options,...overrides}),read:async()=>{const saved=await bucket.get(checkpoint);return saved?.json();},seed:async owners=>bucket.put(checkpoint,JSON.stringify({version:1,owners}))};
}
const owner=(seenIds=[])=>({baselineAt:'2026-11-22T10:00:00.000Z',seenIds});

test('the shared pure bot core retains menus, parsing, and stable article buttons',()=>{
 assert.equal(typeof core.parseFeed,'function');assert.equal(typeof core.screen,'function');
 const items=core.parseFeed([row('a'),row('b')]),view=core.screen(items,'list:all:0',siteURL),button=view.keyboard[0][0].callback_data;
 const reordered=core.parseFeed([row('new'),row('b'),row('a')]);
 assert.match(core.screen(reordered,button,siteURL).text,/Новина a/);
 assert.match(core.screen(items,'home',siteURL).text,/Выберите раздел/);
});

test('webhook authentication, private owner checks, and bounded input fail before any Telegram request',async t=>{
 const f=await fixture(t);
 for(const [input,status] of [[request(command(1),{secret:'wrong'}),403],[request(command(1),{secret:'é'.repeat(env.TELEGRAM_WEBHOOK_SECRET.length)}),403],[request(command(1),{method:'GET'}),405],[request(command(1),{type:'text/plain'}),415],[request('invalid JSON'),400],[request(' '.repeat(128*1024+1)),413]]){
  const response=await bot.processTelegramUpdate(input,f.options);assert.equal(response.status,status);assert.doesNotMatch(await response.text(),/fixture_|123456:|private network detail/);
 }
 for(const update of [command(2,'/start',456),{...command(3),message:{...command(3).message,chat:{id:123,type:'group'}}},{...command(4),message:{...command(4).message,from:{id:123,is_bot:true}}}])assert.equal((await f.process(update)).status,200);
 assert.equal(f.calls.length,0);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM objects').get().n,0);
});

test('confirmed webhook replies are durably deduplicated across bucket instances',async t=>{
 const f=await fixture(t);assert.equal((await f.process(command(10))).status,200);assert.equal(f.calls.length,1);
 assert.equal(f.calls[0].args.protect_content,true);
 assert.equal((await f.process(command(10),{bucket:storage.createD1Bucket(f.db)})).status,200);assert.equal(f.calls.length,1);
 assert.equal((await f.process(command(8))).status,200);assert.equal(f.calls.length,2);
 const saved=await (await f.bucket.get('telegram/update-10-v1.json')).json();assert.equal(saved.completed,true);
 assert.doesNotMatch(JSON.stringify(saved),/Перевірений|fixture_|123456:/);
});

test('Workers-supported manual redirect handling rejects hostile redirects before reading bodies',async t=>{
 const f=await fixture(t);let calls=0,bodyReads=0;
 for(const redirected of [false,true]){
  const fetchFn=async(url,options)=>{
   calls++;assert.equal(options.redirect,'manual');
   const result=redirected?confirmed('sendMessage'):new Response(null,{status:302,headers:{location:'https://attacker.example/token'}});
   if(redirected)Object.defineProperty(result,'redirected',{value:true});
   Object.defineProperty(result,'body',{get(){bodyReads++;throw Error('Redirect body must not be read');}});
   return result;
  };
  const reply=await f.process(command(redirected?102:101),{fetchFn});
  assert.equal(reply.status,503);assert.doesNotMatch(await reply.text(),/attacker|123456:|Redirect body/);
 }
 assert.equal(calls,2);assert.equal(bodyReads,0);
});

test('a parallel replay cannot send while the original webhook lease is in flight',async t=>{
 const f=await fixture(t);let unlock,started;
 const ready=new Promise(resolve=>{started=resolve;}),hold=new Promise(resolve=>{unlock=resolve;});let sends=0;
 const fetchFn=async()=>{sends++;started();await hold;return confirmed('sendMessage');};
 const first=f.process(command(11),{fetchFn});await ready;
 assert.equal((await f.process(command(11),{fetchFn,bucket:storage.createD1Bucket(f.db)})).status,503);assert.equal(sends,1);
 unlock();assert.equal((await first).status,200);assert.equal((await f.process(command(11),{fetchFn})).status,200);assert.equal(sends,1);
});

test('callback article buttons survive isolate restarts and feed reorder without opening another item',async t=>{
 const f=await fixture(t,{records:[row('a'),row('b')]});assert.equal((await f.process(command(20,'/news'))).status,200);
 const action=f.calls[0].args.reply_markup.inline_keyboard[0][0].callback_data;
 f.setFeed([row('new'),row('b'),row('a')]);assert.equal((await f.process(callback(21,action),{bucket:storage.createD1Bucket(f.db)})).status,200);
 const edited=f.calls.find(call=>call.method==='editMessageText');assert.match(edited.args.text,/Новина a/);assert.doesNotMatch(edited.args.text,/Новина b|Новина new/);
 f.setFeed([row('b')]);assert.equal((await f.process(callback(22,action))).status,200);
 assert.match(f.calls.at(-1).args.text,/обновилась|устарел/);
});

test('rate limiting leaves webhook work unconfirmed and retries without sleeping',async t=>{
 const f=await fixture(t);let instant=100000,attempts=0;
 const fetchFn=async()=>{attempts++;return attempts===1?Response.json({ok:false,error_code:429,parameters:{retry_after:120}},{status:429}):confirmed('sendMessage');};
 const failed=await f.process(command(30),{fetchFn,now:()=>instant});assert.equal(failed.status,503);assert.equal(failed.headers.get('retry-after'),'120');
 assert.equal((await (await f.bucket.get('telegram/update-30-v1.json')).json()).completed,false);
 instant+=121000;assert.equal((await f.process(command(30),{fetchFn,now:()=>instant})).status,200);assert.equal(attempts,2);
 assert.equal((await f.process(command(30),{fetchFn,now:()=>instant})).status,200);assert.equal(attempts,2);
});

test('network and storage failures never expose credentials or mark a reply delivered',async t=>{
 const f=await fixture(t);
 const response=await f.process(command(40),{fetchFn:async()=>{throw Error('private network detail '+env.TELEGRAM_BOT_TOKEN);}});
 assert.equal(response.status,503);assert.doesNotMatch(await response.text(),/123456:|private network detail/);
 assert.equal((await (await f.bucket.get('telegram/update-40-v1.json')).json()).completed,false);
 const broken={get:async()=>{throw Error(env.TELEGRAM_WEBHOOK_SECRET);},put:async()=>{throw Error();}};
 assert.equal((await f.process(command(41),{bucket:broken})).status,503);assert.equal(f.calls.length,0);
});

test('a transient checkpoint write failure is retried before acknowledging or sending again',async t=>{
 const f=await fixture(t,{records:[row('fresh')]});await f.seed({'123':owner()});
 let webhookFailure=true,notificationFailure=true;
 const bucket={get:key=>f.bucket.get(key),put:async(key,body,options)=>{
  const value=JSON.parse(body);
  if(key==='telegram/update-50-v1.json'&&value.completed&&webhookFailure){webhookFailure=false;throw Error('temporary write');}
  if(key===checkpoint&&value.owners['123'].seenIds.includes('fresh')&&notificationFailure){notificationFailure=false;throw Error('temporary write');}
  return f.bucket.put(key,body,options);
 }};
 assert.equal((await f.process(command(50),{bucket})).status,200);assert.equal(f.calls.length,1);
 assert.equal((await f.process(command(50),{bucket})).status,200);assert.equal(f.calls.length,1);
 assert.deepEqual(await f.deliver({bucket}),{initializedOwners:0,sentMessages:1,sentArticles:1});
 assert.deepEqual((await f.read()).owners['123'].seenIds,['fresh']);assert.equal(f.calls.length,2);
});

test('new notification owners quietly baseline the archive without sending it',async t=>{
 const f=await fixture(t);assert.deepEqual(await f.deliver(),{initializedOwners:1,sentMessages:0,sentArticles:0});assert.equal(f.calls.length,0);
 const state=await f.read();assert.deepEqual(state.owners['123'].seenIds,['old']);assert.ok(Number.isFinite(Date.parse(state.owners['123'].baselineAt)));
 assert.deepEqual(Object.keys(state).sort(),['owners','version']);
});

test('imported notification checkpoints deliver only new records and keep the metadata schema',async t=>{
 const f=await fixture(t,{records:[row('old'),row('fresh')]});await f.seed({'123':owner(['old'])});
 assert.deepEqual(await f.deliver(),{initializedOwners:0,sentMessages:1,sentArticles:1});assert.match(f.calls[0].args.text,/Новина fresh/);assert.doesNotMatch(f.calls[0].args.text,/Новина old/);assert.equal(f.calls[0].args.protect_content,true);
 const state=await f.read();assert.deepEqual(state.owners['123'],owner(['old','fresh']));assert.doesNotMatch(JSON.stringify(state),/Перевірений|fixture_|123456:/);
 assert.deepEqual(await f.deliver({bucket:storage.createD1Bucket(f.db)}),{initializedOwners:0,sentMessages:0,sentArticles:0});assert.equal(f.calls.length,1);
});

test('notification invocations send at most three digest chunks and retain the pending remainder',async t=>{
 const f=await fixture(t,{records:Array.from({length:20},(_,index)=>row('new-'+String(index).padStart(2,'0')))});await f.seed({'123':owner()});
 assert.deepEqual(await f.deliver(),{initializedOwners:0,sentMessages:3,sentArticles:15});assert.equal((await f.read()).owners['123'].seenIds.length,15);
 assert.deepEqual(await f.deliver(),{initializedOwners:0,sentMessages:1,sentArticles:5});assert.equal(f.calls.length,4);
});

test('a failed second digest chunk resumes only unconfirmed IDs after the rate limit expires',async t=>{
 const f=await fixture(t,{records:Array.from({length:7},(_,index)=>row('new-'+index))});await f.seed({'123':owner()});let count=0,instant=Date.parse('2026-11-23T10:00:00Z');
 const fetchFn=async()=>++count===2?Response.json({ok:false,error_code:429,parameters:{retry_after:120}},{status:429}):confirmed('sendMessage',count);
 await assert.rejects(f.deliver({fetchFn,now:()=>instant}),safe);assert.equal((await f.read()).owners['123'].seenIds.length,5);
 instant+=121000;assert.deepEqual(await f.deliver({fetchFn,now:()=>instant}),{initializedOwners:0,sentMessages:1,sentArticles:2});assert.equal(count,3);
});

test('per-owner CAS leases prevent overlapping notification sends across isolates',async t=>{
 const f=await fixture(t,{records:[row('fresh')]});await f.seed({'123':owner()});let started,unlock,sends=0;
 const ready=new Promise(resolve=>{started=resolve;}),hold=new Promise(resolve=>{unlock=resolve;});
 const fetchFn=async()=>{sends++;started();await hold;return confirmed('sendMessage');};
 const first=f.deliver({fetchFn});await ready;
 assert.deepEqual(await f.deliver({fetchFn,bucket:storage.createD1Bucket(f.db)}),{initializedOwners:0,sentMessages:0,sentArticles:0});assert.equal(sends,1);
 unlock();assert.equal((await first).sentArticles,1);assert.equal(sends,1);
});

test('one permanently rejected owner does not hide news from another allowed owner',async t=>{
 const settings={...env,TELEGRAM_ALLOWED_USER_IDS:'123,456'},f=await fixture(t,{settings,records:[row('fresh')]});await f.seed({'123':owner(),'456':owner()});
 const fetchFn=async(url,options)=>JSON.parse(options.body).chat_id===123?Response.json({ok:false,error_code:403},{status:403}):confirmed('sendMessage');
 await assert.rejects(f.deliver({fetchFn}),safe);
 const state=await f.read();assert.deepEqual(state.owners['123'].seenIds,[]);assert.deepEqual(state.owners['456'].seenIds,['fresh']);
});

test('corrupt checkpoints and unavailable feeds stop notifications without resetting state',async t=>{
 const f=await fixture(t);await f.bucket.put(checkpoint,JSON.stringify({version:1,owners:{'123':{seenIds:[]}}}));
 await assert.rejects(f.deliver(),safe);assert.equal(f.calls.length,0);assert.deepEqual(await f.read(),{version:1,owners:{'123':{seenIds:[]}}});
 await f.seed({'123':owner()});await assert.rejects(f.deliver({getFeed:async()=>{throw Error(env.TELEGRAM_BOT_TOKEN);}}),safe);assert.deepEqual((await f.read()).owners['123'].seenIds,[]);
 assert.deepEqual(await bot.deliverFreshNews({env:{PLAY_PULSE_NOTIFICATIONS_ENABLED:'0'}}),{initializedOwners:0,sentMessages:0,sentArticles:0});
});
