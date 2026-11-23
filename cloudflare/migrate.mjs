import {constants} from 'node:fs';
import {open,mkdir,link,unlink,lstat} from 'node:fs/promises';
import {dirname,basename,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {MAX_OBJECT_BYTES} from './storage.mjs';
import {validateNotificationState} from '../bot/notifications.mjs';

const encoder=new TextEncoder();
const failure=(code='MIGRATION_INVALID')=>Object.assign(new Error(code==='MIGRATION_WRITE_FAILED'?
  'Не удалось создать приватный SQL-файл. Существующие файлы не перезаписываются.':
  'Не удалось проверить данные переноса Play Pulse.'),{name:'D1MigrationError',code});
const quote=value=>"'"+value.replace(/'/g,"''")+"'";
function validated({news,notifications}={}){
  try{
    if(!Array.isArray(news)||!news.length||news.length>1500||news.some(item=>!item||Array.isArray(item)||typeof item.id!=='string'||!/^[a-z0-9][a-z0-9-]{0,95}$/.test(item.id))||
      new Set(news.map(item=>item.id)).size!==news.length)throw Error();
    validateNotificationState(notifications);
    const objects=[['news/updates-v1.json',JSON.stringify(news)],['telegram/notifications-v1.json',JSON.stringify(notifications)]];
    if(objects.some(([,body])=>encoder.encode(body).byteLength>MAX_OBJECT_BYTES))throw Error();
    return objects;
  }catch{throw failure();}
}

export function buildMigrationSQL(input){
  const objects=validated(input),table='_play_pulse_import_'+randomUUID().replaceAll('-','');
  const statements=[`CREATE TABLE ${table} (object_key TEXT NOT NULL, part INTEGER NOT NULL, chunk TEXT NOT NULL, PRIMARY KEY(object_key, part));`];
  const assembled=[];
  for(const [key,body] of objects){
    const points=Array.from(body),parts=Math.ceil(points.length/10000);
    for(let part=0;part<parts;part++){
      const chunk=points.slice(part*10000,(part+1)*10000).join('');
      statements.push(`INSERT INTO ${table}(object_key, part, chunk) VALUES (${quote(key)}, ${part}, ${quote(chunk)});`);
    }
    // Publish only the complete JSON object. No partially assembled archive
    // is visible, and a replay never replaces live edits or delivered IDs.
    assembled.push(`INSERT INTO objects(key, body, etag) SELECT ${quote(key)}, body, ${quote(randomUUID())} FROM (SELECT group_concat(chunk, '') AS body, count(*) AS parts FROM (SELECT chunk FROM ${table} WHERE object_key = ${quote(key)} ORDER BY part)) WHERE parts = ${parts} AND length(CAST(body AS BLOB)) = ${encoder.encode(body).byteLength} ON CONFLICT(key) DO NOTHING;`);
  }
  statements.push(...assembled,`DROP TABLE ${table};`);
  if(statements.some(statement=>encoder.encode(statement).byteLength>=100000))throw failure();
  return statements.join('\n')+'\n';
}

async function readPrivateJSON(path){
  let file;
  try{
    file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const info=await file.stat();
    if(!info.isFile()||info.size>16*1024*1024)throw Error();
    const bytes=await file.readFile();
    if(bytes.length>16*1024*1024)throw Error();
    return JSON.parse(bytes.toString('utf8'));
  }catch{throw failure();}
  finally{await file?.close().catch(()=>{});}
}

export async function writePrivateMigration({newsPath,notificationsPath,outPath}={}){
  if([newsPath,notificationsPath,outPath].some(path=>typeof path!=='string'||!path))throw failure();
  const [news,notifications]=await Promise.all([readPrivateJSON(newsPath),readPrivateJSON(notificationsPath)]);
  const sql=buildMigrationSQL({news,notifications}),destination=resolve(outPath),parent=dirname(destination);
  const temporary=join(parent,'.'+basename(destination)+'.'+randomUUID()+'.tmp');
  let file;
  try{
    await mkdir(parent,{recursive:true,mode:0o700});
    if(!(await lstat(parent)).isDirectory())throw Error();
    file=await open(temporary,'wx',0o600);
    await file.writeFile(sql);await file.sync();await file.close();file=undefined;
    await link(temporary,destination);
    return {newsCount:news.length,ownerCount:Object.keys(notifications.owners).length};
  }catch{throw failure('MIGRATION_WRITE_FAILED');}
  finally{await file?.close().catch(()=>{});await unlink(temporary).catch(()=>{});}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{
    const values=new Map(),args=process.argv.slice(2);
    if(args.length!==6)throw failure();
    for(let index=0;index<args.length;index+=2){
      if(!['--news','--notifications','--out'].includes(args[index])||values.has(args[index]))throw failure();
      values.set(args[index],args[index+1]);
    }
    const result=await writePrivateMigration({newsPath:values.get('--news'),notificationsPath:values.get('--notifications'),outPath:values.get('--out')});
    console.log('Приватный импорт подготовлен: новостей '+result.newsCount+', владельцев '+result.ownerCount+'.');
  }catch{
    console.error('Подготовка импорта остановлена. Проверьте приватные JSON-файлы и новый путь --out.');
    process.exitCode=1;
  }
}
