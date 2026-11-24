import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestD1} from './test-d1.mjs';
import {createD1Bucket} from './storage.mjs';
import * as telegram from './telegram.mjs';

const channel='-1001234567890',owner='123',botId=123456;
const env={TELEGRAM_BOT_TOKEN:botId+':'+'t'.repeat(40),TELEGRAM_ALLOWED_USER_IDS:owner,PLAY_PULSE_NOTIFICATIONS_ENABLED:'1',TELEGRAM_CHANNEL_ID:channel};
const channelKey='telegram/channel-notifications-v1.json',ownerKey='telegram/notifications-v1.json';
const row=(id,overrides={})=>({id,date:'2026-11-24',category:'API',title:'Новина '+id,summary:'Повний матеріал '+id,source:'https://developer.android.com/news',sourceLabel:'Android',...overrides});
async function fixture(t,{settings=env,records=[row('old')]}={}){
 const {db,sqlite}=await createTestD1(t),bucket=createD1Bucket(db),calls=[];
 let source=records,instant=Date.parse('2026-11-24T08:00:00Z'),rights=true;
 const fetchFn=async(url,options)=>{
  assert.equal(options.redirect,'manual');assert.equal(options.method,'POST');
  assert.ok(url.startsWith('https://api.telegram.org/bot'+env.TELEGRAM_BOT_TOKEN+'/'));
  const method=url.split('/').at(-1),args=JSON.parse(options.body);calls.push({method,args});
  const result=method==='getMe'?{id:botId,is_bot:true,first_name:'Play Pulse',username:'PlayPulseNewsBot'}:
   method==='getChat'?{id:Number(channel),type:'channel',title:'Play Pulse'}:
   method==='getChatMember'?{status:'administrator',user:{id:botId,is_bot:true,first_name:'Play Pulse'},can_post_messages:rights}:
   {message_id:calls.length,chat:{id:args.chat_id,type:String(args.chat_id).startsWith('-')?'channel':'private'}};
  return Response.json({ok:true,result});
 };
 const options={env:settings,bucket,getFeed:async()=>source,siteURL:'https://private.example',fetchFn,now:()=>instant};
 return {db,sqlite,bucket,calls,options,deliver:overrides=>telegram.deliverFreshNews({...options,...overrides}),
  setFeed:items=>{source=items;},setRights:value=>{rights=value;},advance:milliseconds=>{instant+=milliseconds;},
  state:async key=>(await bucket.get(key))?.json(),sent:()=>calls.filter(call=>call.method==='sendMessage')};
}

test('channel verification checks the stable ID and bot posting permission without sending messages',async t=>{
 assert.equal(typeof telegram.verifyChannelAccess,'function');
 const f=await fixture(t);
 assert.deepEqual(await telegram.verifyChannelAccess(f.options),{id:channel,title:'Play Pulse'});
 assert.deepEqual(f.calls.map(({method,args})=>({method,args})),[
  {method:'getMe',args:{}},{method:'getChat',args:{chat_id:Number(channel)}},{method:'getChatMember',args:{chat_id:Number(channel),user_id:botId}}
 ]);
 assert.equal(f.sent().length,0);
});

test('a verified numeric channel ID may contain a zero immediately after its -100 prefix',async t=>{
 const f=await fixture(t),target='-1000123456789';
 const result=await telegram.verifyChannelAccess({...f.options,env:{...env,TELEGRAM_CHANNEL_ID:target},fetchFn:(url,options)=>
  url.endsWith('/getChat')?Response.json({ok:true,result:{id:Number(target),type:'channel',title:'Play Pulse'}}):f.options.fetchFn(url,options)});
 assert.deepEqual(result,{id:target,title:'Play Pulse'});
 assert.equal(f.sent().length,0);
});

test('an unresolved username, wrong chat type or missing post permission cannot enable channel delivery',async t=>{
 const f=await fixture(t);
 for(const target of ['@somechannel','123','-42','-100not-a-number']){
  const before=f.calls.length;
  await assert.rejects(f.deliver({env:{...env,TELEGRAM_CHANNEL_ID:target}}));
  assert.equal(f.calls.length,before);
 }
 f.setRights(false);
 await assert.rejects(f.deliver());
 assert.equal(await f.state(channelKey),undefined);assert.equal(f.sent().length,0);
});

