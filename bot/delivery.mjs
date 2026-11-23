import {setTimeout as sleep} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

const botDirectory=fileURLToPath(new URL('./',import.meta.url));
const defaultState=fileURLToPath(new URL('./.runtime/notifications.json',import.meta.url));

export function notificationConfig(env={}){
  const enabled=env.PLAY_PULSE_NOTIFICATIONS_ENABLED?.trim()||'0';
  if(!['0','1'].includes(enabled))throw Error('Проверьте PLAY_PULSE_NOTIFICATIONS_ENABLED: допустимы 0 и 1.');
  if(enabled==='0')return {enabled:false};
  const seconds=Number(env.PLAY_PULSE_NOTIFICATIONS_INTERVAL_SECONDS||60);
  if(!Number.isInteger(seconds)||seconds<15||seconds>3600)throw Error('Интервал уведомлений должен быть от 15 до 3600 секунд.');
  const configuredPath=env.PLAY_PULSE_NOTIFICATIONS_STATE_FILE?.trim();
  const configuredBootstrap=env.PLAY_PULSE_NOTIFICATIONS_BOOTSTRAP_FILE?.trim();
  return {enabled:true,intervalMs:seconds*1000,statePath:configuredPath?resolve(botDirectory,configuredPath):defaultState,
    bootstrapPath:configuredBootstrap?resolve(botDirectory,configuredBootstrap):undefined};
}

const pause=(ms,signal)=>sleep(ms,undefined,{signal});
const noteworthy=result=>result&&(result.initializedOwners>0||result.sentMessages>0||result.sentArticles>0);

export async function runNotifications(notifier,{
  signal,intervalMs=60000,wait=pause,onError=()=>{},onResult=()=>{}
}={}){
  let initialized=false;
  while(!signal?.aborted){
    try{
      if(!initialized){
        const result=await notifier.initialize();
        initialized=true;
        if(noteworthy(result))onResult(result);
      }
      if(signal?.aborted)return;
      const result=await notifier.check();
      if(noteworthy(result))onResult(result);
    }catch(error){
      if(signal?.aborted)return;
      if(error?.fatal)throw error;
      onError(error);
    }
    if(signal?.aborted)return;
    try{await wait(intervalMs,signal);}
    catch(error){if(!signal?.aborted)throw error;}
  }
}
