import {randomBytes} from 'node:crypto';
import {lstat,open,readFile,rename,unlink} from 'node:fs/promises';
import {basename,dirname,join} from 'node:path';
import {setTimeout as wait} from 'node:timers/promises';
import {parseEnv} from 'node:util';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {checkTelegram} from './setup.mjs';

const DEFAULT_ENV=fileURLToPath(new URL('./.env',import.meta.url));
const OWNER_KEY='TELEGRAM_ALLOWED_USER_IDS';
class PairingError extends Error {}
const hasOwner=env=>typeof env[OWNER_KEY]==='string'&&!!env[OWNER_KEY].trim();

export function findPairingUser(updates,challenge){
  if(!Array.isArray(updates)||typeof challenge!=='string'||!challenge||!/^[A-Za-z0-9_-]{1,64}$/.test(challenge))return null;
  for(const update of updates){
    const message=update?.message,from=message?.from,id=from?.id;
    if(message?.text==='/start '+challenge&&from?.is_bot===false&&Number.isSafeInteger(id)&&id>0&&
      message.chat?.type==='private'&&message.chat.id===id)return id;
  }
  return null;
}

async function readEnvironment(path){
  if(!(await lstat(path)).isFile())throw new PairingError('Локальный .env должен быть обычным файлом.');
  return readFile(path,'utf8');
}

export async function saveOwnerId(envPath,id){
  if(!Number.isSafeInteger(id)||id<=0)throw new PairingError('Неверный Telegram user ID.');
  const lockPath=envPath+'.pair.lock';let lock,tempPath,temp;
  try{
    lock=await open(lockPath,'wx',0o600);
    const original=await readEnvironment(envPath);
    if(hasOwner(parseEnv(original)))throw new PairingError('Владелец уже настроен; существующий доступ сохранён.');
    const newline=original.includes('\r\n')?'\r\n':'\n';
    // Appending preserves comments and multiline secrets byte for byte. Node's
    // dotenv parser uses the last assignment when the template has an empty key.
    const next=original+(original&&!original.endsWith('\n')?newline:'')+OWNER_KEY+'='+id+newline;
    if(parseEnv(next)[OWNER_KEY]!==String(id))throw new PairingError('Не удалось безопасно обновить локальный .env.');
    tempPath=join(dirname(envPath),'.'+basename(envPath)+'.pair-'+randomBytes(12).toString('hex'));
    temp=await open(tempPath,'wx',0o600);
    await temp.writeFile(next,'utf8');await temp.sync();await temp.close();temp=undefined;
    if(await readEnvironment(envPath)!==original)throw new PairingError('Локальный .env изменился. Повторите привязку.');
    await rename(tempPath,envPath);tempPath=undefined;
  }catch(failure){
    if(failure instanceof PairingError)throw failure;
    throw new PairingError('Не удалось безопасно записать локальный .env. Проверьте файл и отсутствие другой привязки.');
  }finally{
    await temp?.close().catch(()=>{});
    if(tempPath)await unlink(tempPath).catch(()=>{});
    if(lock){await lock.close().catch(()=>{});await unlink(lockPath).catch(()=>{});}
  }
}

export async function runPairing(env=process.env,{
  fetchFn=fetch,envPath=DEFAULT_ENV,log=console.log,error=console.error,signal,
  timeoutMs=5*60*1000,pollDelayMs=1000
}={}){
  const deadline=new AbortController();let timedOut=false,timer;
  const active=signal?AbortSignal.any([signal,deadline.signal]):deadline.signal;
  try{
    active.throwIfAborted();
    if(hasOwner(env)||hasOwner(parseEnv(await readEnvironment(envPath)))){
      log('Play Pulse: владелец уже настроен; повторная привязка не нужна.');return 0;
    }
    const token=env.TELEGRAM_BOT_TOKEN?.trim();
    if(!/^\d{5,16}:[\w-]{32,100}$/.test(token||''))throw new PairingError('Проверьте TELEGRAM_BOT_TOKEN в локальном .env.');
    timer=setTimeout(()=>{timedOut=true;deadline.abort();},timeoutMs);
    const guardedFetch=(url,options)=>fetchFn(url,{...options,signal:AbortSignal.any([active,options.signal])});
    let username;
    try{({username}=await checkTelegram(token,guardedFetch));}
    catch{throw new PairingError('Не удалось проверить Telegram. Проверьте токен и отсутствие активного webhook.');}
    active.throwIfAborted();
    const challenge=randomBytes(32).toString('base64url');
    log('Play Pulse: откройте одноразовую ссылку своим Telegram-аккаунтом и нажмите «Начать». Ссылка действует 5 минут; не передавайте её другим.');
    log('https://t.me/'+username+'?start='+challenge);
    for(;;){
      active.throwIfAborted();
      let updates;
      try{
        // No offset: receiving a pairing request must not acknowledge or drop
        // unrelated updates. Do not change the bot's allowed_updates setting.
        const response=await guardedFetch('https://api.telegram.org/bot'+token+'/getUpdates',{
          method:'POST',redirect:'error',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({timeout:25,limit:100}),signal:AbortSignal.timeout(35000)
        });
        if(response.status===409)throw new PairingError('Telegram уже использует другой процесс или webhook. Остановите прежний процесс перед привязкой.');
        if(!response.ok)throw Error();
        const data=await response.json();
        if(data?.ok!==true||!Array.isArray(data.result)||data.result.length>100)throw Error();
        updates=data.result;
      }catch(failure){
        if(failure instanceof PairingError)throw failure;
        throw new PairingError('Telegram API недоступен. Повторите привязку позже.');
      }
      active.throwIfAborted();
      const id=findPairingUser(updates,challenge);
      if(id!==null){
        await saveOwnerId(envPath,id);
        log('Play Pulse: владелец привязан, доступ сохранён в локальном .env.');return 0;
      }
      if(updates.length===100)throw new PairingError('Очередь Telegram заполнена чужими сообщениями. Привязка остановлена без удаления сообщений.');
      await wait(pollDelayMs,undefined,{signal:active});
    }
  }catch(failure){
    if(signal?.aborted){error('Play Pulse: привязка отменена.');return 130;}
    if(timedOut){error('Play Pulse: время привязки истекло. Запустите команду снова для новой ссылки.');return 1;}
    error('Play Pulse: '+(failure instanceof PairingError?failure.message:'Не удалось выполнить привязку. Проверьте локальный .env.'));
    return 1;
  }finally{clearTimeout(timer);}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const controller=new AbortController(),cancel=()=>controller.abort();
  process.once('SIGINT',cancel);
  try{process.exitCode=await runPairing(process.env,{signal:controller.signal});}
  finally{process.removeListener('SIGINT',cancel);}
}
