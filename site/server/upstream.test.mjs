import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSiteHandler} from './app.mjs';
import {createBucket} from './bucket.mjs';

const bridge=await import('./upstream.mjs').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return {};throw error;});
const upstreamURL='https://play-pulse-news.nemofresh.chatgpt.site/news.json';
const token='fixture-sites-token-confined-to-source';
const cfg={origin:'https://private.example',readToken:'read_'+'r'.repeat(40),writeToken:'write_'+'w'.repeat(40),setupToken:'setup_'+'s'.repeat(40),ownerId:'owner_'+'a'.repeat(40),pepper:'a'.repeat(64)};
const row=(id,title='Новина '+id)=>({id,date:'2026-11-23',category:'API',title,summary:'Перевірений матеріал',source:'https://developer.android.com/news',sourceLabel:'Android'});
const safeFailure=error=>error instanceof Error&&!error.message.includes(token)&&!error.message.includes(cfg.readToken)&&!error.message.includes(cfg.writeToken);
async function fixture(t,seed=[row('existing')]){
 assert.equal(typeof bridge.syncUpstreamOnce,'function');
 const directory=await mkdtemp(join(tmpdir(),'play-pulse-upstream-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const handler=await createSiteHandler({config:cfg,bucket:createBucket(directory),assets:{},seed});
 const read=async()=>{const response=await handler(new Request(cfg.origin+'/news.json',{headers:{authorization:'Bearer '+cfg.readToken}}));assert.equal(response.status,200);return response.json();};
 const write=records=>handler(new Request(cfg.origin+'/api/news',{method:'POST',headers:{authorization:'Bearer '+cfg.writeToken,'content-type':'application/json'},body:JSON.stringify(records)}));
 return {handler,read,write};
}

test('the bridge confines Sites credentials to the fixed source and imports only unseen IDs',async t=>{
 const f=await fixture(t);assert.equal((await f.write([row('existing','Зміна власника')])).status,200);
 const internal=[],sourceCalls=[];
 const handler=async request=>{internal.push(request.clone());return f.handler(request);};
 const fetchFn=async(url,options)=>{
  sourceCalls.push(url);assert.equal(url,upstreamURL);assert.equal(options.redirect,'error');
  const headers=new Headers(options.headers);assert.equal(headers.get('oai-sites-authorization'),'Bearer '+token);assert.equal(headers.get('authorization'),null);
  assert.equal(headers.get('accept'),'application/json');assert.ok(options.signal instanceof AbortSignal);
  return Response.json([row('existing'),row('new'),row('new','Дублікат')]);
 };
 assert.deepEqual(await bridge.syncUpstreamOnce({handler,config:cfg,token,fetchFn}),{added:1,skipped:2});
 const saved=await f.read();assert.equal(saved.find(item=>item.id==='existing').title,'Зміна власника');assert.equal(saved.find(item=>item.id==='new').title,'Новина new');
 assert.deepEqual(await bridge.syncUpstreamOnce({handler,config:cfg,token,fetchFn}),{added:0,skipped:3});
 assert.deepEqual(sourceCalls,[upstreamURL,upstreamURL]);
 for(const request of internal){assert.equal(new URL(request.url).origin,cfg.origin);assert.equal(request.headers.get('oai-sites-authorization'),null);assert.equal(request.headers.get('origin'),null);assert.equal(request.headers.get('cookie'),null);}
 const writes=internal.filter(request=>request.method==='POST');assert.equal(writes.length,1);assert.equal(writes[0].headers.get('x-play-pulse-insert-only'),'1');
 assert.equal((await f.handler(new Request(cfg.origin+'/news.json'))).status,401);
 assert.equal((await f.handler(new Request(cfg.origin+'/'))).status,302);
});

test('failed or malformed sources never write, delete, or replace the existing Render feed',async t=>{
 const f=await fixture(t),before=await f.read();let internalCalls=0;
 const handler=async request=>{internalCalls++;return f.handler(request);};
 const sources=[
  async()=>{throw Error('private network detail '+token);},
  async()=>new Response(null,{status:302,headers:{location:'https://attacker.example/news.json'}}),
  async()=>new Response(token,{status:401}),
  async()=>new Response('[]',{headers:{'content-type':'text/html'}}),
  async()=>new Response('private invalid JSON '+token,{headers:{'content-type':'application/json'}}),
  async()=>Response.json({data:[row('unexpected')]}),
  async()=>Response.json(Array.from({length:3001},(_,index)=>row('too-many-'+index))),
  async()=>Response.json([{...row('bad'),id:null}])
 ];
 for(const fetchFn of sources)await assert.rejects(bridge.syncUpstreamOnce({handler,config:cfg,token,fetchFn}),safeFailure);
 assert.equal(internalCalls,0);assert.deepEqual(await f.read(),before);
 assert.deepEqual(await bridge.syncUpstreamOnce({handler,config:cfg,token,fetchFn:async()=>Response.json([])}),{added:0,skipped:0});
 assert.deepEqual(await f.read(),before);
});

test('source byte limits cover both declared and streamed body sizes',async t=>{
 const f=await fixture(t);let calls=0;
 const handler=async request=>{calls++;return f.handler(request);};
 const responses=[
  ()=>new Response('[]',{headers:{'content-type':'application/json','content-length':String(12*1024*1024+1)}}),
  ()=>new Response(' '.repeat(12*1024*1024)+'[]',{headers:{'content-type':'application/json'}})
 ];
 for(const response of responses)await assert.rejects(bridge.syncUpstreamOnce({handler,config:cfg,token,fetchFn:async()=>response()}),safeFailure);
 assert.equal(calls,0);assert.deepEqual((await f.read()).map(item=>item.id),['existing']);
});

test('imports use bounded validated writer batches below 128 KiB',async t=>{
 const f=await fixture(t),writes=[];
 const records=Array.from({length:13},(_,index)=>({...row('large-'+index),summary:'界'.repeat(1400),detail:'界'.repeat(3600)}));
 const handler=async request=>{if(request.method==='POST')writes.push(await request.clone().text());return f.handler(request);};
 assert.deepEqual(await bridge.syncUpstreamOnce({handler,config:cfg,token,fetchFn:async()=>Response.json(records)}),{added:13,skipped:0});
 assert.ok(writes.length>1);for(const body of writes){assert.ok(Buffer.byteLength(body)<=128*1024);assert.ok(JSON.parse(body).length<=10);}
 assert.equal((await f.read()).length,14);
});

test('oversized individual records fail safely before any writer request',async t=>{
 const f=await fixture(t);let writes=0;
 const handler=async request=>{if(request.method==='POST')writes++;return f.handler(request);};
 await assert.rejects(bridge.syncUpstreamOnce({handler,config:cfg,token,fetchFn:async()=>Response.json([row('valid'),{...row('oversized'),detail:'x'.repeat(128*1024)}])}),safeFailure);
 assert.equal(writes,0);assert.deepEqual((await f.read()).map(item=>item.id),['existing']);
});

test('an owner-created ID racing an import keeps the owner version',async t=>{
 const f=await fixture(t);let raced=false;
 const handler=async request=>{
  if(request.method==='POST'&&!raced){raced=true;assert.equal((await f.write([row('race','Версія власника')])).status,200);}
  return f.handler(request);
 };
 assert.deepEqual(await bridge.syncUpstreamOnce({handler,config:cfg,token,fetchFn:async()=>Response.json([row('race','Стара версія джерела')])}),{added:0,skipped:1});
 assert.equal((await f.read()).find(item=>item.id==='race').title,'Версія власника');
});

test('the optional bridge retries safely every minute and stops on abort',async t=>{
 const f=await fixture(t);assert.equal(typeof bridge.runUpstreamSync,'function');
 const controller=new AbortController(),errors=[],waits=[];let attempts=0;
 await bridge.runUpstreamSync({handler:f.handler,config:cfg,token,signal:controller.signal,
  fetchFn:async()=>{if(++attempts===1)throw Error(token);return Response.json([row('retry')]);},
  onError:error=>errors.push(error),
  wait:async(ms,signal)=>{waits.push(ms);assert.equal(signal,controller.signal);if(waits.length===2)controller.abort();}
 });
 assert.equal(attempts,2);assert.deepEqual(waits,[60000,60000]);assert.equal(errors.length,1);assert.ok(safeFailure(errors[0]));
 assert.equal((await f.read()).some(item=>item.id==='retry'),true);
 let disabledCalls=0;
 await bridge.runUpstreamSync({token:'',fetchFn:async()=>{disabledCalls++;},wait:async()=>{disabledCalls++;}});
 assert.equal(disabledCalls,0);
});

test('shutdown aborts an in-flight source fetch without another attempt or error log',async t=>{
 const f=await fixture(t);assert.equal(typeof bridge.runUpstreamSync,'function');
 const controller=new AbortController();let start,errors=0,waits=0;
 const started=new Promise(resolve=>{start=resolve;});
 const task=bridge.runUpstreamSync({handler:f.handler,config:cfg,token,signal:controller.signal,
  fetchFn:async(url,{signal})=>new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(Error(token)),{once:true});start();}),
  onError:()=>{errors++;},wait:async()=>{waits++;}
 });
 await started;controller.abort();await task;assert.equal(errors,0);assert.equal(waits,0);
 assert.deepEqual((await f.read()).map(item=>item.id),['existing']);
});
