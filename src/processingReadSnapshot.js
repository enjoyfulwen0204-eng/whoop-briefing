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
const predicate="(?:[a-z_][a-z0-9_]*\\s*(?:(?:=|<>|>=|<=|>|<)\\s*(?:\\?|'[a-z0-9_:-]*'|\\d+)|IS\\s+(?:NOT\\s+)?NULL|IN\\s*\\('[a-z0-9_:-]*'(?:\\s*,\\s*'[a-z0-9_:-]*')*\\)))";
const select=new RegExp('^SELECT\\s+(?:\\*|1|[a-z_][a-z0-9_]*(?:\\s*,\\s*[a-z_][a-z0-9_]*)*)\\s+FROM\\s+([a-z_][a-z0-9_]*)\\s+(?:INDEXED\\s+BY\\s+[a-z_][a-z0-9_]*\\s+)?WHERE\\s+user_id\\s*=\\s*\\?(?:\\s+AND\\s+'+predicate+')*(?:\\s+ORDER\\s+BY\\s+[a-z_][a-z0-9_]*(?:\\s+(?:ASC|DESC))?(?:\\s*,\\s*[a-z_][a-z0-9_]*(?:\\s+(?:ASC|DESC))?)*)?(?:\\s+LIMIT\\s+(?:\\?|\\d+))?\\s*;?$','i');
export const READ_SNAPSHOT_LIMITS=Object.freeze({entries:256,bytes:4*1024*1024,resultBytes:256*1024,rows:128,keyBytes:8192});
export function readSnapshotKey(statement,context){
 if(!context||typeof context.userId!=='string'||!statement||typeof statement!=='object'||Array.isArray(statement))return null;
 const {sql,args}=statement;
 if(typeof sql!=='string'||!Array.isArray(args)||args[0]!==context.userId)return null;
 const normalized=sql.replace(/\s+/g,' ').trim(),match=select.exec(normalized);
 if(/\b(?:CURRENT_TIME|CURRENT_DATE|CURRENT_TIMESTAMP)\b|['"]now['"]/i.test(normalized))return null;
 if(normalized!==userState&&(!match||!tables.has(match[1].toLowerCase())))return null;
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
   descriptor.value=structuredClone(descriptor.value);
  }
  return Object.defineProperties(copy,descriptors);
 };
 const copy=Object.create(Object.getPrototypeOf(result));
 Object.assign(copy,{columns:[...result.columns],columnTypes:[...result.columnTypes],rows:result.rows.map(object),
  rowsAffected:result.rowsAffected,lastInsertRowid:result.lastInsertRowid});return copy;
}
export function createReadSnapshotMemo(){
 let contexts=new Map(),entries=0,bytes=0,epoch=0,closed=false;
 return {
  epoch:()=>epoch,
  get(context,key){const result=contexts.get(context)?.get(key);return !closed&&result?cloneResult(result):undefined;},
  put(context,key,result,observedEpoch){
   if(closed||epoch!==observedEpoch||entries>=READ_SNAPSHOT_LIMITS.entries||!Array.isArray(result?.rows)
    ||result.rows.length>READ_SNAPSHOT_LIMITS.rows||!Array.isArray(result.columns)||!Array.isArray(result.columnTypes))return;
   try{
    const binaryBytes=result.rows.reduce((total,row)=>total+Object.values(Object.getOwnPropertyDescriptors(row))
     .reduce((sum,descriptor)=>sum+(descriptor.value instanceof ArrayBuffer||ArrayBuffer.isView(descriptor.value)?descriptor.value.byteLength:0),0),0);
    const size=binaryBytes+Buffer.byteLength(JSON.stringify(result,(_key,value)=>typeof value==='bigint'?String(value):value),'utf8')+Buffer.byteLength(key,'utf8');
    if(size>READ_SNAPSHOT_LIMITS.resultBytes||bytes+size>READ_SNAPSHOT_LIMITS.bytes)return;
    const snapshot=cloneResult(result),rows=contexts.get(context)??new Map();
    if(rows.has(key))return;
    rows.set(key,snapshot);contexts.set(context,rows);entries++;bytes+=size;
   }catch{/* A result outside this narrow clone shape is simply not reused. */}
  },
  getData(context,key){const data=contexts.get(context)?.get('data:'+key)?.prefixData;return !closed&&data?structuredClone(data):undefined;},
  putData(context,key,data,observedEpoch){
   if(closed||epoch!==observedEpoch||entries>=READ_SNAPSHOT_LIMITS.entries||!Array.isArray(data?.rows)
    ||data.rows.length>READ_SNAPSHOT_LIMITS.rows||Buffer.byteLength(key)>READ_SNAPSHOT_LIMITS.keyBytes)return;
   try{const size=Buffer.byteLength(JSON.stringify(data),'utf8')+Buffer.byteLength(key,'utf8');
    if(size>READ_SNAPSHOT_LIMITS.resultBytes||bytes+size>READ_SNAPSHOT_LIMITS.bytes)return;
    const rows=contexts.get(context)??new Map(),dataKey='data:'+key;if(rows.has(dataKey))return;
    rows.set(dataKey,{prefixData:structuredClone(data)});contexts.set(context,rows);entries++;bytes+=size;
   }catch{/* Non-canonical or oversize DATA is not reused. */}
  },
  clear(){contexts.clear();entries=0;bytes=0;epoch++;},
  close(){this.clear();closed=true;},
 };
}
