const SITE='https://play-pulse-news.nemofresh.chatgpt.site';
const MAX_TEXT=4096;
const MONTHS=['січень','лютий','березень','квітень','травень','червень','липень','серпень','вересень','жовтень','листопад','грудень'];
const DAY_MONTHS=['січня','лютого','березня','квітня','травня','червня','липня','серпня','вересня','жовтня','листопада','грудня'];
const escapeHTML=text=>text.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

function httpsURL(raw,site=false){
  if(typeof raw!=='string'||raw.length>1200||!/^https:\/\//i.test(raw)||/[\s\\]/u.test(raw))return null;
  try{
    const url=new URL(raw);
    if(url.protocol!=='https:'||!url.hostname||url.username||url.password||url.port||site&&(url.search||url.hash))return null;
    return url.href;
  }catch{return null;}
}

export function articleSiteURL(siteURL,id){
  const site=httpsURL(siteURL,true);
  if(!site||typeof id!=='string'||!/^[a-z0-9][a-z0-9-]{0,95}$/.test(id))throw new TypeError('Потрібні коректні адреса сайту та ID новини.');
  const article=new URL(site);article.searchParams.set('article',id);article.hash='news';
  return article.href;
}

function publicationDate(raw){
  const match=/^(20\d\d)-(0[1-9]|1[0-2])(?:-(0[1-9]|[12]\d|3[01]))?$/.exec(raw);
  if(!match)throw new TypeError('Некоректна дата дайджесту.');
  const [,year,month,day]=match;
  if(day){
    const parsed=new Date(raw+'T00:00:00Z');
    if(!Number.isFinite(parsed.getTime())||parsed.toISOString().slice(0,10)!==raw)throw new TypeError('Некоректна дата дайджесту.');
  }
  return day?`${Number(day)} ${DAY_MONTHS[Number(month)-1]} ${year}`:`${MONTHS[Number(month)-1]} ${year}`;
}

function prefix(item,{preview},part=1,parts=1){
  const continuation=parts>1?(part===1?'Частина ':'Продовження · частина ')+part+' з '+parts:'';
  const plain=[item.title,...(preview?['Приклад оформлення']:[]),...(continuation?[continuation]:[])].join('\n');
  const html=['<b>'+escapeHTML(item.title)+'</b>',...(preview?['<i>Приклад оформлення</i>']:[]),...(continuation?['<i>'+escapeHTML(continuation)+'</i>']:[])].join('\n');
  return {plain,html};
}

function sources(item){
  const links=[];
  for(const source of item.links||[]){
    const url=httpsURL(source?.url);if(!url||links.some(link=>link.url===url))continue;
    const raw=typeof source.label==='string'?source.label.trim().replace(/\s+/gu,' '):'';
    const label=raw&&!/^(оригинал|источник)$/iu.test(raw)?raw:'Джерело';
    links.push({label,url});if(links.length===9)break;
  }
  return links;
}

function footer(item,links,articleURL){
  const metadata=[item.category,publicationDate(item.date),...(item.status?[item.status]:[])].join(' · ');
  const label=links.length===1?'Джерело: ':'Джерела: ';
  return {
    plain:metadata+(links.length?'\n'+label+links.map(link=>link.label).join(' · '):'')+'\nНовина на Play Pulse',
    html:'<i>'+escapeHTML(metadata)+'</i>'+(links.length?'\n'+label+links.map(link=>'<a href="'+escapeHTML(link.url)+'">'+escapeHTML(link.label)+'</a>').join(' · '):'')+'\n<a href="'+escapeHTML(articleURL)+'">Новина на Play Pulse</a>',
  };
}

function mediaPreview(links){
  for(const {url} of links){
    const {hostname,pathname}=new URL(url);
    const article=hostname==='blog.google'&&/^\/(?:(?:products-and-platforms\/(?:platforms|products)\/[^/]+)|(?:products\/[^/]+)|(?:intl\/[a-z]{2}(?:-[a-z]{2})?\/(?:products\/[^/]+|(?!products(?:\/|$))[^/]+)))\/[^/]+\/?$/i.test(pathname)||
      hostname==='developer.android.com'&&/^\/blog\/posts\/[^/]+\/?$/.test(pathname)||
      hostname==='android-developers.googleblog.com'&&/^\/20\d{2}\/\d{2}\/[^/]+\.html$/.test(pathname);
    if(article)return {is_disabled:false,url,prefer_large_media:true,show_above_text:true};
  }
  return {is_disabled:true};
}

function splitBody(body,limit){
  if(limit<1)throw new RangeError('Заголовок новини перевищує розмір повідомлення Telegram.');
  const result=[];let start=0;
  while(start<body.length){
    let end=Math.min(body.length,start+limit);
    if(end<body.length){
      const line=body.lastIndexOf('\n',end-1),space=body.lastIndexOf(' ',end-1),boundary=Math.max(line,space);
      if(boundary>=start+Math.floor(limit/2))end=boundary+1;
      const before=body.charCodeAt(end-1),after=body.charCodeAt(end);
      if(before>=0xd800&&before<=0xdbff&&after>=0xdc00&&after<=0xdfff)end--;
    }
    if(end<=start)throw new RangeError('Новину не вдалося розділити для Telegram.');
    result.push(body.slice(start,end));start=end;
  }
  return result.length?result:[''];
}

// One article per message. Telegram limits the text after HTML entity parsing;
// count UTF-16 conservatively and split the unescaped body without losing text.
// Only the final confirmed continuation is eligible for the article checkpoint.
export function formatDigest(items,{siteURL=SITE,date,preview=false,destination='private'}={}){
  if(!items.length)return [];
  const site=httpsURL(siteURL,true);if(!site)throw new TypeError('Потрібна безпечна HTTPS-адреса сайту.');
  if(date!==undefined)publicationDate(date);
  const options={preview},messages=[];
  for(const item of items){
    const articleURL=articleSiteURL(site,item.id);
    const body=item.summary+(item.detail?'\n\n'+item.detail:''),first=prefix(item,options),links=sources(item),ending=footer(item,links,articleURL),media=mediaPreview(links);
    let pieces=[body];
    if(first.plain.length+body.length+ending.plain.length+4>MAX_TEXT){
      let total=2;
      for(;;){
        const capacity=MAX_TEXT-prefix(item,options,total,total).plain.length-2;
        pieces=splitBody(body,capacity);
        // Only the last part needs room for source labels and metadata. Earlier
        // parts can use the full text budget instead of creating extra messages.
        pieces.push(...splitBody(pieces.pop(),capacity-ending.plain.length-2));
        if(pieces.length===total)break;total=pieces.length;
      }
    }
    for(const [index,text] of pieces.entries()){
      const part=index+1,parts=pieces.length,heading=prefix(item,options,part,parts);
      messages.push({articleId:item.id,part,parts,ids:part===parts?[item.id]:[],payload:{
        text:heading.html+'\n\n'+escapeHTML(text)+(part===parts?'\n\n'+ending.html:''),parse_mode:'HTML',link_preview_options:part===1?media:{is_disabled:true},protect_content:true,
        ...(destination==='channel'?{}:{reply_markup:{inline_keyboard:[[{text:'Открыть Play Pulse',url:articleURL},{text:'Все новости',callback_data:'list:all:0'}]]}}),
      }});
    }
  }
  return messages;
}
