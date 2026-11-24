import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveArticleMedia,channelMediaMessage} from './media.mjs';

const blog='https://blog.google/products-and-platforms/platforms/google-play/story/';
const android='https://developer.android.com/blog/posts/adaptive-quality';
const photo='https://storage.googleapis.com/gweb-uniblog-publish-prod/images/story.width-1300.png';
const html=body=>new Response(body,{headers:{'content-type':'text/html; charset=utf-8'}});
const article=(...urls)=>({links:urls.map(url=>({label:'Source',url}))});

test('real official covers are preferred over Telegram and public fetches carry no credentials',async()=>{
 const calls=[];
 const result=await resolveArticleMedia(article('https://t.me/trafficarts/1479',blog),{fetchFn:async(url,options)=>{
  calls.push({url,options});return html('<head><meta content="'+photo+'?a=1&amp;b=2" property="og:image"></head>');
 }});
 assert.deepEqual(result,{type:'photo',url:photo+'?a=1&b=2',sourceUrl:blog});
 assert.equal(calls.length,1);assert.equal(calls[0].url,blog);assert.equal(calls[0].options.method,'GET');
 assert.equal(calls[0].options.redirect,'manual');assert.equal(calls[0].options.credentials,'omit');
 assert.deepEqual([...new Headers(calls[0].options.headers).keys()],['accept']);
 assert.equal(calls[0].options.body,undefined);
});

test('Android own static blog assets and direct official MP4 videos are supported',async()=>{
 const cover='https://developer.android.com/static/blog/assets/adaptive_quality.webp';
 assert.deepEqual(await resolveArticleMedia(article(android),{fetchFn:async()=>html(`<meta property='og:image' content='${cover}'>`)}),{type:'photo',url:cover,sourceUrl:android});
 const video='https://storage.googleapis.com/gweb-uniblog-publish-prod/videos/demo.mp4';
 assert.deepEqual(await resolveArticleMedia(article(blog),{fetchFn:async()=>html(`<meta property="og:image" content="${photo}"><meta property="og:video:secure_url" content="${video}">`)}),{type:'video',url:video,sourceUrl:blog});
});

test('unapproved sources and editorial indexes cannot make network requests',async()=>{
 for(const url of ['http://blog.google/products/platforms/post','https://blog.google.evil.test/post','https://user@blog.google/products/platforms/post','https://blog.google:443/products/platforms/post','https://blog.google/','https://blog.google/products-and-platforms/platforms/google-play/','https://blog.google/intl/ja-jp/products/android-chrome-play/','https://developer.android.com/google/play/billing/release-notes','https://t.me/other/123','https://t.me/trafficarts/1479?url=https://evil.test']){
  assert.equal(await resolveArticleMedia(article(url),{fetchFn:async()=>{assert.fail('Unsafe source fetch');}}),null,url);
 }
});

test('generic logos, foreign hosts and unsafe media URLs never become attachments',async()=>{
 for(const url of ['https://evil.test/cover.jpg','http://storage.googleapis.com/gweb-uniblog-publish-prod/images/cover.jpg','https://storage.googleapis.com.evil.test/cover.jpg','https://user@storage.googleapis.com/gweb-uniblog-publish-prod/images/cover.jpg','https://storage.googleapis.com:443/gweb-uniblog-publish-prod/images/cover.jpg','https://storage.googleapis.com/foreign-bucket/cover.jpg','https://developer.android.com/static/images/logos/android.svg','https://developer.android.com/static/blog/assets/android_logo.png','https://lh3.googleusercontent.com/avatar/default_userpic.jpg','javascript:alert(1)']){
  assert.equal(await resolveArticleMedia(article(blog),{fetchFn:async()=>html(`<meta property="og:image" content="${url}">`)}),null,url);
 }
});

test('Telegram OG thumbnails and neighboring posts cannot impersonate exact-post media',async()=>{
 const tg='https://t.me/trafficarts/1479',cdn='https://cdn4.telesco.pe/file/real-image.jpg';
 const result=await resolveArticleMedia(article(tg),{fetchFn:async(url)=>{
  assert.equal(url,'https://t.me/trafficarts/1479?embed=1');
  return html(`<meta property="og:image" content="${cdn}"><div data-post="trafficarts/1478"><a class="tgme_widget_message_photo_wrap" style="background-image:url('${cdn}')"></a></div><div data-post="trafficarts/1479"><div><img src="${cdn}"></div><div>Only text</div></div>`);
 }});
 assert.equal(result,null);
});

