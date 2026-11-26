import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {buildMigrationSQL,writePrivateMigration} from './migrate.mjs';
import {createD1Bucket} from './storage.mjs';
import {createTestD1} from './test-d1.mjs';

const article=id=>({id,date:'2026-11-23',category:'API',title:"Новина '; DROP TABLE objects; --",summary:'Перевірена новина',source:'https://developer.android.com/news',sourceLabel:'Google'});
const checkpoint={version:1,owners:{'111':{baselineAt:'2026-11-23T08:30:00.000Z',seenIds:['old','backdated']}}};
async function files(t){
  const directory=await mkdtemp(join(tmpdir(),'play-pulse-d1-import-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const newsPath=join(directory,'news.json'),notificationsPath=join(directory,'notifications.json'),outPath=join(directory,'private.sql');
  await writeFile(newsPath,JSON.stringify([article('old')]));
  await writeFile(notificationsPath,JSON.stringify(checkpoint));
  return {directory,newsPath,notificationsPath,outPath};
}

test('migration imports full raw news and notification metadata without old account state',async t=>{
  const {db,sqlite}=await createTestD1(t),news=[article('old'),article('backdated')];
  sqlite.exec(buildMigrationSQL({news,notifications:checkpoint}));
  const bucket=createD1Bucket(db);
  const storedNews=await bucket.get('news/updates-v1.json'),storedNotifications=await bucket.get('telegram/notifications-v1.json');
  assert.ok(storedNews);assert.ok(storedNotifications);
  assert.deepEqual(await storedNews.json(),news);
  assert.deepEqual(await storedNotifications.json(),checkpoint);
  assert.equal(await bucket.get('account/admin-v1.json'),null);
  assert.equal(sqlite.prepare('SELECT count(*) AS count FROM objects').get().count,2);
});

test('large imports keep each SQL statement below D1 limits and assemble the complete JSON',async t=>{
  const {db,sqlite}=await createTestD1(t);
  const news=Array.from({length:100},(_,i)=>({...article('news-'+i),summary:'Я'.repeat(1000)}));
  const sql=buildMigrationSQL({news,notifications:checkpoint});
  assert.ok(Buffer.byteLength(sql)>100000);
  assert.ok(sql.trim().split('\n').every(statement=>Buffer.byteLength(statement)<100000));
  sqlite.exec(sql);
  assert.deepEqual(await (await createD1Bucket(db).get('news/updates-v1.json')).json(),news);
});

test('replaying an import never overwrites newer news or sent IDs',async t=>{
  const {db,sqlite}=await createTestD1(t),bucket=createD1Bucket(db);
  const tableNames=()=>sqlite.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(row=>row.name);
  const before=tableNames();
  const sql=buildMigrationSQL({news:[article('old')],notifications:checkpoint});
  sqlite.exec(sql);
  await bucket.put('news/updates-v1.json',JSON.stringify([article('owner-edit')]));
  const newer={version:1,owners:{'111':{...checkpoint.owners['111'],seenIds:['old','newer']}}};
  await bucket.put('telegram/notifications-v1.json',JSON.stringify(newer));
  sqlite.exec(sql);
  assert.deepEqual(await (await bucket.get('news/updates-v1.json')).json(),[article('owner-edit')]);
  assert.deepEqual(await (await bucket.get('telegram/notifications-v1.json')).json(),newer);
  assert.deepEqual(tableNames(),before);
});

test('invalid news or checkpoint data is refused without exposing private content',()=>{
  for(const input of [
    {news:null,notifications:checkpoint},
    {news:[article('same'),article('same')],notifications:checkpoint},
    {news:[article('valid')],notifications:{version:1,owners:{'111':{secret:'private fixture secret'}}}}
  ])assert.throws(()=>buildMigrationSQL(input),error=>{
    assert.equal(error.code,'MIGRATION_INVALID');
    assert.ok(!error.stack.includes('private fixture secret'));return true;
  });
});

test('private import files are exclusive and owner-readable only',async t=>{
  const f=await files(t),{sqlite}=await createTestD1(t);
  assert.deepEqual(await writePrivateMigration(f),{newsCount:1,ownerCount:1});
  assert.equal((await stat(f.outPath)).mode&0o777,0o600);
  const sql=await readFile(f.outPath,'utf8');
  sqlite.exec(sql);
  await assert.rejects(writePrivateMigration(f),{code:'MIGRATION_WRITE_FAILED'});
  assert.equal(await readFile(f.outPath,'utf8'),sql);
});

test('CLI reads explicit paths and prints counts without private news content',async t=>{
  const f=await files(t);
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('./migrate.mjs',import.meta.url)),
    '--news',f.newsPath,'--notifications',f.notificationsPath,'--out',f.outPath],{env:{},encoding:'utf8'});
  assert.equal(result.status,0);
  assert.match(result.stdout,/1/);
  assert.ok(!result.stdout.includes('DROP TABLE'));
  assert.ok(!result.stderr.includes(f.newsPath));
  assert.equal((await stat(f.outPath)).mode&0o777,0o600);
});
