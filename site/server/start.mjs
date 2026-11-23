import {loadSite,createServer} from './server.mjs';
import {runUpstreamSync} from './upstream.mjs';

try{
  const options=await loadSite(),server=createServer(options),controller=new AbortController();
  const upstreamToken=process.env.PLAY_PULSE_UPSTREAM_SITES_TOKEN;
  const upstreamError=()=>console.error('Play Pulse: синхронизация опубликованной ленты временно недоступна. Повторная попытка через минуту.');
  server.on('error',()=>{controller.abort();console.error('Play Pulse: сервер недоступен. Проверьте параметры запуска.');process.exitCode=1;});
  server.listen(options.config.port,'0.0.0.0',()=>{
    console.log('Play Pulse: приватный сервер запущен.');
    if(upstreamToken)void runUpstreamSync({handler:options.handler,config:options.config,token:upstreamToken,signal:controller.signal,onError:upstreamError}).catch(upstreamError);
  });
  let stopping=false;
  const stop=()=>{
    if(stopping)return;stopping=true;
    controller.abort();
    const deadline=setTimeout(()=>server.closeAllConnections(),10000);deadline.unref();
    server.close(()=>{clearTimeout(deadline);});server.closeIdleConnections();
  };
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,stop);
}catch{
  console.error('Play Pulse: запуск остановлен. Проверьте приватные параметры, исходную ленту и постоянное хранилище.');
  process.exitCode=1;
}
