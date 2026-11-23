import {randomUUID,timingSafeEqual} from 'node:crypto';
import {parseFeed,screen,allowedChat} from '../bot/core.mjs';
import {formatDigest} from '../bot/presentation.mjs';

const CHECKPOINT='telegram/notifications-v1.json';
const ID=/^[a-z0-9][a-z0-9-]{0,95}$/,OWNER=/^[1-9]\d{0,15}$/;
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,keys)=>record(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const error=(status=503,retryAfter=60)=>Object.assign(Error('Telegram временно недоступен. Проверьте подключение и сохранённое состояние.'),{status,retryAfter});
const response=(status=200,retryAfter)=>Response.json({ok:status===200},{status,headers:{'cache-control':'no-store',...(retryAfter?{'retry-after':String(retryAfter)}:{})}});
const conditional=saved=>saved?{etagMatches:saved.etag}:{etagDoesNotMatch:'*'};
const same=(a,b)=>{
 if(typeof a!=='string'||typeof b!=='string')return false;
 const encoder=new TextEncoder(),provided=encoder.encode(a),expected=encoder.encode(b);
 return provided.byteLength===expected.byteLength&&timingSafeEqual(provided,expected);
};

function settings(env,webhook=false){
 const token=env.TELEGRAM_BOT_TOKEN?.trim(),owners=(env.TELEGRAM_ALLOWED_USER_IDS||'').split(',').map(id=>id.trim());
 if(!/^\d{5,16}:[\w-]{32,100}$/.test(token||'')||!owners.length||owners.length>50||owners.some(id=>!OWNER.test(id)||!Number.isSafeInteger(Number(id)))||new Set(owners).size!==owners.length)throw error();
 if(webhook&&!/^[A-Za-z0-9_-]{32,256}$/.test(env.TELEGRAM_WEBHOOK_SECRET||''))throw error();
 return {token,owners,allowed:new Set(owners)};
}

async function boundedJSON(input,limit){
 if(Number(input.headers.get('content-length')||0)>limit)throw error(413);
 if(!input.body)throw error(400);
 const reader=input.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let size=0,text='';
 try{
  for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit){void reader.cancel().catch(()=>{});throw error(413);}text+=decoder.decode(value,{stream:true});}
  return JSON.parse(text+decoder.decode());
 }catch(failure){if(failure?.status===413)throw failure;throw error(400);}
 finally{reader.releaseLock();}
}

function telegramAPI(token,fetchFn,signal){
 return async(method,args)=>{
  if(!['sendMessage','editMessageText','answerCallbackQuery'].includes(method))throw error();
  try{
   const timeout=AbortSignal.timeout(8000),requestSignal=signal?AbortSignal.any([signal,timeout]):timeout;
   const result=await fetchFn('https://api.telegram.org/bot'+token+'/'+method,{method:'POST',redirect:'manual',headers:{'content-type':'application/json'},body:JSON.stringify(args),signal:requestSignal});
   if(result.redirected||result.status>=300&&result.status<400)throw error();
   const data=await boundedJSON(result,64*1024),status=!result.ok?result.status:data?.ok===false?Number(data.error_code)||502:0;
   if(status===400&&method==='editMessageText')return /message is not modified/i.test(data?.description||'')?{notEdited:true}:{editUnavailable:true};
   if(status){const retry=Number.isSafeInteger(data?.parameters?.retry_after)&&data.parameters.retry_after>0?Math.min(86400,data.parameters.retry_after):60;throw error(status,retry);}
   if(data?.ok!==true)throw error();
   if(method==='answerCallbackQuery'){if(data.result!==true)throw error();}
   else if(!(method==='editMessageText'&&data.result===true)&&(!Number.isSafeInteger(data.result?.message_id)||data.result.message_id<1))throw error();
   return {result:data.result};
  }catch(failure){throw error(Number.isInteger(failure?.status)?failure.status:503,Number.isInteger(failure?.retryAfter)?failure.retryAfter:60);}
 };
}

