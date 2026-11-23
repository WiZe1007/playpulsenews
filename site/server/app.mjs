import {readFile} from 'node:fs/promises';
import {timingSafeEqual} from 'node:crypto';

const publicAssets=new Set(['/account.html','/account.css','/account.js','/mark.svg','/assets/scene-5.webp']);
const accounts=new Set(['/api/account','/api/account/setup','/api/account/login','/api/account/logout','/api/account/password']);
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'}});
const denied=(status=401)=>json({ok:false,error:status===503?'Сервіс тимчасово недоступний.':'Потрібен дозволений доступ.'},status);
const matches=(provided,expected)=>typeof provided==='string'&&Buffer.byteLength(provided)===Buffer.byteLength(expected)&&timingSafeEqual(Buffer.from(provided),Buffer.from(expected));
let corePromise;
export function loadCore(){
  return corePromise??=readFile(new URL('../worker/runtime.mjs',import.meta.url),'utf8').then(code=>import('data:text/javascript;base64,'+Buffer.from(code+'\nexport default makeApp;').toString('base64'))).then(module=>module.default);
}
function cleanHeaders(input){
  const headers=new Headers(input);
  for(const key of [...headers.keys()])if(key.startsWith('oai-')||key.startsWith('x-forwarded-')||['authorization','host','x-play-pulse-setup-token'].includes(key))headers.delete(key);
  return headers;
}
function forward(request,url,headers){
  return new Request(url,{method:request.method,headers,signal:request.signal,...(!['GET','HEAD'].includes(request.method)&&request.body?{body:request.body,duplex:'half'}:{})});
}

export async function createSiteHandler({config:cfg,bucket,assets,seed}){
  if(!Array.isArray(seed)||seed.length>3000||seed.some(item=>!item||typeof item.id!=='string'||typeof item.title!=='string'||typeof item.summary!=='string'||typeof item.date!=='string'||typeof item.source!=='string')||new Set(seed.map(item=>item.id)).size!==seed.length)throw Error('Некорректная исходная лента Play Pulse.');
  const makeApp=await loadCore(),app=makeApp(assets,seed),env={BUCKET:bucket,PP_PASSWORD_PEPPER:cfg.pepper};
  return async request=>{
    try{
      const incoming=new URL(request.url),url=new URL(incoming.pathname+incoming.search,cfg.origin),path=url.pathname;
      const readOnly=['GET','HEAD'].includes(request.method),headers=cleanHeaders(request.headers);
      if(path==='/healthz')return readOnly?new Response(request.method==='HEAD'?null:JSON.stringify({ok:true}),{headers:{'content-type':'application/json','cache-control':'no-store'}}):denied(405);
      if(path==='/api/runtime')return request.method==='GET'?json({platform:'render'}):denied(405);
      if(path==='/api/news'){
        if(request.method!=='POST')return denied(405);
        if(!matches(request.headers.get('authorization'),'Bearer '+cfg.writeToken))return denied();
        const origin=request.headers.get('origin');if(origin&&origin!==cfg.origin)return denied(403);
        for(const key of ['origin','sec-fetch-site','cookie'])headers.delete(key);
        return await app.fetch(forward(request,url,headers),env);
      }
      headers.set('oai-authenticated-user-id',cfg.ownerId);
      if(accounts.has(path)){
        if(path==='/api/account/setup'&&!matches(request.headers.get('x-play-pulse-setup-token'),cfg.setupToken))return denied(403);
        return await app.fetch(forward(request,url,headers),env);
      }
      if(publicAssets.has(path)&&readOnly)return await app.fetch(forward(request,url,headers),env);
      const serviceRead=path==='/news.json'&&readOnly&&matches(request.headers.get('authorization'),'Bearer '+cfg.readToken);
      if(!serviceRead){
        const probe=new Request(cfg.origin+'/api/account',{headers:{cookie:request.headers.get('cookie')||'','oai-authenticated-user-id':cfg.ownerId}});
        const state=await app.fetch(probe,env);
        if(!state.ok)return denied(503);
        if((await state.json()).authenticated!==true){
          if(readOnly&&(path==='/'||path.endsWith('.html')))return new Response(null,{status:302,headers:{location:'/account.html?next=%2F','cache-control':'no-store'}});
          return denied();
        }
      }
      if(path==='/news.json'){
        const stored=await bucket.get('news/updates-v1.json');
        if(stored&&!Array.isArray(await stored.json()))return denied(503);
      }
      const response=await app.fetch(forward(request,url,headers),env);
      if(path==='/news.json'&&response.headers.get('x-play-pulse-writable')==='unavailable')return denied(503);
      return response;
    }catch{return denied(503);}
  };
}
