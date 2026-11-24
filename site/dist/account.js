'use strict';

const $ = id => document.getElementById(id);
const make = (tag, text, cls) => {
 const node = document.createElement(tag);
 if (text) node.textContent = text;
 if (cls) node.className = cls;
 return node;
};
const fields = (form, name) => form.elements.namedItem(name);
const AUTH = '/api/account';
const ADMIN_NEWS = '/api/admin/news';
const googleHosts = new Set(['blog.google','developer.android.com','android-developers.googleblog.com','android.com','www.android.com','support.google.com','developers.google.com','google.play','play.google.com','status.play.google.com','firebase.google.com','firebase.blog','source.android.com']);
const regulatorHosts = new Set(['www.gamblingcommission.gov.uk','kansspelautoriteit.nl','www.mga.org.mt','www.gov.br']);
const editorialHosts = new Set(['9to5google.com','www.androidauthority.com','androidweekly.net']);
const allowedHosts = new Set([...googleHosts,...regulatorHosts,...editorialHosts,'www.apptweak.com','www.dia.govt.nz','www.legislation.gov.au','www.congressonacional.leg.br','playcity.gov.ua','www.youtube.com','youtube.com']);
const telegramChannels = new Set(['trafficarts','uaff_media','affhubmedia','igaming_news','playcityukr','android_broadcast','traffnews']);
const videoURL = /^https:\/\/(?:www\.)?youtube\.com\/(?:@AndroidDevelopers|watch\?v=[A-Za-z0-9_-]{11})$/;
const gamblingCategory = 'Гемблінг';
const dayFmt = new Intl.DateTimeFormat('uk-UA',{day:'numeric',month:'long',year:'numeric',timeZone:'UTC'});
const monthFmt = new Intl.DateTimeFormat('uk-UA',{month:'long',year:'numeric',timeZone:'UTC'});
const editor = $('editor-form');
const privateGateway = () => platform==='render'||platform==='cloudflare';
let platform = null, account = null, articles = [], listLimit = 20, editing = null, draftId = '', dirty = false, saving = false, listRequest = 0;

