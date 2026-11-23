import {pathToFileURL} from 'node:url';
import {config,feed} from './bot.mjs';
import {checkTelegram} from './setup.mjs';
import {notificationConfig} from './delivery.mjs';

export async function checkReadiness(env=process.env,{fetchFn=fetch}={}){
  if(!env.TELEGRAM_ALLOWED_USER_IDS?.trim())throw Error('Укажите Telegram ID владельца в TELEGRAM_ALLOWED_USER_IDS локального .env.');
  let cfg;
  try{cfg=config(env);notificationConfig(env);}catch{throw Error('Проверьте локальные параметры запуска бота, уведомлений и авторизации ленты.');}
  const {username}=await checkTelegram(cfg.token,fetchFn);
  const articles=await feed(cfg,fetchFn)();
  return {username,articleCount:articles.length};
}

export async function runDoctor(env=process.env,{log=console.log,error=console.error,...options}={}){
  try{
    const {username,articleCount}=await checkReadiness(env,options);
    log('Play Pulse: проверка пройдена. Бот @'+username+'; записей в живой ленте: '+articleCount+'.');
    log('Проверка личного чата: отправьте боту /start и откройте «Последние новости».');
    return 0;
  }catch(failure){
    error('Play Pulse: '+failure.message);
    return 1;
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)process.exitCode=await runDoctor();
