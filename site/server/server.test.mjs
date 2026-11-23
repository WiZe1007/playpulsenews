import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {request as httpRequest} from 'node:http';
import {createServer,loadSite} from './server.mjs';
const origin='https://private.example';
const row={id:'private-live-record',date:'2026-11-23',category:'API',title:'Жива новина',summary:'Приватний матеріал',source:'https://developer.android.com/news',sourceLabel:'Android'};
async function fixture(t){
  assert.equal(typeof loadSite,'function');
  const dir=await mkdtemp(join(tmpdir(),'play-pulse-http-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const seedFile=join(dir,'private-feed.json');await writeFile(seedFile,JSON.stringify([row]),{mode:0o600});
  const env={RENDER_EXTERNAL_URL:origin,PLAY_PULSE_DATA_DIR:join(dir,'data'),PLAY_PULSE_SEED_FILE:seedFile,PLAY_PULSE_OWNER_ID:'owner_'+'a'.repeat(40),PP_PASSWORD_PEPPER:'a'.repeat(64),PLAY_PULSE_READ_TOKEN:'read_'+'r'.repeat(40),PLAY_PULSE_WRITE_TOKEN:'write_'+'w'.repeat(40),PLAY_PULSE_SETUP_TOKEN:'setup_'+'s'.repeat(40)};
  return {dir,env,seedFile};
}
async function listen(t,options){
  assert.equal(typeof createServer,'function');
  const server=createServer(options);server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  return 'http://127.0.0.1:'+server.address().port;
}

test('native HTTP serves only the configured private feed and ignores spoofed identity and host headers',async t=>{
  const f=await fixture(t),options=await loadSite(f.env),url=await listen(t,options);
  const health=await fetch(url+'/healthz');assert.deepEqual(await health.json(),{ok:true});
  const home=await fetch(url+'/',{redirect:'manual',headers:{host:'attacker.invalid','x-forwarded-host':'attacker.invalid','oai-authenticated-user-id':f.env.PLAY_PULSE_OWNER_ID}});
  assert.equal(home.status,302);assert.equal(home.headers.get('location'),'/account.html?next=%2F');
  const denied=await fetch(url+'/news.json');assert.equal(denied.status,401);
  const response=await fetch(url+'/news.json',{headers:{authorization:'Bearer '+f.env.PLAY_PULSE_READ_TOKEN}});
  assert.equal(response.status,200);assert.deepEqual(await response.json(),[row]);
  const head=await fetch(url+'/news.json',{method:'HEAD',headers:{authorization:'Bearer '+f.env.PLAY_PULSE_READ_TOKEN}});
  assert.equal(head.status,200);assert.equal(await head.text(),'');
  for(const path of ['/news.json.bak','/.env','/server/start.mjs','/server/index.js','/private-feed.json'])assert.equal((await fetch(url+path)).status,401);
});

test('native HTTP rejects oversized declared and chunked bodies without leaking errors or writing news',async t=>{
  const f=await fixture(t),options=await loadSite(f.env),url=await listen(t,options);
  const headers={authorization:'Bearer '+f.env.PLAY_PULSE_WRITE_TOKEN,'content-type':'application/json'};
  const response=await fetch(url+'/api/news',{method:'POST',headers,body:'x'.repeat(128*1024+1)});
  assert.equal(response.status,413);assert.doesNotMatch(await response.text(),/read_|write_|setup_|\/var\//);
  const chunked=await new Promise((resolve,reject)=>{
    const request=httpRequest(url+'/api/news',{method:'POST',headers:{...headers,'transfer-encoding':'chunked'}},response=>{
      let body='';response.setEncoding('utf8');response.on('data',chunk=>{body+=chunk;});response.on('end',()=>resolve({status:response.statusCode,body}));
    });
    request.on('error',reject);request.write('x'.repeat(70000));request.end('x'.repeat(70000));
  });
  assert.equal(chunked.status,413);
  const feed=await fetch(url+'/news.json',{headers:{authorization:'Bearer '+f.env.PLAY_PULSE_READ_TOKEN}});
  assert.deepEqual(await feed.json(),[row]);
});

test('startup refuses missing or malformed private imports instead of using the repository seed',async t=>{
  const f=await fixture(t);
  await rm(f.seedFile);
  await assert.rejects(loadSite(f.env),error=>!error.message.includes(f.seedFile));
  await writeFile(f.seedFile,'not-json private content');
  await assert.rejects(loadSite(f.env),error=>!error.message.includes('private content'));
  await writeFile(f.seedFile,JSON.stringify([row,row]));
  await assert.rejects(loadSite(f.env));
});