async function loadRuntime() {
 if(platform) return;
 let response;
 try {
  response = await fetch('/api/runtime',{credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json'}});
 } catch {
  throw Object.assign(new Error('Немає з’єднання. Спробуй ще раз.'),{status:0});
 }
 if(response.status===404) {platform='sites';return;}
 const data = await response.json().catch(() => null);
 if(!response.ok || !['render','cloudflare'].includes(data?.platform)) throw new Error('Unexpected runtime');
 platform=data.platform;
}

async function api(path, payload) {
 let response;
 try {
  response = await fetch(path,{credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json',...(payload!==undefined?{'Content-Type':'application/json'}:{})},...(payload!==undefined?{method:'POST',body:JSON.stringify(payload)}:{})});
 } catch {
  throw Object.assign(new Error('Немає з’єднання. Спробуй ще раз.'),{status:0});
 }
 const data = await response.json().catch(() => null);
 if (!response.ok || !data || data.ok !== true) {
  throw Object.assign(new Error('Не вдалося виконати дію.'),{status:response.ok?502:response.status,retry:response.headers.get('retry-after')});
 }
 return data;
}
function notify(id, words='', kind='') {
 const target = $(id);
 target.textContent = words;
 if (kind) target.dataset.kind = kind;
 else delete target.dataset.kind;
 target.hidden = !words;
}
function accessError(e) {
 if (e.status===401||e.status===403) return privateGateway()?'Доступ має тільки власник сайту. Увійди зі своїм логіном і паролем Play Pulse.':'Відкрий Play Pulse через свій обліковий запис ChatGPT. Кабінет доступний тільки власнику сайту.';
 if (e.status===429) {
  const seconds = Number(e.retry);
  return Number.isFinite(seconds)&&seconds>0?'Забагато спроб. Зачекай приблизно '+Math.max(1,Math.ceil(seconds/60))+' хв. і спробуй ще раз.':'Забагато спроб. Зачекай трохи й спробуй ще раз.';
 }
 if (e.status===0) return e.message;
 return 'Не вдалося виконати дію. Спробуй ще раз.';
}
function busy(form, value) {
 form.setAttribute('aria-busy',String(value));
 const submit = form.querySelector('[type=submit]');
 if(submit) submit.disabled = value;
}
function regions(state) {
 $('loading').hidden = state !== 'loading';
 $('signed-out').hidden = state !== 'signed-out';
 $('admin').hidden = state !== 'admin';
 $('logout').hidden = state !== 'admin';
}
function applyAccount(data, focus=false) {
 account = data;
 if (data.authenticated && data.role === 'admin') {
  const target=feedReturnPath(new URLSearchParams(window.location.search).get('next'));
  if(privateGateway()&&target){window.location.assign(target);return;}
  regions('admin');
  $('username').textContent = data.username;
  if (!editing && !dirty) resetEditor();
  loadArticles();
  if (focus) $('admin-title').focus();
  return;
 }
 regions('signed-out');
 const setup = data.configured === false;
 const ownerSetup = setup && privateGateway();
 $('auth-title').textContent = ownerSetup?'Потрібне налаштування власника':setup?'Створи кабінет':privateGateway()?'Вхід у Play Pulse':'Вхід у кабінет';
 $('auth-intro').textContent = privateGateway()?(ownerSetup?'Кабінет ще не налаштовано. Власник має завершити початкове налаштування доступу.':'Сайт приватний. Введи логін і пароль власника, щоб відкрити стрічку та кабінет.'):(setup?'Створи окремий логін і пароль для Play Pulse. Доступ до самого сайту й далі перевіряє ChatGPT.':'Введи окремий логін і пароль Play Pulse. Доступ до самого сайту й далі перевіряє ChatGPT.');
 $('setup-form').hidden = !setup || ownerSetup;
 $('login-form').hidden = setup;
 if (focus) {
  if(ownerSetup) $('auth-title').focus();
  else fields(setup?$('setup-form'):$('login-form'),'username').focus();
 }
}
async function loadAccount(message='') {
 regions('loading');
 $('loading-text').textContent = 'Перевіряю доступ…';
 $('retry').hidden = true;
 try {
  await loadRuntime();
  const data = await api(AUTH);
  if(typeof data.configured!=='boolean'||typeof data.authenticated!=='boolean') throw new Error('Unexpected status');
  applyAccount(data,Boolean(message));
  if(message) notify('auth-message',message);
 } catch(e) {
  $('loading-text').textContent = accessError(e);
  $('retry').hidden = false;
 }
}
$('retry').onclick = () => loadAccount();
function checkPassword(password, confirm) {
 const length = Array.from(password).length;
 if(length<12||length>128||new TextEncoder().encode(password).length>512) return 'Пароль має містити від 12 до 128 символів.';
 if(password!==confirm) return 'Паролі не збігаються.';
 return '';
}
function feedReturnPath(raw) {
 if(typeof raw!=='string'||raw.split(/[?#]/,1)[0]!=='/'||/[\\\u0000-\u0020]/u.test(raw))return null;
 try {
  const url=new URL(raw,'https://play-pulse.invalid');
  if(url.origin!=='https://play-pulse.invalid'||url.pathname!=='/'||url.hash&&!['#news'].includes(url.hash))return null;
  for(const key of url.searchParams.keys())if(!['article','topic'].includes(key))return null;
  const ids=url.searchParams.getAll('article'),topics=url.searchParams.getAll('topic');
  if(ids.length>1||topics.length>1||ids.length&&!/^[a-z0-9][a-z0-9-]{0,95}$/.test(ids[0])||topics.length&&!['policies','publishing','monetization','games','store','api','gambling'].includes(topics[0]))return null;
  return url.pathname+url.search+url.hash;
 } catch {return null;}
}
async function authSubmit(event, setup) {
 event.preventDefault();
 if(setup && platform!=='sites') return;
 const form = event.currentTarget;
 const username = fields(form,'username').value.trim();
 const password = fields(form,'password').value;
 if(setup) {
  const error = !/^[A-Za-z][A-Za-z0-9._\-]{2,31}$/.test(username)?'Перевір формат логіна.':checkPassword(password,fields(form,'confirm').value);
  if(error) {notify('auth-message',error,'error');return;}
 }
 busy(form,true);
 notify('auth-message',setup?'Створюю кабінет…':'Входжу…');
 try {
  const data = await api(AUTH+(setup?'/setup':'/login'),{username,password});
  form.reset();
  notify('auth-message');
  if (data.authenticated && data.role==='admin') {
   applyAccount(data,true);
  }
  else await loadAccount();
 } catch(e) {
  if (e.status===409 && setup) {await loadAccount('Кабінет уже створено. Увійди зі своїм логіном і паролем.');return;}
  const message = e.status===401?'Неправильний логін або пароль.':e.status===400?'Перевір логін і пароль.':accessError(e);
  notify('auth-message',message,'error');
 } finally {busy(form,false);}
}
$('login-form').onsubmit = event => authSubmit(event,false);
$('setup-form').onsubmit = event => authSubmit(event,true);
$('logout').onclick = async () => {
 if (saving || !askDiscard()) return;
 $('logout').disabled = true;
 try {
  await api(AUTH+'/logout',{});
  resetEditor();
  notify('account-message');
  await loadAccount('Ти вийшов із кабінету.');
 } catch(e) {
  if(e.status===401) await loadAccount('Сеанс завершився. Увійди ще раз.');
  else notify('account-message',accessError(e),'error');
 } finally {$('logout').disabled = false;}
};
$('password-open').onclick = () => {
 const form = $('password-form');
 form.reset();
 fields(form,'username').value = account?.username||'';
 notify('password-message');
 $('password-dialog').showModal();
 fields(form,'currentPassword').focus();
};
$('password-close').onclick = () => $('password-dialog').close();
$('password-dialog').addEventListener('close',() => $('password-form').reset());
$('password-form').onsubmit = async event => {
 event.preventDefault();
 const form = event.currentTarget;
 const currentPassword = fields(form,'currentPassword').value, password = fields(form,'password').value;
 const error = password===currentPassword?'Новий пароль має відрізнятися від поточного.':checkPassword(password,fields(form,'confirm').value);
 if(error) {notify('password-message',error,'error');return;}
 busy(form,true);
 notify('password-message','Зберігаю пароль…');
 try {
  await api(AUTH+'/password',{currentPassword,password});
  $('password-dialog').close();
  notify('account-message','Пароль оновлено. Інші сеанси кабінету завершено.','success');
 } catch(e) {
  if(e.status===401) {
   notify('password-message','Поточний пароль неправильний або сеанс завершився. Перевір пароль і спробуй ще раз.','error');
  } else notify('password-message',e.status===400?'Перевір новий пароль.':accessError(e),'error');
 } finally {busy(form,false);}
};

function showDate(value) {
 if(typeof value!=='string') return '';
 const month = value.length===7;
 const date = new Date(value+(month?'-01':'')+'T00:00:00Z');
 return Number.isNaN(date.valueOf())?value:(month?monthFmt:dayFmt).format(date);
}
function renderArticles() {
 const term = $('filter').value.trim().toLocaleLowerCase('uk-UA');
 const matches = term?articles.filter(item => [item.title,item.category,item.date,showDate(item.date)].join(' ').toLocaleLowerCase('uk-UA').includes(term)):articles;
 const fragment = document.createDocumentFragment();
 for(const item of matches.slice(0,listLimit)) {
  const row = make('li');
  const button = make('button','','article-item');
  button.type='button';
  if(item.id===editing?.id) button.setAttribute('aria-current','true');
  button.append(make('span',showDate(item.date)+' · '+item.category,'article-item-meta'),make('span',item.title,'article-item-title'));
  button.onclick = () => {if(!askDiscard()) return; resetEditor(item,true);};
  row.append(button);fragment.append(row);
 }
 $('article-list').replaceChildren(fragment);
 $('list-message').textContent = !matches.length?(term?'Нічого не знайдено.':'Новин поки немає.'):'Показано '+Math.min(listLimit,matches.length)+' із '+matches.length;
 $('admin-more').hidden = matches.length<=listLimit;
}
async function loadArticles() {
 const request = ++listRequest;
 $('list-message').textContent = 'Завантаження новин…';
 $('retry-list').hidden = true;
 try {
  const response = await fetch('/news.json',{credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json'}});
  if(!response.ok) throw new Error('Archive unavailable');
  const data = await response.json();
  if(!Array.isArray(data)) throw new Error('Invalid archive');
  if(request!==listRequest) return;
  articles = data.filter(x=>x&&typeof x.id==='string'&&typeof x.title==='string'&&typeof x.date==='string').sort((a,b)=>b.date.localeCompare(a.date));
  renderArticles();
 } catch {
  if(request!==listRequest) return;
  $('list-message').textContent = 'Не вдалося завантажити список.';
  $('retry-list').hidden = false;
 }
}
$('retry-list').onclick = loadArticles;
$('filter').oninput = () => {listLimit=20;renderArticles();};
$('admin-more').onclick = () => {listLimit+=20;renderArticles();};

function askDiscard() {
 if (saving) return false;
 return !dirty || window.confirm('Відкинути незбережені зміни?');
}
function syncDate() {
 const month = $('precision').value==='month';
 $('day-field').hidden = month;
 $('month-field').hidden = !month;
 fields(editor,'day').disabled = month;
 fields(editor,'month').disabled = !month;
 fields(editor,'day').required = !month;
 fields(editor,'month').required = month;
}
$('precision').onchange = () => {
 const day = fields(editor,'day'), month = fields(editor,'month');
 if($('precision').value==='month'&&!month.value&&day.value) month.value = day.value.slice(0,7);
 syncDate();
};
editor.addEventListener('input',() => {dirty=true;});
function syncSourceHint() {$('source-hint').hidden=fields(editor,'category').value!==gamblingCategory;}
editor.addEventListener('change',() => {dirty=true;syncSourceHint();});
editor.addEventListener('invalid',event => {const details=event.target.closest('details');if(details)details.open=true;},true);
function sourceRow(source={}, markDirty=false) {
 const mount = $('sources');
 if(mount.childElementCount>=8) return;
 const row = make('div','','source-row');
 const grid = make('div','','fields source-fields');
 const urlLabel = make('label','Посилання');
 const url = make('input');
 url.type='url';url.maxLength=1200;url.value=source.url||'';url.required=true;url.dataset.field='url';
 urlLabel.append(url);
 const labelLabel = make('label','Назва джерела');
 const name = make('input');name.type='text';name.maxLength=95;name.value=source.label||'';name.required=true;name.dataset.field='label';
 labelLabel.append(name);
 grid.append(urlLabel,labelLabel);
 const remove = make('button','Прибрати джерело','button secondary remove-source');
 remove.type='button';
 remove.onclick = () => {if(saving)return;row.remove();dirty=true;updateSourceButton();$('add-source').focus();};
 row.append(grid,remove);mount.append(row);updateSourceButton();
 if(markDirty){dirty=true;url.focus();}
}
function updateSourceButton() {$('add-source').hidden=$('sources').childElementCount>=8;}
$('add-source').onclick = () => {if(!saving)sourceRow({},true);};
function scrollToEditor(){
 $('editor').scrollIntoView({block:'start'});
 $('editor-title').focus({preventScroll:true});
}
function resetEditor(item=null, focus=false) {
 editor.reset();
 editing = item;
 draftId = '';
 $('sources').replaceChildren();
 $('editor-title').textContent = item?'Редагувати новину':'Додати новину';
 $('editor-mode').textContent = item?'Зміни оновлять наявну новину в стрічці.':'Після збереження новина з’явиться у стрічці за вибраною датою.';
 $('save').textContent = item?'Зберегти зміни':'Зберегти новину';
 $('cancel-edit').hidden = !item;
 $('precision').value = item?.date?.length===7?'month':'day';
 const day = new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Kyiv',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
 fields(editor,'day').value = item?.date?.length===10?item.date:item?'':day;
 fields(editor,'month').value = item?.date?.length===7?item.date:'';
 for(const key of ['title','category','summary','source','sourceLabel','status','detail']) fields(editor,key).value = item?.[key]||'';
 for(const source of item?.sources||[])sourceRow(source);
 $('extra').open = Boolean(item?.detail||item?.sources?.length);
 updateSourceButton();
 syncDate();
 syncSourceHint();
 dirty=false;
 notify('editor-message');
 renderArticles();
 if(focus) scrollToEditor();
}
$('add').onclick = () => {if(askDiscard())resetEditor(null,true);};
$('cancel-edit').onclick = () => {if(askDiscard())resetEditor(null,true);};
function telegramPost(raw) {
 const match=/^https:\/\/t\.me\/(s\/)?([A-Za-z0-9_]+)\/([1-9][0-9]*)$/i.exec(raw);
 return Boolean(match && telegramChannels.has(match[2].toLowerCase()));
}
function urlAllowed(raw,category,supporting=false) {
 if(typeof raw!=='string'||raw.length>1200||!/^https:\/\/[a-z0-9.-]+\//i.test(raw)||/[\s\\]/.test(raw))return false;
 if(category===gamblingCategory && (telegramPost(raw)||raw==='https://unity.com/legal/content-policy'))return true;
 try {
  const url = new URL(raw);
  if(url.hostname==='t.me'){
   const post=/^https:\/\/t\.me\/(?:s\/)?([a-z0-9_]+)\/[1-9][0-9]*$/i.exec(raw),handle=post?.[1].toLowerCase();
   return Boolean(post&&supporting&&(handle==='android_broadcast'||handle==='gappsleaks'&&category!==gamblingCategory));
  }
  if(url.protocol!=='https:'||url.username||url.password||url.port||!allowedHosts.has(url.hostname))return false;
  if(editorialHosts.has(url.hostname)&&!supporting)return false;
  if(['www.youtube.com','youtube.com'].includes(url.hostname)&&(!supporting||!videoURL.test(raw)))return false;
  if(regulatorHosts.has(url.hostname)&&(category!==gamblingCategory||url.hostname==='www.gov.br'&&!url.pathname.startsWith('/fazenda/pt-br/')))return false;
  return !(url.hostname==='support.google.com'&&url.pathname.startsWith('/accounts/')) && !(url.hostname==='www.android.com'&&url.pathname.startsWith('/intent/'));
 } catch {return false;}
}
function discoverySource(raw,category){
 const url=new URL(raw);
 return editorialHosts.has(url.hostname)||['www.youtube.com','youtube.com'].includes(url.hostname)||url.hostname==='t.me'&&(url.pathname.toLowerCase().includes('/gappsleaks/')||category!==gamblingCategory&&url.pathname.toLowerCase().includes('/android_broadcast/'));
}
function checkedDate(date) {
 if (!/^20\d{2}-(0[1-9]|1[0-2])(?:-(0[1-9]|[12]\d|3[01]))?$/.test(date)) return false;
 if (date.length===7) return true;
 const parsed = new Date(date+'T00:00:00.000Z');
 return !Number.isNaN(parsed.valueOf())&&parsed.toISOString().slice(0,10)===date;
}
function getRecord() {
 const month = $('precision').value==='month';
 const date = fields(editor,month?'month':'day').value.trim();
 if(!checkedDate(date)) throw new Error(month?'Вибери місяць у форматі РРРР-ММ.':'Вибери дійсну дату публікації.');
 const data = {date};
 for(const key of ['title','category','summary','source','sourceLabel']) {
  const value = fields(editor,key).value.trim();
  if(!value) throw new Error('Заповни всі обов’язкові поля.');
  data[key]=value;
 }
 if(!urlAllowed(data.source,data.category))throw new Error(data.category===gamblingCategory?'Вкажи офіційне джерело або пряме посилання на допис дозволеного Telegram-каналу.':'Вкажи HTTPS-посилання на офіційне джерело Google, Android або регулятора.');
 for(const key of ['status','detail']) {
  const value = fields(editor,key).value.trim();
  if(value)data[key]=value;
 }
 const sources = [...$('sources').children].map(row => ({
  label:row.querySelector('[data-field=label]').value.trim(),
  url:row.querySelector('[data-field=url]').value.trim()
 }));
 if(sources.some(s=>!s.label||!urlAllowed(s.url,data.category,true)))throw new Error('Заповни назви додаткових джерел і перевір, чи дозволені ці посилання.');
 if(telegramPost(data.source)){
  if(!['Повідомлення каналу','Підтверджено Google'].includes(data.status))throw new Error('Для основного джерела в Telegram вкажи статус «Повідомлення каналу» або «Підтверджено Google».');
  if(data.status==='Підтверджено Google'&&!sources.some(s=>googleHosts.has(new URL(s.url).hostname)))throw new Error('Для статусу «Підтверджено Google» додай офіційне посилання Google або Android.');
 }
 const googleCorroborated=[data.source,...sources.map(s=>s.url)].some(url=>googleHosts.has(new URL(url).hostname));
 if(data.status==='Підтверджено Google'&&!googleCorroborated)throw new Error('Для статусу «Підтверджено Google» додай офіційне посилання Google або Android.');
 if(['t.me','unity.com'].includes(new URL(data.source).hostname)&&!googleCorroborated&&sources.some(s=>discoverySource(s.url,data.category)))throw new Error('Для матеріалів медіа й пошукових сигналів потрібне офіційне першоджерело.');
 if(sources.length)data.sources=sources;
 if(!editing&&!draftId)draftId='manual-'+date+'-'+crypto.randomUUID();
 return {...data,id:editing?.id||draftId};
}
editor.onsubmit = async event => {
 event.preventDefault();
 if(saving)return;
 let data;
 try {data=getRecord();}
 catch(e){notify('editor-message',e.message,'error');return;}
 saving=true;busy(editor,true);$('logout').disabled=true;
 const editorControls = [...editor.elements].filter(node=>!node.disabled&&node!==$('save'));
 for(const control of editorControls)control.disabled=true;
 notify('editor-message','Зберігаю новину…');
 try {
  const result = await api(ADMIN_NEWS,[data]);
  if(!Array.isArray(result.ids)||!result.ids.includes(data.id))throw new Error('No save receipt');
  const message = result.changed?(editing?'Зміни збережено.':'Новину додано до стрічки.'):'Змін немає.';
  resetEditor(data);
  notify('editor-message',message,'success');
  loadArticles();
 } catch(e) {
  const message = e.status===401?'Сеанс завершився. Відкрий кабінет у новій вкладці й увійди. Потім повернись сюди, щоб зберегти чернетку.':e.status===400?'Перевір заповнені поля й офіційні джерела.':e.status===409?'Не вдалося зберегти через конфлікт або ліміт архіву. Чернетка залишилась у формі.':accessError(e);
  notify('editor-message',message,'error');
 } finally {
  for(const control of editorControls)control.disabled=false;
  saving=false;busy(editor,false);$('logout').disabled=false;syncDate();
 }
};

loadAccount();
