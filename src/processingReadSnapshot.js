import {types as nativeTypes} from 'node:util';
import {memoizedSqlSyntax} from './sqlSyntaxMemo.js';
// Reuse only deterministic, tenant-bound data reads inside one original
// processing write transaction and one server context. This is not authority:
// callers still execute their original lease/clock/hash/privacy checks.
const tables=new Set(['whoop_sleeps','whoop_recoveries','whoop_cycles','whoop_workouts','whoop_resource_access',
 'whoop_capabilities','whoop_resource_tombstones','phase4_computation_state','phase4_source_links',
 'body_energy_results','body_energy_checkpoints','evidence_runs','evidence_items','observation_episodes',
 'episode_observations','episode_evidence','episode_events','episode_semantic_events','health_insights',
 'insight_revisions','phase4_episode_revisions','phase4_evidence_result_authorities','phase4_operation_receipts']);
const userState=`SELECT u.id,u.status,u.timezone,u.lifecycle_generation,
 COALESCE(t.auth_generation,0) auth_generation,p.source_generation,p.purge_generation,p.pending_purge_count
 FROM users u LEFT JOIN user_whoop_tokens t ON t.user_id=u.id
 LEFT JOIN phase4_user_state p ON p.user_id=u.id WHERE u.id=?`.replace(/\s+/g,' ').trim();
// Exact non-health principal row only; the owned executor opts in after its
// HTTP BEGIN IMMEDIATE ACK, inside one LIVE Stage6 write snapshot. Predicates,
// capability/configuration/eligibility/clock checks still execute every time.
const principalReadiness=`SELECT u.status,o.state,COALESCE(t.auth_generation,0) auth_generation,p.pending_purge_count
 FROM users u JOIN phase4_user_state p ON p.user_id=u.id JOIN user_onboarding o ON o.user_id=u.id
 LEFT JOIN user_whoop_tokens t ON t.user_id=u.id WHERE u.id=?`.replace(/\s+/g,' ').trim();
