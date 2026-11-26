'use strict';
const $=id=>document.getElementById(id);
const gambling='Гемблінг';
const cats=['Усі новини','Політики','Публікація','Монетизація','Ігри','Магазин','API',gambling,'Практика Play Console'];
const slugs=['','policies','publishing','monetization','games','store','api','gambling','play-console-practice'];
const articleID=/^[a-z0-9][a-z0-9-]{0,95}$/;
function categoryFromURL(){const slug=new URL(location.href).searchParams.get('topic')||'';return cats[slugs.indexOf(slug)]||cats[0];}
function articleFromURL(){const ids=new URL(location.href).searchParams.getAll('article');return !ids.length?undefined:ids.length===1&&articleID.test(ids[0])?ids[0]:null;}
function pushCategory(next){
 const url=new URL(location.href),slug=slugs[cats.indexOf(next)];
 if(slug)url.searchParams.set('topic',slug);else url.searchParams.delete('topic');
 url.searchParams.delete('article');missingArticle=false;
 url.hash='news';
 if(url.href!==location.href)history.pushState(null,'',url);
}
const pageSize=12;
const topicDescriptions=['Правила й вимоги до застосунків','Релізи, перевірки та Play Console','Платежі, підписки й комісії','Ігрова екосистема та програми Play','Функції магазину та новинки','Інструменти й бібліотеки','Правила Google Play для азартних застосунків Android','Модерація, відхилення та випуск застосунків'];
const topicPaths=['M12 3l7 3v6c0 4-4 7-7 9-3-2-7-5-7-9V6z M9 12l2 2 4-4','M5 4h8l4 4v12H5z M13 4v5h5 M8 14h6 M8 17h6','M4 7h16v11H4z M4 10h16 M8 15h3','M8 8h8c4 0 6 8 3 9-2 1-4-2-5-2h-4c-1 0-3 3-5 2-3-1-1-9 3-9z M7 12h4 M9 10v4 M15 11h.01 M17 13h.01','M4 8h16l-1 12H5z M8 9V7a4 4 0 0 1 8 0v2','M8 7l-5 5 5 5 M16 7l5 5-5 5 M14 5l-4 14','M12 3l7 3v6c0 4-4 7-7 9-3-2-7-5-7-9V6z M12 8v5 M12 16h.01','M5 3h14v18H5z M8 8l1 1 2-2 M12 8h4 M8 14l1 1 2-2 M12 14h4'];
const ns='http://www.w3.org/2000/svg';
const el=(tag,cls,value)=>{const n=document.createElement(tag); if(cls)n.className=cls; if(value)n.textContent=value;return n;};
const dayFmt=new Intl.DateTimeFormat('uk-UA',{day:'numeric',month:'long',year:'numeric',timeZone:'UTC'});
const monthFmt=new Intl.DateTimeFormat('uk-UA',{month:'long',year:'numeric',timeZone:'UTC'});
const bareMonthFmt=new Intl.DateTimeFormat('uk-UA',{month:'long',timeZone:'UTC'});
const fmt=d=>typeof d!=='string'?'':d.length===7?monthFmt.format(new Date(d+'-01T00:00Z')):dayFmt.format(new Date(d+'T00:00Z'));
const safeLink=href=>{try{const u=new URL(href);return u.protocol==='https:'&&!u.username&&!u.password?u.href:null;}catch{return null;}};
let saved=new Set();try{saved=new Set(JSON.parse(localStorage.getItem('play-pulse-saved-v1')||'[]'));}catch{}
let articles=[], category=categoryFromURL(), q='', onlySaved=false, loadError=false, loaded=false, priorFocus, shownArticle=null, missingArticle=false;
const bookmarks=()=>{try{localStorage.setItem('play-pulse-saved-v1',JSON.stringify([...saved]));}catch{}};
const icon=()=>{const svg=document.createElementNS(ns,'svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('fill','none');svg.setAttribute('aria-hidden','true');const path=document.createElementNS(ns,'path');path.setAttribute('d','M6 4h12v16l-6-4-6 4z');svg.append(path);return svg;};
const mark=(button,id)=>{button.setAttribute('aria-pressed',String(saved.has(id)));button.setAttribute('aria-label',saved.has(id)?'Вилучити зі збережених':'Зберегти новину');button.title=button.getAttribute('aria-label');};
let limit=pageSize, searchTimer=0, currentRows=[];
function showArticle(a,trigger,route=true){
 if(missingArticle){missingArticle=false;$('count').textContent=numberLabel(currentRows.length);}
 priorFocus=trigger||$('feed-title');shownArticle=a.id;
 if(route){const url=new URL(location.href);url.searchParams.set('article',a.id);url.hash='news';if(url.href!==location.href)history.pushState(null,'',url);}
 $('article-meta').textContent=[a.category,fmt(a.date),a.status].filter(Boolean).join(' · ');
 $('article-title').textContent=a.title;$('article-summary').textContent=a.summary;$('article-detail').textContent=a.detail||'';$('article-detail').hidden=!a.detail;
 const list=[{label:a.sourceLabel||'Офіційне джерело',url:a.source},...(a.sources||[])], seen=new Set();
 $('article-links').replaceChildren(...list.flatMap(s=>{const href=safeLink(s.url);if(!href||seen.has(href))return [];seen.add(href);const x=el('a','cta',s.label||'Офіційне джерело');x.href=href;x.target='_blank';x.rel='noopener noreferrer';return [x];}));
 if(!$('dialog').open)$('dialog').showModal();
}
$('close').onclick=()=>$('dialog').close();
$('dialog').addEventListener('click',e=>{if(e.target!==$('dialog'))return;const r=$('dialog').getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)$('dialog').close();});
$('dialog').addEventListener('close',()=>{if($('dialog').open)return;const id=shownArticle;shownArticle=null;if(id&&articleFromURL()===id){const url=new URL(location.href);url.searchParams.delete('article');history.replaceState(null,'',url);}priorFocus?.focus();});
function syncArticleFromURL(){
 if(!loaded||loadError)return;
 const id=articleFromURL(),article=typeof id==='string'?articles.find(item=>item.id===id):null;
 missingArticle=id!==undefined&&!article;
 if(!article){if($('dialog').open)$('dialog').close();shownArticle=null;render();if(missingArticle)goToFeed();return;}
 if(category===cats[0]?article.category===gambling:article.category!==category){
  category=cats.includes(article.category)?article.category:cats[0];limit=pageSize;
  const url=new URL(location.href),slug=slugs[cats.indexOf(category)];if(slug)url.searchParams.set('topic',slug);else url.searchParams.delete('topic');history.replaceState(null,'',url);
 }
 render();showArticle(article,undefined,false);
}
const monthAt=d=>new Date(d.slice(0,7)+'-01T00:00Z');
const firstUpper=s=>s.charAt(0).toLocaleUpperCase('uk-UA')+s.slice(1);
function dateHeading(date){
 const monthOnly=date.length===7;
 if(monthOnly)return firstUpper(bareMonthFmt.format(monthAt(date)))+' '+date.slice(0,4);
 return dayFmt.formatToParts(new Date(date+'T00:00Z')).filter(part=>part.type==='day'||part.type==='month'||part.type==='year').map(part=>part.value).join(' ');
}
function card(a){
 const entry=el('article','news-card journal-entry timeline-entry');entry.dataset.id=a.id;
 const meta=el('div','journal-story-meta');meta.append(el('span','category',a.category));
 if(a.status){
  const statusClass=a.category===gambling?(a.status==='Повідомлення каналу'?' journal-status-report':a.status==='Підтверджено Google'?' journal-status-confirmed':''):'';
  meta.append(el('span','journal-status'+statusClass,a.status));
 }
 const heading=el('h5','journal-story-title'),btn=el('button','open-story',a.title);
 btn.type='button';btn.setAttribute('aria-haspopup','dialog');btn.onclick=()=>showArticle(a,btn);heading.append(btn);
 const b=el('button','bookmark');b.type='button';b.dataset.id=a.id;b.append(icon());mark(b,a.id);b.onclick=()=>{
  if(saved.has(a.id))saved.delete(a.id);else saved.add(a.id);bookmarks();
  if(onlySaved){render();$('saved').focus();}else mark(b,a.id);
 };
 entry.append(meta,heading,el('p','summary',a.summary),b);return entry;
}
function renderTimeline(from=0){
 if(!from)$('list').replaceChildren();
 let group=$('list').lastElementChild;
 for(const a of currentRows.slice(from,limit)){
  const key=a.date;
  if(group?.dataset.date!==key){
   group=el('section','journal-day');group.dataset.date=key;
   const title=el('h4','journal-date');title.id='news-date-'+key;
   const time=el('time','',dateHeading(key));time.dateTime=key;title.append(time);
   if(key.length===7)title.append(el('span','journal-date-note','Без точної дати'));
   group.setAttribute('aria-labelledby',title.id);group.append(title,el('div','journal-day-items'));$('list').append(group);
  }
  group.lastElementChild.append(card(a));
 }
 $('more').hidden=limit>=currentRows.length;
}
for(const cat of cats){const b=el('button','tab',cat);b.type='button';b.dataset.cat=cat;b.setAttribute('aria-pressed',String(cat===category));b.onclick=()=>{category=cat;pushCategory(cat);limit=pageSize;render();};$('tabs').append(b);}
cats.slice(1).forEach((cat,i)=>{
 const button=el('button','topic');button.type='button';
 const svg=document.createElementNS(ns,'svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');
 const path=document.createElementNS(ns,'path');path.setAttribute('d',topicPaths[i]);svg.append(path);
 button.append(svg,el('strong','',cat),el('span','',topicDescriptions[i]));
 button.onclick=()=>{clearTimeout(searchTimer);category=cat;pushCategory(cat);onlySaved=false;q='';$('search').value='';limit=pageSize;render();goToFeed();};
 $('topic-grid').append(button);
});
function goToFeed(){const title=$('feed-title');title.tabIndex=-1;title.focus({preventScroll:true});$('news').scrollIntoView();}
function numberLabel(n){const m=n%100;if(m>=11&&m<=14)return n+' новин';return n+(n%10===1?' новина':n%10>=2&&n%10<=4?' новини':' новин');}
function render(){
 for(const b of $('tabs').children)b.setAttribute('aria-pressed',String(b.dataset.cat===category));$('saved').setAttribute('aria-pressed',String(onlySaved));
 const gamblingView=category===gambling;
 $('gambling-guide').hidden=!gamblingView;
 const terms=q.trim().toLocaleLowerCase('uk-UA').split(/\s+/).filter(Boolean);
 $('view-title').textContent=loadError?'Стрічка недоступна':onlySaved?'Збережені новини':terms.length?'Результати пошуку':category===cats[0]||gamblingView?'Від нових до старих':category;
 if(!loaded&&!loadError)return;
 const matching=articles.filter(a=>(category===cats[0]?a.category!==gambling:a.category===category)&&(!onlySaved||saved.has(a.id))&&terms.every(term=>a.searchText.includes(term)));
 const noFilters=!terms.length&&!onlySaved;
 currentRows=matching;
 renderTimeline();
 $('empty').hidden=matching.length>0;
 $('empty-title').textContent=loadError?'Не вдалося завантажити стрічку':onlySaved&&!terms.length?'У цій категорії немає збережених новин':gamblingView&&noFilters?'Поки немає підтверджених новин':'Нічого не знайдено';
 $('empty-reason').textContent=loadError?'Перевір з’єднання та спробуй ще раз.':onlySaved&&!terms.length?'Натисни іконку закладки біля новини, щоб зберегти її на цьому пристрої.':gamblingView&&noFilters?'Правила Google Play і перелік країн та регіонів доступні вище.':'Зміни пошуковий запит або вибери іншу категорію.';
 $('reset').textContent=loadError?'Спробувати ще раз':gamblingView&&!noFilters?'Скинути фільтри':'Показати всі новини';
 $('count').textContent=loadError?'Стрічка недоступна':missingArticle?'Новину за цим посиланням не знайдено. Переглянь інші матеріали у стрічці.':numberLabel(matching.length);
}
$('search').addEventListener('input',e=>{q=e.target.value;limit=pageSize;clearTimeout(searchTimer);searchTimer=setTimeout(render,90);});
$('saved').onclick=()=>{onlySaved=!onlySaved;limit=pageSize;render();};
$('jump-saved').onclick=()=>{onlySaved=true;q='';$('search').value='';limit=pageSize;render();goToFeed();};
$('more').onclick=()=>{const first=limit;limit+=pageSize;renderTimeline(first);$('list').querySelectorAll('.open-story')[first]?.focus();};
$('reset').onclick=()=>{if(loadError){loadNews();return;}if(!(category===gambling&&(q.trim()||onlySaved))){category=cats[0];pushCategory(category);}clearTimeout(searchTimer);q='';onlySaved=false;limit=pageSize;$('search').value='';render();$('search').focus();};
window.addEventListener('popstate',()=>{const next=categoryFromURL();if(next!==category){category=next;limit=pageSize;}render();syncArticleFromURL();});
render();
async function loadNews(){$('empty').hidden=true;$('count').textContent='Завантаження стрічки…';try{const r=await fetch('/news.json',{cache:'no-cache'});if(!r.ok)throw Error(r.status);const data=await r.json();if(!Array.isArray(data))throw Error('invalid');articles=data.filter(x=>x&&typeof x.id==='string'&&articleID.test(x.id)&&typeof x.title==='string'&&typeof x.summary==='string'&&/^\d{4}-\d{2}(-\d{2})?$/.test(x.date)&&safeLink(x.source)).sort((a,b)=>b.date.localeCompare(a.date)).map(a=>({...a,searchText:[a.title,a.summary,a.detail,a.category,a.status].join(' ').toLocaleLowerCase('uk-UA')}));loaded=true;loadError=false;}catch{loadError=true;}render();syncArticleFromURL();}
loadNews();
