import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
const code=await readFile(new URL("./runtime.mjs",import.meta.url),"utf8");
const {default:makeApp}=await import("data:text/javascript;base64,"+Buffer.from(code+"\nexport default makeApp;").toString("base64"));
const seed=JSON.parse(await readFile(new URL("../dist/news.json",import.meta.url),"utf8"));
const asset=Buffer.from("ABCDEF01234\n");
const app=makeApp({"/index.html":{type:"text/html; charset=utf-8",base64:asset.toString("base64"),size:asset.length},"/media/fly.mp4":{type:"video/mp4",base64:asset.toString("base64"),size:asset.length}},seed);
const entries = new Map();
let etag=0;
const BUCKET={
  async get(key) {
    const obj=entries.get(key);
    return obj ? {etag:obj.etag,json:async()=>JSON.parse(obj.body)}:null;
  },
  async put(key,body,{onlyIf}) {
    const existing=entries.get(key);
    if (onlyIf.etagDoesNotMatch==="*" && existing || onlyIf.etagMatches && existing?.etag!==onlyIf.etagMatches) return null;
    const record={etag:String(++etag),body};
    entries.set(key,record);
    return record;
  }
};
const host="https://site.example";
const req=(path,opts={})=>app.fetch(new Request(host+path,opts),{BUCKET});
const one={id:"worker-test",category:"Магазин",date:"2026-11-23",title:"Test",summary:"news",source:"https://developer.android.com/test",sourceLabel:"Official"};
const post=(items,headers={})=>req("/api/news",{method:"POST",headers:{"content-type":"application/json",...headers},body:JSON.stringify(items)});
assert.equal((await req("/")).status,200);
assert.equal(await (await req("/")).text(),asset.toString());
assert.equal((await req("/not-a-route")).status,404);
assert.equal((await req("/api/news")).status,405);
assert.equal((await req("/news.json",{method:"HEAD"})).headers.get("x-play-pulse-writable"),"yes");
assert.equal((await (await req("/news.json")).json()).length,seed.length);
const response=await req("/media/fly.mp4",{headers:{range:"bytes=1-4"}});
assert.equal(response.status,206); assert.equal(await response.text(),"BCDE");
assert.equal((await req("/media/fly.mp4",{headers:{range:"bytes=999-1000"}})).status,416);
assert.equal(await (await req("/media/fly.mp4",{headers:{range:"bytes=-3"}})).text(),"34\n");
assert.equal((await post([one],{origin:"https://other.example"})).status,403);
assert.equal((await post([one],{"sec-fetch-site":"cross-site"})).status,403);
assert.equal((await post([one],{"content-type":"application/x-www-form-urlencoded"})).status,415);
for(const bad of [{...one,date:"2026-02-31"},{...one,source:"https://support.google.com.evil.example/article"},{...one,source:"https://support.google.com@host.example/"},{...one,source:"javascript:alert(1)"}])
  assert.equal((await post([bad])).status,400);
assert.equal((await post([{...one,summary:"x".repeat(130*1024)}])).status,413);
const out=await (await post([one,one])).json();
assert.deepEqual(out,{ok:true,ids:[one.id],total:seed.length+1,changed:true});
assert.equal((await (await post([one])).json()).changed,false);
const both=await Promise.all([post([{...one,id:"first"}]),post([{...one,id:"second"}])]);
assert.ok(both.every(x=>x.ok));
const gambling={...one,id:"gambling-category-test",category:"Гемблінг",source:"https://support.google.com/googleplay/android-developer/answer/9877032"};
assert.equal((await post([gambling])).status,200);
assert.equal((await post([{...gambling,category:"Гемблинг"}])).status,400);
const regulatorSources=["https://www.dia.govt.nz/Online-Gambling-for-Providers",
  "https://www.legislation.gov.au/C2026A00072/asmade/2026-08-26/text/original/pdf",
  "https://www.congressonacional.leg.br/materias/medidas-provisorias/-/mpv/175871",
  "https://playcity.gov.ua/news/playcity-zaklykalo-mizhnarodni-kompanii-zupynyty-spivpratsiu-z-nelehalnym-hralnym-biznesom"];
