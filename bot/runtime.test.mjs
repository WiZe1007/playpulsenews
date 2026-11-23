import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {handler, telegram, feed, runPolling, SITE} from './bot.mjs';

const TOKEN='123456789:'+'A'.repeat(35);
const update={update_id:7,message:{from:{id:111},chat:{id:111,type:'private'},message_id:1,text:'/start'}};
const response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});

// These tests replace only HTTP and the clock; rendering, transport error
// handling, delivery and the actual command-line process remain real.
for(const method of ['sendMessage','editMessageText']){
  test(`a rate-limited ${method} delivers the original reply after retry_after`,async()=>{
    const requests=[],waits=[];
    const api=telegram(TOKEN,async(url,options)=>{
      requests.push({method:url.split('/').at(-1),body:JSON.parse(options.body)});
      return requests.length===1
        ? response({ok:false,error_code:429,description:'Too Many Requests',parameters:{retry_after:17}},429)
        : response({ok:true,result:{message_id:9}});
    },{wait:async ms=>{waits.push(ms);}});
    const h=handler(new Set(['111']),api,async()=>[]);
    const event=method==='sendMessage'?update:{callback_query:{id:'button',from:{id:111},message:update.message,data:'home'}};
    // Callback acknowledgements are independent of delivery rate limiting.
    const call=method==='sendMessage'?api:async(name,args)=>name==='answerCallbackQuery'?{result:true}:api(name,args);
    const actual=method==='sendMessage'?h:handler(new Set(['111']),call,async()=>[]);
    assert.equal(await actual(event),true);
    assert.equal(requests.length,2,'the reply must be retried instead of reported as delivered');
    assert.deepEqual(waits,[17000]);
    assert.deepEqual(requests.map(x=>x.method),[method,method]);
    assert.deepEqual(requests[1].body,requests[0].body);
    if(method==='sendMessage')assert.equal(requests[1].body.protect_content,true);
  });
}

for(const status of [401,409])test(`Telegram ${status} failures carry safe fatal metadata`,async()=>{
  const api=telegram(TOKEN,async()=>response({ok:false,error_code:status,description:'Server description '+TOKEN},status));
  await assert.rejects(api('getUpdates',{}),error=>{
    assert.equal(error.fatal,true);
    assert.equal(error.status,status);
    assert.equal(error.retryable,false);
    assert.ok(!String(error.stack).includes(TOKEN));
    assert.ok(!JSON.stringify(error).includes(TOKEN));
    return true;
  });
});

test('/news opens the latest feed, including a command addressed to the bot',async()=>{
  const article={id:'latest',date:'2026-11-23',category:'Магазин',title:'Нова стаття',summary:'Текст',source:'https://developer.android.com/news'};
  for(const text of ['/news','/news@PlayPulseBot']){
    const replies=[];
    const h=handler(new Set(['111']),async(method,args)=>{replies.push({method,args});},async()=>[{
      ...article,links:[{label:'Оригинал',url:article.source}]
    }]);
    await h({...update,message:{...update.message,text}});
    assert.equal(replies.length,1);
    assert.match(replies[0].args.text,/Нова стаття/);
    assert.ok(replies[0].args.reply_markup.inline_keyboard.flat().some(button=>button.callback_data?.startsWith('item:')));
  }
});

test('cancelling a feed request propagates cancellation without a fallback reply',async()=>{
  const controller=new AbortController();
  let started;
  const ready=new Promise(resolve=>{started=resolve;});
  const read=feed({url:SITE+'/news.json',auth:'sites',feedToken:'fixture-feed'},async(_url,{signal})=>{
    started();
    return await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  },{signal:controller.signal});
  const replies=[];
  const h=handler(new Set(['111']),async(...args)=>{replies.push(args);},read);
  const result=h({...update,message:{...update.message,text:'/news'}});
  await ready;
  controller.abort();
  await assert.rejects(result,{name:'AbortError'});
  assert.equal(replies.length,0,'shutdown must not create a feed-error message');
});

test('stopping during a batch prevents handling the next update',async()=>{
  const controller=new AbortController(),handled=[];
  const api=telegram(TOKEN,async()=>response({ok:true,result:[update,{...update,update_id:8}]}),{signal:controller.signal});
  await runPolling(api,async event=>{
    handled.push(event.update_id);
    controller.abort();
  },{signal:controller.signal});
  assert.deepEqual(handled,[7]);
});

