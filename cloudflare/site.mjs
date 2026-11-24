import {makeApp} from '../site/worker/runtime.mjs';
import {feedReturnTarget} from '../site/return-target.mjs';

const NEWS_KEY='news/updates-v1.json';
const PUBLIC_ASSETS=new Set(['/account.html','/account.css','/account.js','/mark.svg','/assets/scene-5.webp']);
const ACCOUNT_PATHS=new Set(['/api/account','/api/account/setup','/api/account/login','/api/account/logout','/api/account/password']);
const PASSWORD_PATHS=new Set(['/api/account/setup','/api/account/login','/api/account/password']);
const CATEGORIES=new Set(['Політики','Публікація','Монетизація','Ігри','Магазин','API','Гемблінг']);
const encoder=new TextEncoder();
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'}});
const deny=(status=401)=>json({ok:false,error:status===503?'Сервіс тимчасово недоступний.':'Потрібен дозволений доступ.'},status);
function matches(provided,expected){
  if(typeof provided!=='string')return false;
  const left=encoder.encode(provided),right=encoder.encode(expected);
  if(left.length!==right.length)return false;
  if(typeof crypto.subtle.timingSafeEqual==='function')return crypto.subtle.timingSafeEqual(left,right);
  // Other WebCrypto runtimes lack the Workers extension. Compare every byte.
  let different=0;for(let index=0;index<right.length;index++)different|=left[index]^right[index];
  return different===0;
}
function configuration(env,origin,bucket){
  try{
    const url=new URL(origin||env.PLAY_PULSE_PUBLIC_ORIGIN);
    if(url.protocol!=='https:'||url.username||url.password||url.port||url.pathname!=='/'||url.search||url.hash)throw Error();
    const readToken=env.PLAY_PULSE_READ_TOKEN,writeToken=env.PLAY_PULSE_WRITE_TOKEN,setupToken=env.PLAY_PULSE_SETUP_TOKEN;
    if(![readToken,writeToken,setupToken].every(value=>typeof value==='string'&&/^[A-Za-z0-9_-]{32,128}$/.test(value))||new Set([readToken,writeToken,setupToken]).size!==3)throw Error();
    if(!/^[A-Za-z0-9_-]{32,128}$/.test(env.PLAY_PULSE_OWNER_ID||'')||!/^[a-f0-9]{64}$/.test(env.PP_PASSWORD_PEPPER||''))throw Error();
    if(typeof bucket?.get!=='function'||typeof bucket?.put!=='function'||typeof env.ASSETS?.fetch!=='function')throw Error();
    return {origin:url.origin,readToken,writeToken,setupToken,ownerId:env.PLAY_PULSE_OWNER_ID};
  }catch{throw Error('Перевір приватні параметри Play Pulse.');}
}
function cleanHeaders(input){
  const headers=new Headers(input);
  for(const name of [...headers.keys()])if(name.startsWith('oai-')||name.startsWith('x-forwarded-')||['authorization','host','x-play-pulse-setup-token'].includes(name))headers.delete(name);
  return headers;
}
function forwarded(request,url,headers){
  return new Request(url,{method:request.method,headers,signal:request.signal,...(!['GET','HEAD'].includes(request.method)&&request.body?{body:request.body,duplex:'half'}:{})});
}

export async function readFeed(bucket){
  try{
    const stored=await bucket.get(NEWS_KEY);
    if(!stored)throw Error();
    const items=await stored.json();
    if(!Array.isArray(items)||items.length>1500||items.some(item=>!item||Array.isArray(item)||
      typeof item.id!=='string'||!/^[a-z0-9][a-z0-9-]{0,95}$/.test(item.id)||
      typeof item.date!=='string'||!/^20\d\d-(0[1-9]|1[0-2])(?:-(0[1-9]|[12]\d|3[01]))?$/.test(item.date)||
      !CATEGORIES.has(item.category)||typeof item.title!=='string'||!item.title.trim()||
      typeof item.summary!=='string'||!item.summary.trim()||typeof item.source!=='string'||!item.source.startsWith('https://'))||
      new Set(items.map(item=>item.id)).size!==items.length)throw Error();
    return items;
  }catch{throw Error('Приватна стрічка Play Pulse тимчасово недоступна.');}
}

