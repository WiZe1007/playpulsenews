import {createServer as nodeServer} from 'node:http';
import {constants} from 'node:fs';
import {readFile,readdir,mkdir,stat,access} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join,extname,relative} from 'node:path';
import {config} from './config.mjs';
import {createBucket} from './bucket.mjs';
import {createSiteHandler} from './app.mjs';

const dist=fileURLToPath(new URL('../dist/',import.meta.url));
const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.webp':'image/webp','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.ico':'image/x-icon','.woff2':'font/woff2','.mp4':'video/mp4','.webm':'video/webm'};
const MAX_BODY=128*1024;
async function loadAssets(){
  const assets={};
  async function walk(directory){
    for(const entry of await readdir(directory,{withFileTypes:true})){
      if(entry.name.startsWith('.')||directory===dist&&entry.name==='server')continue;
      const path=join(directory,entry.name);
      if(entry.isDirectory())await walk(path);
      else if(entry.isFile()&&types[extname(entry.name)]){
        const bytes=await readFile(path);
        assets['/'+relative(dist,path)]={type:types[extname(entry.name)],base64:bytes.toString('base64'),size:bytes.byteLength};
      }
    }
  }
  await walk(dist);
  if(!['/index.html','/account.html','/account.css','/account.js'].every(path=>Object.hasOwn(assets,path)))throw Error();
  return assets;
}
export async function loadSite(env=process.env){
  const cfg=config(env);
  try{
    const info=await stat(cfg.seedFile);
    if(!info.isFile()||info.size>12*1024*1024)throw Error();
    const seed=JSON.parse(await readFile(cfg.seedFile,'utf8'));
    if(!Array.isArray(seed)||!seed.length)throw Error();
    await mkdir(cfg.dataDir,{recursive:true,mode:0o700});
    await access(cfg.dataDir,constants.R_OK|constants.W_OK);
    const bucket=createBucket(cfg.dataDir),assets=await loadAssets();
    const handler=await createSiteHandler({config:cfg,bucket,assets,seed});
    return {config:cfg,bucket,handler};
  }catch{throw Error('Не удалось загрузить приватную ленту или хранилище Play Pulse.');}
}
function readBody(request){
  return new Promise((resolve,reject)=>{
    const chunks=[];let size=0;
    const cleanup=()=>{request.removeListener('data',data);request.removeListener('end',end);request.removeListener('error',error);request.removeListener('aborted',aborted);};
    const data=chunk=>{
      size+=chunk.length;
      if(size>MAX_BODY){cleanup();request.pause();resolve({tooLarge:true});return;}
      chunks.push(chunk);
    };
    const end=()=>{cleanup();resolve({body:Buffer.concat(chunks)});};
    const error=failure=>{cleanup();reject(failure);};
    const aborted=()=>error(Error('Request aborted'));
    request.on('data',data);request.once('end',end);request.once('error',error);request.once('aborted',aborted);
  });
}
const safeBody=code=>JSON.stringify({ok:false,error:code===413?'Запит завеликий.':'Сервіс тимчасово недоступний.'});
function fail(response,status){
  if(response.headersSent||response.destroyed)return;
  response.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','connection':'close'});
  response.end(safeBody(status));
}
export function createServer({handler,config:cfg}){
  return nodeServer({maxHeaderSize:16384,requestTimeout:15000,headersTimeout:10000},async(request,response)=>{
    try{
      if(!request.url?.startsWith('/')||request.url.startsWith('//')){fail(response,400);return;}
      const controller=new AbortController();request.once('aborted',()=>controller.abort());
      const method=request.method||'GET',readOnly=['GET','HEAD'].includes(method);
      if(Number(request.headers['content-length']||0)>MAX_BODY){fail(response,413);return;}
      const body=readOnly?{}:await readBody(request);
      if(body.tooLarge){fail(response,413);return;}
      const input=new Request(new URL(request.url,cfg.origin),{method,headers:request.headers,signal:controller.signal,...(!readOnly?{body:body.body}:{})});
      const result=await handler(input);
      if(response.destroyed)return;
      response.statusCode=result.status;
      for(const [name,value] of result.headers)if(name!=='set-cookie')response.setHeader(name,value);
      const cookies=result.headers.getSetCookie();if(cookies.length)response.setHeader('set-cookie',cookies);
      response.setHeader('x-content-type-options','nosniff');response.setHeader('x-frame-options','DENY');
      const bytes=method==='HEAD'?undefined:Buffer.from(await result.arrayBuffer());
      response.end(bytes);
    }catch{fail(response,503);}
  });
}
