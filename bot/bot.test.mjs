import test from 'node:test';
import assert from 'node:assert/strict';
import {SITE,CATEGORIES,safeSource,config,parseFeed,screen,allowedChat,telegram,feed,handler} from './bot.mjs';
import * as core from './core.mjs';
const base={TELEGRAM_BOT_TOKEN:'123456789:'+'A'.repeat(35),TELEGRAM_ALLOWED_USER_IDS:'111, 222',PLAY_PULSE_FEED_TOKEN:'private_fixt'};
const row=(i=0)=>({id:'post-'+i,title:i===0?'<b>News</b>':'Заголовок '+i,date:i===0?'2026-11':('2026-10-'+String(i).padStart(2,'0')),category:CATEGORIES[i%7],summary:'Текст & <script>',source:'https://developer.android.com/news'});
test('configuration default private Sites, Render cutover and validation',()=>{
  assert.equal(config(base).url,SITE+'/news.json');
  assert.equal(config(base).auth,'sites');
  const render=config({...base,PLAY_PULSE_FEED_URL:'https://example.onrender.com/news.json'});
  assert.equal(render.auth,'none');assert.equal(render.feedToken,undefined);
  assert.equal(render.siteURL,'https://example.onrender.com');
  for(const overrides of [{TELEGRAM_ALLOWED_USER_IDS:'sam'},{TELEGRAM_ALLOWED_USER_IDS:'0'},{PLAY_PULSE_FEED_TOKEN:''},
    {PLAY_PULSE_FEED_URL:'https://example.onrender.com/news.json',PLAY_PULSE_AUTH_MODE:'sites'},
    {PLAY_PULSE_FEED_URL:'https://example.onrender.com/news.json#frag'},
    {PLAY_PULSE_FEED_URL:'https://example.onrender.com/news.json?secret=1'},
    {PLAY_PULSE_FEED_URL:'https://x@onrender.com/news.json'},{PLAY_PULSE_FEED_URL:'http://example.onrender.com/news.json'}])assert.throws(()=>config({...base,...overrides}));
});
test('feed parsing and filters, Telegram allowlist, escaped HTML and keyboards',()=>{
  const rows=Array.from({length:14},(_,i)=>row(i));
  rows.push({...row(15),date:'2026-02-31'}, {...row(16),source:'https://developer.android.com.evil.test/news'});
  const items=parseFeed(rows);
  assert.equal(items.length,14);assert.equal(items[0].date,'2026-11');
  assert.equal(screen(items,'cats').keyboard.length,8);
  const newest=screen(items,'list:all:0');
  assert.match(newest.text,/&lt;b&gt;News/);
  assert.ok(newest.keyboard.flat().some(x=>x.callback_data==='list:all:1'));
  const item=screen(items,newest.keyboard[0][0].callback_data);
  assert.match(item.text,/Текст &amp; &lt;script&gt;/);
  assert.match(item.text,/<a href="https:\/\/developer\.android\.com\/news">/);
  assert.ok(!item.keyboard.flat().some(button=>button.url==='https://developer.android.com/news'));
  assert.ok(item.keyboard.flat().some(button=>button.callback_data==='list:all:0'));
  assert.match(screen(items,'list:archive:0').text,/Заголовок 1/);
  assert.match(screen(items,'list:6:0').text,/Гемблинг/);
  assert.equal(safeSource('https://t.me/s/PlayCityUkr/229','Гемблінг'),'https://t.me/s/PlayCityUkr/229');
  for(const url of ['https://t.me/other/1','https://t.me/trafficarts/2?x','https://t.me/a/../trafficarts/2','https://t.me:443/trafficarts/2','javascript:alert(1)','https://google.play@evil.test/x'])assert.equal(safeSource(url,'Гемблінг'),null);
  assert.equal(safeSource('https://t.me/trafficarts/1','Магазин'),null);
});
const auth=(id=111,type='private',chatId=id,text='/start')=>({message:{from:{id},chat:{id:chatId,type},message_id:1,text}});
test('feed parsing preserves complete canonical summary and detail instead of silently shortening them',()=>{
  const source={...row(1),summary:'С'.repeat(1390)+'КІНЕЦЬ',detail:'Д'.repeat(3590)+'ПОДРОБИЦІ'};
  const [item]=parseFeed([source]);assert.equal(item.summary,source.summary);assert.equal(item.detail,source.detail);
  assert.throws(()=>parseFeed([{...source,summary:'x'.repeat(1401)}]));assert.throws(()=>parseFeed([{...source,detail:'x'.repeat(3601)}]));
});
test('feed parsing preserves complete canonical source names for readable source links',()=>{
  const sourceLabel='Федеральний реєстр законодавства Австралії: текст чинного закону';
  const label='Android Developers Blog: технічні вимоги до якості застосунків';
  const [item]=parseFeed([{...row(1),sourceLabel,sources:[{label,url:'https://developer.android.com/blog/posts/quality'}]}]);
  assert.deepEqual(item.links.map(link=>link.label),[sourceLabel,label]);
});
test('silent unauthorised chats and supported callbacks',async()=>{
  const cfg=config(base);
  for(const u of [auth(333),auth(111,'group'),auth(111,'private',222),{message:{chat:{type:'private'}}}])assert.equal(allowedChat(u,cfg.allowed),null);
  const calls=[];
  const h=handler(cfg.allowed,async(...x)=>calls.push(x),async()=>parseFeed([row()]));
  for(const u of [auth(333),auth(111,'group')])assert.equal(await h(u),false);
  await h(auth());assert.equal(calls[0][0],'sendMessage');assert.equal(calls[0][1].protect_content,true);
  await h({callback_query:{id:'btn',from:{id:111},message:auth().message,data:'list:all:0'}});
  assert.equal(calls[1][0],'answerCallbackQuery');assert.equal(calls[2][0],'editMessageText');
});
test('mock transports are fixed-scope; automatic redirect disabled and errors redact credentials',async()=>{
  let req;
  const capture=async(url,opts)=>{req={url,...opts};return new Response(JSON.stringify([row()]),{headers:{'Content-Type':'application/json'}});};
  for(const cfg of [config(base),config({...base,PLAY_PULSE_FEED_URL:'https://example.onrender.com/news.json'}),config({...base,PLAY_PULSE_FEED_URL:'https://example.onrender.com/news.json',PLAY_PULSE_AUTH_MODE:'bearer'})]){
    assert.equal((await feed(cfg,capture)()).length,1);
    assert.equal(req.redirect,'error');
    assert.equal(req.headers['OAI-Sites-Authorization'],cfg.auth==='sites'?'Bearer private_fixt':undefined);
    assert.equal(req.headers.Authorization,cfg.auth==='bearer'?'Bearer private_fixt':undefined);
  }
  assert.throws(()=>feed({url:'https://evil.test/news.json',auth:'sites',feedToken:'private_fixt'}));
  await assert.rejects(feed(config(base),async()=>{throw Error('private_fixt')})(),e=>!e.message.includes('private_fixt'));
  const tg=telegram(base.TELEGRAM_BOT_TOKEN,async(url,opts)=>{assert.match(url,/^https:\/\/api\.telegram\.org/);assert.equal(opts.redirect,'error');return new Response(JSON.stringify({ok:true,result:[]}));});
  assert.deepEqual(await tg('getUpdates',{}),{result:[]});
  await assert.rejects(tg('../',{}));
});

