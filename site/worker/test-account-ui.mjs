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
 runtimeStatus = ['render','cloudflare'].includes(platform) ? 200 : 404, accountStatus = 200, search = '' } = {}) {
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
    return Response.json({ ok: accountStatus === 200, configured, authenticated: false }, { status: accountStatus });
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
