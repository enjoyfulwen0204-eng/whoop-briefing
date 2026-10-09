import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createDb} from '../src/db.js';
import {createOwnedDb} from './stage5OwnedDb.js';
import {fixtureKeys} from './localDb.js';
import {hranaTransport} from './hranaTransport.js';
import {controlledMigration} from '../scripts/phase4-migrate.js';
export {fixtureKeys};
// Frozen fee0448 (v6) CREATE and d4beb11 (v7) ALTER. de7c079 changed
// future ADDs only; it explicitly left the already-added production column.
export const V6_TELEGRAM_TABLE=`CREATE TABLE IF NOT EXISTS telegram_operations (
 update_id INTEGER PRIMARY KEY, result_json TEXT NOT NULL, committed_at TEXT NOT NULL)`;
export const V7_DELIVERY_COLUMN="ALTER TABLE telegram_operations ADD COLUMN delivery_state TEXT NOT NULL DEFAULT 'DELIVERED'";
export function openHttpFixture(url){
 const transport=hranaTransport(url);
 const db=createDb({url:'https://isolated.invalid',fetch:transport.fetch,phase4Keys:fixtureKeys});
 return {db,transport,close(){db.close();transport.close();}};
}
export async function deliveryFixture(t,{version=32,defaultValue='DELIVERED'}={}){
 const dir=await mkdtemp(join(tmpdir(),'delivery-default-')),url=`file:${join(dir,'db.sqlite')}`,seed=createOwnedDb({url});let fixture;
 t.after(async()=>{fixture?.close();await rm(dir,{recursive:true,force:true});});
 try{
  if(defaultValue!=='ACTION_READY'){
   await seed.raw.execute(V6_TELEGRAM_TABLE);
   await seed.raw.execute(defaultValue==='DELIVERED'?V7_DELIVERY_COLUMN:
    "ALTER TABLE telegram_operations ADD COLUMN delivery_state TEXT NOT NULL DEFAULT 'AMBIGUOUS'");
  }
  await seed.migrate({targetVersion:31});
  if(version===32)await controlledMigration(seed.raw,{apply:true,keys:fixtureKeys,targetVersion:32});
  else if(version!==31)throw Error('ISOLATED_FIXTURE_VERSION_REQUIRED');
 }finally{await seed.close();}
 fixture=openHttpFixture(url);return {...fixture,url,dir};
}
export async function deliveryColumn(db){return (await db.raw.execute('PRAGMA table_info(telegram_operations)')).rows.find(row=>row.name==='delivery_state');}