function validLease(value){
 return value===null||exact(value,['token','until'])&&typeof value.token==='string'&&/^[0-9a-f-]{36}$/.test(value.token)&&Number.isSafeInteger(value.until)&&value.until>=0;
}
function updateState(value,id,owner){
 if(!exact(value,['version','updateId','ownerId','completed','lease'])||value.version!==1||value.updateId!==id||value.ownerId!==owner||typeof value.completed!=='boolean'||!validLease(value.lease))throw error();
 return value;
}
async function claimUpdate(bucket,key,id,owner,instant){
 for(let attempt=0;attempt<4;attempt++){
  const saved=await bucket.get(key),state=saved?updateState(await saved.json(),id,owner):{version:1,updateId:id,ownerId:owner,completed:false,lease:null};
  if(state.completed)return {completed:true};
  if(state.lease?.until>instant)return null;
  state.lease={token:randomUUID(),until:instant+60000};
  const written=await bucket.put(key,JSON.stringify(state),{onlyIf:conditional(saved)});
  if(written)return {state,etag:written.etag};
 }
 return null;
}
async function finishUpdate(bucket,key,claim){
 for(let attempt=0;attempt<4;attempt++){
  const saved=attempt?await bucket.get(key):{etag:claim.etag,json:async()=>claim.state};
  if(!saved)throw error();
  const state=updateState(await saved.json(),claim.state.updateId,claim.state.ownerId);
  if(state.completed)return;
  if(state.lease?.token!==claim.state.lease.token)throw error();
  const next={...state,completed:true,lease:null};
  try{if(await bucket.put(key,JSON.stringify(next),{onlyIf:conditional(saved)}))return;}catch{}
 }
 throw error();
}
async function releaseUpdate(bucket,key,claim,until){
 try{
  const saved=await bucket.get(key);if(!saved)return;
  const state=updateState(await saved.json(),claim.state.updateId,claim.state.ownerId);
  if(state.completed||state.lease?.token!==claim.state.lease.token)return;
  state.lease.until=until;await bucket.put(key,JSON.stringify(state),{onlyIf:conditional(saved)});
 }catch{}
}

export async function processTelegramUpdate(request,{env,bucket,getFeed,siteURL,fetchFn=fetch,now=Date.now}){
 if(request.method!=='POST')return response(405);
 let claim,key,confirmedReply=false;
 try{
  const cfg=settings(env,true);
  if(!same(request.headers.get('x-telegram-bot-api-secret-token'),env.TELEGRAM_WEBHOOK_SECRET))return response(403);
  if(!/^application\/json(?:\s*;|\s*$)/i.test(request.headers.get('content-type')||''))return response(415);
  const update=await boundedJSON(request,128*1024);
  if(!Number.isSafeInteger(update?.update_id)||update.update_id<0)return response(400);
  const chat=allowedChat(update,cfg.allowed),actor=update?.callback_query?.from||update?.message?.from;
  if(!chat||actor?.is_bot===true)return response();
  const command=/^\/(start|news|menu)(?:@[a-zA-Z0-9_]+)?(?:\s|$)/.exec(typeof update.message?.text==='string'?update.message.text:'');
  if(!chat.cb&&!command)return response();
  if(chat.cb&&(typeof chat.cb.id!=='string'||!chat.cb.id||chat.cb.id.length>256||!Number.isSafeInteger(chat.msg.message_id)||chat.msg.message_id<1))return response(400);
  const action=(typeof chat.cb?.data==='string'?Array.from(chat.cb.data).slice(0,64).join(''):command?.[1]==='news'?'list:all:0':'home').normalize('NFKC');
  key='telegram/update-'+update.update_id+'-v1.json';claim=await claimUpdate(bucket,key,update.update_id,String(chat.id),now());
  if(!claim)return response(503,60);if(claim.completed)return response();
  const api=telegramAPI(cfg.token,fetchFn,request.signal);
  if(chat.cb){try{await api('answerCallbackQuery',{callback_query_id:chat.cb.id});}catch(failure){if(failure.status!==400)throw failure;}}
  let view;
  try{const items=action.startsWith('list:')||action.startsWith('item:')?parseFeed(await getFeed()):[];view=screen(items,action,siteURL);}
  catch{view={text:'Не удалось загрузить новости. Попробуйте ещё раз или откройте сайт.',keyboard:[[{text:'Повторить',callback_data:'list:all:0'}],[{text:'🌐 Открыть Play Pulse',url:siteURL}],[{text:'⌂ Главное меню',callback_data:'home'}]]};}
  const args={chat_id:chat.id,text:view.text,parse_mode:'HTML',link_preview_options:{is_disabled:true},reply_markup:{inline_keyboard:view.keyboard}};
  if(chat.cb){const edited=await api('editMessageText',{...args,message_id:chat.msg.message_id});if(edited.editUnavailable)await api('sendMessage',{...args,protect_content:true});}
  else await api('sendMessage',{...args,protect_content:true});
  confirmedReply=true;await finishUpdate(bucket,key,claim);return response();
 }catch(failure){
  const retry=Number.isInteger(failure?.retryAfter)?failure.retryAfter:60;
  if(claim&&!claim.completed&&!confirmedReply)await releaseUpdate(bucket,key,claim,now()+retry*1000);
  return response([400,413].includes(failure?.status)?failure.status:503,retry);
 }
}

