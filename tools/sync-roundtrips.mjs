/** Offline-only: fake libSQL transport backed by an isolated native SQLite DB.
 * Executes actual createSync/composeDb/store/privacy/lifecycle/ownership code.
 * Counts physical client calls (not statements inside a batch). No durable
 * scheduler receipts or HTTP admission included: this is not a production ETA.
 * Run with an empty environment and test/stage7-recovery-loader.mjs (network
 * deny). Args: tombstones per resource (default 0), optional baseline checkout.
 * Example: node --import ./test/stage7-recovery-loader.mjs tools/sync-roundtrips.mjs 2
 * Use the same tool with a frozen baseline checkout to compare transport calls.
 * Normal sample: 3 users, 7 records/resource, completed backfill, due sync.
 * Tombstone sample: 2/7 records blocked in each sleep/recovery/workout feed.
 * Does not claim to benchmark reports, reconciliation, provider pagination,
 * durable scheduler receipts, HTTP drivers or real network wall time.
 */
import Database from 'libsql';
import {Sqlite3Client,Sqlite3Transaction} from '@libsql/client/sqlite3';
import {AsyncLocalStorage} from 'node:async_hooks';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
const NOW=new Date('2026-11-03T06:10:00Z');
export async function measureSync({days=7,users=3,tombstones=0,sourceRoot=fileURLToPath(new URL('..',import.meta.url))}={}){
 if(!Number.isInteger(users)||users<1||users>3||!Number.isInteger(days)||days<1||days>90||!Number.isInteger(tombstones)||tombstones<0||tombstones>days)throw Error('SYNTHETIC_BENCHMARK_BOUNDS');
 const {composeDb}=await import(pathToFileURL(resolve(sourceRoot,'src/db.js')));
 const {createSync}=await import(pathToFileURL(resolve(sourceRoot,'src/sync.js')));
 const {createSchemaTransitionRuntimeProfile,SCHEMA_TRANSITION_PROFILE}=await import(pathToFileURL(resolve(sourceRoot,'src/schemaTransitionProfile.js')));
 const {fixtureKeys}=await import(pathToFileURL(resolve(sourceRoot,'test/localDb.js')));
 const {log}=await import(pathToFileURL(resolve(sourceRoot,'src/logger.js')));
 const scope=new AsyncLocalStorage(),counts={},sqlCounts={};let enabled=false;
 const bump=(kind,sql)=>{if(!enabled)return;const step=scope.getStore()??'ownership';const row=counts[step]??={execute:0,batch:0,transaction:0,commit:0,rollback:0};row[kind]++;if(sql){const key=sql.replace(/\s+/g,' ').trim();sqlCounts[key]=(sqlCounts[key]??0)+1;}};
 const wrap=target=>new Proxy(target,{get(o,k){
  if(k==='execute')return s=>{bump('execute',typeof s==='string'?s:s.sql);return o.execute(s);};
  if(k==='batch')return (...args)=>{bump('batch');return o.batch(...args);};
  if(k==='transaction')return async mode=>{bump('transaction');return wrap(await o.transaction(mode));};
  if(k==='commit'||k==='rollback')return (...args)=>{bump(k);return o[k](...args);};
  const v=Reflect.get(o,k);return typeof v==='function'?v.bind(o):v;
 }});
 const anchor=new Database(':memory:'),base=new Sqlite3Client(':memory:',{},anchor,'number');
 base.transaction=async(mode='write')=>{await base.execute(mode==='write'?'BEGIN IMMEDIATE':'BEGIN DEFERRED');return new Sqlite3Transaction(anchor,'number');};
 const client=wrap(base),runtimeProfile=createSchemaTransitionRuntimeProfile({environment:{PHASE4_EXECUTION_PROFILE:SCHEMA_TRANSITION_PROFILE},keys:fixtureKeys});
 const composed=composeDb(client,{phase4Keys:fixtureKeys,runtimeProfile});
 const db=new Proxy(composed,{get(o,k){const v=Reflect.get(o,k);return typeof v==='function'&&!['transaction','withRuntimeFence','close'].includes(k)?(...a)=>scope.run(k,()=>v(...a)):v;}});
 const oldLog={...log};for(const k of Object.keys(oldLog))log[k]=()=>{};
 try{
  await db.migrate({targetVersion:33});
  for(let i=0;i<users;i++){
   const id=`synthetic-${i}`;await db.createUser({id,displayName:'Synthetic',timezone:'Asia/Taipei',status:'ACTIVE'},{now:NOW});
   for(const resource of ['sleep','recovery','cycle','workout','body_measurement'])await db.saveSyncState(id,resource,{backfillComplete:true,lastSuccessAt:'2026-11-02T00:00:00Z'},{now:NOW});
  }
  for(let u=0;u<users;u++)for(const resource of ['sleep','recovery','workout'])for(let i=0;i<tombstones;i++)await db.raw.execute({sql:'INSERT INTO whoop_resource_tombstones(user_id,resource_type,resource_id,deleted_at,created_at,updated_at) VALUES (?,?,?,?,?,?)',args:[`synthetic-${u}`,resource,`s-${i}`,NOW.toISOString(),NOW.toISOString(),NOW.toISOString()]});
  const records=Array.from({length:days},(_,i)=>{const end=new Date(+NOW-i*86400000-3600000).toISOString();return {id:`s-${i}`,sleep_id:`s-${i}`,cycle_id:i,user_id:1,start:new Date(Date.parse(end)-8*3600000).toISOString(),end,updated_at:end,created_at:end,score_state:'SCORED',nap:false,score:{user_calibrating:false,recovery_score:60,hrv_rmssd_milli:50,resting_heart_rate:55,strain:10,stage_summary:{total_light_sleep_time_milli:14400000,total_slow_wave_sleep_time_milli:7200000,total_rem_sleep_time_milli:7200000}}};});
  const whoop={sleeps:async()=>records,recoveries:async()=>records,cycles:async()=>records,workouts:async()=>records,bodyMeasurement:async()=>({height_meter:1.7,weight_kilogram:70,max_heart_rate:180})};
  enabled=true;const outcomes=[];
  for(let i=0;i<users;i++)outcomes.push(await createSync({db,whoop,userId:`synthetic-${i}`,timezone:'Asia/Taipei',expectedLifecycleGeneration:1,now:NOW}).syncAll());
  enabled=false;
  const totals=Object.values(counts).reduce((a,r)=>{for(const [k,n]of Object.entries(r))a[k]=(a[k]??0)+n;return a;},{});
  return {scope:'synthetic SYNC composition; no durable scheduler admission or real HTTP',users,days,tombstones,outcomes:outcomes.map(o=>({outcome:o.outcome,complete:o.complete})),totals,steps:counts,topQueries:Object.entries(sqlCounts).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([sql,calls])=>({sql,calls,serial_ms_at_100ms:calls*100}))};
 }finally{enabled=false;Object.assign(log,oldLog);db.close();}
}
if(import.meta.url===pathToFileURL(process.argv[1]??'').href)console.log(JSON.stringify(await measureSync({tombstones:Number(process.argv[2]??0),...(process.argv[3]?{sourceRoot:resolve(process.argv[3])}:{})}),null,2));
