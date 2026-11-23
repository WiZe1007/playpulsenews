import {resolve} from 'node:path';

export function config(env=process.env){
  try{
    const publicURL=new URL(env.PLAY_PULSE_PUBLIC_ORIGIN||env.RENDER_EXTERNAL_URL);
    if(publicURL.protocol!=='https:'||publicURL.username||publicURL.password||publicURL.port||publicURL.pathname!=='/'||publicURL.search||publicURL.hash)throw Error();
    const readToken=env.PLAY_PULSE_READ_TOKEN,writeToken=env.PLAY_PULSE_WRITE_TOKEN,setupToken=env.PLAY_PULSE_SETUP_TOKEN;
    if(![readToken,writeToken,setupToken].every(value=>typeof value==='string'&&/^[A-Za-z0-9_-]{32,128}$/.test(value))||new Set([readToken,writeToken,setupToken]).size!==3)throw Error();
    const ownerId=env.PLAY_PULSE_OWNER_ID,pepper=env.PP_PASSWORD_PEPPER;
    if(typeof ownerId!=='string'||!/^[A-Za-z0-9_-]{32,128}$/.test(ownerId)||typeof pepper!=='string'||!/^[a-f0-9]{64}$/.test(pepper))throw Error();
    if(!env.PLAY_PULSE_DATA_DIR?.trim()||!env.PLAY_PULSE_SEED_FILE?.trim())throw Error();
    const port=Number(env.PORT||10000);
    if(!Number.isInteger(port)||port<1||port>65535)throw Error();
    return {origin:publicURL.origin,readToken,writeToken,setupToken,ownerId,pepper,dataDir:resolve(env.PLAY_PULSE_DATA_DIR),seedFile:resolve(env.PLAY_PULSE_SEED_FILE),port};
  }catch{throw Error('Проверьте приватные параметры сервера Play Pulse.');}
}
