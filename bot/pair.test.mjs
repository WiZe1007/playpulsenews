import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,stat,rm,readdir,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseEnv} from 'node:util';

const {findPairingUser,saveOwnerId,runPairing}=await import('./pair.mjs').catch(()=>({}));
const token='123456789:'+'A'.repeat(35);
const me={id:123456789,is_bot:true,first_name:'Play Pulse',username:'play_pulse_fixture_bot',can_join_groups:false,can_read_all_group_messages:false,supports_inline_queries:false};
const webhook={url:'',has_custom_certificate:false,pending_update_count:0};
const json=result=>new Response(JSON.stringify({ok:true,result}),{headers:{'Content-Type':'application/json'}});
const challenge='a'.repeat(43);
const update=(text='/start '+challenge,overrides={})=>({update_id:51,message:{message_id:3,date:1795428000,from:{id:81234567,is_bot:false,first_name:'Owner'},chat:{id:81234567,type:'private',first_name:'Owner'},text,...overrides}});
const available=name=>assert.equal(typeof ({findPairingUser,saveOwnerId,runPairing})[name],'function',name+' must implement owner pairing');
async function workspace(t,text='TELEGRAM_BOT_TOKEN='+token+'\nTELEGRAM_ALLOWED_USER_IDS=\n'){
  const dir=await mkdtemp(join(tmpdir(),'play-pulse-pair-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const path=join(dir,'.env');await writeFile(path,text,{mode:0o644});return {dir,path};
}
function fixture(logs,onUpdates){
  return async(url,options)=>{
    const method=new URL(url).pathname.split('/').at(-1);
    assert.equal(options.method,'POST');assert.equal(options.redirect,'error');
    assert.ok(options.signal instanceof AbortSignal);
    if(method==='getMe')return json(me);
    if(method==='getWebhookInfo')return json(webhook);
    assert.equal(method,'getUpdates','pairing must never send messages or change webhook');
    const args=JSON.parse(options.body);
    assert.equal(Object.hasOwn(args,'offset'),false,'unrelated updates must not be acknowledged');
    assert.equal(Object.hasOwn(args,'allowed_updates'),false,'existing update subscription must remain intact');
    assert.equal(args.limit,100);assert.ok(args.timeout>0);
    const link=logs.find(x=>/^https:\/\/t\.me\//.test(x));
    const payload=new URL(link).searchParams.get('start');
    return onUpdates(payload,options);
  };
}

test('only an exact challenge from a human in the matching private chat can own the bot',()=>{
  available('findPairingUser');
  assert.equal(findPairingUser([update()],challenge),81234567);
  const rejected=[update('/start'),update('/start stranger'),update('/start '+challenge+' extra'),
    update(undefined,{chat:{id:81234567,type:'group'}}),
    update(undefined,{chat:{id:9,type:'private'}}),
    update(undefined,{from:{id:81234567,is_bot:true}}),
    update(undefined,{from:{id:81234567}}),
    update(undefined,{from:{id:0,is_bot:false},chat:{id:0,type:'private'}}),
    update(undefined,{from:{id:Number.MAX_SAFE_INTEGER+1,is_bot:false},chat:{id:Number.MAX_SAFE_INTEGER+1,type:'private'}}),
    {edited_message:update().message},{callback_query:{from:{id:81234567},message:update().message}},null];
  for(const value of rejected)assert.equal(findPairingUser([value],challenge),null);
  assert.equal(findPairingUser([update('/start'),update()],challenge),81234567);
  assert.equal(findPairingUser([],challenge),null);
  assert.equal(findPairingUser([update()],''),null);
});

test('saving an owner preserves every existing byte and restricts the replacement file to 0600',async t=>{
  available('saveOwnerId');
  const original='# private setup\r\nTELEGRAM_BOT_TOKEN="'+token+'"\r\nPLAY_PULSE_FEED_TOKEN="line one\r\nTELEGRAM_ALLOWED_USER_IDS=inside-secret\r\nline three"\r\nTELEGRAM_ALLOWED_USER_IDS= # owner not paired\r\nOTHER=value # keep comment';
  const {dir,path}=await workspace(t,original);
  await saveOwnerId(path,81234567);
  const saved=await readFile(path,'utf8');
  assert.equal(saved,original+'\r\nTELEGRAM_ALLOWED_USER_IDS=81234567\r\n');
  assert.equal(parseEnv(saved).TELEGRAM_ALLOWED_USER_IDS,'81234567');
  assert.equal(parseEnv(saved).TELEGRAM_BOT_TOKEN,token);
  assert.equal((await stat(path)).mode&0o777,0o600);
  assert.deepEqual(await readdir(dir),['.env']);
});

test('saving refuses an existing owner and invalid IDs without modifying any file',async t=>{
  available('saveOwnerId');
  const original='TELEGRAM_ALLOWED_USER_IDS="99,100"\n# keep\n';
  const {path}=await workspace(t,original);
  await assert.rejects(saveOwnerId(path,81234567),/уже/);
  assert.equal(await readFile(path,'utf8'),original);
  for(const id of [0,-1,1.5,'81234567',Number.MAX_SAFE_INTEGER+1])await assert.rejects(saveOwnerId(path,id));
  assert.equal(await readFile(path,'utf8'),original);
});

test('saving refuses symlink paths and leaves their target unchanged',async t=>{
  available('saveOwnerId');
  const {dir,path}=await workspace(t,'# target stays untouched\n');
  const link=join(dir,'linked.env');await symlink(path,link);
  await assert.rejects(saveOwnerId(link,81234567));
  assert.equal(await readFile(path,'utf8'),'# target stays untouched\n');
});

test('pairing prints a fresh random deep link and saves only its matching private sender',async t=>{
  available('runPairing');
  const payloads=[];
  for(let i=0;i<2;i++){
    const {path}=await workspace(t),logs=[],errors=[];
    const fetchFn=fixture(logs,async payload=>{
      payloads.push(payload);assert.match(payload,/^[A-Za-z0-9_-]{43}$/);
      return json([update('/start'),update('/start wrong'),update('/start '+payload)]);
    });
    assert.equal(await runPairing({TELEGRAM_BOT_TOKEN:token},{envPath:path,fetchFn,log:x=>logs.push(x),error:x=>errors.push(x)}),0);
    assert.ok(logs.some(x=>x==='https://t.me/play_pulse_fixture_bot?start='+payloads[i]));
    assert.equal(parseEnv(await readFile(path,'utf8')).TELEGRAM_ALLOWED_USER_IDS,'81234567');
    assert.deepEqual(errors,[]);assert.equal(logs.join('\n').includes(token),false);
  }
  assert.notEqual(payloads[0],payloads[1]);
});

test('pairing waits through unrelated starts without advancing the update offset',async t=>{
  available('runPairing');const {path}=await workspace(t),logs=[];let polls=0;
  const fetchFn=fixture(logs,async payload=>json(++polls===1?[update('/start stranger')]:[update('/start stranger'),update('/start '+payload)]));
  assert.equal(await runPairing({TELEGRAM_BOT_TOKEN:token},{envPath:path,fetchFn,log:x=>logs.push(x),error:()=>{},pollDelayMs:0}),0);
  assert.equal(polls,2);assert.equal(parseEnv(await readFile(path,'utf8')).TELEGRAM_ALLOWED_USER_IDS,'81234567');
});

test('an existing owner in the environment or file prevents all Telegram requests',async t=>{
  available('runPairing');
  for(const source of ['environment','file']){
    const text=source==='file'?'TELEGRAM_ALLOWED_USER_IDS=99\n':'# no owner\n';
    const {path}=await workspace(t,text),logs=[];let calls=0;
    const env={TELEGRAM_BOT_TOKEN:token,...(source==='environment'?{TELEGRAM_ALLOWED_USER_IDS:'99'}:{})};
    assert.equal(await runPairing(env,{envPath:path,fetchFn:async()=>{calls++;throw Error('unexpected');},log:x=>logs.push(x),error:()=>{}}),0);
    assert.equal(calls,0);assert.match(logs.join('\n'),/уже/);assert.equal(await readFile(path,'utf8'),text);
  }
});

test('an abort cancels a pending Telegram poll without saving an owner',async t=>{
  available('runPairing');const {path}=await workspace(t),logs=[],errors=[],controller=new AbortController();
  const fetchFn=fixture(logs,async(payload,options)=>{
    queueMicrotask(()=>controller.abort());
    return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Error('raw '+token)),{once:true}));
  });
  assert.equal(await runPairing({TELEGRAM_BOT_TOKEN:token},{envPath:path,fetchFn,signal:controller.signal,log:x=>logs.push(x),error:x=>errors.push(x)}),130);
  assert.equal(parseEnv(await readFile(path,'utf8')).TELEGRAM_ALLOWED_USER_IDS,'');
  assert.equal(errors.join('\n').includes(token),false);
});

