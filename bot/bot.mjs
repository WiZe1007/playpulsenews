import {pathToFileURL} from 'node:url';
import {setTimeout as sleep} from 'node:timers/promises';
import {createNotifier} from './notifications.mjs';
import {notificationConfig,runNotifications} from './delivery.mjs';
import {restoreNotificationState} from './migration.mjs';
import {SITE,config,handler,parseFeed} from './core.mjs';
export {SITE,CATEGORIES,escapeHTML,safeSource,config,parseFeed,screen,allowedChat,handler} from './core.mjs';
const CANONICAL=SITE+'/news.json';
const METHODS=new Set(['getUpdates','sendMessage','editMessageText','answerCallbackQuery']);
const delay=(ms,signal)=>sleep(ms,undefined,{signal});
const cancelled=()=>new DOMException('Операция отменена.','AbortError');
const requestSignal=(signal,timeout)=>signal?AbortSignal.any([signal,AbortSignal.timeout(timeout)]):AbortSignal.timeout(timeout);
export class TelegramError extends Error {
  constructor(status=0){
    super(status===401?'Telegram отклонил токен бота. Проверьте TELEGRAM_BOT_TOKEN.':
      status===409?'Конфликт получения обновлений: webhook или второй экземпляр бота.':
      status>=400&&status<500?'Telegram отклонил запрос.':'Telegram API временно недоступен.');
    this.name='TelegramError';
    this.status=status;
    this.fatal=status===401||status===409;
    this.retryable=status===0||status===429||status>=500;
  }
}
export function telegram(token, fetchFn=fetch, {signal,wait=delay}={}){
  return async(method,args)=>{
    if(!METHODS.has(method))throw Error('Неизвестная операция.');
    for(;;){
      try {
        if(signal?.aborted)throw cancelled();
        const r=await fetchFn('https://api.telegram.org/bot'+token+'/'+method,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify(args),signal:requestSignal(signal,method==='getUpdates'?40000:10000)});
        const j=await r.json().catch(()=>null);
        const status=!r.ok?r.status:j?.ok===false?(Number(j.error_code)||502):0;
        if(status===429){
          const seconds=Number.isSafeInteger(j?.parameters?.retry_after)&&j.parameters.retry_after>0?j.parameters.retry_after:1;
          await wait(seconds*1000,signal);
          continue;
        }
        if(status===400&&method==='editMessageText')
          return /message is not modified/i.test(j?.description||'')?{notEdited:true}:{editUnavailable:true};
        if(status)throw new TelegramError(status);
        if(j?.ok!==true)throw new TelegramError(502);
        return {result:j.result};
      }catch(error){
        if(signal?.aborted)throw cancelled();
        if(error instanceof TelegramError)throw error;
        throw new TelegramError();
      }
    }
  };
}
export function feed({url=CANONICAL,auth='sites',feedToken}, fetchFn=fetch, {signal}={}){
  if((url===CANONICAL)!==(auth==='sites')||!['sites','bearer','none'].includes(auth))throw Error('Неверная авторизация ленты.');
  const headers={'Accept':'application/json'};
  if(auth==='sites')headers['OAI-Sites-Authorization']='Bearer '+feedToken;
  if(auth==='bearer')headers.Authorization='Bearer '+feedToken;
  let items, at=0;
  return async()=>{
    if(signal?.aborted)throw cancelled();
    if(items&&Date.now()-at<15000)return items;
    try{
      const r=await fetchFn(url,{redirect:'error',headers,signal:requestSignal(signal,8000)});
      if(!r.ok||!r.headers.get('content-type')?.toLowerCase().includes('application/json')||!r.body)throw Error();
      const reader=r.body.getReader(), decoder=new TextDecoder('utf-8',{fatal:true});let len=0, text='';
      try{for(;;){const {done,value}=await reader.read();if(done)break;len+=value.byteLength;if(len>12*1024*1024){await reader.cancel();throw Error();}text+=decoder.decode(value,{stream:true});}}finally{reader.releaseLock();}
      items=parseFeed(JSON.parse(text+decoder.decode()));at=Date.now();return items;
    }catch{
      if(signal?.aborted)throw cancelled();
      throw Error('Лента недоступна. Попробуйте ещё раз.');
    }
  };
}
export async function runPolling(api,handle,{signal,wait=delay,onError=()=>{}}={}){
  let offset=0;
  while(!signal?.aborted){
    try {
      const batch=await api('getUpdates',{offset,timeout:25,limit:50,allowed_updates:['message','callback_query']});
      for(const u of Array.isArray(batch.result)?batch.result:[]){
        if(signal?.aborted)return;
        try{await handle(u);}
        catch(error){
          if(signal?.aborted)return;
          if(error?.fatal||error?.retryable!==false)throw error;
          // A permanent per-chat rejection (for example a blocked bot) must
          // not prevent the remaining private users from receiving replies.
          onError(error);
        }
        if(signal?.aborted)return;
        if(Number.isSafeInteger(u.update_id))offset=Math.max(offset,u.update_id+1);
      }
    }catch(error){
      if(signal?.aborted)return;
      if(error?.fatal||error?.retryable===false)throw error;
      onError(error);
      try{await wait(5000,signal);}
      catch(error){if(!signal?.aborted)throw error;}
    }
  }
}
async function main(){
  const cfg=config(process.env),settings=notificationConfig(process.env),controller=new AbortController();
  const signal=controller.signal,stop=()=>controller.abort();
  const tasks=[];
  for(const name of ['SIGINT','SIGTERM'])process.once(name,stop);
  try{
    if(settings.enabled&&settings.bootstrapPath)
      await restoreNotificationState({statePath:settings.statePath,bootstrapPath:settings.bootstrapPath,allowed:cfg.allowed});
    const api=telegram(cfg.token,fetch,{signal});
    const getFeed=feed(cfg,fetch,{signal});
    const handle=handler(cfg.allowed,api,getFeed,cfg.siteURL);
    console.log('Play Pulse: бот запущен в закрытом режиме.');
    tasks.push(runPolling(api,handle,{signal,onError:()=>console.error('Play Pulse: ошибка запроса. Повторяем временные сбои; постоянные ошибки чата пропускаем.')}));
    if(settings.enabled){
      const notifier=createNotifier({getFeed,api,allowed:cfg.allowed,siteURL:cfg.siteURL,statePath:settings.statePath,signal});
      tasks.push(runNotifications(notifier,{
        signal,intervalMs:settings.intervalMs,
        onError:()=>console.error('Play Pulse: автоуведомления временно недоступны. Проверьте ленту, права и состояние доставки; архив автоматически не сбрасывается.'),
        onResult:result=>{
          if(result.initializedOwners)console.log('Play Pulse: уведомления включены; существующие записи отмечены без рассылки.');
          if(result.sentMessages)console.log('Play Pulse: автоуведомления отправлены; сообщений: '+result.sentMessages+', записей: '+result.sentArticles+'.');
        }
      }));
      console.log('Play Pulse: новые записи отправляются автоматически; проверка каждые '+settings.intervalMs/1000+' секунд.');
    }
    await Promise.all(tasks);
  }finally{
    controller.abort();
    await Promise.allSettled(tasks);
    for(const name of ['SIGINT','SIGTERM'])process.removeListener(name,stop);
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{
  console.error(error instanceof TelegramError?'Play Pulse: '+error.message:'Не удалось запустить Play Pulse. Проверьте таблицу настроек.');
  process.exitCode=1;
});
