import {setTimeout as delay} from 'node:timers/promises';

// This only carries the existing published feed across the hosting migration.
// The source and its credential are deliberately confined to this exact URL.
const SOURCE='https://play-pulse-news.nemofresh.chatgpt.site/news.json';
const MAX_FEED=12*1024*1024,MAX_SOURCE_RECORDS=3000,MAX_WRITE=128*1024;
const failure=()=>Error('Синхронизация ленты Play Pulse временно недоступна.');
const waitInterval=(milliseconds,signal)=>delay(milliseconds,undefined,{signal});

async function readFeed(response,signal,maxRecords=MAX_SOURCE_RECORDS){
 if(!response.ok||!/^application\/json(?:\s*;|\s*$)/i.test(response.headers.get('content-type')||''))throw failure();
 if(Number(response.headers.get('content-length')||0)>MAX_FEED){void response.body?.cancel().catch(()=>{});throw failure();}
 if(!response.body)throw failure();
 const reader=response.body.getReader(),chunks=[];let length=0;
 const abort=()=>{void reader.cancel().catch(()=>{});};
 signal?.addEventListener('abort',abort,{once:true});
 try{
  for(;;){
   signal?.throwIfAborted();
   const {done,value}=await reader.read();signal?.throwIfAborted();
   if(done)break;
   length+=value.byteLength;
   if(length>MAX_FEED){void reader.cancel().catch(()=>{});throw failure();}
   chunks.push(value);
  }
  const bytes=new Uint8Array(length);let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  const data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  if(!Array.isArray(data)||data.length>maxRecords||data.some(item=>!item||typeof item!=='object'||Array.isArray(item)||typeof item.id!=='string'||!/^[a-z0-9][a-z0-9-]{0,95}$/.test(item.id)))throw failure();
  return data;
 }finally{signal?.removeEventListener('abort',abort);reader.releaseLock();}
}

function batches(records){
 const result=[];let batch=[];
 for(const record of records){
  if(Buffer.byteLength(JSON.stringify([record]))>MAX_WRITE)throw failure();
  if(batch.length===10||Buffer.byteLength(JSON.stringify([...batch,record]))>MAX_WRITE){result.push(batch);batch=[];}
  batch.push(record);
 }
 if(batch.length)result.push(batch);
 return result;
}

export async function syncUpstreamOnce({handler,config,token,fetchFn=fetch,signal}){
 try{
  if(typeof token!=='string'||!token||token.length>8192||/\s/.test(token))throw failure();
  const attempt=AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(20000)]);
  attempt.throwIfAborted();
  const response=await fetchFn(SOURCE,{redirect:'error',cache:'no-store',headers:{Accept:'application/json','OAI-Sites-Authorization':'Bearer '+token},signal:attempt});
  if(response.redirected||response.url&&response.url!==SOURCE)throw failure();
  const source=await readFeed(response,attempt);
  if(!source.length)return {added:0,skipped:0};
  const unique=new Map();for(const record of source)if(!unique.has(record.id))unique.set(record.id,record);
  const currentIDs=async()=>{
   attempt.throwIfAborted();
   const current=await handler(new Request(config.origin+'/news.json',{headers:{Accept:'application/json',authorization:'Bearer '+config.readToken},signal:attempt}));
   return new Set((await readFeed(current,attempt,4500)).map(item=>item.id));
  };
  const existing=await currentIDs(),pending=[...unique.values()].filter(record=>!existing.has(record.id));
  const chunks=batches(pending);let added=0;
  for(const chunk of chunks){
   const latest=await currentIDs(),entries=chunk.filter(record=>!latest.has(record.id));
   if(!entries.length)continue;
   attempt.throwIfAborted();
   const receipt=await handler(new Request(config.origin+'/api/news',{method:'POST',headers:{Accept:'application/json','content-type':'application/json',authorization:'Bearer '+config.writeToken,'X-Play-Pulse-Insert-Only':'1'},body:JSON.stringify(entries),signal:attempt}));
   if(!receipt.ok)throw failure();
   const data=await receipt.json(),ids=new Set(entries.map(item=>item.id));
   if(data?.ok!==true||!Array.isArray(data.ids)||new Set(data.ids).size!==data.ids.length||data.ids.some(id=>!ids.has(id)))throw failure();
   added+=data.ids.length;
  }
  return {added,skipped:source.length-added};
 }catch{throw failure();}
}

export async function runUpstreamSync({handler,config,token,fetchFn=fetch,signal,wait=waitInterval,onError=()=>{}}){
 if(!token)return;
 while(!signal?.aborted){
  try{await syncUpstreamOnce({handler,config,token,fetchFn,signal});}
  catch{if(signal?.aborted)return;try{onError(failure());}catch{}}
  if(signal?.aborted)return;
  try{await wait(60000,signal);}catch{if(signal?.aborted)return;throw failure();}
 }
}
