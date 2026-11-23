import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

import {setupBot,runSetup} from './setup.mjs';
const token='123456789:'+'A'.repeat(35);
const env={TELEGRAM_BOT_TOKEN:token};
const me={id:123456789,is_bot:true,first_name:'Play Pulse',username:'play_pulse_fixture_bot',can_join_groups:false,can_read_all_group_messages:false,supports_inline_queries:false};
const webhook={url:'',has_custom_certificate:false,pending_update_count:0};
const json=result=>new Response(JSON.stringify({ok:true,result}),{headers:{'Content-Type':'application/json'}});

test('setup applies the Russian profile and private commands after read-only preflight',async()=>{
  const requests=[];
  const fetchFn=async(url,options)=>{
    const method=new URL(url).pathname.split('/').at(-1);
    assert.equal(options.method,'POST');
    assert.equal(options.redirect,'error');
    assert.ok(options.signal instanceof AbortSignal);
    if(method==='setMyProfilePhoto'){
      const request=new Request(url,options);
      assert.match(request.headers.get('content-type'),/^multipart\/form-data; boundary=/);
      const body=await request.formData();
      assert.deepEqual(JSON.parse(body.get('photo')),{type:'static',photo:'attach://avatar'});
      const photo=body.get('avatar');
      assert.equal(photo.name,'avatar.jpg');
      assert.equal(photo.type,'image/jpeg');
      assert.deepEqual(Buffer.from(await photo.arrayBuffer()),await readFile(new URL('./assets/avatar.jpg',import.meta.url)));
      requests.push({method,body:'multipart JPEG'});
    }else requests.push({method,body:JSON.parse(options.body)});
    return json(method==='getMe'?me:method==='getWebhookInfo'?webhook:true);
  };
  assert.deepEqual(await setupBot(env,{fetchFn}),{username:'play_pulse_fixture_bot'});
  assert.deepEqual(requests,[
    {method:'getMe',body:{}},
    {method:'getWebhookInfo',body:{}},
    {method:'setMyName',body:{name:'Play Pulse'}},
    {method:'setMyDescription',body:{description:'Новости Google Play и Play Console. Все рубрики, Android-гемблинг и архив Play Pulse в одном меню.'}},
    {method:'setMyShortDescription',body:{short_description:'Новости Google Play и Play Console, Android-гемблинг и архив Play Pulse.'}},
    {method:'setMyCommands',body:{commands:[{command:'start',description:'Открыть Play Pulse'},{command:'news',description:'Последние новости'},{command:'menu',description:'Главное меню'}],scope:{type:'all_private_chats'}}},
    {method:'setChatMenuButton',body:{menu_button:{type:'commands'}}},
    {method:'setMyProfilePhoto',body:'multipart JPEG'}
  ]);
});

test('setup rejects invalid token before making a request',async()=>{
  let requests=0;
  await assert.rejects(setupBot({TELEGRAM_BOT_TOKEN:'secret with spaces'},{fetchFn:async()=>{requests++;throw Error('unexpected');}}),/TELEGRAM_BOT_TOKEN/);
  assert.equal(requests,0);
});

test('setup refuses an active webhook without changing it or the bot profile',async()=>{
  const methods=[];
  await assert.rejects(setupBot(env,{fetchFn:async url=>{
    const method=new URL(url).pathname.split('/').at(-1);methods.push(method);
    return json(method==='getMe'?me:{...webhook,url:'https://private.example/hook?secret=not-for-logs'});
  }}),error=>/webhook/.test(error.message)&&!error.message.includes('private.example')&&!error.message.includes('not-for-logs'));
  assert.deepEqual(methods,['getMe','getWebhookInfo']);
});

test('setup rejects malformed Telegram identities and webhook responses before mutation',async()=>{
  for(const badMe of [{...me,is_bot:false},{...me,id:0},{...me,username:'https://secret.invalid/'}]){
    let calls=0;
    await assert.rejects(setupBot(env,{fetchFn:async()=>{calls++;return json(badMe);}}),/Telegram/);
    assert.equal(calls,1);
  }
  let calls=0;
  await assert.rejects(setupBot(env,{fetchFn:async()=>json(++calls===1?me:{pending_update_count:0})}),/Telegram/);
  assert.equal(calls,2);
});

test('setup stops on the failed profile operation and never exposes raw API errors',async()=>{
  const methods=[];
  await assert.rejects(setupBot(env,{fetchFn:async url=>{
    const method=new URL(url).pathname.split('/').at(-1);methods.push(method);
    if(method==='setMyDescription')return new Response(JSON.stringify({ok:false,error_code:400,description:'raw '+token+' https://secret.example/'}),{status:400});
    return json(method==='getMe'?me:method==='getWebhookInfo'?webhook:true);
  }}),error=>/setMyDescription/.test(error.message)&&!error.message.includes(token)&&!error.message.includes('secret.example'));
  assert.deepEqual(methods,['getMe','getWebhookInfo','setMyName','setMyDescription']);
});

test('setup CLI reports safe success or failure and does not require an owner ID',async()=>{
  const logs=[],errors=[];
  const options={log:message=>logs.push(message),error:message=>errors.push(message),fetchFn:async url=>json(url.endsWith('/getMe')?me:url.endsWith('/getWebhookInfo')?webhook:true)};
  assert.equal(await runSetup(env,options),0);
  assert.match(logs.join('\n'),/@play_pulse_fixture_bot/);
  assert.deepEqual(errors,[]);
  assert.equal(await runSetup(env,{...options,fetchFn:async()=>{throw Error(token+' https://api.telegram.org/bot'+token+'/getMe');}}),1);
  assert.equal(errors.length,1);
  assert.doesNotMatch(errors[0],/123456789|AAAAA|https?:\/\//);
});
