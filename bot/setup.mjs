import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

const DEFAULT_PHOTO=new URL('./assets/avatar.jpg',import.meta.url);
const tokenPattern=/^\d{5,16}:[\w-]{32,100}$/;

function readToken(env){
  const token=env.TELEGRAM_BOT_TOKEN?.trim();
  if(!tokenPattern.test(token||''))throw Error('Проверьте TELEGRAM_BOT_TOKEN в локальном .env.');
  return token;
}

async function requestTelegram(token,method,body,fetchFn){
  try{
    const multipart=body instanceof FormData;
    const response=await fetchFn('https://api.telegram.org/bot'+token+'/'+method,{
      method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),
      ...(multipart?{}:{headers:{'Content-Type':'application/json'}}),
      body:multipart?body:JSON.stringify(body)
    });
    if(!response.ok)throw Error();
    const data=await response.json();
    if(data?.ok!==true)throw Error();
    return data.result;
  }catch{throw Error('Telegram: не удалось выполнить '+method+'.');}
}

// Read-only preflight, shared with setup, pairing and readiness checks.
export async function checkTelegram(token,fetchFn=fetch){
  token=readToken({TELEGRAM_BOT_TOKEN:token});
  const me=await requestTelegram(token,'getMe',{},fetchFn);
  if(!Number.isSafeInteger(me?.id)||me.id<=0||me.is_bot!==true||typeof me.first_name!=='string'||!me.first_name.trim()||
    typeof me.username!=='string'||!/^[a-zA-Z][a-zA-Z0-9_]{4,31}$/.test(me.username))throw Error('Telegram: некорректный ответ getMe.');
  const webhook=await requestTelegram(token,'getWebhookInfo',{},fetchFn);
  if(typeof webhook?.url!=='string')throw Error('Telegram: некорректный ответ getWebhookInfo.');
  if(webhook.url)throw Error('У бота активен webhook. Отключите его в прежних настройках перед запуском long polling.');
  return {id:me.id,username:me.username};
}

export async function setupBot(env=process.env,{fetchFn=fetch,photoPath=DEFAULT_PHOTO}={}){
  const token=readToken(env);
  let photo;
  try{
    photo=await readFile(photoPath);
    if(photo.length>10*1024*1024||photo[0]!==0xff||photo[1]!==0xd8||photo[2]!==0xff)throw Error();
  }catch{throw Error('Не удалось прочитать JPEG-аватар Play Pulse.');}
  const {username}=await checkTelegram(token,fetchFn);
  const operations=[
    ['setMyName',{name:'Play Pulse'}],
    ['setMyDescription',{description:'Новости Google Play и Play Console. Все рубрики, Android-гемблинг и архив Play Pulse в одном меню.'}],
    ['setMyShortDescription',{short_description:'Новости Google Play и Play Console, Android-гемблинг и архив Play Pulse.'}],
    ['setMyCommands',{commands:[
      {command:'start',description:'Открыть Play Pulse'},
      {command:'news',description:'Последние новости'},
      {command:'menu',description:'Главное меню'}
    ],scope:{type:'all_private_chats'}}],
    ['setChatMenuButton',{menu_button:{type:'commands'}}]
  ];
  const form=new FormData();
  form.set('photo',JSON.stringify({type:'static',photo:'attach://avatar'}));
  form.set('avatar',new Blob([photo],{type:'image/jpeg'}),'avatar.jpg');
  operations.push(['setMyProfilePhoto',form]);
  for(const [method,body] of operations){
    if(await requestTelegram(token,method,body,fetchFn)!==true)throw Error('Telegram: не удалось выполнить '+method+'.');
  }
  return {username};
}

export async function runSetup(env=process.env,{log=console.log,error=console.error,...options}={}){
  try{
    const {username}=await setupBot(env,options);
    log('Play Pulse: оформление @'+username+' настроено.');
    return 0;
  }catch(failure){
    error('Play Pulse: '+failure.message);
    return 1;
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)process.exitCode=await runSetup();
