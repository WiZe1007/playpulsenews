import {DatabaseSync} from 'node:sqlite';
import {readFile} from 'node:fs/promises';
import {PlayPulseAuth} from './auth.mjs';

export function createTestAuthNamespace(env){
  const objects=new Map();
  return {
    idFromName:name=>String(name),
    get(id){
      if(!objects.has(id))objects.set(id,new PlayPulseAuth({},env));
      return objects.get(id);
    }
  };
}

// Execute the production adapter's SQL against SQLite; no SQL string matching.
export async function createTestD1(t){
  const sqlite=new DatabaseSync(':memory:');
  t.after(()=>sqlite.close());
  sqlite.exec(await readFile(new URL('./schema.sql',import.meta.url),'utf8'));
  const db={prepare(sql){
    const statement=sqlite.prepare(sql);
    const bound=(values=[])=>({
      bind(...args){return bound(args);},
      async first(column){const row=statement.get(...values);return row?(column?row[column]:{...row}):null;},
      async run(){const result=statement.run(...values);return {success:true,meta:{changes:Number(result.changes)},results:[]};},
      async all(){return {success:true,results:statement.all(...values).map(row=>({...row}))};}
    });
    return bound();
  }};
  return {db,sqlite};
}