assert.equal((await post(regulatorSources.map((source,index)=>({...gambling,id:"regulator-"+index,source})))).status,200);
for(const source of ["https://playcity.gov.ua.example/news","http://playcity.gov.ua/news","https://bad@playcity.gov.ua/news","https://playcity.gov.ua:444/news"])
  assert.equal((await post([{...gambling,source}])).status,400);
const channelReport={...gambling,id:"channel-report-test",source:"https://t.me/s/UaFf_Media/204",status:"Повідомлення каналу"};
const telegram={label:"Telegram",url:"https://t.me/android_broadcast/19"};
const unityContext={label:"Unity",url:"https://unity.com/legal/content-policy"};
assert.equal((await post([{...channelReport,id:"telegram-unity-context",sources:[unityContext]}])).status,200);
assert.equal((await post([{...channelReport,status:"Підтверджено Google",sources:[unityContext]}])).status,400);
assert.equal((await post([{...one,source:unityContext.url}])).status,400);
assert.equal((await post([{...gambling,source:"https://unity.com/legal/content-policy?x"}])).status,400);
assert.equal((await post([channelReport,{...gambling,id:"telegram-secondary",sources:[telegram]}])).status,200);
assert.equal((await post([{...channelReport,id:"telegram-corroborated",status:"Підтверджено Google",sources:[{label:"Google",url:gambling.source},telegram]}])).status,200);
for(const bad of [{...channelReport,status:undefined},{...channelReport,status:"verified"},{...channelReport,status:"Підтверджено Google",sources:[telegram]},
  {...channelReport,status:"Підтверджено Google",sources:[{label:"Regulator",url:regulatorSources[0]}]},
  {...channelReport,category:"Ігри"},{...gambling,category:"Магазин",sources:[{label:"Канал",url:"https://t.me/trafficarts/19"}]},
  ...["http://t.me/trafficarts/2","https://u@t.me/trafficarts/2","https://t.me:443/trafficarts/2",
    "https://t.me/trafficarts","https://t.me/+trafficarts","https://t.me/other_channel/2","https://t.me/trafficarts/0",
    "https://t.me/trafficarts/2?","https://t.me/trafficarts/2#","https://t.me/trafficarts/2/",
    "https://t.me/jump/../trafficarts/2","https://t.me/%74rafficarts/2","https://t.me/trafficarts/1e3"].map(source=>({...channelReport,source}))])
  assert.equal((await post([bad])).status,400);
