import {reservePilotPrefixRead,requireCurrentBetaPilotAttempt} from './betaPilotPermit.js';
import {PILOT_V32_PREFIX_SHAPES} from './betaPilotV32ReadShapes.js';

// These original four inventory descriptors have no residual filter/join/sort.
// Raw history is separately admitted only through the frozen v32 registry.
const specs=Object.freeze({
 family:{table:'phase4_family_directory_entries',prefix:['user_id','execution_mode','source_token'],
  suffix:['sequence'],nullable:['family_key','descriptor_json'],fields:['user_id','execution_mode','source_token','sequence','family_token','family_key','descriptor_json','entry_state','directory_version','entry_hmac']},
 routeEntries:{table:'phase4_receipt_route_entries',prefix:['user_id','execution_mode','subject_kind','subject_token'],
  suffix:['sequence'],fields:['user_id','execution_mode','subject_kind','subject_token','sequence','operation_kind','operation_key','route_version','binding_hmac']},
 routes:{table:'phase4_receipt_routes',prefix:['user_id','execution_mode'],suffix:['operation_kind','operation_key'],
  fields:['user_id','execution_mode','operation_kind','operation_key','route_version','route_state','subjects_json','route_hmac','created_at']},
 receiptProjection:{table:'phase4_operation_receipts',prefix:['user_id','execution_mode'],suffix:['operation_kind','operation_key'],
  fields:['operation_kind','operation_key','privacy_artifact_id']},
});
export const PILOT_PREFIX_MAX_ROWS=1000,PILOT_PREFIX_MAX_BYTES=1024*1024;
const denied=()=>{throw Object.assign(Error('BETA_PILOT_PREFIX_BOUNDS_UNAVAILABLE'),{code:'BETA_PILOT_PREFIX_BOUNDS_UNAVAILABLE'});};

async function probe(client,context,spec,args){
 if(!spec||!Array.isArray(args)||args.length!==spec.prefix.length||args[0]!==context.userId
  ||args.some(value=>typeof value!=='string'||Buffer.byteLength(value,'utf8')>256)
  ||spec.prefix.includes('execution_mode')&&args[spec.prefix.indexOf('execution_mode')]!=='SHADOW'
  ||spec.prefix.includes('artifact_execution_mode')&&args[spec.prefix.indexOf('artifact_execution_mode')]!=='SHADOW')denied();
 const where=spec.prefix.map(field=>`${field}=?`).join(' AND '),order=spec.suffix.length?` ORDER BY ${spec.suffix.join(',')}`:'',
  source=`${spec.table} INDEXED BY ${spec.index??`sqlite_autoindex_${spec.table}_1`} WHERE ${where}${order} LIMIT ?`,
  boundedArgs=[...args,PILOT_PREFIX_MAX_ROWS+1];
 const invalidTypes=spec.fields.map(field=>{
  const types=spec.numeric?.includes(field)?['integer','real']:field==='sequence'?['integer']:['text'];
  if(spec.nullable?.includes(field))types.push('null');
  return `typeof(${field}) NOT IN (${types.map(type=>`'${type}'`).join(',')})`;
 }).join(' OR ');
 const size=`CASE WHEN ${invalidTypes} THEN 0 ELSE 1024+6*(${spec.fields.map(field=>`coalesce(length(CAST(${field} AS BLOB)),0)`).join('+')}) END`;
 requireCurrentBetaPilotAttempt(context.userId,client);
 const result=(await client.execute({sql:`SELECT COUNT(*) candidate_count,coalesce(SUM(serialized_bound),0) serialized_bytes,
  coalesce(SUM(invalid_types),0) invalid_types FROM (SELECT ${size} serialized_bound,
   CASE WHEN ${invalidTypes} THEN 1 ELSE 0 END invalid_types FROM ${source})`,args:boundedArgs})).rows[0];
 if(!Number.isSafeInteger(result?.candidate_count)||!Number.isSafeInteger(result?.serialized_bytes)
  ||result.invalid_types!==0||result.candidate_count>PILOT_PREFIX_MAX_ROWS||result.serialized_bytes>PILOT_PREFIX_MAX_BYTES)denied();
 requireCurrentBetaPilotAttempt(context.userId,client);return {source,boundedArgs,result};
}

/** Admission only: caller keeps the original complete SQL/authority semantics
 * and must use this forced index in the SAME processing write transaction.
 * No cross-transaction/writes cache or provider billed-unit claim is returned. */
export async function pilotPrefixFrom(client,context,table,args,alias='',tenant=false){
 if(alias&&!/^[a-z_]{1,32}$/.test(alias))denied();
 if(!reservePilotPrefixRead(context,client))return `${table}${alias?' '+alias:''}`;
 let spec=PILOT_V32_PREFIX_SHAPES[table];
 if(tenant){
  if(table!=='phase4_operation_receipts'||spec?.prefix[1]!=='execution_mode')denied();
  spec={...spec,prefix:spec.prefix.slice(0,2),suffix:[...spec.prefix.slice(2),...spec.suffix]};
 }
 await probe(client,context,spec,args);
 return `${table}${alias?' '+alias:''} INDEXED BY ${spec.index}`;
}

/** Probe and payload run in the SAME existing processing write transaction.
 * N+1 overflow rejects the entire history; it never passes a truncated prefix
 * to authority/HMAC validation. 32 consumed read-set reservations per attempt
 * allow this helper at most 64 statements / 32*3*(N+1) logical candidate visits and 32MiB
 * accepted serialized payload. Index seeks/pages, fencing queries, triggers,
 * writes/storage and other callsites are NOT certified by this envelope. */
export async function readPilotPrefixRows(client,context,specId,args,ordinaryStatement){
 if(!reservePilotPrefixRead(context,client))return (await client.execute(ordinaryStatement)).rows;
 const spec=specs[specId],{source,boundedArgs,result}=await probe(client,context,spec,args);
 const rows=(await client.execute({sql:`SELECT ${spec.fields.join(',')} FROM ${source}`,args:boundedArgs})).rows;
 requireCurrentBetaPilotAttempt(context.userId,client);
 // An unexpected adapter/transaction result cannot turn overflow into success.
 if(rows.length!==result.candidate_count||Buffer.byteLength(JSON.stringify(rows),'utf8')>PILOT_PREFIX_MAX_BYTES)denied();
 return rows;
}
