import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const code=await readFile(new URL('../dist/app.js',import.meta.url),'utf8');
class Element{
 constructor(tag='div'){this.tagName=tag;this.children=[];this.dataset={};this.attributes={};this.listeners=new Map();this.textContent='';this.value='';this.hidden=false;this.open=false;}
 get lastElementChild(){return this.children.at(-1);}
 setAttribute(key,value){this.attributes[key]=String(value);}
 getAttribute(key){return this.attributes[key]??null;}
 append(...nodes){this.children.push(...nodes);}
 replaceChildren(...nodes){this.children=nodes;}
 addEventListener(name,callback){this.listeners.set(name,callback);}
 focus(){this.focused=true;}
 scrollIntoView(){this.scrolled=true;}
 showModal(){this.open=true;}
 close(){this.open=false;queueMicrotask(()=>this.listeners.get('close')?.());}
 querySelectorAll(selector){return this.children.flatMap(child=>[(child.className||'').split(' ').includes(selector.slice(1))?child:null,...child.querySelectorAll(selector)]).filter(Boolean);}
}
const row=(id,category='API')=>({id,category,date:'2026-11-24',title:'Новина '+id,summary:'Повний виклад '+id,detail:'Подробиці '+id,source:'https://developer.android.com/news',sourceLabel:'Android'});
async function page({path='/',items=[row('first'),row('casino','Гемблінг')],status=200}={}){
 const nodes=new Map(),events=new Map(),changes=[];
 const node=id=>{if(!nodes.has(id))nodes.set(id,new Element());return nodes.get(id);};
 const location={href:'https://private.example'+path};
 const navigate=(kind,url)=>{location.href=new URL(url,location.href).href;changes.push({kind,url:location.href});};
 const history={pushState:(_state,_title,url)=>navigate('push',url),replaceState:(_state,_title,url)=>navigate('replace',url)};
 const context=vm.createContext({document:{getElementById:node,createElement:tag=>new Element(tag),createElementNS:(_ns,tag)=>new Element(tag)},location,history,localStorage:{getItem:()=>null,setItem(){}},window:{addEventListener:(name,callback)=>events.set(name,callback)},URL,Intl,Set,clearTimeout,setTimeout,queueMicrotask,fetch:async()=>new Response(JSON.stringify(items),{status})});
 await vm.runInContext(code,context);
 return {node,location,changes,async visit(path){location.href=new URL(path,location.href).href;events.get('popstate')?.();await Promise.resolve();}};
}

test('a direct article link opens its full story after loading the entire feed, even beyond the first page',async()=>{
 const items=Array.from({length:15},(_,i)=>row('item-'+i));
 const ui=await page({path:'/?article=item-14#news',items});
 assert.equal(ui.node('dialog').open,true);
 assert.equal(ui.node('article-title').textContent,'Новина item-14');
 assert.equal(ui.node('article-summary').textContent,'Повний виклад item-14');
 assert.equal(ui.node('article-detail').textContent,'Подробиці item-14');
 assert.equal(ui.changes.some(change=>change.kind==='push'),false);
});

test('a gambling deep link selects the separate feed and opens exactly its requested story',async()=>{
 const ui=await page({path:'/?article=casino#news'});
 assert.equal(ui.node('dialog').open,true);
 assert.equal(ui.node('article-title').textContent,'Новина casino');
 assert.equal(ui.node('gambling-guide').hidden,false);
 assert.equal(new URL(ui.location.href).searchParams.get('topic'),'gambling');
});

test('unknown and invalid article links do not substitute a different story and show a clear status',async()=>{
 for(const path of ['/?article=missing#news','/?article=%3Cscript%3E#news','/?article=first&article=casino#news']){
  const ui=await page({path});assert.equal(ui.node('dialog').open,false);
  assert.match(ui.node('count').textContent,/не знайдено/);
  assert.equal(ui.node('feed-title').focused,true);
  ui.node('list').querySelectorAll('.open-story')[0].onclick();
  ui.node('dialog').close();await Promise.resolve();
  assert.doesNotMatch(ui.node('count').textContent,/не знайдено/);
 }
 const unavailable=await page({path:'/?article=first#news',status:503});
 assert.equal(unavailable.node('dialog').open,false);
 assert.match(unavailable.node('count').textContent,/недоступна/);
 assert.doesNotMatch(unavailable.node('count').textContent,/не знайдено/);
});

test('story navigation keeps the URL, dialog and browser history aligned',async()=>{
 const ui=await page();
 ui.node('list').querySelectorAll('.open-story')[0].onclick();
 assert.equal(new URL(ui.location.href).searchParams.get('article'),'first');
 assert.equal(ui.node('dialog').open,true);
 await ui.visit('/#news');assert.equal(ui.node('dialog').open,false);
 await ui.visit('/?article=first#news');assert.equal(ui.node('dialog').open,true);
 ui.node('dialog').close();await Promise.resolve();
 assert.equal(new URL(ui.location.href).searchParams.has('article'),false);
 assert.equal(ui.node('dialog').open,false);
});