test('a pairing deadline cancels the pending poll without saving an owner',async t=>{
  available('runPairing');const {path}=await workspace(t),logs=[],errors=[];
  const fetchFn=fixture(logs,async(payload,options)=>new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Error('raw '+token)),{once:true})));
  assert.equal(await runPairing({TELEGRAM_BOT_TOKEN:token},{envPath:path,fetchFn,timeoutMs:30,log:x=>logs.push(x),error:x=>errors.push(x)}),1);
  assert.equal(parseEnv(await readFile(path,'utf8')).TELEGRAM_ALLOWED_USER_IDS,'');
  assert.match(errors.join('\n'),/время|Время/);assert.equal(errors.join('\n').includes(token),false);
});

test('pairing refuses a full unrelated queue rather than discarding old updates',async t=>{
  available('runPairing');const {path}=await workspace(t),logs=[],errors=[];
  const fetchFn=fixture(logs,async()=>json(Array.from({length:100},(_,i)=>({...update('/start'),update_id:i}))));
  assert.equal(await runPairing({TELEGRAM_BOT_TOKEN:token},{envPath:path,fetchFn,log:x=>logs.push(x),error:x=>errors.push(x)}),1);
  assert.equal(parseEnv(await readFile(path,'utf8')).TELEGRAM_ALLOWED_USER_IDS,'');assert.match(errors.join('\n'),/очеред/i);
});

