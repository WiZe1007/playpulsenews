const SITE='https://play-pulse-news.nemofresh.chatgpt.site';
const MAX_TEXT=4096;
const EMOJI={Політики:'🛡',Публікація:'🚀',Монетизація:'💳',Ігри:'🎮',Магазин:'🛍',API:'⚙',Гемблінг:'🎰'};
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
  const category=(EMOJI[item.category]||'✦')+' '+item.category;
  const published='Опубліковано: '+publicationDate(item.date);
  const status=item.status?'Статус: '+item.status:'';
  const continuation=parts>1?(part===1?'Частина ':'Продовження · частина ')+part+' з '+parts:'';
  const plain=['PLAY PULSE',...(preview?['Приклад оформлення']:[]),category,item.title,published,...(status?[status]:[]),...(continuation?[continuation]:[])].join('\n');
  const html=['<b>PLAY PULSE</b>',...(preview?['<b>Приклад оформлення</b>']:[]),'<i>'+escapeHTML(category)+'</i>','<b>'+escapeHTML(item.title)+'</b>','<i>'+escapeHTML(published)+'</i>',...(status?['<i>'+escapeHTML(status)+'</i>']:[]),...(continuation?['<i>'+escapeHTML(continuation)+'</i>']:[])].join('\n');
  return {plain,html};
}

function sources(item){
  const buttons=[];
  for(const source of item.links||[]){
    const url=httpsURL(source?.url);if(!url||buttons.some(button=>button.url===url))continue;
    const raw=typeof source.label==='string'?source.label.trim().replace(/\s+/gu,' '):'';
    const label=Array.from(raw&&!/^(оригинал|источник)$/iu.test(raw)?raw:'Джерело').slice(0,32).join('');
    buttons.push({text:'↗ '+label,url});if(buttons.length===9)break;
  }
  return buttons;
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
  const options={date:date===undefined?undefined:publicationDate(date),preview},messages=[];
  for(const item of items){
    const body=item.summary+(item.detail?'\n\n'+item.detail:''),first=prefix(item,options);
    let pieces=[body];
    if(first.plain.length+2+body.length>MAX_TEXT){
      let total=2;
      for(;;){
        pieces=splitBody(body,MAX_TEXT-prefix(item,options,total,total).plain.length-2);
        if(pieces.length===total)break;total=pieces.length;
      }
    }
    const buttons=sources(item);
    for(const [index,text] of pieces.entries()){
      const part=index+1,parts=pieces.length,heading=prefix(item,options,part,parts);
      messages.push({articleId:item.id,part,parts,ids:part===parts?[item.id]:[],payload:{
        text:heading.html+'\n\n'+escapeHTML(text),parse_mode:'HTML',link_preview_options:{is_disabled:true},protect_content:true,
        reply_markup:{inline_keyboard:[...buttons.map(button=>[button]),[{text:'🌐 Открыть Play Pulse',url:site},...(destination==='channel'?[]:[{text:'Все новости',callback_data:'list:all:0'}])]]},
      }});
    }
  }
  return messages;
}
