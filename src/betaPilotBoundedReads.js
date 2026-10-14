import {processingPrefixReadData} from './processingTransaction.js';
import {reservePilotPrefixRead,requireCurrentBetaPilotAttempt,currentPilotWorkProfile,hasCurrentBetaPilotAttempt} from './betaPilotPermit.js';
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
 const maxBytes=spec.table==='phase4_operation_receipts'&&spec.fields.includes('request_json')?currentPilotWorkProfile(context.userId,client).receiptPrefixBytes:PILOT_PREFIX_MAX_BYTES;
 const result=(await client.execute({sql:`SELECT COUNT(*) candidate_count,coalesce(SUM(serialized_bound),0) serialized_bytes,
  coalesce(SUM(invalid_types),0) invalid_types FROM (SELECT ${size} serialized_bound,
   CASE WHEN ${invalidTypes} THEN 1 ELSE 0 END invalid_types FROM ${source})`,args:boundedArgs})).rows[0];
 if(!Number.isSafeInteger(result?.candidate_count)||!Number.isSafeInteger(result?.serialized_bytes)
  ||result.invalid_types!==0||result.candidate_count>PILOT_PREFIX_MAX_ROWS||result.serialized_bytes>maxBytes)denied();
 requireCurrentBetaPilotAttempt(context.userId,client);return {source,boundedArgs,result};
}

/** Admission only: caller keeps the original complete SQL/authority semantics
 * and must use this forced index in the SAME processing write transaction.
 * No cross-transaction/writes cache or provider billed-unit claim is returned. */
export async function pilotPrefixFrom(client,context,table,args,alias='',tenant=false){
 if(alias&&!/^[a-z_]{1,32}$/.test(alias))denied();
 if(!reservePilotPrefixRead(context,client,JSON.stringify([table,args,tenant])))return `${table}${alias?' '+alias:''}`;
 let spec=PILOT_V32_PREFIX_SHAPES[table];
 if(tenant){
  if(table!=='phase4_operation_receipts'||spec?.prefix[1]!=='execution_mode')denied();
  spec={...spec,prefix:spec.prefix.slice(0,2),suffix:[...spec.prefix.slice(2),...spec.suffix]};
 }
 await probe(client,context,spec,args);
 return `${table}${alias?' '+alias:''} INDEXED BY ${spec.index}`;
}

// Existing authority consumers select one evidence item (and usually one
// scope). Admit that exact primary-key prefix, rather than unrelated tenant
// history. Original typed envelope, root and HMAC validation still runs.
export async function pilotResultAuthorityFrom(client,context,itemId,resultScope){
 const table='phase4_evidence_result_authorities',args=[context.userId,context.executionMode,itemId,...(resultScope===undefined?[]:[resultScope])];
 if(!reservePilotPrefixRead(context,client,JSON.stringify([table,args])))return table;
 const original=PILOT_V32_PREFIX_SHAPES[table],extra=args.length-2,
  spec={...original,prefix:[...original.prefix,...original.suffix.slice(0,extra)],suffix:original.suffix.slice(extra)};
 await probe(client,context,spec,args);return `${table} INDEXED BY ${spec.index}`;
}

/** Probe and payload run in the SAME existing processing write transaction.
 * N+1 overflow rejects the entire history; it never passes a truncated prefix
 * to authority/HMAC validation. Finite per-grant read-set reservations
 * retain every complete prefix probe/payload. The original profile allows32
 * slots; the monitored profile allows128, with2MiB only for full receipt prefixes
 * and1MiB for other sources. These are logical envelopes, not provider units. Index seeks/pages, fencing queries, triggers,
 * writes/storage and other callsites are NOT certified by this envelope. */
export async function readPilotPrefixRows(client,context,specId,args,ordinaryStatement){
 if(!reservePilotPrefixRead(context,client,JSON.stringify([specId,args])))return (await client.execute(ordinaryStatement)).rows;
 const spec=specs[specId],{source,boundedArgs,result}=await probe(client,context,spec,args);
 const rows=(await client.execute({sql:`SELECT ${spec.fields.join(',')} FROM ${source}`,args:boundedArgs})).rows;
 requireCurrentBetaPilotAttempt(context.userId,client);
 // An unexpected adapter/transaction result cannot turn overflow into success.
 if(rows.length!==result.candidate_count||Buffer.byteLength(JSON.stringify(rows),'utf8')>PILOT_PREFIX_MAX_BYTES)denied();
 return rows;
}

// Complete bounded source-link DATA, scoped by the processing executor. No
// accepted authority/root/HMAC result is cached; every consumer validates it.
export async function readPilotSourceLinkRows(client,context,table,artifactId,logical){
 const spec=PILOT_V32_PREFIX_SHAPES.phase4_source_links,args=[context.userId,context.executionMode,table,artifactId];
 const ordinary={sql:`SELECT source_execution_mode,source_type,source_id,relationship FROM phase4_source_links
  WHERE user_id=? AND artifact_execution_mode=? AND artifact_type=? AND artifact_id=? AND unlinked_at IS NULL
  ${logical?'AND relationship=?':''}`,args:[...args,...(logical?[`INPUT_GENERATION:${context.inputGeneration}`]:[])]};
 if(!hasCurrentBetaPilotAttempt(context.userId,client))return (await client.execute(ordinary)).rows;
 if(args.some(value=>typeof value!=='string'||Buffer.byteLength(value)>256)||context.executionMode!=='SHADOW')denied();
 const grant=requireCurrentBetaPilotAttempt(context.userId,client),key=JSON.stringify(['complete-source-link-prefix-v1',spec,args]);
 const validate=data=>{
  if(!Number.isSafeInteger(data.bounds?.candidate_count)||!Number.isSafeInteger(data.bounds?.serialized_bytes)
   ||data.bounds.invalid_types!==0||data.bounds.candidate_count>PILOT_PREFIX_MAX_ROWS
   ||data.bounds.serialized_bytes>PILOT_PREFIX_MAX_BYTES||data.rows.length!==data.bounds.candidate_count
   ||Buffer.byteLength(JSON.stringify(data.rows))>PILOT_PREFIX_MAX_BYTES
   ||data.rows.some(row=>spec.fields.some(field=>row[field]===null?!spec.nullable.includes(field):typeof row[field]!=='string')
     ||spec.prefix.some((field,index)=>row[field]!==args[index])))denied();return data;
 };
 const data=await processingPrefixReadData(client,context,key,async()=>{
  if(!reservePilotPrefixRead(context,client,JSON.stringify([table,args])))denied();
  const {source,boundedArgs,result}=await probe(client,context,spec,args),
    resultSet=await client.execute({sql:`SELECT ${spec.fields.join(',')} FROM ${source}`,args:boundedArgs});
  requireCurrentBetaPilotAttempt(context.userId,client);
  return validate({bounds:{candidate_count:result.candidate_count,serialized_bytes:result.serialized_bytes,invalid_types:result.invalid_types},
    rows:resultSet.rows.map(row=>Object.fromEntries(spec.fields.map(field=>[field,row[field]])))});
 },grant);
 requireCurrentBetaPilotAttempt(context.userId,client);validate(data);
 return data.rows.filter(row=>row.unlinked_at===null&&(!logical||row.relationship===`INPUT_GENERATION:${context.inputGeneration}`));
}