export function createCloudflareSite({env,bucket,origin}){
  const cfg=configuration(env,origin,bucket),core=makeApp({},[]),coreEnv={BUCKET:bucket,PP_PASSWORD_PEPPER:env.PP_PASSWORD_PEPPER};
  const asset=async(request,url,headers)=>{
    headers.delete('cookie');headers.delete('oai-authenticated-user-id');
    const target=new URL(url);if(target.pathname==='/')target.pathname='/index.html';
    const response=await env.ASSETS.fetch(forwarded(request,target,headers)),safe=new Headers(response.headers);
    safe.set('cache-control','private, no-store');safe.set('x-content-type-options','nosniff');safe.set('x-frame-options','DENY');safe.set('referrer-policy','strict-origin-when-cross-origin');
    return new Response(response.body,{status:response.status,statusText:response.statusText,headers:safe});
  };
  return async request=>{
    try{
      const incoming=new URL(request.url);
      if(incoming.origin!==cfg.origin)return deny(403);
      const url=new URL(cfg.origin);url.pathname=incoming.pathname;url.search=incoming.search;
      const path=url.pathname,readOnly=['GET','HEAD'].includes(request.method),headers=cleanHeaders(request.headers);
      if(path==='/healthz')return readOnly?new Response(request.method==='HEAD'?null:'{"ok":true}',{headers:{'content-type':'application/json','cache-control':'no-store'}}):deny(405);
      if(path==='/api/runtime')return request.method==='GET'?json({platform:'cloudflare'}):deny(405);
      if(path==='/api/news'){
        if(request.method!=='POST')return deny(405);
        if(!matches(request.headers.get('authorization'),'Bearer '+cfg.writeToken))return deny();
        const origin=request.headers.get('origin');if(origin&&origin!==cfg.origin)return deny(403);
        await readFeed(bucket);
        for(const name of ['origin','sec-fetch-site','cookie'])headers.delete(name);
        return await core.fetch(forwarded(request,url,headers),coreEnv);
      }
      headers.set('oai-authenticated-user-id',cfg.ownerId);
      if(ACCOUNT_PATHS.has(path)){
        if(path==='/api/account/setup'&&!matches(request.headers.get('x-play-pulse-setup-token'),cfg.setupToken))return deny(403);
        if(request.method==='POST'&&PASSWORD_PATHS.has(path)){
          const site=request.headers.get('sec-fetch-site');
          if(request.headers.get('origin')!==cfg.origin||site&&site!=='same-origin')return deny(403);
          if(path==='/api/account/password'){
            const probe=new Request(cfg.origin+'/api/account',{headers:{cookie:request.headers.get('cookie')||'','oai-authenticated-user-id':cfg.ownerId}});
            const state=await core.fetch(probe,coreEnv);
            if(!state.ok)return deny(503);
            if((await state.json()).authenticated!==true)return deny();
          }
          if(typeof env.AUTH?.idFromName!=='function'||typeof env.AUTH?.get!=='function')return deny(503);
          const object=env.AUTH.get(env.AUTH.idFromName('play-pulse-owner-auth-v1'));
          return await object.fetch(forwarded(request,url,headers));
        }
        return await core.fetch(forwarded(request,url,headers),coreEnv);
      }
      if(PUBLIC_ASSETS.has(path)&&readOnly)return await asset(request,url,headers);
      const serviceRead=path==='/news.json'&&readOnly&&matches(request.headers.get('authorization'),'Bearer '+cfg.readToken);
      if(!serviceRead){
        const probe=new Request(cfg.origin+'/api/account',{headers:{cookie:request.headers.get('cookie')||'','oai-authenticated-user-id':cfg.ownerId}});
        const state=await core.fetch(probe,coreEnv);
        if(!state.ok)return deny(503);
        if((await state.json()).authenticated!==true){
          if(readOnly&&(path==='/'||path.endsWith('.html')))return new Response(null,{status:302,headers:{location:'/account.html?next='+encodeURIComponent(feedReturnTarget(url)),'cache-control':'no-store'}});
          return deny();
        }
      }
      if(path==='/news.json'){
        await readFeed(bucket);
        const response=await core.fetch(forwarded(request,url,headers),coreEnv);
        return response.headers.get('x-play-pulse-writable')==='unavailable'?deny(503):response;
      }
      if(path==='/api/admin/news'){
        await readFeed(bucket);
        return await core.fetch(forwarded(request,url,headers),coreEnv);
      }
      if(path.startsWith('/api/'))return json({ok:false,error:'Сторінку не знайдено.'},404);
      return readOnly?await asset(request,url,headers):deny(405);
    }catch{return deny(503);}
  };
}
