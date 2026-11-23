const SITE='https://play-pulse-news.nemofresh.chatgpt.site';
const MAX_TEXT=3800;
const MAX_ITEMS=5;
const DIVIDER='\n\n────────\n\n';
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

function header(date,preview,part,total){
  const label='Дайджест новин'+(date?' · '+date:'');
  const plain=['PLAY PULSE',...(preview?['Приклад оформлення']:[]),label,...(total>1?[`Частина ${part} з ${total}`]:[])].join('\n');
  const html='<b>PLAY PULSE</b>\n'+(preview?'<b>Приклад оформлення</b>\n':'')+`<i>${escapeHTML(label)}</i>`+(total>1?`\n<i>Частина ${part} з ${total}</i>`:'');
  return {plain,html};
}

function article(item,index){
  const number=String(index+1).padStart(2,'0');
  const category=`${number} · ${EMOJI[item.category]||'✦'} ${item.category}`;
  const date='Опубліковано: '+publicationDate(item.date);
  const status=item.status?'Статус: '+item.status:'';
  const plain=[category,item.title,date,...(status?[status]:[])].join('\n')+'\n\n'+item.summary;
  const html=`<i>${escapeHTML(category)}</i>\n<b>${escapeHTML(item.title)}</b>\n<i>${escapeHTML(date)}</i>`+(status?`\n<i>${escapeHTML(status)}</i>`:'')+'\n\n'+escapeHTML(item.summary);
  const sources=[];
  for(const source of item.links||[]){
    const url=httpsURL(source?.url);
    if(!url||sources.some(button=>button.url===url))continue;
    const rawLabel=typeof source.label==='string'?source.label.trim().replace(/\s+/gu,' '):'';
    const label=Array.from(rawLabel&&!/^(оригинал|источник)$/iu.test(rawLabel)?rawLabel:'Джерело').slice(0,32).join('');
    sources.push({text:`↗ ${number} · ${label}`,url});
    if(sources.length===2)break;
  }
  return {id:item.id,plain,html,sources};
}

// Telegram's limit applies after HTML entity parsing. Count visible UTF-16
// units, which also leaves room for astral characters and formatting changes.
// Articles stay whole so a successful chunk can checkpoint precisely its IDs.
export function formatDigest(items,{siteURL=SITE,date,preview=false}={}){
  if(!items.length)return [];
  const site=httpsURL(siteURL,true);
  if(!site)throw new TypeError('Потрібна безпечна HTTPS-адреса сайту.');
  const digestDate=date===undefined?undefined:publicationDate(date);
  const reservedHeader=header(digestDate,preview,items.length,items.length).plain.length+2;
  const groups=[];
  let group=[],length=reservedHeader;
  for(const [index,item] of items.entries()){
    const entry=article(item,index);
    if(reservedHeader+entry.plain.length>MAX_TEXT)throw new RangeError('Новина перевищує розмір повідомлення Telegram.');
    const separator=group.length?DIVIDER.length:0;
    if(group.length&&(group.length===MAX_ITEMS||length+separator+entry.plain.length>MAX_TEXT)){
      groups.push(group);group=[];length=reservedHeader;
    }
    length+=(group.length?DIVIDER.length:0)+entry.plain.length;
    group.push(entry);
  }
  if(group.length)groups.push(group);
  return groups.map((entries,index)=>({
    ids:entries.map(entry=>entry.id),
    payload:{
      text:header(digestDate,preview,index+1,groups.length).html+'\n\n'+entries.map(entry=>entry.html).join(DIVIDER),
      parse_mode:'HTML',
      link_preview_options:{is_disabled:true},
      protect_content:true,
      reply_markup:{inline_keyboard:[
        ...entries.filter(entry=>entry.sources.length).map(entry=>entry.sources),
        [{text:'🌐 Открыть Play Pulse',url:site},{text:'Все новости',callback_data:'list:all:0'}],
      ]},
    },
  }));
}
