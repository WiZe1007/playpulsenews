import test from 'node:test';
import assert from 'node:assert/strict';
import {formatDigest} from './presentation.mjs';

const SITE='https://play-pulse-news.nemofresh.chatgpt.site';
const article=(id='policy-one',overrides={})=>({id,date:'2026-11-23',category:'Політики',title:'Оновлення правил Google Play',summary:'Google уточнив вимоги до публікації застосунків.',detail:'Повний опис новини без скорочень.',status:'Набуло чинності',links:[{label:'Google Play',url:'https://support.google.com/googleplay/android-developer/answer/1'}],...overrides});
const visible=text=>text.replace(/<\/?(?:b|i)>|<a href="[^"]*">|<\/a>/g,'').replace(/&(amp|lt|gt|quot|#39);/g,(_,entity)=>({amp:'&',lt:'<',gt:'>',quot:'"','#39':"'"}[entity]));
const sourceURLs=text=>[...text.matchAll(/<a href="([^"]*)">/g)].map(match=>visible(match[1]));

test('an empty feed produces no Telegram messages',()=>assert.deepEqual(formatDigest([]),[]));

test('each news item is a separate complete message with its own sources',()=>{
 const items=[article('first'),article('second',{title:'Друга новина',summary:'Окремий текст.',detail:'Окремі подробиці.'})];
 const chunks=formatDigest(items,{siteURL:SITE,date:'2026-11-23'});
 assert.equal(chunks.length,2);
 for(const [index,{ids,payload,articleId,part,parts}] of chunks.entries()){
  const item=items[index];assert.deepEqual(ids,[item.id]);assert.equal(articleId,item.id);assert.equal(part,1);assert.equal(parts,1);
  const decoded=visible(payload.text);assert.ok(decoded.includes(item.title));assert.ok(decoded.includes(item.summary));assert.ok(decoded.includes(item.detail));assert.ok(decoded.includes(item.status));
  assert.ok(!decoded.includes(items[1-index].title));assert.match(decoded,/23 листопада 2026/);assert.doesNotMatch(decoded,/Дайджест|Продовження|Частина/);
  assert.equal(payload.parse_mode,'HTML');assert.equal(payload.protect_content,true);assert.deepEqual(payload.link_preview_options,{is_disabled:true});
  assert.deepEqual(sourceURLs(payload.text),[item.links[0].url]);
  const buttons=payload.reply_markup.inline_keyboard.flat();assert.ok(buttons.some(button=>button.url===SITE+'/'));assert.ok(buttons.some(button=>button.callback_data==='list:all:0'));assert.equal(buttons.length,2);
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

test('all available safe source links survive inline and channel posts need no keyboard',()=>{
 const links=Array.from({length:9},(_,index)=>({label:'Джерело '+index,url:'https://developer.android.com/news/'+index}));
 const [{payload}]=formatDigest([article('channel',{links})],{destination:'channel'});
 assert.deepEqual(sourceURLs(payload.text),links.map(link=>link.url));assert.equal(payload.reply_markup,undefined);
});

test('unsafe source and configured site URLs are rejected or omitted',()=>{
 const bad=['javascript:alert(1)','http://example.com/source','//example.com/source','https://user:secret@example.com/source','https://example.com/ source','https://example.com/\\source','not-a-url'],good='https://developer.android.com/news?a=1&b=2';
 const [{payload}]=formatDigest([article('urls',{links:[...bad.map(url=>({label:'Unsafe',url})),{label:'Джерело',url:good}]})]);
 assert.deepEqual(sourceURLs(payload.text),[good]);
 for(const siteURL of [...bad,'https://example.com/?token=secret','https://example.com/#secret'])assert.throws(()=>formatDigest([article()],{siteURL}));
});

test('preview remains explicit for both example posts and month dates retain their precision',()=>{
 const chunks=formatDigest([article('preview-one',{date:'2026-11'}),article('preview-two',{date:'2026-11'})],{preview:true});assert.equal(chunks.length,2);
 for(const {payload} of chunks){assert.match(visible(payload.text),/Приклад оформлення/);assert.match(visible(payload.text),/листопад 2026/);assert.doesNotMatch(visible(payload.text),/01 листопада/);}
 assert.ok(formatDigest([article()]).every(chunk=>!chunk.payload.text.includes('Приклад оформлення')));assert.throws(()=>formatDigest([article()],{date:'2026-02-31'}));
});

test('source labels and href attributes cannot inject Telegram HTML or hide their full names',()=>{
 const label='Довга назва офіційного джерела зі статусом <перевірено> & поясненнями';
 const url='https://developer.android.com/news?a="quoted"&b=2';
 const [{payload}]=formatDigest([article('source-label',{links:[{label,url},{label:'Duplicate',url},{label:'</a><script>bad</script>',url:'https://example.com/other'}]})]);
 assert.ok(visible(payload.text).includes(label));assert.ok(visible(payload.text).includes('</a><script>bad</script>'));
 assert.doesNotMatch(payload.text,/<script>|<перевірено>/);assert.ok(payload.text.includes('&lt;/a&gt;&lt;script&gt;bad&lt;/script&gt;'));
 assert.deepEqual(sourceURLs(payload.text),['https://developer.android.com/news?a=%22quoted%22&b=2','https://example.com/other']);
});

test('complete body and all nine long source names fit the visible limit with footer only on the final part',()=>{
 const links=Array.from({length:9},(_,index)=>({label:String(index)+' '+('Довге <офіційне> & ім’я джерела ').repeat(3),url:'https://developer.android.com/'+index+'?'+('q'.repeat(1000))}));
 const summary=('Перший абзац із пробілами.\n').repeat(50),detail=('🔬 Деталь & пояснення.\n\n').repeat(150),item=article('footer-limit',{title:'Заголовок '.repeat(20),summary,detail,links});
 const body=summary+'\n\n'+detail,chunks=formatDigest([item],{destination:'channel'});assert.ok(chunks.length>1);
 const pieces=chunks.map(({payload},index)=>{
  const decoded=visible(payload.text),start=decoded.indexOf('\n\n')+2;
  assert.ok(decoded.length<=4096);assert.ok(payload.text.isWellFormed());
  if(index<chunks.length-1){assert.deepEqual(sourceURLs(payload.text),[]);return decoded.slice(start);}
  assert.deepEqual(sourceURLs(payload.text),links.map(link=>link.url));
  for(const link of links)assert.ok(decoded.includes(link.label.trim()));
  return decoded.slice(start,decoded.indexOf('\n\nПолітики ·'));
 });
 assert.equal(pieces.join(''),body);assert.deepEqual(chunks.flatMap(chunk=>chunk.ids),[item.id]);
});

test('a footer too large for Telegram fails instead of dropping source names or looping',()=>{
 const links=Array.from({length:9},(_,index)=>({label:'Ж'.repeat(500),url:'https://developer.android.com/'+index}));
 assert.throws(()=>formatDigest([article('huge-footer',{links})]),RangeError);
});

test('maximum canonical content with Unicode source names can finish within one three-message delivery budget',()=>{
 const item=article('unicode-budget',{title:'🔬'.repeat(240),summary:'x'.repeat(1400),detail:'y'.repeat(3600),status:'🔬'.repeat(72),links:Array.from({length:9},(_,index)=>({label:'🔬'.repeat(95),url:'https://developer.android.com/'+index}))});
 const chunks=formatDigest([item],{destination:'channel'});assert.ok(chunks.length<=3);
 assert.ok(chunks.every(chunk=>visible(chunk.payload.text).length<=4096));
 const combined=chunks.map(chunk=>visible(chunk.payload.text)).join('');assert.equal((combined.match(/x/g)||[]).length,1400);assert.equal((combined.match(/y/g)||[]).length,3600);
});

test('editorial article sources enable real large native media above the first part only',()=>{
 const urls=['https://blog.google/products-and-platforms/platforms/google-play/auction-google-play-las-vegas/','https://blog.google/intl/tr-tr/sirket-haberleri/google-play-is-modeli-ile-ilgili-guncellemeler/','https://developer.android.com/blog/posts/google-play-adaptive-quality-standards','https://android-developers.googleblog.com/2026/11/android-updates.html'];
 for(const url of urls){
  const chunks=formatDigest([article('media',{summary:'x'.repeat(1400),detail:'y'.repeat(3600),links:[{label:'Публікація',url}]})],{destination:'channel'});assert.ok(chunks.length>1);
  assert.deepEqual(chunks[0].payload.link_preview_options,{is_disabled:false,url,prefer_large_media:true,show_above_text:true});
  for(const chunk of chunks.slice(1))assert.deepEqual(chunk.payload.link_preview_options,{is_disabled:true});
 }
});

test('help documents, index pages and untrusted preview URLs never produce decorative previews',()=>{
 const urls=['https://support.google.com/googleplay/android-developer/answer/17492799','https://developer.android.com/google/play/billing/play-developer-apis-release-notes','https://developer.android.com/blog/','https://developer.android.com/blog/posts/','https://blog.google/','https://blog.google/products-and-platforms/platforms/google-play/','https://android-developers.googleblog.com/2026/11/','https://t.me/trafficarts','https://t.me/unrelated/123','https://blog.google.evil.example/products/google-play/news/','https://user:secret@blog.google/products/google-play/news/','https://example.com/news'];
 for(const url of urls){const [{payload}]=formatDigest([article('no-media',{links:[{label:'Джерело',url}]})]);assert.deepEqual(payload.link_preview_options,{is_disabled:true});}
});

test('localized Google product articles retain native media eligibility',()=>{
 const urls=['https://blog.google/intl/ja-jp/products/android-chrome-play/best-of-play-awards-2026/','https://blog.google/intl/id-id/products/platforms/google-play-best-of-2026-aplikasi-dan-game-terbaik-tahun-ini/','https://blog.google/intl/en-in/products/platforms/google-play-best-apps-and-games-in-india-in-2026/'];
 for(const url of urls){const [{payload}]=formatDigest([article('localized-media',{links:[{label:'Google Play',url}]})]);assert.deepEqual(payload.link_preview_options,{is_disabled:false,url,prefer_large_media:true,show_above_text:true});}
});

test('localized Google product category indexes stay free of generic media previews',()=>{
 const urls=['https://blog.google/intl/ja-jp/products/android-chrome-play/','https://blog.google/intl/id-id/products/platforms/','https://blog.google/intl/en-in/products/platforms/','https://blog.google/intl/tr-tr/sirket-haberleri/'];
 for(const url of urls){const [{payload}]=formatDigest([article('localized-index',{links:[{label:'Google Play',url}]})]);assert.deepEqual(payload.link_preview_options,{is_disabled:true});}
});

test('a Telegram source cannot override the official article preview later among its sources',()=>{
 const official='https://developer.android.com/blog/posts/elevating-app-quality-reducing-memory-usage-and-improving-device-migration';
 const links=[{label:'Traffic Arts',url:'https://t.me/trafficarts/1479'},{label:'Технічні вимоги',url:'https://support.google.com/googleplay/android-developer/answer/17492799'},{label:'Android Developers',url:official}];
 const [{payload}]=formatDigest([article('official-preview',{links})]);
 assert.deepEqual(payload.link_preview_options,{is_disabled:false,url:official,prefer_large_media:true,show_above_text:true});
 assert.deepEqual(sourceURLs(payload.text),links.map(link=>link.url));
});

test('Telegram-only sources retain their link without embedding external channel text',()=>{
 const url='https://t.me/trafficarts/1479';
 const [{payload}]=formatDigest([article('telegram-only',{links:[{label:'Traffic Arts',url}]})]);
 assert.deepEqual(payload.link_preview_options,{is_disabled:true});assert.deepEqual(sourceURLs(payload.text),[url]);
});
