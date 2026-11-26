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
 assert.equal(f.sent()[0].args.reply_markup,undefined);
 assert.match(f.sent()[0].args.text,/<a href="https:\/\/developer\.android\.com/);
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

const articleSource='https://blog.google/products-and-platforms/platforms/google-play/story/';
const articlePhoto='https://storage.googleapis.com/gweb-uniblog-publish-prod/images/story.png';
const mediaHTML=()=>new Response(`<head><meta property="og:image" content="${articlePhoto}"></head>`,{headers:{'content-type':'text/html'}});
test('a channel article cover and full caption publish as one confirmed post',async t=>{
 const f=await fixture(t);await f.deliver();f.setFeed([row('old'),row('photo',{source:articleSource,summary:'Повний текст новини.',detail:'Усі подробиці збережені.'})]);
 let publicReads=0;
 const fetchFn=(url,options)=>{if(url===articleSource){publicReads++;return mediaHTML();}return f.options.fetchFn(url,options);};
 const stats=await f.deliver({fetchFn}),photos=f.calls.filter(call=>call.method==='sendPhoto');
 assert.equal(photos.length,1);assert.equal(f.sent().length,0);assert.equal(publicReads,1);
 assert.equal(photos[0].args.photo,articlePhoto);assert.match(photos[0].args.caption,/Повний текст новини\./);assert.match(photos[0].args.caption,/Усі подробиці збережені\./);
 assert.match(photos[0].args.caption,/<a href="https:\/\/blog\.google/);assert.equal(photos[0].args.protect_content,true);
 assert.equal(photos[0].args.text,undefined);assert.equal(photos[0].args.link_preview_options,undefined);
 assert.equal(stats.sentMessages,1);assert.equal(stats.sentArticles,1);assert.deepEqual((await f.state(channelKey)).channels[channel].seenIds,['old','photo']);
 await f.deliver({fetchFn});assert.equal(photos.length,1);assert.equal(publicReads,1);
});

test('a rejected media file falls back to the complete text only after explicit Telegram 400',async t=>{
 const f=await fixture(t);await f.deliver();f.setFeed([row('old'),row('photo',{source:articleSource,detail:'Повний контекст.'})]);let attempts=0;
 const fetchFn=(url,options)=>url===articleSource?mediaHTML():url.endsWith('/sendPhoto')?(attempts++,Response.json({ok:false,error_code:400,description:'wrong file identifier'},{status:400})):f.options.fetchFn(url,options);
 const stats=await f.deliver({fetchFn});assert.equal(attempts,1);assert.equal(f.sent().length,1);assert.match(f.sent()[0].args.text,/Повний контекст\./);assert.equal(stats.sentArticles,1);
 assert.deepEqual((await f.state(channelKey)).channels[channel].seenIds,['old','photo']);
});

test('an uncertain media send leaves the article pending and never sends a duplicate text fallback',async t=>{
 const f=await fixture(t);await f.deliver();f.setFeed([row('old'),row('photo',{source:articleSource})]);let attempts=0;
 const fetchFn=(url,options)=>{if(url===articleSource)return mediaHTML();if(url.endsWith('/sendPhoto')){attempts++;throw Error('Network outcome unknown');}return f.options.fetchFn(url,options);};
 await assert.rejects(f.deliver({fetchFn}));assert.equal(attempts,1);assert.equal(f.sent().length,0);assert.deepEqual((await f.state(channelKey)).channels[channel].seenIds,['old']);
});

test('a malformed successful media response is uncertain and cannot trigger a second text post',async t=>{
 const f=await fixture(t);await f.deliver();f.setFeed([row('old'),row('photo',{source:articleSource})]);let attempts=0;
 const fetchFn=(url,options)=>url===articleSource?mediaHTML():url.endsWith('/sendPhoto')?(attempts++,new Response('{',{headers:{'content-type':'application/json'}})):f.options.fetchFn(url,options);
 await assert.rejects(f.deliver({fetchFn}));assert.equal(attempts,1);assert.equal(f.sent().length,0);assert.deepEqual((await f.state(channelKey)).channels[channel].seenIds,['old']);
});

test('a channel post exceeding the caption limit keeps the complete text and private copies stay text',async t=>{
 const f=await fixture(t,{settings:{...env,TELEGRAM_OWNER_NOTIFICATIONS_ENABLED:'1'}});await f.deliver();
 f.setFeed([row('old'),row('long',{source:articleSource,summary:'с'.repeat(1100),detail:'Кінець контексту.'})]);let reads=0;
 const fetchFn=(url,options)=>{if(url===articleSource){reads++;return mediaHTML();}return f.options.fetchFn(url,options);};
 await f.deliver({fetchFn});assert.equal(f.calls.filter(call=>call.method==='sendPhoto').length,0);assert.equal(f.sent().length,2);
 assert.ok(f.sent().every(call=>call.args.text.includes('с'.repeat(1100))&&call.args.text.includes('Кінець контексту.')));assert.ok(reads<=2);
});

test('a real source MP4 publishes as one protected video with the full news caption',async t=>{
 const f=await fixture(t);await f.deliver();f.setFeed([row('old'),row('video',{source:articleSource,detail:'Повний відеоконтекст.'})]);
 const video='https://storage.googleapis.com/gweb-uniblog-publish-prod/videos/demo.mp4';
 const fetchFn=(url,options)=>url===articleSource?new Response(`<head><meta property="og:video" content="${video}"></head>`,{headers:{'content-type':'text/html'}}):f.options.fetchFn(url,options);
 assert.equal((await f.deliver({fetchFn})).sentArticles,1);
 const videos=f.calls.filter(call=>call.method==='sendVideo');assert.equal(videos.length,1);assert.equal(videos[0].args.video,video);assert.equal(videos[0].args.supports_streaming,true);assert.equal(videos[0].args.protect_content,true);assert.match(videos[0].args.caption,/Повний відеоконтекст\./);assert.equal(f.sent().length,0);
});

test('confirmed photo delivery resumes only its failed final checkpoint without re-fetching or resending media',async t=>{
 const f=await fixture(t);await f.deliver();f.setFeed([row('old'),row('photo',{source:articleSource})]);let reads=0;
 const fetchFn=(url,options)=>{if(url===articleSource){reads++;return mediaHTML();}return f.options.fetchFn(url,options);};
 const bucket={get:key=>f.bucket.get(key),put:(key,body,options)=>{
  if(key===channelKey&&JSON.parse(body).channels[channel].seenIds.includes('photo'))throw Error('Checkpoint unavailable');
  return f.bucket.put(key,body,options);
 }};
 await assert.rejects(f.deliver({fetchFn,bucket}));assert.equal(f.calls.filter(call=>call.method==='sendPhoto').length,1);assert.equal(reads,1);
 f.advance(61000);const stats=await f.deliver({fetchFn});assert.equal(stats.sentMessages,0);assert.equal(stats.sentArticles,1);assert.equal(reads,1);assert.equal(f.calls.filter(call=>call.method==='sendPhoto').length,1);
});

test('the hosted channel uses a labelled editorial photo or a large preview without truncation',async t=>{
 const siteURL='https://private.example';
 const f=await fixture(t,{settings:{...env,PLAY_PULSE_PUBLIC_ORIGIN:siteURL}});
 f.options.env.DB=f.db;
 await f.deliver();
 const long='і'.repeat(1200);
 f.setFeed([row('old'),row('a',{category:'Політики'}),row('b',{category:'Політики',summary:long})]);
 const result=await f.deliver();
 assert.equal(result.sentArticles,2);
 const photo=f.calls.find(c=>c.method==='sendPhoto')?.args;
 assert.match(photo?.photo,/\/covers\/[a-f0-9]{64}\.png$/);
 assert.match(photo.caption,/Графіка WWA/);
 const text=f.sent()[0].args;
 assert.ok(text.text.includes(long));
 assert.match(text.text,/Графіка WWA/);
 assert.match(text.link_preview_options.url,/\/covers\/[a-f0-9]{64}\.png$/);
 assert.notEqual(text.link_preview_options.url,photo.photo);
 assert.equal(text.link_preview_options.show_above_text,true);
});