function validateCheckpoint(value){
 if(!exact(value,['version','owners'])||value.version!==1||!record(value.owners))throw error();
 for(const [id,owner] of Object.entries(value.owners))if(!OWNER.test(id)||!Number.isSafeInteger(Number(id))||!exact(owner,['baselineAt','seenIds'])||typeof owner.baselineAt!=='string'||!Number.isFinite(Date.parse(owner.baselineAt))||!Array.isArray(owner.seenIds)||owner.seenIds.some(id=>typeof id!=='string'||!ID.test(id))||new Set(owner.seenIds).size!==owner.seenIds.length)throw error();
 return value;
}
async function readCheckpoint(bucket){const saved=await bucket.get(CHECKPOINT);return {saved,state:saved?validateCheckpoint(await saved.json()):{version:1,owners:{}}};}
async function changeCheckpoint(bucket,change){
 for(let attempt=0;attempt<4;attempt++){
  const {saved,state}=await readCheckpoint(bucket),count=change(state);
  if(!count)return {state,count:0};
  try{if(await bucket.put(CHECKPOINT,JSON.stringify(state),{onlyIf:conditional(saved)}))return {state,count};}catch{}
 }
 throw error();
}
async function claimOwner(bucket,key,instant){
 for(let attempt=0;attempt<4;attempt++){
  const saved=await bucket.get(key),prior=saved?await saved.json():null;
  if(prior&&(!exact(prior,['version','lease'])||prior.version!==1||!validLease(prior.lease)))throw error();
  if(prior?.lease?.until>instant)return null;
  const state={version:1,lease:{token:randomUUID(),until:instant+60000}},written=await bucket.put(key,JSON.stringify(state),{onlyIf:conditional(saved)});
  if(written)return {state,etag:written.etag};
 }
 return null;
}
async function renewOwner(bucket,key,claim,instant){
 claim.state.lease.until=instant+60000;
 const written=await bucket.put(key,JSON.stringify(claim.state),{onlyIf:{etagMatches:claim.etag}});if(!written)throw error();claim.etag=written.etag;
}
async function releaseOwner(bucket,key,claim,until){
 claim.state.lease.until=until;
 if(!await bucket.put(key,JSON.stringify(claim.state),{onlyIf:{etagMatches:claim.etag}}))throw error();
}

export async function deliverFreshNews({env,bucket,getFeed,siteURL,fetchFn=fetch,now=Date.now}){
 const stats={initializedOwners:0,sentMessages:0,sentArticles:0};
 if(env.PLAY_PULSE_NOTIFICATIONS_ENABLED==='0'||env.PLAY_PULSE_NOTIFICATIONS_ENABLED===undefined)return stats;
 try{
  if(env.PLAY_PULSE_NOTIFICATIONS_ENABLED!=='1')throw error();
  const cfg=settings(env),items=parseFeed(await getFeed()),ids=items.map(item=>item.id),instant=now(),date=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Kyiv',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(instant));
  const initialized=await changeCheckpoint(bucket,state=>{
   let count=0;for(const id of cfg.owners)if(!Object.hasOwn(state.owners,id)){state.owners[id]={baselineAt:new Date(instant).toISOString(),seenIds:[...ids]};count++;}return count;
  });
  stats.initializedOwners=initialized.count;let failed,checks=0;
  // Rotate a bounded owner window so blocked or busy owners cannot exhaust the
  // free Worker's subrequest allowance or permanently starve later owners.
  const start=Math.floor(instant/60000)*3%cfg.owners.length,owners=[...cfg.owners.slice(start),...cfg.owners.slice(0,start)];
  for(const id of owners){
   if(stats.sentMessages>=3||checks>=3)break;
   const known=new Set(initialized.state.owners[id].seenIds);if(!items.some(item=>!known.has(item.id)))continue;
   checks++;const leaseKey='telegram/notification-lease-'+id+'-v1.json',claim=await claimOwner(bucket,leaseKey,now());if(!claim)continue;
   let until=0;
   try{
    const {state}=await readCheckpoint(bucket),owner=state.owners[id];if(!owner)throw error();
    const seen=new Set(owner.seenIds),fresh=items.filter(item=>!seen.has(item.id)).slice(0,15),chunks=formatDigest(fresh,{siteURL,date});
    const api=telegramAPI(cfg.token,fetchFn);
    for(const {ids:sentIds,payload} of chunks){
     if(stats.sentMessages>=3)break;
     await renewOwner(bucket,leaseKey,claim,now());await api('sendMessage',{...payload,chat_id:Number(id)});
     await changeCheckpoint(bucket,current=>{
      const saved=current.owners[id];if(!saved)throw error();const prior=new Set(saved.seenIds),newIds=sentIds.filter(key=>!prior.has(key));saved.seenIds.push(...newIds);return newIds.length;
     });
     stats.sentMessages++;stats.sentArticles+=sentIds.length;
    }
   }catch(failure){until=now()+(failure?.status===403?3600000:(failure?.retryAfter||60)*1000);failed??=failure;}
   finally{await releaseOwner(bucket,leaseKey,claim,until);}
  }
  if(failed)throw failed;return stats;
 }catch(failure){throw error(Number.isInteger(failure?.status)?failure.status:503,Number.isInteger(failure?.retryAfter)?failure.retryAfter:60);}
}