const predicate="(?:[a-z_][a-z0-9_]*\\s*(?:(?:=|<>|>=|<=|>|<)\\s*(?:\\?|'[a-z0-9_:-]*'|\\d+)|IS\\s+(?:NOT\\s+)?NULL|IN\\s*\\('[a-z0-9_:-]*'(?:\\s*,\\s*'[a-z0-9_:-]*')*\\)))";
const select=new RegExp('^SELECT\\s+(?:\\*|1|[a-z_][a-z0-9_]*(?:\\s*,\\s*[a-z_][a-z0-9_]*)*)\\s+FROM\\s+([a-z_][a-z0-9_]*)\\s+(?:INDEXED\\s+BY\\s+[a-z_][a-z0-9_]*\\s+)?WHERE\\s+user_id\\s*=\\s*\\?(?:\\s+AND\\s+'+predicate+')*(?:\\s+ORDER\\s+BY\\s+[a-z_][a-z0-9_]*(?:\\s+(?:ASC|DESC))?(?:\\s*,\\s*[a-z_][a-z0-9_]*(?:\\s+(?:ASC|DESC))?)*)?(?:\\s+LIMIT\\s+(?:\\?|\\d+))?\\s*;?$','i');
export const READ_SNAPSHOT_LIMITS=Object.freeze({entries:256,bytes:4*1024*1024,resultBytes:256*1024,rows:128,keyBytes:8192});
function snapshotSqlShape(sql){
 const normalized=sql.replace(/\s+/g,' ').trim(),match=select.exec(normalized);
 if(/\b(?:CURRENT_TIME|CURRENT_DATE|CURRENT_TIMESTAMP)\b|['"]now['"]/i.test(normalized))return 0;
 if(normalized===userState)return 1;
 if(normalized===principalReadiness)return 2;
 return match&&tables.has(match[1].toLowerCase())?3:0;
}
export function readSnapshotKey(statement,context,{allowPrincipalReadiness=false}={}){
 if(!context||typeof context.userId!=='string'||!statement||typeof statement!=='object'||Array.isArray(statement))return null;
 const {sql,args}=statement;
 if(typeof sql!=='string'||!Array.isArray(args)||args[0]!==context.userId)return null;
 const shape=memoizedSqlSyntax(snapshotSqlShape,sql);
 if(shape===0||shape===2&&!(allowPrincipalReadiness===true&&args.length===1))return null;
 if(args.some(value=>value!==null&&!['string','number','bigint','boolean'].includes(typeof value)||typeof value==='number'&&!Number.isFinite(value)))return null;
 const key=JSON.stringify([sql,args.map(value=>[value===null?'null':typeof value,String(value)])]);
 return Buffer.byteLength(key,'utf8')<=READ_SNAPSHOT_LIMITS.keyBytes?key:null;
}
// Preserve actual installed libSQL ResultSet prototype/toJSON and the numeric
// non-enumerable row aliases, without sharing mutable driver results.
export function cloneResult(result){
 const object=value=>{const copy=Object.create(Object.getPrototypeOf(value)),descriptors=Object.getOwnPropertyDescriptors(value);
  for(const descriptor of Object.values(descriptors)){
   if(!Object.hasOwn(descriptor,'value'))throw Error('UNSUPPORTED_RESULT_DESCRIPTOR');
   const value=descriptor.value,type=typeof value;
   descriptor.value=value===null||type==='undefined'||type==='string'||type==='number'||type==='boolean'||type==='bigint'
     ?value:structuredClone(value);
  }
  return Object.defineProperties(copy,descriptors);
 };
 const copy=Object.create(Object.getPrototypeOf(result));
 Object.assign(copy,{columns:[...result.columns],columnTypes:[...result.columnTypes],rows:result.rows.map(object),
  rowsAffected:result.rowsAffected,lastInsertRowid:result.lastInsertRowid});return copy;
}
export function createReadSnapshotMemo(){
 let contexts=new Map(),rawContexts=new Map(),rawEntries=0,rawBytes=0,rawEpoch=0,entries=0,bytes=0,epoch=0,closed=false;
 return {
  epoch:()=>epoch,
  get(context,key){const result=contexts.get(context)?.get(key);return !closed&&result?cloneResult(result):undefined;},
  put(context,key,result,observedEpoch){
   if(closed||epoch!==observedEpoch||entries+rawEntries>=READ_SNAPSHOT_LIMITS.entries||!Array.isArray(result?.rows)
    ||result.rows.length>READ_SNAPSHOT_LIMITS.rows||!Array.isArray(result.columns)||!Array.isArray(result.columnTypes))return;
   try{
    // One original epoch and context: first stored DATA already wins. Avoid
    // cloning/serializing an in-flight duplicate that cannot replace it.
    // Keep the original final check below for reentrant result evaluation.
    if(contexts.get(context)?.has(key))return;
    const binaryBytes=result.rows.reduce((total,row)=>total+Object.values(Object.getOwnPropertyDescriptors(row))
     .reduce((sum,descriptor)=>sum+(descriptor.value instanceof ArrayBuffer||ArrayBuffer.isView(descriptor.value)?descriptor.value.byteLength:0),0),0);
    const size=binaryBytes+Buffer.byteLength(JSON.stringify(result,(_key,value)=>typeof value==='bigint'?String(value):value),'utf8')+Buffer.byteLength(key,'utf8');
    if(size>READ_SNAPSHOT_LIMITS.resultBytes||bytes+rawBytes+size>READ_SNAPSHOT_LIMITS.bytes)return;
    const snapshot=cloneResult(result),rows=contexts.get(context)??new Map();
    if(rows.has(key))return;
    rows.set(key,snapshot);contexts.set(context,rows);entries++;bytes+=size;
   }catch{/* A result outside this narrow clone shape is simply not reused. */}
  },
  getData(context,key){const data=contexts.get(context)?.get('data:'+key)?.prefixData;return !closed&&data?structuredClone(data):undefined;},
  putData(context,key,data,observedEpoch){
   if(closed||epoch!==observedEpoch||entries+rawEntries>=READ_SNAPSHOT_LIMITS.entries||!Array.isArray(data?.rows)
    ||data.rows.length>READ_SNAPSHOT_LIMITS.rows||Buffer.byteLength(key)>READ_SNAPSHOT_LIMITS.keyBytes)return;
   try{
    if(typeof key==='string'&&contexts.get(context)?.has('data:'+key))return;
    const size=Buffer.byteLength(JSON.stringify(data),'utf8')+Buffer.byteLength(key,'utf8');
    if(size>READ_SNAPSHOT_LIMITS.resultBytes||bytes+rawBytes+size>READ_SNAPSHOT_LIMITS.bytes)return;
    const rows=contexts.get(context)??new Map(),dataKey='data:'+key;if(rows.has(dataKey))return;
    rows.set(dataKey,{prefixData:structuredClone(data)});contexts.set(context,rows);entries++;bytes+=size;
   }catch{/* Non-canonical or oversize DATA is not reused. */}
  },
  // PRIVATE UNQUALIFIED DATA-only extension. It shares the ORIGINAL total
  // entry/byte budget. It stores no ResultSet metadata, reference or guard.
  rawEpoch:()=>rawEpoch,
  getRawRows(context,key){
   const rows=rawContexts.get(context)?.get(key)?.rows;
   return !closed&&rows?{rows:structuredClone(rows)}:undefined;
  },
  putRawRows(context,key,result,observedEpoch){
   try{
    if(closed||rawEpoch!==observedEpoch||entries+rawEntries>=READ_SNAPSHOT_LIMITS.entries
     ||typeof key!=='string'||Buffer.byteLength(key)>READ_SNAPSHOT_LIMITS.keyBytes
     ||!result||typeof result!=='object'||nativeTypes.isProxy(result))return;
    const descriptor=Object.getOwnPropertyDescriptor(result,'rows');
    if(!descriptor||!Object.hasOwn(descriptor,'value'))return;
    const source=descriptor.value;
    if(nativeTypes.isProxy(source)||!Array.isArray(source)||Object.getPrototypeOf(source)!==Array.prototype||source.length>READ_SNAPSHOT_LIMITS.rows)return;
    const rowDescriptors=Object.getOwnPropertyDescriptors(source);
    if(Reflect.ownKeys(rowDescriptors).length!==source.length+1)return;
    if(rawContexts.get(context)?.has(key))return;
    const rows=Array.from({length:source.length},(_unused,index)=>{
     const d=rowDescriptors[index];if(!d||!Object.hasOwn(d,'value'))throw Error('RAW_DATA_ROW_ACCESSOR');
     const row=d.value;
     if(!row||typeof row!=='object'||nativeTypes.isProxy(row)||![Object.prototype,null].includes(Object.getPrototypeOf(row)))throw Error('RAW_DATA_ROW_SHAPE');
     const descriptors=Object.getOwnPropertyDescriptors(row),copy=Object.create(null);
     if(Reflect.ownKeys(descriptors).some(key=>typeof key!=='string'))throw Error('RAW_DATA_SYMBOL');
     for(const [name,d] of Object.entries(descriptors)){
      if(!d.enumerable)continue;
      if(!Object.hasOwn(d,'value')||d.value!==null&&!['undefined','string','number','bigint','boolean'].includes(typeof d.value)
       ||typeof d.value==='number'&&!Number.isFinite(d.value))throw Error('RAW_DATA_SCALAR_REQUIRED');
      Object.defineProperty(copy,name,{value:d.value,enumerable:true,writable:true,configurable:true});
     }
     return copy;
    });
    const size=Buffer.byteLength(JSON.stringify(rows,(_key,v)=>typeof v==='bigint'?String(v):v),'utf8')+Buffer.byteLength(key);
    if(size>READ_SNAPSHOT_LIMITS.resultBytes||bytes+rawBytes+size>READ_SNAPSHOT_LIMITS.bytes
     ||closed||rawEpoch!==observedEpoch||entries+rawEntries>=READ_SNAPSHOT_LIMITS.entries)return;
    const values=rawContexts.get(context)??new Map();if(values.has(key))return;
    values.set(key,{rows,size});rawContexts.set(context,values);rawEntries++;rawBytes+=size;
   }catch{/* Unsupported/late/oversize raw DATA follows the original SQL path. */}
  },
  clearRawRows(){rawContexts.clear();rawEntries=0;rawBytes=0;rawEpoch++;},
  clear({retainRawData=false}={}){contexts.clear();entries=0;bytes=0;epoch++;if(!retainRawData)this.clearRawRows();},
  close(){this.clear();closed=true;},
 };
}
