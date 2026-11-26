import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const code = await readFile(new URL('../dist/account.js', import.meta.url), 'utf8');

// Exercise the shipped browser script without a browser or external requests.
class Element {
 constructor() {
  this.hidden = true;
  this.value = '';
  this.textContent = '';
  this.dataset = {};
  this.children = [];
  this.controls = new Map();
  this.elements = { namedItem: name => {
   if (!this.controls.has(name)) this.controls.set(name, new Element());
   return this.controls.get(name);
  }};
 }
 get childElementCount() { return this.children.length; }
 setAttribute() {}
 addEventListener() {}
 focus() { this.focused = true; }
 reset() {}
 append(...nodes) { this.children.push(...nodes); }
 replaceChildren(...nodes) { this.children = nodes; }
 querySelector() {
  if (!this.submit) this.submit = new Element();
  return this.submit;
 }
}

async function page({ platform = 'render', configured = false, runtimeError = false,
 runtimeStatus = ['render','cloudflare'].includes(platform) ? 200 : 404, accountStatus = 200, search = '', authenticated = false } = {}) {
 const nodes = new Map();
 const node = id => {
  if (!nodes.has(id)) nodes.set(id, new Element());
  return nodes.get(id);
 };
 const requests = [];
 const redirects = [];
 const context = vm.createContext({
  document: { getElementById: node, createElement: () => new Element(), createDocumentFragment: () => new Element() },
  window: { location: { search, assign: path => redirects.push(path) }, confirm: () => true },
  URL, URLSearchParams, TextEncoder, Intl,
  fetch: async (path, options = {}) => {
   requests.push({ path, options });
   if (path === '/api/runtime') {
    if (runtimeError) throw new TypeError('Offline');
    return new Response(JSON.stringify({ platform }), { status: runtimeStatus });
   }
   if (path === '/api/account/login') {
    return Response.json({ ok: true, configured: true, authenticated: true, role: 'admin', username: 'owner' });
   }
   if (path === '/api/account') {
    return Response.json({ ok: accountStatus === 200, configured, authenticated,...(authenticated?{role:'admin',username:'owner'}:{}) }, { status: accountStatus });
   }
   if (path === '/news.json') return Response.json([]);
   throw new Error('Unexpected request: ' + path);
  }
 });
 await vm.runInContext(code, context);
 return { node, requests, redirects, context, async login() {
  const form = node('login-form');
  form.elements.namedItem('username').value = 'owner';
  form.elements.namedItem('password').value = 'fixture password for login';
  await form.onsubmit({ preventDefault() {}, currentTarget: form });
 }};
}

test('Render first use shows owner setup state without public registration', async () => {
 const ui = await page();
 assert.equal(ui.node('signed-out').hidden, false);
 assert.equal(ui.node('setup-form').hidden, true);
 assert.equal(ui.node('login-form').hidden, true);
 assert.match(ui.node('auth-title').textContent, /налаштування/i);
 assert.doesNotMatch(ui.node('auth-intro').textContent, /ChatGPT/);
 const form = ui.node('setup-form');
 form.elements.namedItem('username').value = 'owner';
 form.elements.namedItem('password').value = 'fixture setup password';
 form.elements.namedItem('confirm').value = 'fixture setup password';
 await form.onsubmit({ preventDefault() {}, currentTarget: form });
 assert.equal(ui.requests.some(request => request.path === '/api/account/setup'), false);
});

test('original Sites first use retains owner cabinet registration', async () => {
 const ui = await page({ platform: 'sites' });
 assert.equal(ui.node('setup-form').hidden, false);
 assert.equal(ui.node('login-form').hidden, true);
 assert.match(ui.node('auth-intro').textContent, /ChatGPT/);
});

test('runtime connection failure leaves authentication forms closed', async () => {
 const ui = await page({ runtimeError: true });
 assert.equal(ui.node('loading').hidden, false);
 assert.equal(ui.node('retry').hidden, false);
 assert.equal(ui.node('setup-form').hidden, true);
 assert.equal(ui.node('login-form').hidden, true);
});

