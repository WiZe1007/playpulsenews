import {constants} from 'node:fs';
import {mkdir,open,rename,unlink} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

// One Node server process owns the persistent disk. Share the queue between
// bucket instances so compare-and-set remains atomic across concurrent requests.
const queues=new Map();
const MAX_OBJECT=16*1024*1024;
const failure=()=>Error('Хранилище Play Pulse повреждено или недоступно.');
function serialized(directory,operation){
  const previous=queues.get(directory)||Promise.resolve();
  const current=previous.then(operation,operation),tail=current.then(()=>{},()=>{});
  queues.set(directory,tail);
  return current.finally(()=>{if(queues.get(directory)===tail)queues.delete(directory);});
}
export function createBucket(directory){
  const root=resolve(directory),established=new Set();
  const pathOf=key=>join(root,createHash('sha256').update(key).digest('hex')+'.json');
  const checkKey=key=>{if(typeof key!=='string'||!key||key.length>512)throw failure();};
  async function read(key){
    let file;
    try{
      file=await open(pathOf(key),constants.O_RDONLY|constants.O_NOFOLLOW);
      const info=await file.stat();
      if(!info.isFile()||info.size>MAX_OBJECT)throw failure();
      const value=JSON.parse(await file.readFile('utf8'));
      if(!value||value.version!==1||value.key!==key||typeof value.body!=='string'||typeof value.etag!=='string'||!/^[0-9a-f-]{36}$/.test(value.etag))throw failure();
      JSON.parse(value.body);established.add(key);
      return {etag:value.etag,body:value.body,json:async()=>JSON.parse(value.body)};
    }catch(error){
      if(!file&&error.code==='ENOENT'&&!established.has(key))return null;
      throw failure();
    }finally{await file?.close();}
  }
  return {
    get(key){checkKey(key);return serialized(root,()=>read(key));},
    put(key,body,{onlyIf={}}={}){
      checkKey(key);
      return serialized(root,async()=>{
        let file,temporary;
        try{
          if(typeof body!=='string'||Buffer.byteLength(body)>12*1024*1024)throw failure();
          JSON.parse(body);
          await mkdir(root,{recursive:true,mode:0o700});
          const saved=await read(key);
          if(onlyIf.etagMatches!==undefined&&saved?.etag!==onlyIf.etagMatches||onlyIf.etagDoesNotMatch==='*'&&saved)return null;
          if(onlyIf.etagDoesNotMatch!==undefined&&onlyIf.etagDoesNotMatch!=='*'&&saved?.etag===onlyIf.etagDoesNotMatch)return null;
          const etag=randomUUID(),encoded=JSON.stringify({version:1,key,etag,body})+'\n';
          if(Buffer.byteLength(encoded)>MAX_OBJECT)throw failure();
          temporary=join(root,'.'+randomUUID()+'.tmp');
          file=await open(temporary,'wx',0o600);
          await file.writeFile(encoded);await file.sync();await file.close();file=undefined;
          await rename(temporary,pathOf(key));temporary=undefined;
          const dir=await open(root,'r');try{await dir.sync();}finally{await dir.close();}
          established.add(key);
          return {etag};
        }catch{throw failure();}
        finally{await file?.close().catch(()=>{});if(temporary)await unlink(temporary).catch(()=>{});}
      });
    }
  };
}