function cliFixture(t,transport){
  const preload=`
    const response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
    const update=${JSON.stringify(update)};
    ${transport}
  `;
  const child=spawn(process.execPath,[
    '--import','data:text/javascript;base64,'+Buffer.from(preload).toString('base64'),
    fileURLToPath(new URL('./bot.mjs',import.meta.url))
  ],{
    env:{TELEGRAM_BOT_TOKEN:TOKEN,TELEGRAM_ALLOWED_USER_IDS:'111',PLAY_PULSE_FEED_TOKEN:'fixture-feed'},
    stdio:['ignore','pipe','pipe','ipc']
  });
  const messages=[],waiting=[];
  let output='';
  child.stdout.on('data',chunk=>{output+=chunk;});
  child.stderr.on('data',chunk=>{output+=chunk;});
  child.on('message',message=>{
    const index=waiting.findIndex(x=>x.matches(message));
    if(index<0)messages.push(message);
    else waiting.splice(index,1)[0].resolve(message);
  });
  const exited=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
  t.after(async()=>{
    if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
    await exited;
  });
  return {child,exited,output:()=>output,
    async next(matches,timeout=2000){
      const index=messages.findIndex(matches);
      if(index>=0)return messages.splice(index,1)[0];
      let timer,entry;
      try{return await new Promise((resolve,reject)=>{
        entry={matches,resolve};waiting.push(entry);
        timer=setTimeout(()=>reject(Error('Fixture event timed out: '+output)),timeout);
      });}finally{
        clearTimeout(timer);
        const index=waiting.indexOf(entry);if(index>=0)waiting.splice(index,1);
      }
    }
  };
}

async function exitWithin(fixture,ms=1200){
  let timer;
  try{return await Promise.race([fixture.exited,new Promise(resolve=>{timer=setTimeout(()=>resolve(null),ms);})]);}
  finally{clearTimeout(timer);}
}

test('SIGTERM promptly cancels an in-flight long poll',async t=>{
  const fixture=cliFixture(t,`
    globalThis.fetch=async(_url,{signal})=>{
      const keepAlive=setInterval(()=>{},10000);
      process.send({event:'poll'});
      return await new Promise((_,reject)=>signal.addEventListener('abort',()=>{
        clearInterval(keepAlive);reject(signal.reason);
      },{once:true}));
    };
  `);
  await fixture.next(x=>x.event==='poll');
  fixture.child.kill('SIGTERM');
  assert.deepEqual(await exitWithin(fixture),{code:0,signal:null});
});

test('SIGTERM cancels retry backoff without another poll',async t=>{
  const fixture=cliFixture(t,`
    console.error=()=>{setImmediate(()=>process.send({event:'backoff'}));};
    globalThis.fetch=async()=>{
      return response({ok:false,error_code:500,description:'Server error'},500);
    };
  `);
  await fixture.next(x=>x.event==='backoff');
  fixture.child.kill('SIGTERM');
  assert.deepEqual(await exitWithin(fixture),{code:0,signal:null});
});

for(const {status,message} of [{status:401,message:/токен|авторизац/i},{status:409,message:/конфликт/i}])test(`Telegram ${status} terminates instead of retrying forever`,async t=>{
  const fixture=cliFixture(t,`
    globalThis.fetch=async()=>{
      process.send({event:'poll'});
      return response({ok:false,error_code:${status},description:'Server error'},${status});
    };
  `);
  await fixture.next(x=>x.event==='poll');
  assert.deepEqual(await exitWithin(fixture),{code:1,signal:null});
  assert.match(fixture.output(),message);
  assert.ok(!fixture.output().includes(TOKEN));
});

test('polling never confirms an update whose reply failed temporarily',async t=>{
  const fixture=cliFixture(t,`
    let sends=0,delivered=false;
    globalThis.fetch=async(url,{body,signal})=>{
      const method=url.split('/').at(-1),args=JSON.parse(body);
      if(method==='getUpdates'){
        if(args.offset>7){
          process.send({event:'confirmed',offset:args.offset,delivered});
          const keepAlive=setInterval(()=>{},10000);
          return await new Promise((_,reject)=>signal.addEventListener('abort',()=>{clearInterval(keepAlive);reject(signal.reason);},{once:true}));
        }
        return response({ok:true,result:[update]});
      }
      if(method==='sendMessage'){
        sends++;
        if(sends===1)return response({ok:false,error_code:500,description:'Server error'},500);
        delivered=true;
        return response({ok:true,result:{message_id:2}});
      }
      throw Error('Unexpected fixture method');
    };
  `);
  const confirmed=await fixture.next(x=>x.event==='confirmed',7000);
  assert.equal(confirmed.delivered,true,'failed replies must not be acknowledged by offset');
  assert.equal(confirmed.offset,8);
  fixture.child.kill('SIGTERM');
  assert.deepEqual(await exitWithin(fixture),{code:0,signal:null});
});