test('configured Render shows private login without ChatGPT gate instructions', async () => {
 const ui = await page({ configured: true });
 assert.equal(ui.node('login-form').hidden, false);
 assert.equal(ui.node('setup-form').hidden, true);
 assert.doesNotMatch(ui.node('auth-intro').textContent, /ChatGPT/);
});

test('Render access errors direct owner to Play Pulse login', async () => {
 const ui = await page({ accountStatus: 401 });
 assert.doesNotMatch(ui.node('loading-text').textContent, /ChatGPT/);
 assert.match(ui.node('loading-text').textContent, /логін|пароль|увійди/i);
});

test('successful Render login returns to requested feed root', async () => {
 const ui = await page({ configured: true, search: '?next=%2F' });
 await ui.login();
 assert.deepEqual(ui.redirects, ['/']);
});

test('private login preserves a safe article return link without allowing external navigation',async()=>{
 for(const platform of ['render','cloudflare']){
  const target='/?article=story-42&topic=gambling#news';
  const ui=await page({platform,configured:true,search:'?next='+encodeURIComponent(target)});
  await ui.login();assert.deepEqual(ui.redirects,[target]);
 }
 for(const target of ['//evil.example/?article=story','/\\evil.example','/account.html?article=story','/?article=a&article=b','/?article=%3Cscript%3E','/?topic=unknown','/?article=story&token=secret','/?article=story#other','/./?article=story']){
  const ui=await page({platform:'cloudflare',configured:true,search:'?next='+encodeURIComponent(target)});
  await ui.login();assert.deepEqual(ui.redirects,[],target);assert.equal(ui.node('admin').hidden,false);
 }
});

test('an existing owner session continues an article return link instead of stopping in the cabinet',async()=>{
 const target='/?article=story-42#news';
 for(const platform of ['render','cloudflare']){
  const ui=await page({platform,configured:true,authenticated:true,search:'?next='+encodeURIComponent(target)});
  assert.deepEqual(ui.redirects,[target]);
 }
 const cabinet=await page({platform:'cloudflare',configured:true,authenticated:true});
 assert.deepEqual(cabinet.redirects,[]);assert.equal(cabinet.node('admin').hidden,false);
});

test('successful login keeps cabinet for absent or untrusted return paths', async () => {
 for (const search of ['', '?next=https%3A%2F%2Fevil.example', '?next=%2F%2Fevil.example', '?next=%2Faccount.html']) {
  const ui = await page({ configured: true, search });
  await ui.login();
  assert.deepEqual(ui.redirects, []);
  assert.equal(ui.node('admin').hidden, false);
 }
 const sites = await page({ platform: 'sites', configured: true, search: '?next=%2F' });
 await sites.login();
 assert.deepEqual(sites.redirects, []);
 assert.equal(sites.node('admin').hidden, false);
});

test('Cloudflare uses private owner login, blocks signup, and safely returns to the feed', async () => {
 const setup = await page({ platform: 'cloudflare' });
 assert.equal(setup.node('signed-out').hidden, false);
 assert.equal(setup.node('setup-form').hidden, true);
 assert.equal(setup.node('login-form').hidden, true);
 assert.doesNotMatch(setup.node('auth-intro').textContent, /ChatGPT/);
 const ui = await page({ platform: 'cloudflare', configured: true, search: '?next=%2F' });
 assert.equal(ui.node('login-form').hidden, false);
 assert.doesNotMatch(ui.node('auth-intro').textContent, /ChatGPT/);
 await ui.login();
 assert.deepEqual(ui.redirects, ['/']);
 const denied = await page({ platform: 'cloudflare', accountStatus: 401 });
 assert.doesNotMatch(denied.node('loading-text').textContent, /ChatGPT/);
});

