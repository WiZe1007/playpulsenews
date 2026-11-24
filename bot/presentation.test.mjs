import test from 'node:test';
import assert from 'node:assert/strict';
import {formatDigest} from './presentation.mjs';

const SITE='https://play-pulse-news.nemofresh.chatgpt.site';
const article=(id='policy-one',overrides={})=>({id,date:'2026-11-23',category:'Політики',title:'Оновлення правил Google Play',summary:'Google уточнив вимоги до публікації застосунків.',detail:'Повний опис новини без скорочень.',status:'Набуло чинності',links:[{label:'Google Play',url:'https://support.google.com/googleplay/android-developer/answer/1'}],...overrides});
const visible=text=>text.replace(/<\/?(?:b|i)>/g,'').replace(/&(amp|lt|gt|quot|#39);/g,(_,entity)=>({amp:'&',lt:'<',gt:'>',quot:'"','#39':"'"}[entity]));

test('an empty feed produces no Telegram messages',()=>assert.deepEqual(formatDigest([]),[]));

test('each news item is a separate complete message with its own sources',()=>{
 const items=[article('first'),article('second',{title:'Друга новина',summary:'Окремий текст.',detail:'Окремі подробиці.'})];
 const chunks=formatDigest(items,{siteURL:SITE,date:'2026-11-23'});
 assert.equal(chunks.length,2);
 for(const [index,{ids,payload,articleId,part,parts}] of chunks.entries()){
  const item=items[index];assert.deepEqual(ids,[item.id]);assert.equal(articleId,item.id);assert.equal(part,1);assert.equal(parts,1);
  const decoded=visible(payload.text);assert.ok(decoded.includes(item.title));assert.ok(decoded.includes(item.summary));assert.ok(decoded.includes(item.detail));assert.ok(decoded.includes(item.status));
  assert.ok(!decoded.includes(items[1-index].title));assert.match(decoded,/Опубліковано: 23 листопада 2026/);assert.doesNotMatch(decoded,/Дайджест|Продовження|Частина/);
  assert.equal(payload.parse_mode,'HTML');assert.equal(payload.protect_content,true);assert.deepEqual(payload.link_preview_options,{is_disabled:true});
  const buttons=payload.reply_markup.inline_keyboard.flat();assert.ok(buttons.some(button=>button.url===item.links[0].url));assert.ok(buttons.some(button=>button.url===SITE+'/'));assert.ok(buttons.some(button=>button.callback_data==='list:all:0'));
 }
});

test('full summary and details split only at the Telegram limit and checkpoint only the final part',()=>{
 const summary='界'.repeat(1400),detail='🧬'.repeat(1800),item=article('long',{summary,detail});
 const chunks=formatDigest([item]);assert.equal(chunks.length,2);
 assert.deepEqual(chunks.map(chunk=>chunk.ids),[[],['long']]);assert.deepEqual(chunks.map(chunk=>[chunk.articleId,chunk.part,chunk.parts]),[['long',1,2],['long',2,2]]);
 const decoded=chunks.map(chunk=>visible(chunk.payload.text));
 const body=Array.from(decoded.join('')).filter(char=>char==='界'||char==='🧬').join('');assert.equal(body,summary+detail);
 assert.match(decoded[0],/Частина 1 з 2/);assert.match(decoded[1],/Продовження.*2 з 2/);
 for(const chunk of chunks){assert.ok(visible(chunk.payload.text).length<=4096);assert.ok(chunk.payload.text.isWellFormed());assert.ok(Buffer.byteLength(chunk.payload.text)<32768);}
 assert.equal(formatDigest([article('fits',{summary:'x'.repeat(1400),detail:'y'.repeat(2000)})]).length,1);
});

test('split HTML preserves every Unicode character and escapes source text without broken entities',()=>{
 const summary="<&'\"".repeat(350),detail='🚀&<>'.repeat(700),item=article('escaped',{title:'<b>Новина</b> & "цитата"',summary,detail,status:'<статус>'});
 const chunks=formatDigest([item]);assert.equal(chunks.length,2);
 const combined=chunks.map(chunk=>visible(chunk.payload.text)).join('');
 assert.equal((combined.match(/🚀/gu)||[]).length,700);assert.equal((combined.match(/'/g)||[]).length,350);
 for(const {payload} of chunks){assert.doesNotMatch(payload.text,/<статус>|<script>/);assert.ok(payload.text.includes('&lt;b&gt;Новина&lt;/b&gt;'));assert.ok(payload.text.isWellFormed());assert.ok(visible(payload.text).length<=4096);}
});

test('many short articles never share a message and keep caller order',()=>{
 const items=Array.from({length:24},(_,index)=>article('news-'+index,{title:'Новина '+index,summary:'Коротко.',detail:''})),chunks=formatDigest(items);
 assert.equal(chunks.length,24);assert.deepEqual(chunks.flatMap(chunk=>chunk.ids),items.map(item=>item.id));assert.ok(chunks.every(chunk=>chunk.ids.length===1));
});
test('unchanged article payloads remain stable across delivery dates for resumable continuations',()=>{
 const item=article('stable',{summary:'x'.repeat(1400),detail:'y'.repeat(3600)});
 assert.deepEqual(formatDigest([item],{date:'2026-11-23'}),formatDigest([item],{date:'2026-11-24'}));
});

test('all available safe source links survive and channel posts omit private callback controls',()=>{
 const links=Array.from({length:9},(_,index)=>({label:'Джерело '+index,url:'https://developer.android.com/news/'+index}));
 const [{payload}]=formatDigest([article('channel',{links})],{destination:'channel'}),buttons=payload.reply_markup.inline_keyboard.flat();
 assert.equal(buttons.filter(button=>button.url?.startsWith('https://developer.android.com/')).length,9);assert.ok(buttons.some(button=>button.url===SITE+'/'));assert.ok(buttons.every(button=>!button.callback_data));
});

test('unsafe source and configured site URLs are rejected or omitted',()=>{
 const bad=['javascript:alert(1)','http://example.com/source','//example.com/source','https://user:secret@example.com/source','https://example.com/ source','https://example.com/\\source','not-a-url'],good='https://developer.android.com/news?a=1&b=2';
 const [{payload}]=formatDigest([article('urls',{links:[...bad.map(url=>({label:'Unsafe',url})),{label:'Джерело',url:good}]})]);
 assert.deepEqual(payload.reply_markup.inline_keyboard.flat().filter(button=>button.url&&button.url!==SITE+'/').map(button=>button.url),[good]);
 for(const siteURL of [...bad,'https://example.com/?token=secret','https://example.com/#secret'])assert.throws(()=>formatDigest([article()],{siteURL}));
});

test('preview remains explicit for both example posts and month dates retain their precision',()=>{
 const chunks=formatDigest([article('preview-one',{date:'2026-11'}),article('preview-two',{date:'2026-11'})],{preview:true});assert.equal(chunks.length,2);
 for(const {payload} of chunks){assert.match(visible(payload.text),/Приклад оформлення/);assert.match(visible(payload.text),/Опубліковано: листопад 2026/);assert.doesNotMatch(visible(payload.text),/01 листопада/);}
 assert.ok(formatDigest([article()]).every(chunk=>!chunk.payload.text.includes('Приклад оформлення')));assert.throws(()=>formatDigest([article()],{date:'2026-02-31'}));
});
