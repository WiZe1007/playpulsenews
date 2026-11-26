import {createHash} from 'node:crypto';
import {formatDigest,articleSiteURL} from './presentation.mjs';
export const SITE='https://play-pulse-news.nemofresh.chatgpt.site';
export const CATEGORIES=['Політики','Публікація','Монетизація','Ігри','Магазин','API','Гемблінг','Практика Play Console'];
const RU=['Политики','Публикация','Монетизация','Игры','Магазин','API','Гемблинг','Практика Play Console'];
const GOOGLE_HOSTS=new Set(['blog.google','developer.android.com','android-developers.googleblog.com','android.com','www.android.com','support.google.com','developers.google.com','google.play','play.google.com','status.play.google.com','firebase.google.com','firebase.blog','source.android.com']);
const REGULATORS=new Set(['www.gamblingcommission.gov.uk','www.mga.org.mt','www.gov.br']);
const EDITORIAL_HOSTS=new Set(['9to5google.com','www.androidauthority.com','androidweekly.net']);
// Only publisher-owned release and research pages on these platforms.
const publisherPaths = new Map([
  ['github.com', /^\/(?:google\/bundletool|RevenueCat\/purchases-android|mjmirza\/app-store-compliance)\/releases\/tag\/[\w.-]+$/],
  ['androidstudio.googleblog.com', /^\/20\d{2}\/\d{2}\/android-studio-[\w-]+\.html$/],
  ['blog.jetbrains.com', /^\/kotlin\/2026\/11\/kotlin-benchmark-2-0-how-ai-coding-agents-handle-harder-tasks-and-closed-source-code\/$/],
  ['appfigures.com', /^\/resources\/insights\/.+/]
]);
const SAFE_HOSTS=new Set([...GOOGLE_HOSTS,...REGULATORS,...EDITORIAL_HOSTS,...publisherPaths.keys(),'digital-markets-act.ec.europa.eu','www.apptweak.com','www.dia.govt.nz','www.legislation.gov.au','www.congressonacional.leg.br','playcity.gov.ua','t.me','unity.com','www.youtube.com','youtube.com']);
const TELEGRAM_CHANNELS=new Set(['trafficarts','uaff_media','affhubmedia','igaming_news','playcityukr','android_broadcast','traffnews']);
const VIDEO_RE=/^https:\/\/(?:www\.)?youtube\.com\/(?:@AndroidDevelopers|watch\?v=[A-Za-z0-9_-]{11})$/;
const day=/^20\d\d-(0[1-9]|1[0-2])(?:-(0[1-9]|[12]\d|3[01]))?$/;
const cut=(s,n)=>Array.from(s).slice(0,n).join('');
const value=(s,n)=>typeof s==='string'?cut(s.trim(),n):'';
const completeValue=(s,n)=>typeof s==='string'?(s.trim().length<=n?s.trim():null):'';
export const escapeHTML=s=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function safeSource(raw,category,supporting=false) {
  if(typeof raw!=='string'||raw.length>1200||!/^https:\/\/[a-z0-9.-]+\//i.test(raw)||/[\s\\]/.test(raw))return null;
  if(raw==='https://www.adjust.com/blog/tiktok-attribution-source-optimization/')return raw;
  try {
    const u=new URL(raw);
    if(u.protocol!=='https:'||u.username||u.password||u.port||!SAFE_HOSTS.has(u.hostname))return null;
    if(u.hostname==='t.me'){
      const post=/^https:\/\/t\.me\/(?:s\/)?([a-z0-9_]+)\/[1-9][0-9]*$/i.exec(raw),handle=post?.[1].toLowerCase();
      const legacy=category==='Гемблінг'&&TELEGRAM_CHANNELS.has(handle);
      const discovery=supporting&&(handle==='android_broadcast'||(handle==='gappsleaks'||handle==='androiddeveu')&&category!=='Гемблінг');
      if(!post||!legacy&&!discovery)return null;
    }
    const publisherPath = publisherPaths.get(u.hostname);
    if(publisherPath && !publisherPath.test(u.pathname)) return null;
    if(EDITORIAL_HOSTS.has(u.hostname)&&!supporting)return null;
    if(['www.youtube.com','youtube.com'].includes(u.hostname)&&(!supporting||!VIDEO_RE.test(raw)))return null;
    if(REGULATORS.has(u.hostname)&&(category!=='Гемблінг'||u.hostname==='www.gov.br'&&!u.pathname.startsWith('/fazenda/pt-br/')))return null;
    if(u.hostname==='unity.com'&&(category!=='Гемблінг'||raw!=='https://unity.com/legal/content-policy'))return null;
    if((u.hostname==='support.google.com'&&u.pathname.startsWith('/accounts/'))||(u.hostname==='www.android.com'&&u.pathname.startsWith('/intent/')))return null;
    return u.href;
  }catch{return null;}
}
function discoverySource(raw,category){
  const url=new URL(raw);
  return EDITORIAL_HOSTS.has(url.hostname)||['www.youtube.com','youtube.com'].includes(url.hostname)||url.hostname==='t.me'&&(url.pathname.toLowerCase().includes('/gappsleaks/')||url.pathname.toLowerCase().includes('/androiddeveu/')||category!=='Гемблінг'&&url.pathname.toLowerCase().includes('/android_broadcast/'));
}
const CANONICAL=SITE+'/news.json';
function httpsURL(raw) {
  if(typeof raw!=='string'||raw.length>1200||!/^https:\/\/[a-z0-9.-]+(?:\/|$)/i.test(raw)||/[\s\\?#]/.test(raw))throw Error('Неверный адрес ленты или сайта.');
  const u=new URL(raw);
  if(u.protocol!=='https:'||u.username||u.password||u.port||!u.hostname.includes('.'))throw Error('Неверный адрес ленты или сайта.');
  return u;
}
export function config(e) {
  const token=e.TELEGRAM_BOT_TOKEN?.trim(), feedToken=e.PLAY_PULSE_FEED_TOKEN?.trim();
  const raw=(e.TELEGRAM_ALLOWED_USER_IDS||'').split(',').map(x=>x.trim());
  const rawURL=e.PLAY_PULSE_FEED_URL||CANONICAL, url=httpsURL(rawURL).href;
  const exact=rawURL===CANONICAL;
  if(!exact&&url===CANONICAL)throw Error('Используйте точный канонический URL Sites.');
  const auth=e.PLAY_PULSE_AUTH_MODE?.trim()|| (exact?'sites':'none');
  if(!/^\d{5,16}:[\w-]{32,100}$/.test(token||'')||raw.length>50||!raw.every(id=>/^[1-9]\d{0,15}$/.test(id)&&Number.isSafeInteger(Number(id)))||
     !['sites','bearer','none'].includes(auth)|| (exact ? auth!=='sites' : auth==='sites')||
     (auth!=='none'&&(!feedToken||feedToken.length>4096||/[^\x21-\x7e]/.test(feedToken))))throw Error('Проверьте параметры запуска.');
  const siteURL=e.PLAY_PULSE_PRESENTATION_URL?httpsURL(e.PLAY_PULSE_PRESENTATION_URL).href:new URL(url).origin;
  return {token,feedToken:auth==='none'?undefined:feedToken,allowed:new Set(raw),url,auth,siteURL};
}
const key=(s)=>s.normalize('NFKC');
const articleKey=({id})=>createHash('sha256').update(id).digest('hex').slice(0,18);
export function articleForAction(items,action){
  const match=/^item:([0-9a-f]{18}):(all|archive|[0-7]):(\d{1,3})$/.exec(action);
  return match?items.find(item=>articleKey(item)===match[1])||null:null;
}
export function parseFeed(data) {
  if(!Array.isArray(data)||data.length>3000)throw Error('Некорректный формат ленты.');
  const result=new Map();
  for(const x of data){
    if(!x||typeof x!=='object'||!CATEGORIES.includes(x.category)||typeof x.id!=='string'||!/^[a-z0-9][a-z0-9-]{0,95}$/.test(x.id)||typeof x.date!=='string'||!day.test(x.date)|| (x.date.length===10 && (!Number.isFinite(Date.parse(x.date))||new Date(x.date).toISOString().slice(0,10)!==x.date)))continue;
    const title=value(x.title,240),summary=completeValue(x.summary,1400),detail=completeValue(x.detail,3600),url=safeSource(x.source,x.category);
    if(!title||!summary||detail===null||!url)continue;
    const links=[{label:value(x.sourceLabel,95)||'Оригинал',url}];
    for(const a of (Array.isArray(x.sources)?x.sources.slice(0,8):[])){
      const u=safeSource(a?.url,x.category,true);
      if(u&&!links.some(z=>z.url===u))links.push({label:value(a.label,95)||'Источник',url:u});
    }
    const primaryHost=new URL(url).hostname,googleCorroborated=links.some(link=>GOOGLE_HOSTS.has(new URL(link.url).hostname));
    if(primaryHost==='t.me'&&x.status!=='Повідомлення каналу'&&!(x.status==='Підтверджено Google'&&googleCorroborated))continue;
    if(x.status==='Підтверджено Google'&&!googleCorroborated)continue;
    if(['t.me','unity.com'].includes(primaryHost)&&!googleCorroborated&&links.slice(1).some(link=>discoverySource(link.url,x.category)))continue;
    result.set(x.id,{id:x.id,date:x.date,category:x.category,title,summary,detail,status:value(x.status,72),links});
  }
  if(data.length&&!result.size)throw Error('Лента пока недоступна.');
  return [...result.values()].sort((a,b)=>b.date.localeCompare(a.date)||a.id.localeCompare(b.id));
}
const callback=(label,data)=>({text:label,callback_data:data});
const link=(label,url)=>({text:label,url});
const site=(url=SITE)=>[link('🌐 Открыть Play Pulse',url)];
const home=()=>[callback('⌂ Главное меню','home')];
export function screen(items, action='home', siteURL=SITE) {
  if(action==='home')return {text:'<b>✦ PLAY PULSE</b>\n\nНовости Google Play и Play Console. Выберите раздел:',keyboard:[[callback('⚡ Последние новости','list:all:0')],[callback('🗂 Категории','cats'),callback('🎰 Гемблинг','list:6:0')],[callback('🗄 Архив','list:archive:0')],site(siteURL)]};
  if(action==='cats')return {text:'<b>🗂 Категории</b>\n\nВыберите тему.',keyboard:[...RU.map((c,i)=>[callback(c,'list:'+i+':0')]),home()]};
  const itemMatch=/^item:([0-9a-f]{18}):(all|archive|[0-7]):(\d{1,3})$/.exec(action);
  if(itemMatch){
    const [,index,cat,pg]=itemMatch;
    const x=items.find(i=>articleKey(i)===index);
    if(!x)return {...screen([], 'home',siteURL),text:'Эта карточка уже обновилась. Откройте список снова.'};
    return {text:formatDigest([x],{siteURL})[0].payload.text,keyboard:[[callback('‹ К списку','list:'+cat+':'+pg)],site(articleSiteURL(siteURL,x.id)),home()]};
  }
  const l=/^list:(all|archive|[0-7]):(\d{1,3})$/.exec(action);
  if(!l)return screen([], 'home',siteURL);
  const [,cat,pg]=l;
  const results=items.map((x,i)=>({x,i})).filter(({x})=>cat==='all'||cat==='archive'||x.category===CATEGORIES[Number(cat)]);
  if(cat==='archive')results.reverse();
  const total=Math.max(1,Math.ceil(results.length/5)),page=Math.min(Number(pg),total-1);
  const rows=results.slice(page*5,page*5+5);
  const title=cat==='all'?'⚡ Последние новости':cat==='archive'?'🗄 Архив · сначала ранние':'✦ '+RU[Number(cat)];
  const keyboard=rows.map(({x})=>[callback(cut(x.title,58),'item:'+articleKey(x)+':'+cat+':'+page)]);
  const nav=[];if(page)nav.push(callback('‹ Назад','list:'+cat+':'+(page-1)));
  if(page+1<total)nav.push(callback('Далее ›','list:'+cat+':'+(page+1)));
  if(nav.length)keyboard.push(nav);
  keyboard.push(home(),site(siteURL));
  return {text:'<b>'+title+'</b>\n<i>'+String(page+1)+' / '+total+'</i>\n\n'+(rows.length?rows.map(({x})=>'<b>'+escapeHTML(cut(x.title,110))+'</b>\n'+x.date+(x.status?' · '+escapeHTML(x.status):'')).join('\n\n'):'В этом разделе пока нет записей.'),keyboard};
}
export function allowedChat(u,allowed){
  const actor=u?.callback_query?.from||u?.message?.from;
  const msg=u?.callback_query?.message||u?.message;
  const id=actor?.id;
  return !!msg&&msg.chat?.type==='private'&&Number.isSafeInteger(id)&&id>0&&msg.chat.id===id&&allowed.has(String(id))?{id,msg,cb:u.callback_query}:null;
}
export function handler(allowed,api,getFeed,siteURL=SITE){
  // Keep one private-message snapshot for each owner so an article button never
  // silently opens a different article if the site receives an update.
  const snapshot=new Map();
  return async u=>{
    const c=allowedChat(u,allowed);if(!c)return false;
    if(c.cb){
      try{await api('answerCallbackQuery',{callback_query_id:c.cb.id});}
      catch(error){if(error?.name==='AbortError')throw error;}
    }
    const input=u?.message?.text;
    const command=/^\/(start|news|menu)(?:@[a-zA-Z0-9_]+)?(?:\s|$)/.exec(typeof input==='string'?input:'');
    if(!c.cb&&!command)return false;
    const action=key(typeof c.cb?.data==='string'?cut(c.cb.data,64):command?.[1]==='news'?'list:all:0':'home');
    let view,chunks;
    try{
      let items=[];
      if(action.startsWith('list:')||action.startsWith('item:')){
        if(action.startsWith('item:')&&!snapshot.has(c.id))view={text:'Список устарел. Откройте его ещё раз.',keyboard:[home(),site(siteURL)]};
        else{
          items=snapshot.get(c.id);
          if(!items||action.endsWith(':0')&&action.startsWith('list:')){items=await getFeed();snapshot.set(c.id,items);}
        }
      }
      if(!view){
        const selected=articleForAction(items,action);
        if(selected)chunks=formatDigest([selected],{siteURL});
        view=screen(items,action,siteURL);
      }
    }catch(error){
      if(error?.name==='AbortError')throw error;
      view={text:'Не удалось загрузить новости. Попробуйте ещё раз или откройте сайт.',keyboard:[[callback('Повторить','list:all:0')],site(siteURL),home()]};
    }
    if(action==='home')snapshot.delete(c.id);
    if(chunks){
      for(const [index,{payload}] of chunks.entries()){
        const args={...payload,chat_id:c.id,reply_markup:{inline_keyboard:view.keyboard}};
        if(c.cb&&index===0){const edit=await api('editMessageText',{...args,message_id:c.msg.message_id});if(edit?.editUnavailable)await api('sendMessage',args);}
        else await api('sendMessage',args);
      }
      return true;
    }
    const args={chat_id:c.id,text:view.text,parse_mode:'HTML',link_preview_options:{is_disabled:true},reply_markup:{inline_keyboard:view.keyboard}};
    if(c.cb){
      const edit=await api('editMessageText',{...args,message_id:c.msg.message_id});
      if(edit?.editUnavailable)await api('sendMessage',{...args,protect_content:true});
    } else await api('sendMessage',{...args,protect_content:true});
    return true;
  };
}