test('editor supports new official sources while keeping media and video links secondary',async()=>{
 const ui=await page();
 const allowed=(url,category='Магазин',supporting=false)=>vm.runInContext('urlAllowed('+JSON.stringify(url)+','+JSON.stringify(category)+','+supporting+')',ui.context);
 for(const url of ['https://firebase.blog/posts/android-update','https://firebase.google.com/support/release-notes/android','https://source.android.com/docs/security/bulletin','https://www.apptweak.com/en/aso-blog/research','https://github.com/google/bundletool/releases/tag/1.18.3','https://github.com/RevenueCat/purchases-android/releases/tag/11.0.0','https://developer.samsung.com/sdp/news/en/2026/10/28/update','https://digital-markets-act.ec.europa.eu/decision_en','https://www.adjust.com/blog/tiktok-attribution-source-optimization/','https://appfigures.com/resources/insights/20261125-report'])assert.equal(allowed(url),true,url);
 for(const url of ['https://9to5google.com/2026/11/20/play-store/','https://www.androidauthority.com/play-store-update/','https://androidweekly.net/issues/issue-754','https://t.me/GAppsLeaks/123','https://t.me/AndroidDevEU/10','https://t.me/android_broadcast/123','https://www.youtube.com/watch?v=AbcDef_12-3','https://youtube.com/@AndroidDevelopers']){
  assert.equal(allowed(url),false,url);assert.equal(allowed(url,'Магазин',true),true,url);
 }
 for(const url of ['https://www.gamblingcommission.gov.uk/news/article/rules','https://www.mga.org.mt/rules/','https://www.gov.br/fazenda/pt-br/assuntos/noticias/rules']){
  assert.equal(allowed(url,'Гемблінг'),true,url);assert.equal(allowed(url),false,url);
 }
 assert.equal(allowed('https://t.me/traffnews/123','Гемблінг'),true);
 for(const url of ['https://github.com/other/bundletool/releases/tag/1.0', 'https://github.com/google/bundletool/issues/1', 'https://www.adjust.com/blog/tiktok-attribution-source-optimization/?redirect=1','https://www.adjust.com/blog/other/','https://appfigures.com/account', 'https://kansspelautoriteit.nl/nieuws/rules','https://www.gov.br/saude/pt-br/news','https://www.gov.br/fazenda/pt-br/%2e%2e/news','https://t.me/GAppsLeaks/123?x','https://www.youtube.com/watch?v=AbcDef_12-3&feature=share','https://9to5google.com:443/story','https://firebase.blog.evil.test/story','https://firebase.blog/\\evil'])assert.equal(allowed(url,'Гемблінг',true),false,url);
});
test('editor requires an official primary source for new discovery links',async()=>{
 const ui=await page();
 vm.runInContext(`draftId='source-fixture'; fields(editor,'day').value='2026-11-24'; fields(editor,'precision').value='day'; fields(editor,'title').value='Новина'; fields(editor,'category').value='Гемблінг'; fields(editor,'summary').value='Суть.'; fields(editor,'sourceLabel').value='Канал'; fields(editor,'source').value='https://t.me/traffnews/123'; fields(editor,'status').value='Повідомлення каналу';`,ui.context);
 const sourceRow={querySelector:selector=>({value:selector==='[data-field=label]'?'Медіа':'https://9to5google.com/2026/11/20/report/'})};ui.node('sources').children=[sourceRow];
 assert.throws(()=>vm.runInContext('getRecord()',ui.context),/основн|першоджерел|офіційн/i);
 vm.runInContext("fields(editor,'source').value='https://developer.android.com/blog/posts/news';",ui.context);
 assert.equal(vm.runInContext('getRecord().sources[0].url',ui.context),'https://9to5google.com/2026/11/20/report/');
});

test('editor cannot label original research Google-confirmed without an official Google reference',async()=>{
 const ui=await page();
 vm.runInContext(`draftId='research-fixture'; fields(editor,'day').value='2026-11-24'; fields(editor,'title').value='Дослідження'; fields(editor,'category').value='Магазин'; fields(editor,'summary').value='Суть.'; fields(editor,'sourceLabel').value='AppTweak'; fields(editor,'source').value='https://www.apptweak.com/en/aso-blog/research'; fields(editor,'status').value='Підтверджено Google';`,ui.context);
 assert.throws(()=>vm.runInContext('getRecord()',ui.context),/Google|офіційн/);
 ui.node('sources').children=[{querySelector:selector=>({value:selector==='[data-field=label]'?'Google':'https://developer.android.com/blog/posts/news'})}];
 assert.equal(vm.runInContext('getRecord().status',ui.context),'Підтверджено Google');
});
