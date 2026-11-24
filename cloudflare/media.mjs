const MAX_HTML=128*1024,MAX_SOURCES=2;
const TELEGRAM_POST=/^\/(?:s\/)?(trafficarts|uaff_media|affhubmedia|igaming_news|playcityukr|android_broadcast|gappsleaks|traffnews)\/([1-9]\d*)\/?$/i;
const decode=text=>text.replace(/&(?:amp|quot|apos|lt|gt|#\d{1,7}|#x[0-9a-f]{1,6});/gi,entity=>{
 const value=entity.slice(1,-1),named={amp:'&',quot:'"',apos:"'",lt:'<',gt:'>'};
 if(Object.hasOwn(named,value.toLowerCase()))return named[value.toLowerCase()];
 const code=Number.parseInt(value.slice(value[1]?.toLowerCase()==='x'?2:1),value[1]?.toLowerCase()==='x'?16:10);
 return code>0&&code<=0x10ffff?String.fromCodePoint(code):entity;
});
function safeURL(raw){
 if(typeof raw!=='string'||raw.length>2000||!/^https:\/\//i.test(raw)||/[\s\\]/u.test(raw))return null;
 const authority=/^https:\/\/([^/?#]+)/i.exec(raw)?.[1];if(!authority||/[:@]/.test(authority))return null;
 try{const url=new URL(raw);return url.protocol==='https:'&&!url.username&&!url.password&&!url.port?url:null;}catch{return null;}
}
function source(raw){
 const url=safeURL(raw);if(!url||url.search||url.hash)return null;
 const {hostname,pathname}=url;
 const google=hostname==='blog.google'&&/^\/(?:(?:products-and-platforms\/(?:platforms|products)\/[^/]+)|(?:products\/[^/]+)|(?:intl\/[a-z]{2}(?:-[a-z]{2})?\/(?:(?:products\/[^/]+)|(?:sirket-haberleri))))\/[^/]+\/?$/i.test(pathname)||
  hostname==='developer.android.com'&&/^\/blog\/posts\/[^/]+\/?$/.test(pathname)||
  hostname==='android-developers.googleblog.com'&&/^\/20\d{2}\/\d{2}\/[^/]+\.html$/.test(pathname);
 if(google)return {url:url.href,kind:'google',requestURL:url.href};
 const post=hostname==='t.me'?TELEGRAM_POST.exec(pathname):null;
 return post?{url:url.href,kind:'telegram',post:post[1].toLowerCase()+'/'+post[2],requestURL:'https://t.me/'+post[1]+'/'+post[2]+'?embed=1'}:null;
}
function mediaURL(raw,kind,type,fromVideoTag=false){
 const url=safeURL(raw);if(!url||url.hash)return null;
 const {hostname,pathname}=url;
 const allowed=kind==='telegram'?/^cdn\d+\.telesco\.pe$/.test(hostname)&&/^\/file\/[^/]+$/.test(pathname):
  hostname==='storage.googleapis.com'&&/^\/gweb-uniblog-publish-prod\/(?:images|videos)\/[^/]+$/.test(pathname)||
  hostname==='developer.android.com'&&/^\/static\/blog\/assets\/[^/]+$/.test(pathname)||
  /^(?:[a-z0-9-]+\.)?googleusercontent\.com$/.test(hostname)&&pathname.length>12;
 if(!allowed||/(?:^|[\/_-])(?:logo|avatar|favicon|userpic|default)(?:[\/_\-.]|$)/i.test(decode(pathname)))return null;
 if(type==='video'?!/\.mp4$/i.test(pathname)&&!(kind==='telegram'&&fromVideoTag&&/^\/file\/[\w-]{20,}$/.test(pathname)):/\.(?:svg|ico|mp4|m3u8)$/i.test(pathname))return null;
 return url.href;
}
function attributes(tag){
 const values=Object.create(null),pattern=/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
 for(const match of tag.matchAll(pattern)){const name=match[1].toLowerCase();if(!Object.hasOwn(values,name))values[name]=decode(match[2]??match[3]??match[4]);}
 return values;
}
const cleanHTML=text=>text.replace(/<!--[\s\S]*?(?:-->|$)|<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi,'');
function officialMedia(text,entry){
 const values=new Map();
 for(const tag of text.matchAll(/<meta\b[^>]{0,8192}>/gi)){const attrs=attributes(tag[0]),key=(attrs.property||attrs.name||'').toLowerCase();if(attrs.content&&!values.has(key))values.set(key,attrs.content);}
 for(const [type,keys] of [['video',['og:video:secure_url','og:video:url','og:video']],['photo',['og:image:secure_url','og:image:url','og:image']]])
  for(const key of keys){const url=mediaURL(values.get(key),entry.kind,type);if(url)return {type,url,sourceUrl:entry.url};}
 return null;
}
function telegramMedia(text,entry){
 let start=-1,end=-1,depth=0;
 for(const tag of text.matchAll(/<\/?div\b[^>]*>/gi)){
  const closing=/^<\//.test(tag[0]);
  if(start<0){if(!closing&&attributes(tag[0])['data-post']?.toLowerCase()===entry.post){start=tag.index;depth=1;}}
  else {depth+=closing?-1:1;if(depth===0){end=tag.index+tag[0].length;break;}}
 }
 if(start<0||end<0)return null;
 const post=text.slice(start,end);
 for(const tag of post.matchAll(/<video\b[^>]*>/gi)){const url=mediaURL(attributes(tag[0]).src,'telegram','video',true);if(url)return {type:'video',url,sourceUrl:entry.url};}
 for(const tag of post.matchAll(/<a\b[^>]*>/gi)){
  const attrs=attributes(tag[0]);if(!/(?:^|\s)tgme_widget_message_photo_wrap(?:\s|$)/.test(attrs.class||''))continue;
  const image=/background-image\s*:\s*url\(\s*(['"]?)(.*?)\1\s*\)/i.exec(attrs.style||'')?.[2],url=mediaURL(image,'telegram','photo');
  if(url)return {type:'photo',url,sourceUrl:entry.url};
 }
 return null;
}
function abort(signal){if(signal?.aborted)throw signal.reason||new DOMException('Operation aborted','AbortError');}
async function readHTML(response,{headOnly,signal}){
 if(!response.ok||response.redirected||!/^text\/html(?:\s*;|\s*$)/i.test(response.headers.get('content-type')||'')||!response.body){void response.body?.cancel().catch(()=>{});return null;}
 const reader=response.body.getReader(),decoder=new TextDecoder();let bytes=0,text='',cancelled=false;
 try{
  while(bytes<MAX_HTML){
   abort(signal);let stop;
   const pendingAbort=new Promise((_,reject)=>{stop=()=>reject(signal.reason||new DOMException('Operation aborted','AbortError'));signal.addEventListener('abort',stop,{once:true});});
   let result;try{result=await Promise.race([reader.read(),pendingAbort]);}finally{signal.removeEventListener('abort',stop);}
   if(result.done)return text+decoder.decode();
   const available=Math.min(result.value.byteLength,MAX_HTML-bytes);text+=decoder.decode(result.value.subarray(0,available),{stream:true});bytes+=available;
   if(headOnly&&/<\/head\s*>/i.test(text)||bytes===MAX_HTML){cancelled=true;void reader.cancel().catch(()=>{});return text;}
  }
  return text;
 }finally{if(!cancelled)void reader.cancel().catch(()=>{});reader.releaseLock();}
}

// Public article metadata only. No owner, feed or Telegram credentials are used.
// A failed source never blocks publication of the complete text.
export async function resolveArticleMedia(item,{fetchFn=fetch,signal}={}){
 abort(signal);
 const candidates=[...new Map((item?.links||[]).map(link=>source(link?.url)).filter(Boolean).map(entry=>[entry.url,entry])).values()]
  .sort((a,b)=>(a.kind==='telegram')-(b.kind==='telegram')).slice(0,MAX_SOURCES);
 const timeout=AbortSignal.timeout(4000),requestSignal=signal?AbortSignal.any([signal,timeout]):timeout;
 for(const entry of candidates){
  try{
   abort(requestSignal);
   const response=await fetchFn(entry.requestURL,{method:'GET',redirect:'manual',credentials:'omit',headers:{accept:'text/html'},signal:requestSignal});
   const text=await readHTML(response,{headOnly:entry.kind==='google',signal:requestSignal});
   if(text!==null){const result=(entry.kind==='google'?officialMedia:telegramMedia)(cleanHTML(text),entry);if(result)return result;}
  }catch{abort(signal);if(timeout.aborted)return null;}
 }
 return null;
}

export function mediaCaptionFits(payload){return Boolean(payload&&typeof payload.text==='string'&&decode(payload.text.replace(/<[^>]*>/g,'')).length<=1024);}
export function channelMediaMessage(payload,media){
 if(!mediaCaptionFits(payload)||!media||!['photo','video'].includes(media.type)||!(mediaURL(media.url,'google',media.type)||mediaURL(media.url,'telegram',media.type,source(media.sourceUrl)?.kind==='telegram')))return null;
 return {method:media.type==='photo'?'sendPhoto':'sendVideo',payload:{[media.type]:media.url,caption:payload.text,parse_mode:'HTML',protect_content:payload.protect_content===true,...(media.type==='video'?{supports_streaming:true}:{})}};
}
