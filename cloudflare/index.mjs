import {createD1Bucket} from './storage.mjs';
import {createCloudflareSite} from './site.mjs';
import {timingSafeEqual} from 'node:crypto';
export {PlayPulseAuth} from './auth.mjs';
export {PlayPulseBot} from './bot-runtime.mjs';

const denied=status=>Response.json({ok:false},{status,headers:{'cache-control':'no-store'}});
function bot(env){
 if(typeof env.BOT?.idFromName!=='function'||typeof env.BOT?.get!=='function')throw Error('Bot runtime unavailable.');
 return env.BOT.get(env.BOT.idFromName('play-pulse-telegram-v1'));
}
function webhookAuthorized(request,env){
 const expected=env.TELEGRAM_WEBHOOK_SECRET;
 if(typeof expected!=='string'||!/^[A-Za-z0-9_-]{32,256}$/.test(expected))throw Error('Webhook configuration unavailable.');
 const provided=request.headers.get('x-telegram-bot-api-secret-token');if(provided===null)return false;
 const encoder=new TextEncoder(),left=encoder.encode(provided),right=encoder.encode(expected);
 return left.length===right.length&&timingSafeEqual(left,right);
}

function services(env){
 const value=env.PLAY_PULSE_PUBLIC_ORIGIN;
 if(typeof value!=='string')throw Error('Play Pulse configuration unavailable.');
 const url=new URL(value);
 if(url.protocol!=='https:'||url.origin!==value||url.username||url.password)throw Error('Play Pulse configuration unavailable.');
 const bucket=createD1Bucket(env.DB),site=createCloudflareSite({env,bucket,origin:value});
 return {site,siteURL:value};
}

export function createWorker(){
 return {
  async fetch(request,env,ctx){
   try{
    const app=services(env);
    const url=new URL(request.url);
    if(url.pathname==='/telegram/webhook'){
     if(url.origin!==app.siteURL)return denied(403);
     if(request.method!=='POST')return denied(405);
     if(!webhookAuthorized(request,env))return denied(403);
     return await bot(env).fetch(request);
    }
    return await app.site(request);
   }catch{
    return Response.json({error:'Play Pulse temporarily unavailable.'},{status:503,headers:{'cache-control':'no-store'}});
   }
  },
  async scheduled(event,env,ctx){
   const app=services(env);
   // This replaces the local feed-delivery timer; it does not research news.
   const result=await bot(env).fetch(new Request(app.siteURL+'/internal/telegram-delivery',{method:'POST'}));
   if(!result.ok||(await result.json()).ok!==true)throw Error('Play Pulse scheduled delivery failed.');
  }
 };
}

export default createWorker();
