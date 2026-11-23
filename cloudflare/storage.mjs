export const MAX_OBJECT_BYTES=1_900_000;
const encoder=new TextEncoder();
const failure=()=>Object.assign(new Error('Хранилище Play Pulse недоступно или содержит некорректные данные.'),{name:'D1StorageError',code:'STORAGE_UNAVAILABLE'});
const validEtag=value=>typeof value==='string'&&value.length>0&&value.length<=128&&!/[\u0000-\u001f\u007f]/.test(value);
function validateBody(body){
  if(typeof body!=='string'||body.length>MAX_OBJECT_BYTES||encoder.encode(body).byteLength>MAX_OBJECT_BYTES)throw failure();
  try{JSON.parse(body);}catch{throw failure();}
}
function conditions(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['etagMatches','etagDoesNotMatch'].includes(key)))throw failure();
  for(const key of ['etagMatches','etagDoesNotMatch'])
    if(value[key]!==undefined&&!validEtag(value[key]))throw failure();
  return value;
}

export function createD1Bucket(db,{prefix=''}={}){
  if(!db||typeof db.prepare!=='function'||typeof prefix!=='string'||/[\u0000-\u001f\u007f]/.test(prefix)||encoder.encode(prefix).byteLength>1024)throw failure();
  const fullKey=key=>{
    if(typeof key!=='string'||!key||/[\u0000-\u001f\u007f]/.test(key))throw failure();
    const full=prefix+key;
    if(encoder.encode(full).byteLength>1024)throw failure();
    return full;
  };
  return {
    async get(key){
      try{
        const row=await db.prepare('SELECT body, etag FROM objects WHERE key = ?1 LIMIT 1').bind(fullKey(key)).first();
        if(row===null)return null;
        if(!row||!validEtag(row.etag))throw failure();
        validateBody(row.body);
        return {etag:row.etag,json:async()=>JSON.parse(row.body)};
      }catch{throw failure();}
    },
    async put(key,body,{onlyIf={}}={}){
      try{
        const savedKey=fullKey(key),condition=conditions(onlyIf);
        validateBody(body);
        const etag=crypto.randomUUID();
        let statement;
        if(condition.etagMatches!==undefined){
          // A conditional update must never insert a missing object. All
          // predicates are evaluated by SQLite within this single statement.
          statement=db.prepare(`UPDATE objects SET body = ?2, etag = ?3
            WHERE key = ?1 AND (?4 = '*' OR etag = ?4)
              AND (?5 IS NULL OR (?5 <> '*' AND etag <> ?5))`)
            .bind(savedKey,body,etag,condition.etagMatches,condition.etagDoesNotMatch??null);
        }else{
          statement=db.prepare(`INSERT INTO objects(key, body, etag) VALUES (?1, ?2, ?3)
            ON CONFLICT(key) DO UPDATE SET body = excluded.body, etag = excluded.etag
            WHERE ?4 IS NULL OR (?4 <> '*' AND objects.etag <> ?4)`)
            .bind(savedKey,body,etag,condition.etagDoesNotMatch??null);
        }
        const result=await statement.run();
        if(result?.success===false||![0,1].includes(result?.meta?.changes))throw failure();
        return result.meta.changes===1?{etag}:null;
      }catch{throw failure();}
    }
  };
}