test('stable article key across feed reorder and protected fallback on stale Telegram message',async()=>{
  const cfg=config(base), items=parseFeed([row(1),row(2),row(3)]);
  const stale=screen(items,'list:all:0').keyboard[0][0].callback_data;
  assert.match(screen([...items].reverse(),stale).text,/Заголовок 3/);
  assert.doesNotMatch(screen(items.filter(x=>x.id!=='post-3'),stale).text,/Заголовок [12]/);
  const calls=[];
  const h=handler(cfg.allowed,async(...x)=>{calls.push(x);if(x[0]==='editMessageText')return {editUnavailable:true};},async()=>{throw Error('fixture failure');});
  await h({callback_query:{id:'btn',from:{id:111},message:auth().message,data:'list:all:0'}});
  assert.equal(calls.at(-1)[0],'sendMessage');
  assert.equal(calls.at(-1)[1].protect_content,true);
  assert.match(calls.at(-1)[1].text,/Не удалось загрузить новости/);
});
test('article lookup and selected private cards preserve full content through Telegram-sized continuations',async()=>{
  assert.equal(typeof core.articleForAction,'function');
  const item={...row(1),summary:'界'.repeat(1400),detail:'🧬'.repeat(1800)},items=parseFeed([item]);
  const action=screen(items,'list:all:0').keyboard[0][0].callback_data;
  assert.equal(core.articleForAction(items,action).id,item.id);assert.equal(core.articleForAction(items,'home'),null);
  const calls=[],api=async(method,args)=>{calls.push({method,args});return {result:{message_id:3}};};
  const handle=handler(new Set(['111']),api,async()=>items);await handle(auth(111,'private',111,'/news'));calls.length=0;
  await handle({callback_query:{id:'card',from:{id:111},message:auth().message,data:action}});
  const messages=calls.filter(call=>call.method!=='answerCallbackQuery');assert.deepEqual(messages.map(call=>call.method),['editMessageText','sendMessage']);
  const decoded=messages.map(call=>call.args.text.replace(/<\/?(?:b|i)>/g,'')).join('');assert.equal((decoded.match(/界/gu)||[]).length,1400);assert.equal((decoded.match(/🧬/gu)||[]).length,1800);
  assert.ok(messages.every(call=>call.args.text.replace(/<\/?(?:b|i)>/g,'').length<=4096));
});

