import {makeApp} from '../site/worker/runtime.mjs';
import {createD1Bucket} from './storage.mjs';

const PASSWORD_PATHS=new Set(['/api/account/setup','/api/account/login','/api/account/password']);
const response=(status)=>Response.json({ok:false,error:status===503?'Сервіс тимчасово недоступний.':'Потрібен дозволений доступ.'},{status,headers:{'cache-control':'no-store'}});

// Fetch-handler Durable Object: no public URL, RPC methods, local SQL or timers.
// D1 remains the single account/session store; the original 100k KDF is reused.
export class PlayPulseAuth {
  #origin;#owner;#core;#env;
  constructor(_ctx,env){
    const url=new URL(env.PLAY_PULSE_PUBLIC_ORIGIN);
    if(url.protocol!=='https:'||url.origin!==env.PLAY_PULSE_PUBLIC_ORIGIN||url.username||url.password||
      !/^[A-Za-z0-9_-]{32,128}$/.test(env.PLAY_PULSE_OWNER_ID||''))throw Error('Приватна автентифікація недоступна.');
    this.#origin=url.origin;this.#owner=env.PLAY_PULSE_OWNER_ID;
    this.#core=makeApp({},[]);
    this.#env={BUCKET:createD1Bucket(env.DB),PP_PASSWORD_PEPPER:env.PP_PASSWORD_PEPPER};
  }
  async fetch(request){
    try{
      const url=new URL(request.url);
      if(!PASSWORD_PATHS.has(url.pathname))return response(404);
      if(request.method!=='POST')return response(405);
      const site=request.headers.get('sec-fetch-site');
      if(url.origin!==this.#origin||request.headers.get('origin')!==this.#origin||
        request.headers.get('oai-authenticated-user-id')!==this.#owner||site&&site!=='same-origin')return response(403);
      return await this.#core.fetch(request,this.#env);
    }catch{return response(503);}
  }
}
