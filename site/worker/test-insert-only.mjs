import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const code=await readFile(new URL('./runtime.mjs',import.meta.url),'utf8');
const {default:makeApp}=await import('data:text/javascript;base64,'+Buffer.from(code+'\nexport default makeApp;').toString('base64'));
const origin='https://private.example';
const row=(id,title='Новина '+id)=>({id,date:'2026-11-23',category:'API',title,summary:'Перевірений матеріал',source:'https://developer.android.com/news',sourceLabel:'Android'});
function fixture(seed=[]){
  const records=new Map();let version=0,beforePut;
  const bucket={
    get:async key=>{const saved=records.get(key);return saved?{etag:saved.etag,json:async()=>JSON.parse(saved.body)}:null;},
    put:async(key,body,{onlyIf})=>{
      if(beforePut){const hook=beforePut;beforePut=undefined;await hook();}
      const current=records.get(key);
      if(onlyIf.etagDoesNotMatch==='*'&&current||onlyIf.etagMatches&&current?.etag!==onlyIf.etagMatches)return null;
      const saved={etag:String(++version),body};records.set(key,saved);return saved;
    }
  };
  const app=makeApp({},seed);
  const post=(items,insertOnly=false)=>app.fetch(new Request(origin+'/api/news',{method:'POST',headers:{'content-type':'application/json',...(insertOnly?{'X-Play-Pulse-Insert-Only':'1'}:{})},body:JSON.stringify(items)}),{BUCKET:bucket});
  const news=async()=>await (await app.fetch(new Request(origin+'/news.json'),{BUCKET:bucket})).json();
  return {post,news,beforePut:hook=>{beforePut=hook;},records};
}

test('insert-only refuses to replace an immutable seed ID and reports a no-op',async()=>{
  const seed=row('seed','Власний заголовок'),f=fixture([seed]);
  const response=await f.post([row('seed','Зовнішня версія')],true);
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{ok:true,ids:[],total:1,changed:false});
  assert.deepEqual(await f.news(),[seed]);
  assert.equal(f.records.size,0,'a no-op must not create a redundant updates object');
});

test('insert-only preserves saved owner edits while normal upserts still update them',async()=>{
  const f=fixture(),saved=row('saved','Збережено власником');
  await f.post([saved]);
  const response=await f.post([row('saved','Зовнішня версія')],true);
  assert.deepEqual(await response.json(),{ok:true,ids:[],total:1,changed:false});
  assert.deepEqual(await f.news(),[saved]);
  const edited=row('saved','Нова редакція власника');
  const normal=await f.post([edited]);
  assert.deepEqual(await normal.json(),{ok:true,ids:['saved'],total:1,changed:true});
  assert.deepEqual(await f.news(),[edited]);
});

test('insert-only checks collisions again after a CAS retry and inserts only still-missing IDs',async()=>{
  const f=fixture(),owner=row('racing','Створено власником під час синхронізації'),fresh=row('fresh','Нова зовнішня стаття');
  f.beforePut(async()=>{
    const response=await f.post([owner]);assert.equal(response.status,200);
  });
  const response=await f.post([row('racing','Старіший зовнішній варіант'),fresh],true);
  assert.deepEqual(await response.json(),{ok:true,ids:['fresh'],total:2,changed:true});
  assert.deepEqual(await f.news(),[fresh,owner]);
});
