import {Buffer} from 'node:buffer';
import {coverPrint} from './cover-print.mjs';

// Keep previously published previews accessible.
export const editorialAssetPaths=new Set(['backup','review','release','games','development'].map(name=>'/assets/editorial/'+name+'.jpg'));
const LIMIT=850_000;
const digest=async bytes=>Buffer.from(await crypto.subtle.digest('SHA-256',bytes));
const formats={jpg:'image/jpeg',png:'image/png'};
const credits={source:'Фото з джерела',ai:'ШІ-ілюстрація WWA',print:'Графіка WWA'};

function format(bytes){
 if(!bytes||bytes.length>LIMIT)return null;
 if(bytes.length>20&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255&&bytes.at(-2)===255&&bytes.at(-1)===217)return 'jpg';
 if(bytes.length>32&&bytes.subarray(0,8).toString('hex')==='89504e470d0a1a0a')return 'png';
 return null;
}

async function sourcePhoto(url,fetchFn){
 const response=await fetchFn(url,{redirect:'manual',credentials:'omit',signal:AbortSignal.timeout(4500)});
 if(!response.ok||!response.body||Number(response.headers.get('content-length'))>LIMIT){
  await response.body?.cancel();return null;
 }
 const reader=response.body.getReader(),chunks=[];
 let total=0;
 try{
  for(;;){
   const {done,value}=await reader.read();if(done)break;
   total+=value.length;if(total>LIMIT){await reader.cancel();return null;}
   chunks.push(value);
  }
 }finally{reader.releaseLock();}
 return Buffer.concat(chunks,total);
}

function promptFor(item,seed){
 const compositions=['editorial still life in soft side light','cut-paper diorama with physical shadows',
  'isometric miniature scene on a studio table','macro editorial photograph with a single focal point',
  'tactile screen-printed magazine illustration','overhead conceptual editorial photograph'];
 return ['Create a sophisticated mobile publishing news illustration. Depict the specific event below with concrete visual metaphors.',
  compositions[seed[0]%compositions.length]+'. No text, logos, screenshots or lettering. No generic phone-only composition.',
  'Story: '+item.id.replaceAll('-',' ')+'. '+item.title+'. '+item.summary.slice(0,650)].join(' ');
}

export async function prepareCover(item,{DB,AI,PLAY_PULSE_PUBLIC_ORIGIN:origin},{media,fetchFn=fetch}={}){
 const existing=()=>DB.prepare('SELECT digest,format,credit FROM article_covers WHERE article=?').bind(item.id).first();
 const describe=row=>({url:origin+'/covers/'+row.digest+'.'+row.format,label:credits[row.credit]});
 const saved=await existing();if(saved)return describe(saved);
 async function reserve(bytes,credit){
  const ext=format(bytes);if(!ext)return null;
  const hash=(await digest(bytes)).toString('hex');
  await DB.prepare('INSERT INTO article_covers(article,digest,format,credit,image) VALUES(?,?,?,?,unhex(?)) ON CONFLICT DO NOTHING')
   .bind(item.id,hash,ext,credit,bytes.toString('hex')).run();
  const row=await existing();return row?describe(row):null;
 }
 if(media?.type==='photo'){
  let bytes;
  try{bytes=await sourcePhoto(media.url,fetchFn);}catch{/* Source images can expire. */}
  const result=await reserve(bytes,'source');if(result)return result;
 }
 const seed=await digest(Buffer.from(item.id));
 if(AI){
  let image;
  try{
   const response=await AI.run('@cf/black-forest-labs/flux-1-schnell',{prompt:promptFor(item,seed),steps:4});
   if(typeof response.image==='string'&&response.image.length<=Math.ceil(LIMIT/3)*4)image=Buffer.from(response.image,'base64');
  }catch{/* Free quota and model outages use the print renderer. */}
  const result=await reserve(image,'ai');if(result)return result;
 }
 for(let attempt=0;attempt<3;attempt++){
  const printSeed=attempt?await digest(Buffer.from(item.id+'/'+attempt)):seed;
  const result=await reserve(await coverPrint(printSeed),'print');if(result)return result;
 }
 throw Error('Could not reserve a distinct cover.');
}

export async function serveCover(path,method,db){
 const match=/^\/covers\/([0-9a-f]{64})\.(jpg|png)$/.exec(path);
 if(!match)return new Response(null,{status:404});
 if(method!=='GET'&&method!=='HEAD')return new Response(null,{status:405});
 const field=method==='HEAD'?'length(image) AS size':'hex(image) AS encoded';
 const row=await db.prepare('SELECT '+field+' FROM article_covers WHERE digest=? AND format=?').bind(match[1],match[2]).first();
 if(!row)return new Response(null,{status:404});
 // D1 serializes raw BLOBs as JSON byte arrays. Transfer hex strings across the binding instead.
 const body=method==='HEAD'?null:Buffer.from(row.encoded,'hex');
 return new Response(body,{headers:{'content-type':formats[match[2]],
  'content-length':String(row.size??body.byteLength),'cache-control':'public, max-age=31536000, immutable','x-content-type-options':'nosniff'}});
}