test('expanded official and original research sources preserve complete articles and source labels',()=>{
 const urls=['https://firebase.google.com/support/release-notes/android','https://firebase.blog/posts/android-update','https://source.android.com/docs/security/bulletin/2026-11-01','https://www.apptweak.com/en/aso-blog/google-play-research'];
 for(const [i,source] of urls.entries()){
  const data={...row(1),id:'expanded-primary-'+i,source,summary:'Повний виклад новини.',detail:'Усі важливі подробиці.',sourceLabel:'Перевірене джерело'};
  const [item]=parseFeed([data]);assert.equal(item.summary,data.summary);assert.equal(item.detail,data.detail);assert.equal(item.links[0].url,source);assert.equal(item.links[0].label,data.sourceLabel);
 }
});
test('editorial, Telegram discovery and Android Developers video links survive as supporting sources only',()=>{
 const urls=['https://9to5google.com/2026/11/20/play-store-update/','https://www.androidauthority.com/play-store-update-123456/','https://androidweekly.net/issues/issue-754','https://t.me/GAppsLeaks/1234','https://t.me/android_broadcast/1234','https://www.youtube.com/watch?v=AbcDef_12-3','https://youtube.com/@AndroidDevelopers'];
 const [item]=parseFeed([{...row(1),sources:urls.map((url,i)=>({label:'Підтвердження '+i,url}))}]);
 assert.deepEqual(item.links.slice(1).map(link=>link.url),urls);
 const view=screen([item],screen([item],'list:all:0').keyboard[0][0].callback_data);
 for(const url of urls)assert.ok(view.text.includes(url.replaceAll('&','&amp;')),url);
 for(const source of urls){assert.equal(safeSource(source,'Магазин'),null,source);assert.throws(()=>parseFeed([{...row(1),source}]));}
});
test('new regulator sources are confined to gambling and Brazil Fazenda public paths',()=>{
 const urls=['https://www.gamblingcommission.gov.uk/news/article/new-rules','https://kansspelautoriteit.nl/nieuws/new-rules','https://www.mga.org.mt/new-rules/','https://www.gov.br/fazenda/pt-br/assuntos/noticias/2026/novembro/new-rules'];
 for(const source of urls){assert.equal(safeSource(source,'Гемблінг'),source);assert.equal(safeSource(source,'API'),null);}
 for(const source of ['https://www.gov.br/saude/pt-br/news','https://www.gov.br/fazenda/pt-br/../../secret','https://www.gov.br/fazenda/pt-br/%2e%2e/secret','https://www.gov.br/fazenda/pt-br.evil/secret'])assert.equal(safeSource(source,'Гемблінг'),null,source);
});
test('discovery links cannot replace an official primary source or certify Google status',()=>{
 const report={...row(1),category:'Гемблінг',source:'https://t.me/traffnews/123',status:'Повідомлення каналу'};
 assert.equal(parseFeed([report]).length,1);
 assert.throws(()=>parseFeed([{...report,sources:[{label:'Медіа',url:'https://9to5google.com/2026/11/20/report/'}]}]));
 assert.throws(()=>parseFeed([{...report,status:'Підтверджено Google',sources:[{label:'AppTweak',url:'https://www.apptweak.com/en/aso-blog/research'}]}]));
 assert.equal(parseFeed([{...report,status:'Підтверджено Google',sources:[{label:'Google',url:'https://firebase.blog/posts/security'}]}]).length,1);
});
test('supporting discovery links reject channel indexes, redirects, malformed videos and lookalike hosts',()=>{
 for(const url of ['https://t.me/GAppsLeaks','https://t.me/GAppsLeaks/1?single','https://t.me/s/GAppsLeaks/0','https://t.me/x/../GAppsLeaks/1','https://www.youtube.com/watch?v=short','https://www.youtube.com/watch?v=AbcDef_12-3&next=evil','https://www.youtube.com/watch?v=AbcDef_12-3#','https://www.youtube.com/@other','https://www.youtube.com/redirect?q=evil','https://www.apptweak.com.evil.test/news','https://www.androidauthority.com:443/story','https://user@9to5google.com/story','https://9to5google.com\\@evil.test/story']){
  const [item]=parseFeed([{...row(1),sources:[{label:'Rejected',url}]}]);assert.equal(item.links.length,1,url);
 }
});

test('original research is not labeled Google-confirmed without a real Google reference',()=>{
 const research={...row(1),source:'https://www.apptweak.com/en/aso-blog/research',status:'Підтверджено Google'};
 assert.throws(()=>parseFeed([research]));
 assert.equal(parseFeed([{...research,sources:[{label:'Google',url:'https://developer.android.com/blog/posts/news'}]}]).length,1);
});