test('only a real photo or video in the exact Telegram public post becomes media',async()=>{
 const tg='https://t.me/trafficarts/1479',cdn='https://cdn4.telesco.pe/file/real-image.jpg';
 assert.deepEqual(await resolveArticleMedia(article(tg),{fetchFn:async()=>html(`<div data-post="trafficarts/1479"><div><a class="foo tgme_widget_message_photo_wrap" style="background-image:url('${cdn}')"></a></div></div>`)}),{type:'photo',url:cdn,sourceUrl:tg});
 const video='https://cdn4.telesco.pe/file/clip.mp4';
 assert.deepEqual(await resolveArticleMedia(article(tg),{fetchFn:async()=>html(`<div data-post='trafficarts/1479'><div><video src="${video}"></video></div></div>`)}),{type:'video',url:video,sourceUrl:tg});
});

test('newly approved Telegram sources resolve media from their exact public post',async()=>{
 const cases=[
  {source:'https://t.me/GAppsLeaks/101',request:'https://t.me/GAppsLeaks/101?embed=1',body:'<div data-post="gappsleaks/101"><a class="tgme_widget_message_photo_wrap" style="background-image:url(\'https://cdn4.telesco.pe/file/android-feature.jpg\')"></a></div>',want:{type:'photo',url:'https://cdn4.telesco.pe/file/android-feature.jpg',sourceUrl:'https://t.me/GAppsLeaks/101'}},
  {source:'https://t.me/s/traffnews/202',request:'https://t.me/traffnews/202?embed=1',body:'<div data-post="traffnews/202"><video src="https://cdn4.telesco.pe/file/AbCdEf0123456789_approved-video"></video></div>',want:{type:'video',url:'https://cdn4.telesco.pe/file/AbCdEf0123456789_approved-video',sourceUrl:'https://t.me/s/traffnews/202'}},
 ];
 for(const item of cases){
  const result=await resolveArticleMedia(article(item.source),{fetchFn:async(url,options)=>{
   assert.equal(url,item.request);assert.equal(options.method,'GET');assert.equal(options.redirect,'manual');assert.equal(options.credentials,'omit');
   assert.deepEqual([...new Headers(options.headers).keys()],['accept']);assert.equal(options.body,undefined);
   return html(item.body);
  }});
  assert.deepEqual(result,item.want);
  assert.equal(channelMediaMessage({text:'Повна новина.',protect_content:true},result)?.method,item.want.type==='photo'?'sendPhoto':'sendVideo');
 }
});

test('new Telegram sources cannot attach channel thumbnails or a different public post',async()=>{
 for(const handle of ['GAppsLeaks','traffnews']){
  const source=`https://t.me/${handle}/101`,cdn='https://cdn4.telesco.pe/file/neighbor-image.jpg';let requests=0;
  const result=await resolveArticleMedia(article(source),{fetchFn:async()=>{
   requests++;
   return html(`<meta property="og:image" content="${cdn}"><div data-post="${handle}/100"><a class="tgme_widget_message_photo_wrap" style="background-image:url('${cdn}')"></a></div><div data-post="other/101"><video src="https://cdn4.telesco.pe/file/wrong.mp4"></video></div><div data-post="${handle}/101"><img src="${cdn}"></div>`);
  }});
  assert.equal(requests,1);assert.equal(result,null);
 }
});

test('new Telegram source names do not permit redirects, credentials or non-post URLs',async()=>{
 for(const source of ['https://t.me/GAppsLeaks','https://t.me/s/traffnews','https://t.me/GAppsLeaks/0','https://t.me/traffnews/1?url=https://evil.test','https://t.me/GAppsLeaks/1#media','https://user@t.me/traffnews/1','https://t.me:443/GAppsLeaks/1','http://t.me/traffnews/1','https://t.me.evil.test/GAppsLeaks/1'])
  assert.equal(await resolveArticleMedia(article(source),{fetchFn:async()=>{assert.fail('Unsafe new Telegram source fetch');}}),null,source);
});

test('an opaque Telegram CDN video URL is accepted only from the exact video element',async()=>{
 const tg='https://t.me/trafficarts/1479',video='https://cdn4.telesco.pe/file/AbCdEf0123456789_opaque-video-token';
 const result=await resolveArticleMedia(article(tg),{fetchFn:async()=>html(`<div data-post="trafficarts/1479"><video src="${video}"></video></div>`)});
 assert.deepEqual(result,{type:'video',url:video,sourceUrl:tg});
 assert.equal(channelMediaMessage({text:'Повна новина.',protect_content:true},result)?.method,'sendVideo');
 for(const body of [`<meta property="og:video" content="${video}"><div data-post="trafficarts/1479">Text only</div>`,`<div data-post="trafficarts/1478"><video src="${video}"></video></div><div data-post="trafficarts/1479">Text only</div>`])
  assert.equal(await resolveArticleMedia(article(tg),{fetchFn:async()=>html(body)}),null);
 assert.equal(await resolveArticleMedia(article(blog),{fetchFn:async()=>html(`<meta property="og:video" content="https://storage.googleapis.com/gweb-uniblog-publish-prod/videos/opaque-token">`)}),null);
});

