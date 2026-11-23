import test from 'node:test';
import assert from 'node:assert/strict';

import {checkReadiness,runDoctor} from './doctor.mjs';
const token='123456789:'+'B'.repeat(35);
const env={TELEGRAM_BOT_TOKEN:token,TELEGRAM_ALLOWED_USER_IDS:'111',PLAY_PULSE_FEED_TOKEN:'private-feed-secret'};
const me={id:123456789,is_bot:true,first_name:'Play Pulse',username:'play_pulse_fixture_bot',can_join_groups:false,can_read_all_group_messages:false,supports_inline_queries:false};
const webhook={url:'',has_custom_certificate:false,pending_update_count:0};
const article={id:'doctor-fixture',date:'2026-11-23',category:'API',title:'Новина',summary:'Перевірена новина',source:'https://developer.android.com/news'};
const json=result=>new Response(JSON.stringify({ok:true,result}),{headers:{'Content-Type':'application/json'}});

function healthyFetch(requests){return async(url,options)=>{
  requests.push({url,options});
  if(url.endsWith('/getMe'))return json(me);
  if(url.endsWith('/getWebhookInfo'))return json(webhook);
  return new Response(JSON.stringify([article]),{headers:{'Content-Type':'application/json'}});
};}

test('doctor verifies the live private feed using the same authorization as the bot',async()=>{
  const requests=[];
  assert.deepEqual(await checkReadiness(env,{fetchFn:healthyFetch(requests)}),{username:'play_pulse_fixture_bot',articleCount:1});
  assert.deepEqual(requests.map(x=>x.url),[
    'https://api.telegram.org/bot'+token+'/getMe',
    'https://api.telegram.org/bot'+token+'/getWebhookInfo',
    'https://play-pulse-news.nemofresh.chatgpt.site/news.json'
  ]);
  assert.equal(requests[2].options.headers['OAI-Sites-Authorization'],'Bearer private-feed-secret');
  for(const {options} of requests)assert.equal(options.redirect,'error');
});

test('doctor requires the owner ID and valid feed configuration before any external request',async()=>{
  for(const invalid of [{...env,TELEGRAM_ALLOWED_USER_IDS:''},{...env,TELEGRAM_ALLOWED_USER_IDS:'@owner'},{...env,PLAY_PULSE_FEED_TOKEN:''}]){
    let requests=0;
    await assert.rejects(checkReadiness(invalid,{fetchFn:async()=>{requests++;throw Error('unexpected');}}),/настро|параметр|TELEGRAM_ALLOWED_USER_IDS/);
    assert.equal(requests,0);
  }
});

test('doctor rejects invalid automatic delivery configuration before external requests',async()=>{
  for(const options of [{PLAY_PULSE_NOTIFICATIONS_ENABLED:'yes'},{PLAY_PULSE_NOTIFICATIONS_ENABLED:'1',PLAY_PULSE_NOTIFICATIONS_INTERVAL_SECONDS:'0'}]){
    let requests=0;
    await assert.rejects(checkReadiness({...env,...options},{fetchFn:async()=>{requests++;throw Error('unexpected');}}),/параметр/);
    assert.equal(requests,0);
  }
});

test('doctor leaves an active webhook intact and does not read the feed',async()=>{
  const methods=[];
  await assert.rejects(checkReadiness(env,{fetchFn:async url=>{
    const method=new URL(url).pathname.split('/').at(-1);methods.push(method);
    return json(method==='getMe'?me:{...webhook,url:'https://example.invalid/private-key'});
  }}),/webhook/);
  assert.deepEqual(methods,['getMe','getWebhookInfo']);
});

test('doctor accepts an empty live feed but rejects unauthorized and malformed feed responses',async()=>{
  for(const badFeed of [()=>new Response('private-feed-secret',{status:403}),()=>new Response('<html>login private-feed-secret</html>',{headers:{'Content-Type':'text/html'}}),()=>new Response('{not-json private-feed-secret',{headers:{'Content-Type':'application/json'}})]){
    await assert.rejects(checkReadiness(env,{fetchFn:async url=>url.endsWith('/getMe')?json(me):url.endsWith('/getWebhookInfo')?json(webhook):badFeed()}),error=>/Лента/.test(error.message)&&!error.message.includes('private-feed-secret'));
  }
  const result=await checkReadiness(env,{fetchFn:async url=>url.endsWith('/getMe')?json(me):url.endsWith('/getWebhookInfo')?json(webhook):new Response('[]',{headers:{'Content-Type':'application/json'}})});
  assert.equal(result.articleCount,0);
});

test('doctor CLI prints only a safe readiness summary and failure detail',async()=>{
  const logs=[],errors=[];
  const output={log:message=>logs.push(message),error:message=>errors.push(message)};
  assert.equal(await runDoctor(env,{...output,fetchFn:healthyFetch([])}),0);
  assert.match(logs.join('\n'),/@play_pulse_fixture_bot/);
  assert.match(logs.join('\n'),/1/);
  assert.match(logs.join('\n'),/\/start/);
  assert.deepEqual(errors,[]);
  assert.equal(await runDoctor(env,{...output,fetchFn:async()=>{throw Error(token+' private-feed-secret https://api.telegram.org/bot'+token+'/getMe');}}),1);
  assert.equal(errors.length,1);
  assert.doesNotMatch([...logs,...errors].join('\n'),/123456789|BBBBB|private-feed-secret|https?:\/\//);
});