test('a new channel quietly baselines its own archive, then posts fresh news without owner copies',async t=>{
 const f=await fixture(t);
 const first=await f.deliver();assert.equal(first.initializedChannels,1);assert.equal(f.sent().length,0);
 assert.equal(await f.state(ownerKey),undefined);
 f.setFeed([row('old'),row('fresh')]);
 assert.equal((await f.deliver()).sentArticles,1);
 assert.deepEqual(f.sent().map(call=>call.args.chat_id),[Number(channel)]);
 assert.ok(!f.sent()[0].args.reply_markup.inline_keyboard.flat().some(button=>button.callback_data));
 const stored=await f.state(channelKey);assert.deepEqual(new Set(stored.channels[channel].seenIds),new Set(['old','fresh']));
 assert.doesNotMatch(JSON.stringify(stored),/Повний|developer.android|123456:/);
 await f.deliver({bucket:createD1Bucket(f.db)});assert.equal(f.sent().length,1);
});

test('channel backfill is explicit and bounded while owner notifications require an explicit opt-in',async t=>{
 const f=await fixture(t,{settings:{...env,TELEGRAM_CHANNEL_BACKFILL:'1'},records:Array.from({length:7},(_,i)=>row('archive-'+i))});
 assert.equal((await f.deliver()).sentArticles,3);assert.equal(f.sent().length,3);
 assert.equal((await f.deliver()).sentArticles,3);assert.equal(f.sent().length,6);
 assert.equal((await f.deliver()).sentArticles,1);assert.equal(f.sent().length,7);
 assert.equal(await f.state(ownerKey),undefined);
 const both=await fixture(t,{settings:{...env,TELEGRAM_OWNER_NOTIFICATIONS_ENABLED:'1'}});
 await both.deliver();both.setFeed([row('old'),row('new')]);await both.deliver();
 assert.deepEqual(new Set(both.sent().map(call=>call.args.chat_id)),new Set([123,Number(channel)]));
});

test('channel backfill posts the archive oldest first with a stable ID order for the same date',async t=>{
 const f=await fixture(t,{settings:{...env,TELEGRAM_CHANNEL_BACKFILL:'1'},records:[
  row('late-b'),row('early',{date:'2026-11-20'}),row('late-a')
 ]});
 await f.deliver();
 assert.deepEqual(f.sent().map(call=>/Новина ([^<\n]+)/.exec(call.args.text)[1]),['early','late-a','late-b']);
});

test('three opted-in destinations rotate fairly while fresh arrivals maintain a backlog',async t=>{
 const f=await fixture(t,{settings:{...env,TELEGRAM_ALLOWED_USER_IDS:'123,456',TELEGRAM_OWNER_NOTIFICATIONS_ENABLED:'1'}});
 await f.deliver();
 for(let minute=0;minute<3;minute++){
  f.setFeed([row('old'),...Array.from({length:3*(minute+1)},(_,index)=>row('new-'+index))]);
  await f.deliver();f.advance(60000);
 }
 assert.deepEqual(new Set(f.sent().map(call=>call.args.chat_id)),new Set([123,456,Number(channel)]));
});

test('confirmed channel continuation parts resume without reposting the first part',async t=>{
 const f=await fixture(t);await f.deliver();
 f.setFeed([row('old'),row('long',{summary:'с'.repeat(1400),detail:'д'.repeat(3600)})]);
 let attempts=0;
 const fetchFn=async(url,options)=>{
  if(url.endsWith('/sendMessage')&&++attempts===2)return Response.json({ok:false,error_code:429,parameters:{retry_after:2}},{status:429});
  return f.options.fetchFn(url,options);
 };
 await assert.rejects(f.deliver({fetchFn}));
 assert.equal(f.sent().length,1);
 assert.deepEqual((await f.state(channelKey)).channels[channel].seenIds,['old']);
 const firstText=f.sent()[0].args.text;
 f.advance(3000);await f.deliver();
 assert.equal(f.sent().length,2);assert.notEqual(f.sent()[1].args.text,firstText);
 assert.deepEqual(new Set((await f.state(channelKey)).channels[channel].seenIds),new Set(['old','long']));
 await f.deliver();assert.equal(f.sent().length,2);
});

test('a permission loss keeps pending IDs and channel metadata isolated from the owner checkpoint',async t=>{
 const f=await fixture(t);await f.deliver();
 const ownerState={version:1,owners:{[owner]:{baselineAt:'2026-11-23T08:00:00.000Z',seenIds:['owner-only']}}};
 await f.bucket.put(ownerKey,JSON.stringify(ownerState));
 f.setFeed([row('old'),row('pending')]);f.setRights(false);
 await assert.rejects(f.deliver());
 assert.equal(f.sent().length,0);assert.deepEqual((await f.state(channelKey)).channels[channel].seenIds,['old']);
 assert.deepEqual(await f.state(ownerKey),ownerState);
 f.setRights(true);f.advance(61000);await f.deliver();assert.equal(f.sent().length,1);
});

