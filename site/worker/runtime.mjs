// Only deploy behind Sites' owner-private access boundary. Sites consumes the
// service bearer before forwarding; no credential is accepted in app payloads.
const UPDATE_KEY = "news/updates-v1.json";
const MAX_BODY = 128 * 1024;
const MAX_RECORDS = 1500;
const CATEGORIES = new Set(["Політики","Публікація","Монетизація","Ігри","Магазин","API","Гемблінг"]);
const GOOGLE_HOSTS = new Set(["blog.google","developer.android.com","android-developers.googleblog.com","android.com","www.android.com","support.google.com","developers.google.com","google.play","play.google.com","status.play.google.com","firebase.google.com","firebase.blog","source.android.com"]);
const REGULATORS = new Set(["www.gamblingcommission.gov.uk","www.mga.org.mt","www.gov.br"]);
const EDITORIAL_HOSTS = new Set(["9to5google.com","www.androidauthority.com","androidweekly.net"]);
// Only publisher-owned release and research pages on these platforms.
const publisherPaths = new Map([
  ['github.com', /^\/(?:google\/bundletool|RevenueCat\/purchases-android)\/releases\/tag\/[\w.-]+$/],
  ['developer.samsung.com', /^\/sdp\/news\/en\/\d{4}\/\d{2}\/\d{2}\/[\w-]+\/?$/],
  ['appfigures.com', /^\/resources\/insights\/.+/]
]);
const HOSTS = new Set([...GOOGLE_HOSTS,...REGULATORS,...EDITORIAL_HOSTS,...publisherPaths.keys(),"digital-markets-act.ec.europa.eu","www.apptweak.com","www.dia.govt.nz","www.legislation.gov.au","www.congressonacional.leg.br","playcity.gov.ua","www.youtube.com","youtube.com"]);
const TELEGRAM_HANDLES = new Set(["trafficarts","uaff_media","affhubmedia","igaming_news","playcityukr","android_broadcast","traffnews"]);
const VIDEO_RE = /^https:\/\/(?:www\.)?youtube\.com\/(?:@AndroidDevelopers|watch\?v=[A-Za-z0-9_-]{11})$/;
const encode = value => JSON.stringify(value);
const json = (value, status = 200, extra = {}) => new Response(encode(value), {
  status, headers: {"content-type":"application/json; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff", ...extra}
});
const plain = (value, max, required = true) => {
  if ((!required && value === undefined)) return undefined;
  if (typeof value !== "string" || value.length > max || !value.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw new Error("Invalid text field");
  return value.trim();
};
const sourceURL = (value,category,supporting=false) => {
  const raw = plain(value, 1200);
  if(!/^https:\/\/[a-z0-9.-]+\//i.test(raw)||/[\s\\]/.test(raw))throw new Error("Use a supported public HTTPS source");
  const url = new URL(raw);
  if(category==="Гемблінг" && raw==="https://unity.com/legal/content-policy") return raw;
  if (url.hostname === "t.me") {
    // Raw validation rejects normalized paths, default ports and redirect params.
    const post = /^https:\/\/t\.me\/(s\/)?([a-z0-9_]+)\/([1-9][0-9]*)$/i.exec(raw),handle=post?.[2].toLowerCase();
    const legacy=category==="Гемблінг"&&TELEGRAM_HANDLES.has(handle);
    const discovery=supporting&&(handle==="android_broadcast"||(handle==="gappsleaks"||handle==="androiddeveu")&&category!=="Гемблінг");
    if(!post||!legacy&&!discovery)throw new Error("Use an allowed public Telegram post in its supported source role");
    return "https://t.me/"+(post[1]?"s/":"")+handle+"/"+post[3];
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port || !HOSTS.has(url.hostname)) throw new Error("Use a supported official HTTPS source");
  const publisherPath = publisherPaths.get(url.hostname);
  if(publisherPath && !publisherPath.test(url.pathname)) throw new Error("Use a release or article from the selected publisher");
  if(EDITORIAL_HOSTS.has(url.hostname)&&!supporting)throw new Error("Media can be an additional source only");
  if(["www.youtube.com","youtube.com"].includes(url.hostname)&&(!supporting||!VIDEO_RE.test(raw)))throw new Error("Use an Android Developers channel or video as an additional source only");
  if(REGULATORS.has(url.hostname)&&(category!=="Гемблінг"||url.hostname==="www.gov.br"&&!url.pathname.startsWith("/fazenda/pt-br/")))throw new Error("Use a gambling regulator's public source");
  if ((url.hostname === "support.google.com" && url.pathname.startsWith("/accounts/")) ||
      (url.hostname === "www.android.com" && url.pathname.startsWith("/intent/"))) throw new Error("Use a public source");
  return url.href;
};
const discoverySource = (raw,category) => {
 const url=new URL(raw);
 return EDITORIAL_HOSTS.has(url.hostname)||["www.youtube.com","youtube.com"].includes(url.hostname)||url.hostname==="t.me"&&(url.pathname.toLowerCase().includes("/gappsleaks/")||url.pathname.toLowerCase().includes("/androiddeveu/")||category!=="Гемблінг"&&url.pathname.toLowerCase().includes("/android_broadcast/"));
};
const validDate = date => {
  if (typeof date !== "string" || !/^20\d{2}-(0[1-9]|1[0-2])(?:-(0[1-9]|[12]\d|3[01]))?$/.test(date)) return false;
  if (date.length === 7) return true;
  return new Date(date + "T00:00:00.000Z").toISOString().slice(0,10) === date;
};
function validated(x) {
  if (!x || typeof x !== "object" || Array.isArray(x) || typeof x.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,95}$/.test(x.id) || !validDate(x.date) || !CATEGORIES.has(x.category)) throw new Error("Invalid id, date or category");
  const out = {id:x.id,date:x.date,category:x.category,title:plain(x.title,240),summary:plain(x.summary,1400),source:sourceURL(x.source,x.category),sourceLabel:plain(x.sourceLabel,95)};
  for (const [k,max] of [["detail",3600],["status",70]]) {
    const field=plain(x[k],max,false); if(field !== undefined) out[k]=field;
  }
  if (x.sources !== undefined) {
    if (!Array.isArray(x.sources) || x.sources.length > 8) throw new Error("Invalid additional sources");
    out.sources=x.sources.map(entry=>({label:plain(entry?.label,95),url:sourceURL(entry?.url,x.category,true)}));
  }
  if(new URL(out.source).hostname==="t.me" &&
     out.status!=="Повідомлення каналу" &&
     !(out.status==="Підтверджено Google" && out.sources?.some(entry=>GOOGLE_HOSTS.has(new URL(entry.url).hostname))))
    throw new Error("Telegram primary source requires a channel-report status or an official Google corroborating source");
  const googleCorroborated=[out.source,...(out.sources||[]).map(entry=>entry.url)].some(url=>GOOGLE_HOSTS.has(new URL(url).hostname));
  if(out.status==="Підтверджено Google"&&!googleCorroborated)throw new Error("Google confirmation requires an official Google source");
  if(["t.me","unity.com"].includes(new URL(out.source).hostname)&&!googleCorroborated&&out.sources?.some(entry=>discoverySource(entry.url,x.category)))throw new Error("Discovery links require an official primary source or Google corroboration");
  return out;
}
async function readBoundedJSON(request, maxBytes) {
  if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers.get("content-type") || "")) return {error:415, reason:"Expected application/json"};
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > maxBytes) return {error:413,reason:"Body too large"};
  if (!request.body) return {error:400,reason:"Body is required"};
  const reader=request.body.getReader(), chunks=[];
  let length=0;
  try {
    for (;;) {
      const {done,value}=await reader.read();
      if (done) break;
      length+=value.byteLength;
      if(length>maxBytes) { await reader.cancel(); return {error:413,reason:"Body too large"}; }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset=0;
    for (const chunk of chunks) { bytes.set(chunk,offset); offset+=chunk.byteLength; }
    const payload=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));
    return {payload};
  } catch { return {error:400,reason:"Invalid JSON"}; }
  finally {reader.releaseLock();}
}
async function parseBounded(request) {
  const body=await readBoundedJSON(request,MAX_BODY);
  if(body.error) return body;
  const {payload}=body;
  try {
    if (!Array.isArray(payload) || !payload.length || payload.length>32) throw new Error("Supply a non-empty JSON array of up to 32 entries");
    return {entries:[...new Map(payload.map(item=>[item?.id,validated(item)])).values()]};
  } catch(error) { return {error:400,reason:error.message || "Invalid news entry"}; }
}
const sortNews = items => items.sort((a,b)=>b.date.localeCompare(a.date)||a.id.localeCompare(b.id));
// Retain the stored archive while withdrawing Ksa stories from all readers.
export const visibleNews = items => items.filter(item => !/^https:\/\/kansspelautoriteit\.nl\//i.test(item.source));
const merged = (seed,items) => sortNews([...new Map([...seed,...items].map(i=>[i.id,i])).values()]);
async function readUpdates(bucket) {
  const obj=await bucket.get(UPDATE_KEY);
  if(!obj) return {entries:[], etag:null};
  const entries=await obj.json();
  if(!Array.isArray(entries)) throw new Error("Invalid persisted news archive");
  return {entries, etag:obj.etag};
}
async function upsert(request,bucket,url,seed) {
  const origin=request.headers.get("origin");
  const fetchSite=request.headers.get("sec-fetch-site");
  if ((origin && origin!==url.origin) || (fetchSite && !["same-origin","none"].includes(fetchSite))) return json({ok:false,error:"Cross-origin writes are not allowed"},403);
  if(!bucket) return json({ok:false,error:"News storage is unavailable"},503);
  const input=await parseBounded(request);
  if(input.error) return json({ok:false,error:input.reason},input.error);
  const insertOnly=request.headers.get("x-play-pulse-insert-only")==="1";
  try {
    for(let tries=0; tries<4; tries++) {
      const saved=await readUpdates(bucket);
      // Recheck every CAS snapshot: an owner may create or edit an ID after a
      // bridge's earlier feed read. Existing seed and saved records take priority.
      const existing=insertOnly?new Set([...seed,...saved.entries].map(item=>item.id)):null;
      const accepted=insertOnly?input.entries.filter(item=>!existing.has(item.id)):input.entries;
      const entries=merged(saved.entries,accepted);
      if(entries.length>MAX_RECORDS) return json({ok:false,error:"Archive capacity reached; no records were changed"},409);
      const prior=new Map(saved.entries.map(x=>[x.id,encode(x)]));
      const unchanged=accepted.every(x=>prior.get(x.id)===encode(x));
      if(!unchanged) {
        const onlyIf=saved.etag?{etagMatches:saved.etag}:{etagDoesNotMatch:"*"};
        const written=await bucket.put(UPDATE_KEY,encode(entries),{onlyIf,httpMetadata:{contentType:"application/json"}});
        if(!written) continue;
      }
      return json({ok:true,ids:accepted.map(x=>x.id),total:visibleNews(merged(seed,entries)).length,changed:!unchanged});
    }
    return json({ok:false,error:"Concurrent write; retry the same request"},409);
  } catch {return json({ok:false,error:"News storage write failed"},503);}
}
// This cabinet is an additional sign-in inside Sites' owner-private gate.
// Do not set wider Sites access while account setup or service writes are enabled.
const OWNER_KEY = "account/admin-v1.json";
const SESSIONS_KEY = "account/sessions-v1.json";
const LOGIN_RATE_LIMIT = 8;
const LOGIN_WINDOW = 10 * 60 * 1000;
const SESSION_AGE = 12 * 60 * 60;
const SESSION_LIMIT = 8;
const ITERATIONS = 100_000; // workerd per-call PBKDF2 cap
const PASSWORD_ALGORITHM = "HMAC-PEPPER-PBKDF2-SHA256-v1";
const COOKIE = "__Host-pp-session";
const utf8 = new TextEncoder();
const hex = bytes => Array.from(bytes,b=>b.toString(16).padStart(2,"0")).join("");
const randomHex = bytes => hex(crypto.getRandomValues(new Uint8Array(bytes)));
const bytesOf = value => Uint8Array.from(value.match(/../g),b=>parseInt(b,16));
const sha = async value => hex(new Uint8Array(await crypto.subtle.digest("SHA-256",utf8.encode(value))));
const visitorId = request => request.headers.get("oai-authenticated-user-id");
const accountError = (status,code,error,headers={}) => json({ok:false,code,error},status,headers);
const noSession = () => accountError(401,"sign_in_required","Увійди до кабінету Play Pulse.");
const errorLogin = () => accountError(401,"invalid_credentials","Неправильний логін або пароль.");
const missingStore = () => accountError(503,"service_unavailable","Кабінет тимчасово недоступний.");
const denied = () => accountError(403,"forbidden","Доступ дозволено лише власнику сайту.");
const conflict = () => accountError(409,"state_conflict","Стан кабінету змінився. Онови сторінку й повтори.");
const methodError = method => accountError(405,"method_not_allowed","Цей метод не підтримується.",{allow:method});
const cookieHeader = (secret,age) => `${COOKIE}=${secret}; Max-Age=${age}; Path=/; Secure; HttpOnly; SameSite=Strict`;
const privateRequest = (request,url) => {
  const origin=request.headers.get("origin"), sec=request.headers.get("sec-fetch-site");
  return origin===url.origin && (!sec || sec==="same-origin");
};
const okState = (account,authenticated,cookie) => json({
  ok:true,configured:!!account,authenticated,
  ...(authenticated ? {username:account.username,role:"admin"} : {})
},200,cookie ? {"set-cookie":cookieHeader(cookie,SESSION_AGE)} : {});
const isRecord = value => value && typeof value==="object" && !Array.isArray(value);
const hasKeys = (obj,...names) => isRecord(obj) && Object.keys(obj).length===names.length && names.every(k=>Object.hasOwn(obj,k));
const usernameOf = value => typeof value==="string" && /^[a-zA-Z][a-zA-Z0-9._-]{2,31}$/.test(value) ? value.toLowerCase() : null;
function validPassword(value) {
  if(typeof value!=="string" || value.length>256 || /[\u0000-\u001f\u007f]/.test(value)) return false;
  const count=Array.from(value).length;
  return count>=12 && count<=128 && utf8.encode(value).byteLength<=512;
}
async function hashPassword(value,salt,pepper) {
  const pepperKey=await crypto.subtle.importKey("raw",bytesOf(pepper),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  const material=new Uint8Array(await crypto.subtle.sign("HMAC",pepperKey,utf8.encode(value)));
  const key=await crypto.subtle.importKey("raw",material,"PBKDF2",false,["deriveBits"]);
  material.fill(0);
  const digest=new Uint8Array(await crypto.subtle.deriveBits({
    name:"PBKDF2",hash:"SHA-256",salt:bytesOf(salt),iterations:ITERATIONS
  },key,256));
  const result=hex(digest); digest.fill(0);
  return result;
}
function equalHash(a,b) {
  if(typeof a!=="string" || typeof b!=="string" || a.length!==64 || b.length!==64) return false;
  let d=0;
  for(let i=0;i<64;i++) d|=a.charCodeAt(i)^b.charCodeAt(i);
  return d===0;
}
const passwordSpec = async (password,pepper) => {
  const salt=randomHex(24);
  return {salt,passwordHash:await hashPassword(password,salt,pepper),algorithm:PASSWORD_ALGORITHM,iterations:ITERATIONS,epoch:randomHex(24)};
};
async function readStore(bucket,key) {
  const item=await bucket.get(key);
  return item ? {value:await item.json(),etag:item.etag} : {value:null,etag:null};
}
function writeStore(bucket,key,value,etag) {
  return bucket.put(key,encode(value),{
    onlyIf:etag?{etagMatches:etag}:{etagDoesNotMatch:"*"},
    httpMetadata:{contentType:"application/json"}
  });
}
async function readAccount(bucket) {
  const found=await readStore(bucket,OWNER_KEY);
  const a=found.value;
  if(a!==null && (!isRecord(a) || a.role!=="admin" || a.algorithm!==PASSWORD_ALGORITHM ||
      a.iterations!==ITERATIONS || !usernameOf(a.username) || !/^[a-f0-9]{64}$/.test(a.owner) ||
      !/^[a-f0-9]{64}$/.test(a.passwordHash) || !/^[a-f0-9]{48}$/.test(a.salt) ||
      !/^[a-f0-9]{48}$/.test(a.epoch))) throw Error("Invalid cabinet record");
  return found;
}
const tokenOf = request => {
  const candidates=(request.headers.get("cookie") || "").split(";").map(x=>x.trim()).filter(x=>x.startsWith(COOKIE+"="));
  if(candidates.length!==1) return null;
  const token=candidates[0].slice(COOKIE.length+1);
  return /^[a-f0-9]{64}$/.test(token) ? token : null;
};
async function readSessions(bucket) {
  const found=await readStore(bucket,SESSIONS_KEY);
  if(found.value!==null && !Array.isArray(found.value)) throw Error("Invalid session state");
  return {...found,value:found.value||[]};
}
const validSessionRecord = (entry,account,now) => entry?.owner===account.owner && entry?.epoch===account.epoch && Number.isFinite(entry.expires) && entry.expires>now;
async function findSession(request,bucket,account) {
  const token=tokenOf(request);
  if(!token || !account) return null;
  const digest=await sha(token);
  const {value}=await readSessions(bucket);
  const now=Date.now();
  return value.find(entry=>validSessionRecord(entry,account,now) && equalHash(entry.digest,digest)) || null;
}
async function makeSession(bucket,account) {
  const token=randomHex(32), digest=await sha(token);
  for(let tries=0;tries<5;tries++) {
    const {value,etag}=await readSessions(bucket), now=Date.now();
    // Preserve entries from other epochs while updating; an older-epoch
    // login cannot remove a concurrent password change's new session.
    const live=value.filter(entry=>entry?.expires>now);
    const myEpoch=live.filter(entry=>validSessionRecord(entry,account,now));
    if(myEpoch.length>=SESSION_LIMIT) {
      const expiredId=myEpoch.sort((a,b)=>a.expires-b.expires)[0].digest;
      live.splice(live.findIndex(entry=>entry.digest===expiredId),1);
    }
    live.push({digest,owner:account.owner,epoch:account.epoch,expires:now+SESSION_AGE*1000});
    if(live.length>128) throw Error("Unexpected cabinet session volume");
    if(await writeStore(bucket,SESSIONS_KEY,live,etag)) return token;
  }
  throw Error("Concurrent session creation");
}
async function revokeSession(bucket,session) {
  if(!session) return;
  for(let tries=0;tries<5;tries++) {
    const {value,etag}=await readSessions(bucket);
    const remaining=value.filter(entry=>entry?.digest!==session.digest);
    if(remaining.length===value.length || await writeStore(bucket,SESSIONS_KEY,remaining,etag)) return;
  }
  throw Error("Concurrent session revocation");
}
// The budget is reserved with an R2 compare-and-set before running PBKDF2.
// All attempts count, so parallel requests cannot bypass throttling.
async function consumeAttempt(bucket,owner) {
  const key="account/rate-"+owner+".json";
  for(let tries=0;tries<5;tries++) {
    const {value,etag}=await readStore(bucket,key), now=Date.now();
    const active=Number.isSafeInteger(value?.until)&&Number.isSafeInteger(value?.attempts)&&value.until>now;
    const until=active?value.until:now+LOGIN_WINDOW, attempts=active?value.attempts:0;
    if(attempts>=LOGIN_RATE_LIMIT) return Math.max(1,Math.ceil((until-now)/1000));
    if(await writeStore(bucket,key,{until,attempts:attempts+1},etag)) return 0;
  }
  return 2;
}
async function throttle(bucket,owner) {
  const seconds=await consumeAttempt(bucket,owner);
  return seconds ? accountError(429,"rate_limited","Забагато спроб. Спробуй трохи пізніше.",{"retry-after":String(seconds)}) : null;
}
async function cabinet(request,env,url,seed) {
  const bucket=env.BUCKET, pepper=env.PP_PASSWORD_PEPPER;
  const id=visitorId(request);
  if(!id || id.length>512) return accountError(401,"platform_identity_required","Потрібно увійти через ChatGPT.");
  const path=url.pathname;
  const isState=path==="/api/account";
  const isSetup=path==="/api/account/setup", isLogin=path==="/api/account/login";
  const isLogout=path==="/api/account/logout", isPassword=path==="/api/account/password";
  const isAdmin=path==="/api/admin/news";
  if(!isState&&!isSetup&&!isLogin&&!isLogout&&!isPassword&&!isAdmin) return accountError(404,"not_found","Сторінку не знайдено.");
  if(isState?request.method!=="GET":request.method!=="POST") return methodError(isState?"GET":"POST");
  if(!isState&&!privateRequest(request,url)) return accountError(403,"bad_origin","Запит має надходити з цього сайту.");
  if(!bucket || typeof pepper!=="string" || !/^[a-f0-9]{64}$/.test(pepper)) return missingStore();
  try {
    const owner=await sha(id);
    const state=await readAccount(bucket), account=state.value;
    if(account && !equalHash(owner,account.owner)) return denied();
    if(isState) return okState(account,!!await findSession(request,bucket,account));
    const session=(isAdmin || isLogout || isPassword)?await findSession(request,bucket,account):null;
    if(isAdmin) return session ? upsert(request,bucket,url,seed) : noSession();
    if(isPassword && !session) return noSession();
    const body=await readBoundedJSON(request,8192);
    if(body.error) return accountError(body.error,"bad_request","Очікується коректний JSON.");
    const data=body.payload;
    if(isLogout) {
      if(!hasKeys(data)) return accountError(400,"bad_request","Дані запиту неправильні.");
      await revokeSession(bucket,session);
      return json({ok:true,configured:!!account,authenticated:false},200,{"set-cookie":cookieHeader("",0)});
    }
    if(isPassword) {
      if(!hasKeys(data,"currentPassword","password") || !validPassword(data.currentPassword) || !validPassword(data.password) || data.currentPassword===data.password)
        return accountError(400,"bad_password","Новий пароль має бути іншим і містити 12–128 символів.");
      const limited=await throttle(bucket,owner);
      if(limited) return limited;
      if(!equalHash(await hashPassword(data.currentPassword,account.salt,pepper),account.passwordHash)) return errorLogin();
      const next={...account,...await passwordSpec(data.password,pepper)};
      if(!await writeStore(bucket,OWNER_KEY,next,state.etag)) return conflict();
      // Previously issued sessions are rejected immediately by comparing epoch.
      return okState(next,true,await makeSession(bucket,next));
    }
    const username=usernameOf(data?.username);
    if(!hasKeys(data,"username","password") || !username || !validPassword(data.password)) return isLogin ? errorLogin() :
      accountError(400,"bad_credentials","Логін: 3–32 латинські символи, починається з літери. Пароль: 12–128 символів.");
    if(isSetup) {
      if(account) return conflict();
      const limited=await throttle(bucket,owner);
      if(limited) return limited;
      const created={owner,username,role:"admin",...await passwordSpec(data.password,pepper)};
      if(!await writeStore(bucket,OWNER_KEY,created,null)) return conflict();
      return okState(created,true,await makeSession(bucket,created));
    }
    if(!account) return errorLogin();
    const limited=await throttle(bucket,owner);
    if(limited) return limited;
    const matches=equalHash(await hashPassword(data.password,account.salt,pepper),account.passwordHash);
    if(!matches || username!==account.username) return errorLogin();
    // If a password change raced with this successful check, no new old session.
    if((await readAccount(bucket)).value?.epoch!==account.epoch) return conflict();
    return okState(account,true,await makeSession(bucket,account));
  } catch {return missingStore();}
}
function serveAsset(request,asset) {
  const {type,base64,size}=asset;
  const range=request.headers.get("range");
  const headers=new Headers({"content-type":type,"content-length":String(size),"x-content-type-options":"nosniff","referrer-policy":"strict-origin-when-cross-origin","cache-control": type.startsWith("text/html")?"no-cache":"private, max-age=3600"});
  if(type==="video/mp4") headers.set("accept-ranges","bytes");
  let from=0,to=size-1,status=200;
  if(range && type==="video/mp4") {
    const parsed=/^bytes=(\d*)-(\d*)$/.exec(range);
    if(parsed && (parsed[1] || parsed[2])) {
      from=parsed[1]?Number(parsed[1]):Math.max(0,size-Number(parsed[2]));
      to=parsed[1] && parsed[2]?Math.min(size-1,Number(parsed[2])):size-1;
      if(!Number.isSafeInteger(from)||!Number.isSafeInteger(to)||from>to||from>=size) {
        headers.set("content-range",`bytes */${size}`); headers.delete("content-length");
        return new Response(null,{status:416,headers});
      }
      status=206;
      headers.set("content-range",`bytes ${from}-${to}/${size}`);
      headers.set("content-length",String(to-from+1));
    }
  }
  if(request.method==="HEAD") return new Response(null,{status,headers});
  const lead=Math.floor(from/3)*3;
  const encodedPart=base64.slice(lead/3*4,Math.ceil((to+1)/3)*4);
  const buf=Uint8Array.from(atob(encodedPart),c=>c.charCodeAt(0));
  return new Response(buf.subarray(from-lead,to-lead+1),{status,headers});
}
export function makeApp(assets,seed) {
  return {async fetch(request,env={}) {
    const url=new URL(request.url), path=url.pathname;
    if (path==="/api/news") {
      if(request.method!=="POST") return methodError("POST");
      // Only Sites dispatch's non-visitor service route may use this legacy
      // writer. Real browser sessions must use the cabinet's admin route.
      if(request.headers.has("oai-authenticated-user-id") || request.headers.has("origin") || request.headers.has("sec-fetch-site") || request.headers.has("cookie")) return denied();
      return upsert(request,env.BUCKET,url,seed);
    }
    if(path==="/api/account" || path.startsWith("/api/account/") || path==="/api/admin/news")
      return cabinet(request,env,url,seed);
    if (!["GET","HEAD"].includes(request.method)) return new Response(null,{status:405,headers:{"allow":"GET, HEAD"}});
    if (path==="/news.json") {
      const headers={"x-play-pulse-writable":env.BUCKET?"yes":"no"};
      let entries=[];
      try {if(env.BUCKET) entries=(await readUpdates(env.BUCKET)).entries;}
      catch {headers["x-play-pulse-writable"]="unavailable";}
      if(request.method==="HEAD") return new Response(null,{headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store",...headers}});
      return json(visibleNews(merged(seed,entries)),200,headers);
    }
    const name=path==="/"?"/index.html":path;
    if(Object.hasOwn(assets,name)) return serveAsset(request,assets[name]);
    return new Response("Not found",{status:404});
  }};
}
