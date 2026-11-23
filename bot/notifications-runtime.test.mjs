import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as pause} from 'node:timers/promises';

for(const bootstrap of [false,true])test(bootstrap?'restored checkpoint precedes polling and delivers news already present at cloud startup':'the enabled bot sends newly published feed items without a user command and persists them',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'play-pulse-runtime-'));
  const statePath=join(dir,'notifications.json');
  const bootstrapPath=bootstrap?join(dir,'bootstrap.json'):undefined;
  if(bootstrap)await writeFile(bootstrapPath,JSON.stringify({version:1,owners:{'111':{baselineAt:'2026-11-23T08:30:00.000Z',seenIds:['old']}}}));
  const preload=`
    import {readFileSync} from 'node:fs';
    const article=(id,title)=>({id,title,date:'2026-11-23',category:'API',summary:'Перевірена новина',source:'https://developer.android.com/news'});
    let reads=0,timestamp=Date.now();
    Date.now=()=>timestamp+=20000;
    globalThis.fetch=async(url,options)=>{
      const json=result=>new Response(JSON.stringify(result),{headers:{'content-type':'application/json'}});
      if(url.endsWith('/news.json'))return json(${bootstrap?"[article('old','Архівна новина'),article('new','Щойно опубліковано')]":"++reads===1?[article('old','Архівна новина')]:[article('old','Архівна новина'),article('new','Щойно опубліковано')]"});
      const method=url.split('/').at(-1);
      if(method==='getUpdates'){
        if(${bootstrap}){
          try{JSON.parse(readFileSync(${JSON.stringify(statePath)},'utf8'));}
          catch{process.send({event:'poll-before-import'});}
        }
        const keepAlive=setInterval(()=>{},10000);
        return await new Promise((_,reject)=>options.signal.addEventListener('abort',()=>{clearInterval(keepAlive);reject(options.signal.reason);},{once:true}));
      }
      if(method==='sendMessage'){
        process.send({event:'notification',payload:JSON.parse(options.body)});
        return json({ok:true,result:{message_id:20,chat:{id:111,type:'private'}}});
      }
      throw Error('Unexpected fixture method');
    };
  `;
  const child=spawn(process.execPath,['--import','data:text/javascript;base64,'+Buffer.from(preload).toString('base64'),fileURLToPath(new URL('./bot.mjs',import.meta.url))],{
    env:{TELEGRAM_BOT_TOKEN:'123456789:'+'A'.repeat(35),TELEGRAM_ALLOWED_USER_IDS:'111',PLAY_PULSE_FEED_TOKEN:'fixture-feed',PLAY_PULSE_NOTIFICATIONS_ENABLED:'1',PLAY_PULSE_NOTIFICATIONS_STATE_FILE:statePath,PLAY_PULSE_NOTIFICATIONS_BOOTSTRAP_FILE:bootstrapPath},
    stdio:['ignore','pipe','pipe','ipc']
  });
  const exited=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
  let logs='';child.stdout.on('data',x=>{logs+=x;});child.stderr.on('data',x=>{logs+=x;});
  t.after(async()=>{
    if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
    await exited;await rm(dir,{recursive:true,force:true});
  });
  let timer;
  const notification=await new Promise((resolve,reject)=>{
    timer=setTimeout(()=>reject(Error('No automatic notification: '+logs)),2500);
    child.once('message',message=>{clearTimeout(timer);resolve(message);});
    child.once('error',error=>{clearTimeout(timer);reject(error);});
  });
  assert.equal(notification.event,'notification');
  assert.equal(String(notification.payload.chat_id),'111');
  assert.match(notification.payload.text,/Щойно опубліковано/);
  assert.doesNotMatch(notification.payload.text,/Архівна новина/);
  assert.equal(notification.payload.parse_mode,'HTML');
  assert.equal(notification.payload.protect_content,true);
  let state='';
  for(let i=0;i<50;i++){
    state=await readFile(statePath,'utf8').catch(()=>'');
    if(state.includes('"new"'))break;
    await pause(20);
  }
  assert.ok(state.includes('"new"'),'successful delivery must reach persistent state');
  child.kill('SIGTERM');
  let exitTimer;
  const outcome=await Promise.race([exited,new Promise(resolve=>{exitTimer=setTimeout(()=>resolve(null),1200);})]);
  clearTimeout(exitTimer);
  assert.deepEqual(outcome,{code:0,signal:null});
});

test('a corrupt explicit bootstrap stops startup before Telegram or feed requests',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'play-pulse-bad-bootstrap-'));
  const statePath=join(dir,'notifications.json'),bootstrapPath=join(dir,'bootstrap.json');
  const bad='private fixture corrupt bootstrap';
  await writeFile(bootstrapPath,bad);
  const preload=`globalThis.fetch=async()=>{process.send({event:'unexpected-network'});throw Error('No network allowed');};`;
  const child=spawn(process.execPath,['--import','data:text/javascript;base64,'+Buffer.from(preload).toString('base64'),fileURLToPath(new URL('./bot.mjs',import.meta.url))],{
    env:{TELEGRAM_BOT_TOKEN:'123456789:'+'A'.repeat(35),TELEGRAM_ALLOWED_USER_IDS:'111',PLAY_PULSE_FEED_TOKEN:'fixture-feed',PLAY_PULSE_NOTIFICATIONS_ENABLED:'1',PLAY_PULSE_NOTIFICATIONS_STATE_FILE:statePath,PLAY_PULSE_NOTIFICATIONS_BOOTSTRAP_FILE:bootstrapPath},
    stdio:['ignore','pipe','pipe','ipc']
  });
  let logs='';const network=[];
  child.stdout.on('data',chunk=>{logs+=chunk;});child.stderr.on('data',chunk=>{logs+=chunk;});
  child.on('message',message=>network.push(message));
  const exited=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
  t.after(async()=>{
    if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
    await exited;await rm(dir,{recursive:true,force:true});
  });
  let timer;
  const outcome=await Promise.race([exited,new Promise(resolve=>{timer=setTimeout(()=>resolve(null),1200);})]);
  clearTimeout(timer);
  assert.deepEqual(outcome,{code:1,signal:null});
  assert.deepEqual(network,[]);
  assert.ok(!logs.includes(bad));
  assert.ok(!logs.includes(bootstrapPath));
});
