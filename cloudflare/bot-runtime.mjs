import {createD1Bucket} from './storage.mjs';
import {createCloudflareSite,readFeed} from './site.mjs';
import {processTelegramUpdate,deliverFreshNews} from './telegram.mjs';
import {syncUpstreamOnce} from '../site/server/upstream.mjs';

const PATHS=new Set(['/telegram/webhook','/internal/telegram-delivery']);
const json=(status=200)=>Response.json({ok:status===200},{status,headers:{'cache-control':'no-store'}});

// This class is reachable only through the private BOT namespace binding.
// D1 retains all feed/checkpoint state; no second polling loop is created.
export class PlayPulseBot {
 #env;#origin;#bucket;#site;#fetch;
 constructor(_ctx,env,{fetchFn=fetch}={}){
  const url=new URL(env.PLAY_PULSE_PUBLIC_ORIGIN);
  if(url.protocol!=='https:'||url.origin!==env.PLAY_PULSE_PUBLIC_ORIGIN||url.username||url.password)throw Error('Play Pulse bot unavailable.');
  this.#env=env;this.#origin=url.origin;this.#fetch=fetchFn;
  this.#bucket=createD1Bucket(env.DB);
  this.#site=createCloudflareSite({env,bucket:this.#bucket,origin:this.#origin});
 }
 async fetch(request){
  try{
   const url=new URL(request.url);
   if(url.origin!==this.#origin)return json(403);
   if(!PATHS.has(url.pathname))return json(404);
   if(request.method!=='POST')return json(405);
   const options={env:this.#env,bucket:this.#bucket,getFeed:()=>readFeed(this.#bucket),siteURL:this.#origin,fetchFn:this.#fetch};
   if(url.pathname==='/telegram/webhook')return await processTelegramUpdate(request,options);
   let failed=false;
   if(this.#env.PLAY_PULSE_UPSTREAM_SITES_TOKEN){
    try{
     await syncUpstreamOnce({handler:this.#site,config:{origin:this.#origin,readToken:this.#env.PLAY_PULSE_READ_TOKEN,writeToken:this.#env.PLAY_PULSE_WRITE_TOKEN},token:this.#env.PLAY_PULSE_UPSTREAM_SITES_TOKEN,fetchFn:this.#fetch,maxBatches:1});
    }catch{failed=true;}
   }
   // An upstream outage must not hide already-published, pending D1 news.
   try{await deliverFreshNews(options);}catch{failed=true;}
   return json(failed?503:200);
  }catch{return json(503);}
 }
}