test('an active webhook is never removed and prevents a pairing link',async t=>{
  available('runPairing');const {path}=await workspace(t),logs=[],errors=[],methods=[];
  const fetchFn=async url=>{const method=new URL(url).pathname.split('/').at(-1);methods.push(method);return json(method==='getMe'?me:{...webhook,url:'https://secret.example/hook'});};
  assert.equal(await runPairing({TELEGRAM_BOT_TOKEN:token},{envPath:path,fetchFn,log:x=>logs.push(x),error:x=>errors.push(x)}),1);
  assert.deepEqual(methods,['getMe','getWebhookInfo']);assert.equal(logs.some(x=>x.startsWith('https://t.me/')),false);
  assert.equal(errors.join('\n').includes('secret.example'),false);
});

test('pairing errors redact raw network details and leave configuration unchanged',async t=>{
  available('runPairing');const {path}=await workspace(t),logs=[],errors=[];
  const fetchFn=fixture(logs,async()=>{throw Error(token+' https://private.example/?secret=fixture');});
  assert.equal(await runPairing({TELEGRAM_BOT_TOKEN:token},{envPath:path,fetchFn,log:x=>logs.push(x),error:x=>errors.push(x)}),1);
  assert.equal(parseEnv(await readFile(path,'utf8')).TELEGRAM_ALLOWED_USER_IDS,'');
  assert.doesNotMatch(errors.join('\n'),/AAAAA|123456789|private.example|secret=fixture/);
});