test('HTML scripts and comments cannot inject fake metadata or fake Telegram media',async()=>{
 assert.equal(await resolveArticleMedia(article(blog),{fetchFn:async()=>html(`<!-- <meta property="og:image" content="${photo}"> --><script>const fake='<meta property="og:image" content="${photo}">';</script>`)}),null);
 assert.equal(await resolveArticleMedia(article('https://t.me/trafficarts/1479'),{fetchFn:async()=>html(`<div data-post="trafficarts/1479"><!-- <a class="tgme_widget_message_photo_wrap" style="background-image:url('https://cdn4.telesco.pe/file/fake.jpg')"></a> --></div>`)}),null);
 assert.equal(await resolveArticleMedia(article(blog),{fetchFn:async()=>html(`<script>const truncated='<meta property="og:image" content="${photo}">';`)}),null);
});

test('redirects, network failures and unbounded HTML fall back without following another host',async()=>{
 let calls=0;
 assert.equal(await resolveArticleMedia(article(blog),{fetchFn:async()=>{calls++;return new Response(null,{status:302,headers:{location:'https://evil.test/'}});}}),null);assert.equal(calls,1);
 assert.equal(await resolveArticleMedia(article(blog),{fetchFn:async()=>{throw Error('Network failure');}}),null);
 assert.equal(await resolveArticleMedia(article(blog),{fetchFn:async()=>html('x'.repeat(128*1024)+`<meta property="og:image" content="${photo}">`)}),null);
});

test('rejected source responses cancel their bodies instead of holding network connections open',async()=>{
 let cancelled=false;
 const stream=new ReadableStream({cancel(){cancelled=true;}});
 assert.equal(await resolveArticleMedia(article(blog),{fetchFn:async()=>new Response(stream,{status:403,headers:{'content-type':'text/html'}})}),null);
 assert.equal(cancelled,true);
});

test('metadata in the early head works on large articles without reading the whole body',async()=>{
 let cancelled=false,pulls=0;
 const stream=new ReadableStream({pull(controller){pulls++;controller.enqueue(new TextEncoder().encode(`<head><meta property="og:image" content="${photo}"></head>`));},cancel(){cancelled=true;}});
 assert.deepEqual(await resolveArticleMedia(article(blog),{fetchFn:async()=>new Response(stream,{headers:{'content-type':'text/html','content-length':'900000'}})}),{type:'photo',url:photo,sourceUrl:blog});
 assert.equal(cancelled,true);assert.ok(pulls<=2);
});

test('caller abort stops media discovery instead of hiding cancellation',async()=>{
 const controller=new AbortController();controller.abort();let called=false;
 await assert.rejects(resolveArticleMedia(article(blog),{signal:controller.signal,fetchFn:async()=>{called=true;return html('');}}),{name:'AbortError'});assert.equal(called,false);
});

test('caller abort interrupts a stalled HTML stream and cancels its reader',async()=>{
 const controller=new AbortController();let started,cancelled=false;
 const ready=new Promise(resolve=>{started=resolve;}),stream=new ReadableStream({pull(){started();},cancel(){cancelled=true;}},{highWaterMark:0});
 const pending=resolveArticleMedia(article(blog),{signal:controller.signal,fetchFn:async()=>new Response(stream,{headers:{'content-type':'text/html'}})});
 await ready;controller.abort();await assert.rejects(pending,{name:'AbortError'});assert.equal(cancelled,true);
});

test('source discovery has a fixed network budget even with nine editorial links',async()=>{
 let calls=0;
 const links=Array.from({length:9},(_,index)=>blog.replace('/story/','/story-'+index+'/'));
 assert.equal(await resolveArticleMedia(article(...links),{fetchFn:async()=>{calls++;return html('<head></head>');}}),null);
 assert.equal(calls,2);
});

test('a full short post becomes one media caption while long posts retain all text',()=>{
 const payload={text:'<b>Новина</b>\n\nПовний текст &amp; деталі.',parse_mode:'HTML',protect_content:true,link_preview_options:{is_disabled:true}};
 assert.deepEqual(channelMediaMessage(payload,{type:'photo',url:photo}),{method:'sendPhoto',payload:{photo,caption:payload.text,parse_mode:'HTML',protect_content:true}});
 assert.deepEqual(channelMediaMessage(payload,{type:'video',url:'https://storage.googleapis.com/gweb-uniblog-publish-prod/videos/a.mp4'}),{method:'sendVideo',payload:{video:'https://storage.googleapis.com/gweb-uniblog-publish-prod/videos/a.mp4',caption:payload.text,parse_mode:'HTML',protect_content:true,supports_streaming:true}});
 assert.equal(channelMediaMessage({...payload,text:'🧬'.repeat(513)},{type:'photo',url:photo}),null);
 assert.equal(channelMediaMessage(payload,{type:'photo',url:'https://foreign.test/cover.jpg'}),null);
 assert.equal(channelMediaMessage(payload,null),null);
});
