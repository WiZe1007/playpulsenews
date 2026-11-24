import {constants} from 'node:fs';
import {mkdir,open,rename,unlink,rmdir,readdir,lstat,writeFile,readFile} from 'node:fs/promises';
import {dirname,basename,join,resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {formatDigest} from './presentation.mjs';

const ID=/^[a-z0-9][a-z0-9-]{0,95}$/;
const OWNER=/^[1-9]\d{0,15}$/;
const PROCESS_IDENTITY=/^linux:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:\d{1,20}$/;
const messages={
  CONFIG_INVALID:'Проверьте параметры доставки новостей.',
  BUSY:'Проверка доставки уже выполняется.',
  LOCKED:'Доставку уже выполняет другой процесс или состояние заблокировано.',
  STATE_INVALID:'Состояние доставки повреждено или недоступно. Автоматический сброс запрещён.',
  STATE_WRITE_FAILED:'Не удалось сохранить состояние доставки. Новые отправки отложены.',
  FEED_UNAVAILABLE:'Не удалось получить ленту для доставки.',
  FORMAT_FAILED:'Не удалось подготовить сообщения с новостями.',
  SEND_FAILED:'Telegram не подтвердил доставку новостей.'
};
export class NotificationError extends Error {
  constructor(code,{status,fatal=false,retryable=true}={}){
    super(messages[code]);this.name='NotificationError';this.code=code;
    this.fatal=fatal===true;this.retryable=retryable!==false;
    if(Number.isInteger(status)&&status>=100&&status<=599)this.status=status;
  }
}
const record=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const keysAre=(value,names)=>record(value)&&Object.keys(value).length===names.length&&names.every(key=>Object.hasOwn(value,key));
const validOwner=id=>OWNER.test(id)&&Number.isSafeInteger(Number(id));
export function validateNotificationState(state){
  if(!keysAre(state,['version','owners'])||state.version!==1||!record(state.owners))throw new NotificationError('STATE_INVALID');
  for(const [id,owner] of Object.entries(state.owners)){
    if(!validOwner(id)||!keysAre(owner,['baselineAt','seenIds'])||typeof owner.baselineAt!=='string'||
      !Number.isFinite(Date.parse(owner.baselineAt))||!Array.isArray(owner.seenIds)||
      owner.seenIds.some(value=>typeof value!=='string'||!ID.test(value))||new Set(owner.seenIds).size!==owner.seenIds.length)
      throw new NotificationError('STATE_INVALID');
  }
  return state;
}
function validateProgressState(state){
  if(!keysAre(state,['version','owners'])||state.version!==1||!record(state.owners))throw new NotificationError('STATE_INVALID');
  for(const [id,progress] of Object.entries(state.owners)){
    if(!validOwner(id)||!keysAre(progress,['articleId','fingerprint','nextPart','parts'])||typeof progress.articleId!=='string'||!ID.test(progress.articleId)||
      typeof progress.fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(progress.fingerprint)||!Number.isInteger(progress.parts)||progress.parts<1||progress.parts>1000||
      !Number.isInteger(progress.nextPart)||progress.nextPart<1||progress.nextPart>progress.parts+1)throw new NotificationError('STATE_INVALID');
  }
  return state;
}
async function readState(path,allowMissing,validate=validateNotificationState){
  let file;
  try{
    file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
    const info=await file.stat();
    if(!info.isFile()||info.size>16*1024*1024)throw new NotificationError('STATE_INVALID');
    const state=validate(JSON.parse(await file.readFile('utf8')));
    await file.chmod(0o600);
    return {state,present:true};
  }catch(error){
    if(!file&&error.code==='ENOENT'&&allowMissing)return {state:{version:1,owners:{}},present:false};
    throw new NotificationError('STATE_INVALID',{retryable:false});
  }finally{await file?.close();}
}
async function writeState(path,state){
  const temporary=join(dirname(path),'.'+basename(path)+'.'+randomUUID()+'.tmp');
  let file;
  try{
    file=await open(temporary,'wx',0o600);
    await file.writeFile(JSON.stringify(state)+'\n');await file.sync();
    await file.close();file=undefined;
    await rename(temporary,path);
  }catch{
    throw new NotificationError('STATE_WRITE_FAILED');
  }finally{
    await file?.close().catch(()=>{});
    await unlink(temporary).catch(()=>{});
  }
}

export async function readProcessIdentity(pid,{platform=process.platform,procRoot='/proc'}={}){
  if(platform!=='linux'||!Number.isSafeInteger(pid)||pid<1)return null;
  try{
    const [boot,stat]=await Promise.all([
      readFile(join(procRoot,'sys/kernel/random/boot_id'),'utf8'),
      readFile(join(procRoot,String(pid),'stat'),'utf8')
    ]);
    // comm (field 2) may itself contain spaces and parentheses. Field 22 is
    // starttime; preserve its integer text rather than losing precision.
    const opening=stat.indexOf('('),closing=stat.lastIndexOf(')');
    if(opening<1||closing<=opening||stat.slice(0,opening).trim()!==String(pid))return null;
    const start=stat.slice(closing+1).trim().split(/\s+/)[19];
    const identity='linux:'+boot.trim().toLowerCase()+':'+start;
    return PROCESS_IDENTITY.test(identity)?identity:null;
  }catch{return null;}
}

async function lockIdentity(path){
  let file;
  try{
    file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
    const info=await file.stat();
    if(!info.isFile()||info.size>512)return null;
    const record=JSON.parse(await file.readFile('utf8'));
    return record?.version===1&&PROCESS_IDENTITY.test(record.identity)?record.identity:null;
  }catch{return null;}
  finally{await file?.close();}
}

// Unique marker names and inode verification prevent an old stale-lock
// reclaimer from removing a newly acquired live lock. Never delete recursively.
async function acquireLock(path,getProcessIdentity){
  const identify=async pid=>{
    try{
      const identity=await getProcessIdentity(pid);
      return typeof identity==='string'&&PROCESS_IDENTITY.test(identity)?identity:null;
    }catch{return null;}
  };
  const identity=await identify(process.pid);
  const marker='owner-'+process.pid+'-'+randomUUID();
  const ownPath=join(path,marker);
  const release=async()=>{
    await unlink(ownPath).catch(()=>{});
    await rmdir(path).catch(()=>{});
  };
  for(let attempt=0;attempt<5;attempt++){
    try{
      await mkdir(path,{mode:0o700});
      const original=await lstat(path);
      try{
        await writeFile(ownPath,JSON.stringify({version:1,identity}),{flag:'wx',mode:0o600});
        const current=await lstat(path),entries=await readdir(path);
        if(current.ino!==original.ino||current.dev!==original.dev||entries.length!==1||entries[0]!==marker)
          throw new NotificationError('LOCKED');
        return release;
      }catch{
        await release();throw new NotificationError('LOCKED');
      }
    }catch(error){
      if(error.code!=='EEXIST')throw new NotificationError('LOCKED');
    }
    try{
      if(!(await lstat(path)).isDirectory())throw new NotificationError('LOCKED');
      const entries=await readdir(path);
      if(entries.length===0){await rmdir(path);continue;}
      const match=entries.length===1&&/^owner-([1-9]\d*)-[0-9a-f-]{36}$/.exec(entries[0]);
      if(!match)throw new NotificationError('LOCKED');
      let dead=false;
      try{process.kill(Number(match[1]),0);}catch(error){dead=error.code==='ESRCH';}
      if(!dead){
        const recorded=await lockIdentity(join(path,entries[0]));
        const current=recorded?await identify(Number(match[1])):null;
        // A container restart can reuse PID 1. A changed boot/start identity
        // proves the marker belongs to an earlier process, despite a live PID.
        dead=Boolean(recorded&&current&&recorded!==current);
      }
      if(!dead)throw new NotificationError('LOCKED');
      await unlink(join(path,entries[0]));await rmdir(path);
    }catch(error){
      if(!['ENOENT','ENOTEMPTY'].includes(error.code))throw new NotificationError('LOCKED');
    }
  }
  throw new NotificationError('LOCKED');
}

export function createNotifier({getFeed,api,allowed,siteURL,statePath,signal,now=()=>new Date(),getProcessIdentity=readProcessIdentity}){
  const owners=Array.from(allowed||[],String);
  if(typeof getFeed!=='function'||typeof api!=='function'||typeof statePath!=='string'||!statePath||
    !owners.length||owners.some(id=>!validOwner(id))||new Set(owners).size!==owners.length||typeof getProcessIdentity!=='function')
    throw new NotificationError('CONFIG_INVALID',{retryable:false});
  const path=resolve(statePath),lockPath=path+'.lock',progressPath=path+'.progress.json';
  let busy=false,pendingState,pendingProgress,established=false,progressEstablished=false;
  const checkAbort=()=>{if(signal?.aborted)throw new DOMException('Операция отменена.','AbortError');};
  const commit=async state=>{
    // If the disk fails after Telegram confirms a send, retry this checkpoint
    // before any further delivery in this process.
    pendingState=state;await writeState(path,state);pendingState=undefined;established=true;
  };
  const commitProgress=async state=>{
    pendingProgress=state;await writeState(progressPath,state);pendingProgress=undefined;progressEstablished=true;
  };
  async function run(deliver){
    if(busy)throw new NotificationError('BUSY');
    busy=true;let release;
    try{
      checkAbort();
      try{await mkdir(dirname(path),{recursive:true,mode:0o700});}
      catch{throw new NotificationError('STATE_WRITE_FAILED');}
      release=await acquireLock(lockPath,getProcessIdentity);
      const loaded=await readState(path,!established||Boolean(pendingState));
      const state=loaded.state;
      if(loaded.present)established=true;
      if(pendingState){
        // Another process may have advanced the durable state since our disk
        // failure. Preserve its progress while recovering confirmed sends.
        for(const [id,pending] of Object.entries(pendingState.owners)){
          const current=state.owners[id];
          state.owners[id]=current?{...current,seenIds:[...new Set([...current.seenIds,...pending.seenIds])]}:pending;
        }
        await commit(state);
      }
      const loadedProgress=await readState(progressPath,!progressEstablished||Boolean(pendingProgress),validateProgressState),progress=loadedProgress.state;
      if(loadedProgress.present)progressEstablished=true;
      let progressChanged=false;
      if(pendingProgress){
        for(const [id,pending] of Object.entries(pendingProgress.owners)){
          if(state.owners[id]?.seenIds.includes(pending.articleId))continue;
          const current=progress.owners[id];
          if(!current)progress.owners[id]=pending;
          else if(current.articleId===pending.articleId&&current.fingerprint===pending.fingerprint)current.nextPart=Math.max(current.nextPart,pending.nextPart);
        }
        progressChanged=true;
      }
      for(const [id,current] of Object.entries(progress.owners))if(state.owners[id]?.seenIds.includes(current.articleId)){delete progress.owners[id];progressChanged=true;}
      if(progressChanged)await commitProgress(progress);
      let items;
      try{
        items=await getFeed();
        if(!Array.isArray(items)||items.length>3000||items.some(item=>!item||typeof item.id!=='string'||!ID.test(item.id)))throw Error();
      }catch{checkAbort();throw new NotificationError('FEED_UNAVAILABLE');}
      checkAbort();
      const instant=new Date(now());
      if(!Number.isFinite(instant.getTime()))throw new NotificationError('CONFIG_INVALID',{retryable:false});
      const date=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Kyiv',year:'numeric',month:'2-digit',day:'2-digit'}).format(instant);
      const ids=[...new Set(items.map(item=>item.id))];
      const stats={initializedOwners:0,sentMessages:0,sentArticles:0};
      let ownerError;
      for(const id of owners){
        if(!Object.hasOwn(state.owners,id)){
          state.owners[id]={baselineAt:instant.toISOString(),seenIds:[...ids]};
          stats.initializedOwners++;
        }
      }
      if(stats.initializedOwners)await commit(state);
      if(!deliver)return stats;
      ownerLoop:for(const id of owners){
        const owner=state.owners[id],seen=new Set(owner.seenIds);
        const fresh=items.filter(item=>!seen.has(item.id));
        if(!fresh.length)continue;
        let chunks,groups;
        try{
          chunks=formatDigest(fresh,{siteURL,date});
          const formatted=chunks.flatMap(chunk=>chunk.ids);
          if(!chunks.length||chunks.some(chunk=>typeof chunk.payload?.text!=='string')||
            new Set(formatted).size!==formatted.length||formatted.length!==fresh.length||formatted.some(item=>!fresh.some(news=>news.id===item)))throw Error();
          groups=[...Map.groupBy(chunks,chunk=>chunk.articleId).entries()];
          if(groups.some(([articleId,parts])=>!ID.test(articleId)||parts.some((chunk,index)=>chunk.part!==index+1||chunk.parts!==parts.length||chunk.ids.length!==(index===parts.length-1?1:0)||chunk.ids.length&&chunk.ids[0]!==articleId)))throw Error();
        }catch{throw new NotificationError('FORMAT_FAILED',{retryable:false});}
        // Finish the saved article before a newer feed entry can replace this
        // owner's single continuation cursor.
        const pendingIndex=groups.findIndex(([articleId])=>articleId===progress.owners[id]?.articleId);
        if(pendingIndex>0)groups.unshift(...groups.splice(pendingIndex,1));
        for(const [articleId,parts] of groups){
          const fingerprint=createHash('sha256').update(JSON.stringify(parts.map(chunk=>chunk.payload))).digest('hex');
          let current=progress.owners[id];
          if(!current||current.articleId!==articleId||current.fingerprint!==fingerprint){
            current={articleId,fingerprint,nextPart:1,parts:parts.length};progress.owners[id]=current;await commitProgress(progress);
          }
          for(const {ids:sentIds,payload,part} of parts){
            checkAbort();
            if(current.nextPart<=part){
              try{
                const reply=await api('sendMessage',{...payload,chat_id:Number(id)});
                if(!Number.isSafeInteger(reply?.result?.message_id)||reply.result.message_id<1)throw Error();
              }catch(error){
                checkAbort();
                const failed=new NotificationError('SEND_FAILED',{status:error?.status,fatal:error?.fatal,retryable:error?.retryable});
                if(!failed.retryable&&!failed.fatal){ownerError??=failed;continue ownerLoop;}
                throw failed;
              }
              current.nextPart=part+1;await commitProgress(progress);stats.sentMessages++;
            }
            if(sentIds.length){
              owner.seenIds.push(...sentIds);await commit(state);stats.sentArticles+=sentIds.length;
              delete progress.owners[id];await commitProgress(progress);
            }
          }
        }
      }
      if(ownerError)throw ownerError;
      return stats;
    }finally{await release?.();busy=false;}
  }
  return {initialize:()=>run(false),check:()=>run(true)};
}
