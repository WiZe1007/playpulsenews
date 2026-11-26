import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {prepareCover,serveCover} from './editorial-media.mjs';
import {createTestD1} from './test-d1.mjs';

test('cover bytes are unique across sources and AI, stable on retry, and served without article data',async t=>{
 const {db}=await createTestD1(t);
 const photos=await Promise.all(['review','release'].map(key=>readFile(new URL('../site/dist/assets/editorial/'+key+'.jpg',import.meta.url))));
 const prompts=[];
 const env={DB:db,PLAY_PULSE_PUBLIC_ORIGIN:'https://private.example',AI:{run:async(_,input)=>{
  assert.deepEqual(Object.keys(input).sort(),['prompt','steps']);
  prompts.push(input.prompt);return {image:photos[1].toString('base64')};
 }}};
 const article=id=>({id,category:'Політики',title:'Новина '+id,summary:'Приватний опис події.'});
 const opts={media:{type:'photo',url:'https://example.org/a.jpg'},fetchFn:async()=>new Response(photos[0])};
 const first=await prepareCover(article('first'),env,opts);
 const second=await prepareCover(article('second'),env,{...opts,media:{type:'photo',url:'https://example.org/a-copy.jpg'}});
 const third=await prepareCover(article('third'),env);
 assert.deepEqual([first.label,second.label,third.label],['Фото з джерела','ШІ-ілюстрація WWA','Графіка WWA']);
 assert.ok(prompts[0].includes('Новина second'));
 assert.deepEqual(await prepareCover(article('second'),env),second);
 assert.equal(prompts.length,2);
 for(const cover of [first,second,third]){
  const path=new URL(cover.url).pathname;
  const response=await serveCover(path,'GET',db);
  const data=Buffer.from(await response.arrayBuffer());
  assert.equal(response.status,200);
  assert.ok(path.includes(createHash('sha256').update(data).digest('hex')));
  const head=await serveCover(path,'HEAD',db);
  assert.equal(head.headers.get('content-length'),String(data.length));
  assert.equal(await head.text(),'');
 }
 assert.equal((await serveCover('/covers/'+'a'.repeat(64)+'.jpg','GET',db)).status,404);
});
