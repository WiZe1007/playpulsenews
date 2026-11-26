import {randomUUID,timingSafeEqual,createHash} from 'node:crypto';
import {parseFeed,screen,allowedChat,articleForAction} from '../bot/core.mjs';
import {formatDigest} from '../bot/presentation.mjs';
import {resolveArticleMedia,channelMediaMessage,editorialChannelPost} from './media.mjs';
import {prepareCover} from './editorial-media.mjs';

const CHECKPOINT='telegram/notifications-v1.json';
const CHANNEL_CHECKPOINT='telegram/channel-notifications-v1.json';
const ID=/^[a-z0-9][a-z0-9-]{0,95}$/,OWNER=/^[1-9]\d{0,15}$/;
const CHANNEL=/^-100\d{1,12}$/;
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

function destinations(env){
 const channel=env.TELEGRAM_CHANNEL_ID?.trim()||null;
 const owners=env.TELEGRAM_OWNER_NOTIFICATIONS_ENABLED??(channel?'0':'1'),backfill=env.TELEGRAM_CHANNEL_BACKFILL??'0';
 if(channel&&(!CHANNEL.test(channel)||!Number.isSafeInteger(Number(channel)))||!['0','1'].includes(owners)||!['0','1'].includes(backfill))throw error();
 return {channel,owners:owners==='1',backfill:backfill==='1'};
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
  if(!['sendMessage','sendPhoto','sendVideo','editMessageText','answerCallbackQuery','getMe','getChat','getChatMember'].includes(method))throw error();
  try{
   const timeout=AbortSignal.timeout(8000),requestSignal=signal?AbortSignal.any([signal,timeout]):timeout;
   const result=await fetchFn('https://api.telegram.org/bot'+token+'/'+method,{method:'POST',redirect:'manual',headers:{'content-type':'application/json'},body:JSON.stringify(args),signal:requestSignal});
   if(result.redirected||result.status>=300&&result.status<400)throw error();
   const data=await boundedJSON(result,64*1024),status=!result.ok?result.status:data?.ok===false?Number(data.error_code)||502:0;
   if(status===400&&method==='editMessageText')return /message is not modified/i.test(data?.description||'')?{notEdited:true}:{editUnavailable:true};
   if(status){
    const retry=Number.isSafeInteger(data?.parameters?.retry_after)&&data.parameters.retry_after>0?Math.min(86400,data.parameters.retry_after):60,failure=error(status,retry);
    if(status===400&&data?.ok===false&&Number(data.error_code)===400&&['sendPhoto','sendVideo'].includes(method))failure.mediaRejected=true;
    throw failure;
   }
   if(data?.ok!==true)throw error();
   if(['getMe','getChat','getChatMember'].includes(method))return {result:data.result};
   if(method==='answerCallbackQuery'){if(data.result!==true)throw error();}
   else if(!(method==='editMessageText'&&data.result===true)&&(!Number.isSafeInteger(data.result?.message_id)||data.result.message_id<1))throw error();
   return {result:data.result};
  }catch(failure){
   const sanitized=error(Number.isInteger(failure?.status)?failure.status:503,Number.isInteger(failure?.retryAfter)?failure.retryAfter:60);
   if(failure?.mediaRejected===true)sanitized.mediaRejected=true;
   throw sanitized;
  }
 };
}

export async function verifyChannelAccess({env,fetchFn=fetch,signal}){
 const cfg=settings(env),{channel}=destinations(env);if(!channel)throw error();
 const api=telegramAPI(cfg.token,fetchFn,signal),me=(await api('getMe',{})).result;
 if(!Number.isSafeInteger(me?.id)||me.id<=0||me.is_bot!==true)throw error(403);
 const chat=(await api('getChat',{chat_id:Number(channel)})).result;
 if(chat?.id!==Number(channel)||chat.type!=='channel'||typeof chat.title!=='string'||!chat.title.trim())throw error(403);
 const member=(await api('getChatMember',{chat_id:Number(channel),user_id:me.id})).result;
 if(member?.user?.id!==me.id||member.user.is_bot!==true||
   !(member.status==='creator'||member.status==='administrator'&&member.can_post_messages===true))throw error(403);
 return {id:channel,title:chat.title};
}

function progressState(value,spec){
 if(!exact(value,['version','articleId','fingerprint','parts','nextPart'])||value.version!==1||value.articleId!==spec.articleId||
   typeof value.fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(value.fingerprint)||!Number.isSafeInteger(value.parts)||value.parts<1||
   !Number.isSafeInteger(value.nextPart)||value.nextPart<1||value.nextPart>value.parts+1)throw error();
 return value;
}
const progressSpec=chunks=>({version:1,articleId:chunks[0].articleId,
 fingerprint:createHash('sha256').update(JSON.stringify(chunks.map(chunk=>chunk.payload))).digest('hex'),parts:chunks.length,nextPart:1});
