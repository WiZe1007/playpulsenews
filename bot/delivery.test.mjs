import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';

const {notificationConfig,runNotifications}=await import('./delivery.mjs').catch(()=>({}));

test('notifications remain opt-in and validate the enabled polling interval',()=>{
  assert.equal(typeof notificationConfig,'function');
  assert.equal(notificationConfig({}).enabled,false);
  const config=notificationConfig({PLAY_PULSE_NOTIFICATIONS_ENABLED:'1'});
  assert.equal(config.enabled,true);
  assert.equal(config.intervalMs,60000);
  assert.equal(config.statePath,fileURLToPath(new URL('./.runtime/notifications.json',import.meta.url)));
  assert.equal(notificationConfig({PLAY_PULSE_NOTIFICATIONS_ENABLED:'1',PLAY_PULSE_NOTIFICATIONS_INTERVAL_SECONDS:'120'}).intervalMs,120000);
  for(const value of ['true','yes','2'])assert.throws(()=>notificationConfig({PLAY_PULSE_NOTIFICATIONS_ENABLED:value}));
  for(const value of ['0','-1','NaN','1.5','999999999'])assert.throws(()=>notificationConfig({PLAY_PULSE_NOTIFICATIONS_ENABLED:'1',PLAY_PULSE_NOTIFICATIONS_INTERVAL_SECONDS:value}));
});

test('an explicit bootstrap file resolves only for enabled notifications',()=>{
  const configured={PLAY_PULSE_NOTIFICATIONS_ENABLED:'1',PLAY_PULSE_NOTIFICATIONS_BOOTSTRAP_FILE:' ./checkpoint.json '};
  assert.equal(notificationConfig(configured).bootstrapPath,fileURLToPath(new URL('./checkpoint.json',import.meta.url)));
  assert.deepEqual(notificationConfig({...configured,PLAY_PULSE_NOTIFICATIONS_ENABLED:'0'}),{enabled:false});
  assert.equal(notificationConfig({PLAY_PULSE_NOTIFICATIONS_ENABLED:'1'}).bootstrapPath,undefined);
});

test('delivery initializes silently then checks sequentially at the configured interval',async()=>{
  assert.equal(typeof runNotifications,'function');
  const controller=new AbortController(),events=[],reports=[];
  const notifier={
    initialize:async()=>{events.push('initialize');return {initializedOwners:1,sentMessages:0,sentArticles:0};},
    check:async()=>{events.push('check');return {initializedOwners:0,sentMessages:0,sentArticles:0};}
  };
  await runNotifications(notifier,{
    signal:controller.signal,intervalMs:60000,onResult:value=>reports.push(value),
    wait:async(ms,signal)=>{
      assert.equal(ms,60000);assert.equal(signal,controller.signal);events.push('wait');
      if(events.filter(x=>x==='check').length===2)controller.abort();
    }
  });
  assert.deepEqual(events,['initialize','check','wait','check','wait']);
  assert.deepEqual(reports,[{initializedOwners:1,sentMessages:0,sentArticles:0}]);
});

test('failed initialization is retried without silently checking against a new baseline',async()=>{
  assert.equal(typeof runNotifications,'function');
  const controller=new AbortController(),events=[],errors=[];
  let attempts=0;
  const notifier={
    initialize:async()=>{events.push('initialize');if(++attempts===1)throw Error('corrupt state');return {initializedOwners:0,sentMessages:0,sentArticles:0};},
    check:async()=>{events.push('check');controller.abort();return {initializedOwners:0,sentMessages:0,sentArticles:0};}
  };
  await runNotifications(notifier,{signal:controller.signal,wait:async()=>{events.push('wait');},onError:error=>errors.push(error)});
  assert.deepEqual(events,['initialize','wait','initialize','check']);
  assert.equal(errors.length,1);
});

test('failed checks retry at the interval and report only completed deliveries',async()=>{
  assert.equal(typeof runNotifications,'function');
  const controller=new AbortController(),errors=[],reports=[];
  let checks=0;
  await runNotifications({
    initialize:async()=>({initializedOwners:0,sentMessages:0,sentArticles:0}),
    check:async()=>{if(++checks===1)throw Error('temporary');controller.abort();return {initializedOwners:0,sentMessages:2,sentArticles:4};}
  },{signal:controller.signal,wait:async()=>{},onError:error=>errors.push(error),onResult:result=>reports.push(result)});
  assert.equal(checks,2);
  assert.equal(errors.length,1);
  assert.deepEqual(reports,[{initializedOwners:0,sentMessages:2,sentArticles:4}]);
});

test('fatal Telegram authentication errors stop delivery for the shared runtime',async()=>{
  assert.equal(typeof runNotifications,'function');
  const failure=Object.assign(Error('safe authentication error'),{fatal:true});
  let waited=false;
  await assert.rejects(runNotifications({initialize:async()=>{},check:async()=>{throw failure;}},{wait:async()=>{waited=true;}}),error=>error===failure);
  assert.equal(waited,false);
});

test('shutdown cancels the pending interval and does not check again',async()=>{
  assert.equal(typeof runNotifications,'function');
  const controller=new AbortController();
  let checks=0,ready;
  const waiting=new Promise(resolve=>{ready=resolve;});
  const run=runNotifications({initialize:async()=>{},check:async()=>{checks++;}},{signal:controller.signal,wait:async(_ms,signal)=>{
    ready();
    await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('Stopped','AbortError')),{once:true}));
  }});
  await waiting;controller.abort();await run;
  assert.equal(checks,1);
});
