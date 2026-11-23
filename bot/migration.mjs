import {constants} from 'node:fs';
import {mkdir,open,link,unlink,lstat} from 'node:fs/promises';
import {dirname,basename,join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {validateNotificationState} from './notifications.mjs';

const LIMIT=16*1024*1024;
const messages={
  CONFIG_INVALID:'Проверьте параметры переноса состояния уведомлений.',
  STATE_INVALID:'Существующее состояние уведомлений повреждено или недоступно. Перезапись запрещена.',
  BOOTSTRAP_INVALID:'Начальное состояние уведомлений отсутствует, повреждено или не соответствует владельцам.',
  RESTORE_FAILED:'Не удалось сохранить начальное состояние уведомлений.'
};
export class MigrationError extends Error {
  constructor(code){super(messages[code]);this.name='MigrationError';this.code=code;}
}

async function readCheckpoint(path,owners,{code,allowMissing=false}){
  let file;
  try{
    file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const info=await file.stat();
    if(!info.isFile()||info.size>LIMIT)throw Error();
    const bytes=await file.readFile();
    if(bytes.length>LIMIT)throw Error();
    const state=validateNotificationState(JSON.parse(bytes.toString('utf8')));
    if(!owners.every(id=>Object.hasOwn(state.owners,id)))throw Error();
    return state;
  }catch(error){
    if(!file&&error.code==='ENOENT'&&allowMissing)return null;
    throw new MigrationError(code);
  }finally{await file?.close().catch(()=>{});}
}

export async function restoreNotificationState({statePath,bootstrapPath,allowed}={}){
  const owners=Array.from(allowed||[],String);
  if(typeof statePath!=='string'||!statePath||!owners.length||owners.some(id=>!/^\d+$/.test(id)||
    !Number.isSafeInteger(Number(id))||Number(id)<1||String(Number(id))!==id))
    throw new MigrationError('CONFIG_INVALID');
  const destination=resolve(statePath);
  const existing=await readCheckpoint(destination,[],{code:'STATE_INVALID',allowMissing:true});
  if(existing)return false;
  if(typeof bootstrapPath!=='string'||!bootstrapPath)throw new MigrationError('BOOTSTRAP_INVALID');
  const source=await readCheckpoint(resolve(bootstrapPath),owners,{code:'BOOTSTRAP_INVALID'});
  const parent=dirname(destination);
  const temporary=join(parent,'.'+basename(destination)+'.bootstrap-'+randomUUID()+'.tmp');
  let file;
  try{
    await mkdir(parent,{recursive:true,mode:0o700});
    if(!(await lstat(parent)).isDirectory())throw Error();
    file=await open(temporary,'wx',0o600);
    await file.writeFile(JSON.stringify(source)+'\n');await file.sync();
    await file.close();file=undefined;
    try{
      // A hard link creates the final name exclusively; a concurrent restore
      // or notifier can win, but can never be overwritten by this operation.
      await link(temporary,destination);
      return true;
    }catch(error){
      if(error.code!=='EEXIST')throw error;
      await readCheckpoint(destination,[],{code:'STATE_INVALID'});
      return false;
    }
  }catch(error){
    if(error instanceof MigrationError)throw error;
    throw new MigrationError('RESTORE_FAILED');
  }finally{
    await file?.close().catch(()=>{});
    await unlink(temporary).catch(()=>{});
  }
}