async function prepareProgress(bucket,key,spec){
 for(let attempt=0;attempt<4;attempt++){
  const saved=await bucket.get(key),prior=saved?progressState(await saved.json(),spec):null;
  if(prior?.fingerprint===spec.fingerprint){if(prior.parts!==spec.parts)throw error();return prior;}
  try{if(await bucket.put(key,JSON.stringify(spec),{onlyIf:conditional(saved)}))return {...spec};}catch{}
 }
 throw error();
}
async function advanceProgress(bucket,key,spec,nextPart){
 for(let attempt=0;attempt<4;attempt++){
  const saved=await bucket.get(key);if(!saved)throw error();
  const state=progressState(await saved.json(),spec);
  if(state.fingerprint!==spec.fingerprint||state.parts!==spec.parts)throw error();
  if(state.nextPart>=nextPart)return state;
  state.nextPart=nextPart;
  try{if(await bucket.put(key,JSON.stringify(state),{onlyIf:conditional(saved)}))return state;}catch{}
 }
 throw error();
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
  let view,selected;
  try{const items=action.startsWith('list:')||action.startsWith('item:')?parseFeed(await getFeed()):[];selected=articleForAction(items,action);view=screen(items,action,siteURL);}
  catch{view={text:'Не удалось загрузить новости. Попробуйте ещё раз или откройте сайт.',keyboard:[[{text:'Повторить',callback_data:'list:all:0'}],[{text:'🌐 Открыть Play Pulse',url:siteURL}],[{text:'⌂ Главное меню',callback_data:'home'}]]};}
  if(selected){
   const chunks=formatDigest([selected],{siteURL}).map(chunk=>({...chunk,payload:{...chunk.payload,reply_markup:{inline_keyboard:view.keyboard}}}));
   const spec=progressSpec(chunks),progressKey='telegram/update-progress-'+update.update_id+'-v1.json';
   const progress=await prepareProgress(bucket,progressKey,spec);
   for(const chunk of chunks.slice(progress.nextPart-1)){
    const args={...chunk.payload,chat_id:chat.id};
    if(chat.cb&&chunk.part===1){
     const {protect_content,...editable}=args;
     const edited=await api('editMessageText',{...editable,message_id:chat.msg.message_id});
     if(edited.editUnavailable)await api('sendMessage',{...args,protect_content:true});
    }else await api('sendMessage',{...args,protect_content:true});
    await advanceProgress(bucket,progressKey,spec,chunk.part+1);
   }
   confirmedReply=true;await finishUpdate(bucket,key,claim);return response();
  }
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

function validateCheckpoint(value,collection='owners'){
 if(!exact(value,['version',collection])||value.version!==1||!record(value[collection]))throw error();
 for(const [id,owner] of Object.entries(value[collection]))if(!(collection==='channels'?CHANNEL:OWNER).test(id)||!Number.isSafeInteger(Number(id))||!exact(owner,['baselineAt','seenIds'])||typeof owner.baselineAt!=='string'||!Number.isFinite(Date.parse(owner.baselineAt))||!Array.isArray(owner.seenIds)||owner.seenIds.some(id=>typeof id!=='string'||!ID.test(id))||new Set(owner.seenIds).size!==owner.seenIds.length)throw error();
 return value;
}
const checkpointKey=collection=>collection==='channels'?CHANNEL_CHECKPOINT:CHECKPOINT;
async function readCheckpoint(bucket,collection='owners'){const saved=await bucket.get(checkpointKey(collection));return {saved,state:saved?validateCheckpoint(await saved.json(),collection):{version:1,[collection]:{}}};}
async function changeCheckpoint(bucket,change,collection='owners'){
 for(let attempt=0;attempt<4;attempt++){
  const {saved,state}=await readCheckpoint(bucket,collection),count=change(state);
  if(!count)return {state,count:0};
  try{if(await bucket.put(checkpointKey(collection),JSON.stringify(state),{onlyIf:conditional(saved)}))return {state,count};}catch{}
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

export async function deliverFreshNews({env,bucket,getFeed,siteURL,fetchFn=fetch,now=Date.now,signal}){
 const stats={initializedOwners:0,sentMessages:0,sentArticles:0};
 if(env.PLAY_PULSE_NOTIFICATIONS_ENABLED==='0'||env.PLAY_PULSE_NOTIFICATIONS_ENABLED===undefined)return stats;
 try{
  if(env.PLAY_PULSE_NOTIFICATIONS_ENABLED!=='1')throw error();
  const cfg=settings(env),targets=destinations(env),items=parseFeed(await getFeed()),ids=items.map(item=>item.id),instant=now();
  const groups=[],candidates=[];let failed,checks=0,channelVerified=false;
  if(targets.owners)groups.push({collection:'owners',ids:cfg.owners});
  if(targets.channel){groups.push({collection:'channels',ids:[targets.channel]});stats.initializedChannels=0;}
  for(const group of groups){
   try{
    if(group.collection==='channels'){
     const current=await readCheckpoint(bucket,'channels');
     if(!Object.hasOwn(current.state.channels,targets.channel)){await verifyChannelAccess({env,fetchFn});channelVerified=true;}
    }
    const initialized=await changeCheckpoint(bucket,state=>{
     let count=0;for(const id of group.ids)if(!Object.hasOwn(state[group.collection],id)){
      state[group.collection][id]={baselineAt:new Date(instant).toISOString(),seenIds:group.collection==='channels'&&targets.backfill?[]:[...ids]};count++;
     }return count;
    },group.collection);
    if(group.collection==='owners')stats.initializedOwners=initialized.count;else stats.initializedChannels=initialized.count;
    for(const id of group.ids)candidates.push({id,collection:group.collection,state:initialized.state});
   }catch(failure){failed??=failure;}
  }
  // Bound work and rotate destinations; channel traffic cannot widen private access.
  const start=candidates.length?Math.floor(instant/60000)%candidates.length:0;
  const ordered=[...candidates.slice(start),...candidates.slice(0,start)];
  for(const {id,collection,state:initial} of ordered){
   if(stats.sentMessages>=3||checks>=3)break;
   const known=new Set(initial[collection][id].seenIds);if(!items.some(item=>!known.has(item.id)))continue;
   checks++;const leaseKey='telegram/'+(collection==='channels'?'channel-':'')+'notification-lease-'+id+'-v1.json',claim=await claimOwner(bucket,leaseKey,now());if(!claim)continue;
   let until=0;
   try{
    if(collection==='channels'&&!channelVerified){await verifyChannelAccess({env,fetchFn});channelVerified=true;}
    const {state}=await readCheckpoint(bucket,collection),owner=state[collection][id];if(!owner)throw error();
    const seen=new Set(owner.seenIds),pending=items.filter(item=>!seen.has(item.id));
    if(collection==='channels')pending.sort((a,b)=>a.date.localeCompare(b.date)||a.id.localeCompare(b.id));
    const fresh=pending.slice(0,15);
    const api=telegramAPI(cfg.token,fetchFn,signal);
    for(const item of fresh){
     if(stats.sentMessages>=3)break;
     const chunks=formatDigest([item],{siteURL,destination:collection==='channels'?'channel':'private'}),spec=progressSpec(chunks);
     const progressKey='telegram/notification-progress-'+collection+'-'+id+'-'+item.id+'-v1.json';
     const progress=await prepareProgress(bucket,progressKey,spec),remaining=chunks.length-progress.nextPart+1;
     if(remaining>3-stats.sentMessages)break;
     for(const chunk of chunks.slice(progress.nextPart-1)){
      const firstChannelPart=collection==='channels'&&chunk.part===1;
      const media=firstChannelPart?await resolveArticleMedia(item,{fetchFn,signal}):null;
      const hosted=firstChannelPart&&env.PLAY_PULSE_PUBLIC_ORIGIN;
      const original=media&&(!hosted||media.type==='video')?channelMediaMessage(chunk.payload,media):null;
      const makeCover=async()=>{
       if(!hosted)return null;
       const {url,label}=await prepareCover(item,env,{media,fetchFn});
       return editorialChannelPost(chunk.payload,url,label);
      };
      const cover=original?null:await makeCover();
      const message=original||cover?.photo;
      await renewOwner(bucket,leaseKey,claim,now());
      if(message){
       try{await api(message.method,{...message.payload,chat_id:Number(id)});}
       catch(failure){
        // A timeout may mean the attachment was published. Only retry a definitive rejection.
        if(failure?.mediaRejected!==true)throw failure;
        const backup=cover||await makeCover();
        await api('sendMessage',{...(backup?.fallback||chunk.payload),chat_id:Number(id)});
       }
      }else{
       const text=cover?.fallback||(media?{...chunk.payload,link_preview_options:{url:media.sourceUrl,prefer_large_media:true,show_above_text:true}}:chunk.payload);
       await api('sendMessage',{...text,chat_id:Number(id)});
      }
      await advanceProgress(bucket,progressKey,spec,chunk.part+1);stats.sentMessages++;
     }
     await changeCheckpoint(bucket,current=>{
      const saved=current[collection][id];if(!saved)throw error();if(saved.seenIds.includes(item.id))return 0;saved.seenIds.push(item.id);return 1;
     },collection);
     stats.sentArticles++;
    }
   }catch(failure){until=now()+(failure?.status===403&&collection==='owners'?3600000:(failure?.retryAfter||60)*1000);failed??=failure;}
   finally{await releaseOwner(bucket,leaseKey,claim,until);}
  }
  if(failed)throw failed;return stats;
 }catch(failure){throw error(Number.isInteger(failure?.status)?failure.status:503,Number.isInteger(failure?.retryAfter)?failure.retryAfter:60);}
}