const expandedOfficial=["https://firebase.google.com/support/release-notes/android","https://firebase.blog/posts/android-news","https://source.android.com/docs/security/bulletin/2026-11-01","https://www.apptweak.com/en/aso-blog/research",'https://github.com/google/bundletool/releases/tag/1.18.3','https://github.com/RevenueCat/purchases-android/releases/tag/11.0.0','https://developer.samsung.com/sdp/news/en/2026/10/28/update','https://digital-markets-act.ec.europa.eu/decision_en','https://appfigures.com/resources/insights/20261125-report'];
for(const [index,source] of expandedOfficial.entries())assert.equal((await post([{...one,id:"expanded-primary-"+index,source}])).status,200,source);
const expandedRegulators=["https://www.gamblingcommission.gov.uk/news/article/rules","https://www.mga.org.mt/rules/","https://www.gov.br/fazenda/pt-br/assuntos/noticias/rules"];
for(const [index,source] of expandedRegulators.entries()){
 assert.equal((await post([{...gambling,id:"expanded-regulator-"+index,source}])).status,200,source);
 assert.equal((await post([{...one,source}])).status,400,source);
}
const discoveryURLs=["https://9to5google.com/2026/11/20/report/","https://www.androidauthority.com/play-store-update/","https://androidweekly.net/issues/issue-754","https://t.me/GAppsLeaks/123","https://t.me/AndroidDevEU/10","https://t.me/android_broadcast/123","https://www.youtube.com/watch?v=AbcDef_12-3","https://youtube.com/@AndroidDevelopers"];
const expandedSources=discoveryURLs.map((url,index)=>({label:"Додаткове джерело "+index,url}));
assert.equal((await post([{...one,id:"expanded-supporting",sources:expandedSources}])).status,200);
for(const source of discoveryURLs)assert.equal((await post([{...one,source}])).status,400,source);
const traffnews={...channelReport,id:"traffnews-report",source:"https://t.me/traffnews/123"};
assert.equal((await post([traffnews])).status,200);
assert.equal((await post([{...traffnews,status:"Підтверджено Google",sources:[{label:"Firebase",url:"https://firebase.blog/posts/android-news"}]}])).status,200);
for(const bad of [{...traffnews,status:undefined},{...traffnews,status:"Підтверджено Google",sources:[{label:"AppTweak",url:expandedOfficial[3]}]},
 {...traffnews,sources:[expandedSources[0]]},{...gambling,sources:[{label:"Знахідка",url:"https://t.me/GAppsLeaks/123"}]},
 ...["https://www.gov.br/saude/pt-br/news","https://www.gov.br/fazenda/pt-br/%2e%2e/news","https://www.gov.br/fazenda/pt-br.evil/news"].map(source=>({...gambling,source})),
 ...["https://www.youtube.com/watch?v=short","https://www.youtube.com/watch?v=AbcDef_12-3&x=1","https://www.youtube.com/watch?v=AbcDef_12-3#","https://t.me/GAppsLeaks/123?x","https://t.me/traffnews/123#","https://9to5google.com:443/story","https://firebase.blog.evil.test/story","https://firebase.blog/\\evil"].map(url=>({...one,sources:[{label:"Unsafe",url}]}))])
 assert.equal((await post([bad])).status,400,JSON.stringify(bad));
assert.equal((await post([{...one,source:expandedOfficial[3],status:"Підтверджено Google"}])).status,400);
assert.equal((await post([{...one,id:"research-google-reference",source:expandedOfficial[3],status:"Підтверджено Google",sources:[{label:"Google",url:one.source}]}])).status,200);
const expandedRead=await (await req("/news.json")).json();
assert.deepEqual(expandedRead.find(item=>item.id==="expanded-supporting").sources.map(item=>item.url),["https://9to5google.com/2026/11/20/report/","https://www.androidauthority.com/play-store-update/","https://androidweekly.net/issues/issue-754","https://t.me/gappsleaks/123","https://t.me/androiddeveu/10","https://t.me/android_broadcast/123","https://www.youtube.com/watch?v=AbcDef_12-3","https://youtube.com/@AndroidDevelopers"]);
const news=await (await req("/news.json")).json();
assert.equal(news.find(i=>i.id===channelReport.id)?.source,"https://t.me/s/uaff_media/204");
assert.equal(news.find(i=>i.id===gambling.id)?.category,"Гемблінг");
for(const id of [one.id,"first","second"]) assert.ok(news.some(i=>i.id===id));
assert.equal((await app.fetch(new Request(host+"/api/news",{method:"POST",body:"[]"}))).status,503);
console.log("Worker checked: asset serving/ranges, seed merge, bounded validation, same-origin policy, repeat/concurrent updates, missing R2.");

for(const source of ['https://github.com/other/bundletool/releases/tag/1.0', 'https://github.com/google/bundletool/issues/1', 'https://appfigures.com/account', 'https://kansspelautoriteit.nl/nieuws/rules'])assert.equal((await post([{...gambling,source}])).status,400,source);
const archivedDutch={...gambling,id:"retired-archive",source:"https://kansspelautoriteit.nl/nieuws/rules"};
const archiveApp=makeApp({},[one,archivedDutch]);
assert.deepEqual((await (await archiveApp.fetch(new Request(host+"/news.json"),{})).json()).map(x=>x.id),[one.id]);