test('a non-channel chat or mismatched membership cannot pass the channel preflight',async t=>{
 const f=await fixture(t);
 for(const [method,result] of [['getChat',{id:Number(channel),type:'supergroup',title:'Wrong target'}],['getChatMember',{status:'member',user:{id:botId,is_bot:true}}],['getChatMember',{status:'administrator',can_post_messages:true,user:{id:999,is_bot:true}}]]){
  await assert.rejects(telegram.verifyChannelAccess({...f.options,fetchFn:(url,options)=>url.endsWith('/'+method)?Response.json({ok:true,result}):f.options.fetchFn(url,options)}));
 }
 assert.equal(f.sent().length,0);
});

test('corrupt part metadata stops channel delivery without resetting progress or reposting',async t=>{
 const f=await fixture(t);await f.deliver();
 f.setFeed([row('old'),row('long',{summary:'с'.repeat(1400),detail:'д'.repeat(3600)})]);
 let attempts=0;
 const fetchFn=(url,options)=>url.endsWith('/sendMessage')&&++attempts===2?Response.json({ok:false,error_code:429,parameters:{retry_after:2}},{status:429}):f.options.fetchFn(url,options);
 await assert.rejects(f.deliver({fetchFn}));assert.equal(f.sent().length,1);
 const key='telegram/notification-progress-channels-'+channel+'-long-v1.json',progress=await f.state(key);
 await f.bucket.put(key,JSON.stringify({...progress,parts:progress.parts+1}));
 f.advance(3000);await assert.rejects(f.deliver());
 assert.equal(f.sent().length,1);assert.deepEqual((await f.state(channelKey)).channels[channel].seenIds,['old']);
});

test('a failed final channel checkpoint resumes its confirmed article without another Telegram message',async t=>{
 const f=await fixture(t);await f.deliver();f.setFeed([row('old'),row('fresh')]);
 const bucket={get:key=>f.bucket.get(key),put:(key,body,options)=>{
  if(key===channelKey&&JSON.parse(body).channels[channel].seenIds.includes('fresh'))throw Error('checkpoint unavailable');
  return f.bucket.put(key,body,options);
 }};
 await assert.rejects(f.deliver({bucket}));assert.equal(f.sent().length,1);
 assert.deepEqual((await f.state(channelKey)).channels[channel].seenIds,['old']);
 f.advance(61000);
 const resumed=await f.deliver();assert.equal(resumed.sentMessages,0);assert.equal(resumed.sentArticles,1);
 assert.equal(f.sent().length,1);assert.deepEqual((await f.state(channelKey)).channels[channel].seenIds,['old','fresh']);
});

test('overlapping channel deliveries share a durable destination lease',async t=>{
 const f=await fixture(t);await f.deliver();f.setFeed([row('old'),row('fresh')]);
 let unlock,started,sends=0;
 const ready=new Promise(resolve=>{started=resolve;}),hold=new Promise(resolve=>{unlock=resolve;});
 const fetchFn=async(url,options)=>{
  if(url.endsWith('/sendMessage')){sends++;started();await hold;}
  return f.options.fetchFn(url,options);
 };
 const first=f.deliver({fetchFn});await ready;
 assert.equal((await f.deliver({fetchFn,bucket:createD1Bucket(f.db)})).sentMessages,0);assert.equal(sends,1);
 unlock();assert.equal((await first).sentArticles,1);assert.equal(sends,1);
});

test('channel configuration keeps commands restricted to the allowed private owner',async t=>{
 const f=await fixture(t),settings={...env,TELEGRAM_WEBHOOK_SECRET:'fixture_'+'w'.repeat(40)};
 const makeRequest=(id,user,chatType='private')=>new Request('https://private.example/telegram/webhook',{
  method:'POST',headers:{'content-type':'application/json','x-telegram-bot-api-secret-token':settings.TELEGRAM_WEBHOOK_SECRET},
  body:JSON.stringify({update_id:id,message:{message_id:1,from:{id:user,is_bot:false},chat:{id:user,type:chatType},text:'/start'}})
 });
 for(const request of [makeRequest(1,456),makeRequest(2,Number(channel),'channel'),makeRequest(3,123,'supergroup')]){
  assert.equal((await telegram.processTelegramUpdate(request,{...f.options,env:settings})).status,200);
 }
 assert.equal(f.calls.length,0);
 assert.equal((await telegram.processTelegramUpdate(makeRequest(4,123),{...f.options,env:settings})).status,200);
 assert.deepEqual(f.sent().map(call=>call.args.chat_id),[123]);
});
