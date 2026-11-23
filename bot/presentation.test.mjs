import test from 'node:test';
import assert from 'node:assert/strict';
import {formatDigest} from './presentation.mjs';

const SITE='https://play-pulse-news.nemofresh.chatgpt.site';
const article=(id='policy-one',overrides={})=>({
  id,date:'2026-11-23',category:'Політики',title:'Оновлення правил Google Play',
  summary:'Google уточнив вимоги до публікації застосунків.',detail:'Повний опис є на сайті.',
  status:'Набуло чинності',links:[{label:'Google Play',url:'https://support.google.com/googleplay/android-developer/answer/1'}],
  ...overrides,
});
const visible=text=>text.replace(/<\/?(?:b|i)>/g,'').replace(/&(amp|lt|gt|quot|#39);/g,(_,entity)=>({amp:'&',lt:'<',gt:'>',quot:'"','#39':"'"}[entity]));

test('empty digests produce no Telegram messages',()=>{
  assert.deepEqual(formatDigest([]),[]);
});

test('digest presents complete news with publication date, source buttons and protected payloads',()=>{
  const item=article();
  const chunks=formatDigest([item],{siteURL:SITE,date:'2026-11-23'});
  assert.equal(chunks.length,1);
  const {ids,payload}=chunks[0];
  assert.deepEqual(ids,['policy-one']);
  assert.equal(payload.chat_id,undefined);
  assert.equal(payload.ids,undefined);
  assert.equal(payload.parse_mode,'HTML');
  assert.equal(payload.protect_content,true);
  assert.deepEqual(payload.link_preview_options,{is_disabled:true});
  assert.match(payload.text,/<b>PLAY PULSE<\/b>/);
  assert.match(visible(payload.text),/Дайджест новин/);
  assert.match(visible(payload.text),/23 листопада 2026/);
  assert.match(payload.text,/<b>Оновлення правил Google Play<\/b>/);
  assert.ok(visible(payload.text).includes(item.summary));
  assert.ok(visible(payload.text).includes(item.status));
  assert.match(visible(payload.text),/Опубліковано: 23 листопада 2026/);
  assert.match(visible(payload.text),/01 · .*Політики/u);
  const buttons=payload.reply_markup.inline_keyboard.flat();
  assert.ok(buttons.some(button=>button.url===item.links[0].url&&button.text.includes('01')));
  assert.ok(buttons.some(button=>button.url===SITE+'/'));
  assert.ok(buttons.some(button=>button.callback_data==='list:all:0'));
  assert.ok(buttons.every(button=>!button.callback_data?.startsWith('item:')));
});

test('dynamic news text is escaped as Telegram HTML without changing its meaning',()=>{
  const item=article('escaped',{
    title:'<b>Заголовок</b> & "цитата"',summary:"Текст <script> & 'апостроф' > 0",
    status:'<невідомо> & "тест"',
  });
  const [{payload}]=formatDigest([item]);
  assert.doesNotMatch(payload.text,/<script>|<невідомо>/);
  assert.ok(payload.text.includes('&lt;b&gt;Заголовок&lt;/b&gt; &amp; &quot;цитата&quot;'));
  assert.ok(payload.text.includes('Текст &lt;script&gt; &amp; &#39;апостроф&#39; &gt; 0'));
  const decoded=visible(payload.text);
  assert.ok(decoded.includes(item.title));
  assert.ok(decoded.includes(item.summary));
  assert.ok(decoded.includes(item.status));
});

test('large Unicode digests split between articles without losing text, IDs or caller order',()=>{
  const items=Array.from({length:13},(_,index)=>article('news-'+index,{
    title:'🎮'.repeat(240),summary:`Матеріал ${index}: `+'🚀'.repeat(630),status:'✓'.repeat(72),
  }));
  const chunks=formatDigest(items,{date:'2026-11-23'});
  assert.ok(chunks.length>1);
  assert.deepEqual(chunks.flatMap(chunk=>chunk.ids),items.map(item=>item.id));
  for(const [index,{ids,payload}] of chunks.entries()){
    assert.ok(ids.length>0&&ids.length<=5);
    assert.ok(visible(payload.text).length<=3800);
    assert.ok(Buffer.byteLength(payload.text,'utf8')<32768);
    assert.ok(visible(payload.text).includes(`Частина ${index+1} з ${chunks.length}`));
    for(const id of ids){
      const item=items.find(row=>row.id===id);
      assert.ok(visible(payload.text).includes(item.title));
      assert.ok(visible(payload.text).includes(item.summary));
    }
    assert.ok(payload.text.isWellFormed());
  }
});

test('escaped worst-case feed records retain full summaries within Telegram parsed-text limit',()=>{
  const items=Array.from({length:9},(_,index)=>article('quotes-'+index,{
    title:'"'.repeat(240),summary:"'".repeat(650),status:'&'.repeat(72),
    links:Array.from({length:9},(_,link)=>({label:'Джерело '+link,url:`https://developer.android.com/news/${index}/${link}`})),
  }));
  const chunks=formatDigest(items);
  assert.deepEqual(chunks.flatMap(chunk=>chunk.ids),items.map(item=>item.id));
  for(const {ids,payload} of chunks){
    assert.ok(visible(payload.text).length<=3800);
    assert.ok(Buffer.byteLength(payload.text,'utf8')<32768);
    const buttons=payload.reply_markup.inline_keyboard.flat();
    assert.ok(buttons.length<=12);
    assert.equal(buttons.filter(button=>button.url?.startsWith('https://developer.android.com/')).length,ids.length*2);
    for(const button of buttons){
      if(button.callback_data)assert.ok(Buffer.byteLength(button.callback_data,'utf8')<=64);
    }
  }
});

test('short items keep source keyboards bounded and never reorder the feed',()=>{
  const items=Array.from({length:24},(_,index)=>article('small-'+index,{title:'Новина '+index,summary:'Коротко.'}));
  const chunks=formatDigest(items);
  assert.deepEqual(chunks.flatMap(chunk=>chunk.ids),items.map(item=>item.id));
  assert.ok(chunks.every(chunk=>chunk.ids.length<=5));
  for(const {payload} of chunks)assert.ok(payload.reply_markup.inline_keyboard.flat().length<=12);
});

test('unsafe source URLs are omitted and unsafe configured site URLs are rejected',()=>{
  const badURLs=['javascript:alert(1)','http://example.com/source','//example.com/source',
    'https://user:secret@example.com/source','https://example.com/ source','https://example.com/\\source','not-a-url'];
  const good='https://developer.android.com/news?a=1&b=2';
  const [{payload}]=formatDigest([article('urls',{links:[...badURLs.map(url=>({label:'Unsafe',url})),{label:'Джерело',url:good}]})]);
  const buttons=payload.reply_markup.inline_keyboard.flat();
  assert.deepEqual(buttons.filter(button=>button.url&&button.url!==SITE+'/').map(button=>button.url),[good]);
  for(const siteURL of [...badURLs,'https://example.com/?token=secret','https://example.com/#secret']){
    assert.throws(()=>formatDigest([article()],{siteURL}));
  }
});

test('preview is explicit on every part and month-only publication dates do not gain a day',()=>{
  const items=Array.from({length:6},(_,index)=>article('preview-'+index,{date:'2026-11'}));
  const chunks=formatDigest(items,{preview:true});
  for(const {payload} of chunks){
    assert.match(visible(payload.text),/Приклад оформлення/);
    assert.match(visible(payload.text),/Опубліковано: листопад 2026/);
    assert.doesNotMatch(visible(payload.text),/01 листопада/);
  }
  assert.ok(formatDigest([article()]).every(chunk=>!chunk.payload.text.includes('Приклад оформлення')));
  assert.throws(()=>formatDigest([article()],{date:'2026-02-31'}));
});
