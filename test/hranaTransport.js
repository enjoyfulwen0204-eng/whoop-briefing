import {createClient} from '@libsql/client/sqlite3';
import {randomUUID,createHash} from 'node:crypto';

// Installed HTTP/Hrana driver speaks its real v2 JSON protocol. Every SQL
// statement is executed by the installed normal SQLite/libsql driver against
// one isolated file. Only transport timing/acknowledgement is controlled.
// No socket, DNS, production credential or provider request is used.
const decode=v=>v.type==='null'?null:v.type==='integer'?BigInt(v.value):v.type==='blob'?Buffer.from(v.base64,'base64'):v.value;
const encode=v=>v===null?{type:'null'}:typeof v==='bigint'?{type:'integer',value:String(v)}:
 typeof v==='number'?{type:'float',value:v}:typeof v==='string'?{type:'text',value:v}:{type:'blob',base64:Buffer.from(v).toString('base64')};
export function hranaTransport(url,{operation=()=> 'UNSCOPED',transactionMaxMs=Infinity,traceTransactions=false}={}) {
 const streams=new Map();let armed=null,commits=0;
 const counts={httpRequests:0,sqlStatements:0,nativeSqlAttempts:0,byFamily:{},byTemplate:{},byOperation:{},byHttpMix:{},byHttpFamily:{}};
 const evidence=[],transactions=[];
 const sqlLabel=sql=>({verb:/^\s*([a-z]+)/i.exec(sql)?.[1]?.toUpperCase(),table:/\b(?:FROM|INTO|UPDATE)\s+"?([a-z0-9_]+)/i.exec(sql)?.[1],template:createHash('sha256').update(sql.replace(/\s+/g,' ').trim()).digest('hex'),
  ...(sql.includes("ELSE 'SYNC_IMMUTABLE_AUTHORITY_CHANGED'")?{operation:'SYNC_COMMIT_WINDOW_AUTHORITY_ASSERTION'}:{})});
 const open=role=>{const client=createClient({url,intMode:'bigint'}),id=randomUUID(),stream={client,id,role,sql:new Map(),inTransaction:false};
  if(traceTransactions){const execute=client.execute.bind(client);client.execute=async statement=>{
   const sql=typeof statement==='string'?statement:statement.sql,at=Date.now(),label=sqlLabel(sql),begin=/^\s*BEGIN\b/i.test(sql),end=/^\s*(COMMIT|ROLLBACK)\b/i.test(sql);
   if(begin){stream.trace={id:randomUUID(),connectionId:id,role,beginSubmittedAt:at,firstStatementAt:at,startedAt:null,lastStatementAt:at,sqlOperations:0,httpOperations:0,nativeWaitMs:0,beginWaitMs:0,concurrentWritersMax:0,statements:[],http:new Set()};}
   const trace=stream.trace;
   if(trace&&!trace.finishedAt){trace.sqlOperations++;trace.http.add(stream.http);trace.httpOperations=trace.http.size;trace.lastStatementAt=at;trace.lastStatement=label;
    trace.concurrentWritersMax=Math.max(trace.concurrentWritersMax,[...streams.values()].filter(s=>s!==stream&&s.trace?.startedAt&&!s.trace.finishedAt).length);
   }
   try{counts.nativeSqlAttempts++;const result=await execute(statement),finishedAt=Date.now();
    if(trace&&!trace.finishedAt){const waitMs=finishedAt-at;trace.nativeWaitMs+=waitMs;if(begin){trace.startedAt=finishedAt;trace.beginWaitMs=waitMs;}
     if(trace.statements.length<256)trace.statements.push({...label,submittedAt:at,finishedAt,waitMs});
     if(end){trace.finishedAt=finishedAt;trace.outcome=label.verb==='COMMIT'?'COMMITTED':trace.timeout?'ROLLED_BACK_BY_MODELED_TIMEOUT':'ROLLED_BACK';const {http,...safe}=trace;transactions.push(safe);}}
    return result;
   }catch(error){if(trace&&!trace.finishedAt){trace.nativeWaitMs+=Date.now()-at;trace.errors??=[];trace.errors.push({...label,at:Date.now(),code:error.code??error.name});if(begin){trace.finishedAt=Date.now();trace.outcome='BEGIN_REJECTED';const {http,...safe}=trace;transactions.push(safe);}}throw error;}
  };}
  streams.set(id,stream);return [id,stream];};
 const assertTransactionAge=async stream=>{
  if(stream.inTransaction&&Date.now()-stream.transactionStartedAt>=transactionMaxMs){
   if(stream.trace)stream.trace.timeout={at:Date.now(),source:'SYNTHETIC_ABSOLUTE_TRANSACTION_LIMIT',limitMs:transactionMaxMs};
   evidence.push({event:'transaction_timeout',ageMs:Date.now()-stream.transactionStartedAt,limitMs:transactionMaxMs});
   await stream.client.execute('ROLLBACK');stream.inTransaction=false;
   throw Object.assign(Error('SYNTHETIC_TRANSACTION_TIMEOUT'),{code:'TRANSACTION_TIMEOUT'});
  }
 };
 const statement=async(stream,stmt,httpFamilies)=>{
  const sql=stmt.sql??stream.sql.get(stmt.sql_id),args=stmt.named_args?.length?
   Object.fromEntries(stmt.named_args.map(x=>[x.name,decode(x.value)])):(stmt.args??[]).map(decode);
  // Synthetic RAM counters retain no SQL arguments, records, or SQL text.
  counts.sqlStatements++;
  await assertTransactionAge(stream);
  const family=/^\s*SELECT last_detail FROM system_heartbeats/i.test(sql)?'PILOT_STATE'
   :/\bobserved_at\b/.test(sql)&&/\buser_onboarding\b/.test(sql)?'PILOT_CLOCK'
   :/^\s*SELECT 1 FROM resource_locks/i.test(sql)?'SYNC_OWNER'
   :/\bphase4_executions\b/.test(sql)?'EXECUTION_OWNER'
   :/\bphase4_execution_work_receipts\b/.test(sql)?'WORK_RECEIPT'
   :/^\s*(BEGIN|COMMIT|ROLLBACK)\b/i.test(sql)?'TRANSACTION'
   :/^\s*SELECT owner FROM resource_locks/i.test(sql)?'CORE_LEASE'
   :/\bphase4_jobs\b/.test(sql)?'CORE_JOB'
   :/\bwhoop_(?:resource_access|capabilities|resource_tombstones)\b/.test(sql)?'SOURCE_GUARD'
   :/\bwhoop_(?:sleeps|recoveries|cycles|workouts|body_measurements)\b/.test(sql)?'CANONICAL'
   :/\bphase4_source_links\b/.test(sql)?'SOURCE_LINK'
   :/\bphase4_operation_receipts\b/.test(sql)?'OPERATION_RECEIPT'
   :/\bphase4_evidence_result_authorities\b/.test(sql)?'RESULT_AUTHORITY'
   :/\bbody_energy_results\b/.test(sql)?'BODY_RESULT'
   :/\b(?:users|phase4_user_state|phase4_computation_state)\b/.test(sql)?'CONTEXT':'OTHER';
  httpFamilies?.add(family);
  counts.byFamily[family]=(counts.byFamily[family]??0)+1;
  const template=createHash('sha256').update(sql.replace(/\s+/g,' ').trim()).digest('hex');
  const prior=counts.byTemplate[template]??{family,count:0};prior.count++;counts.byTemplate[template]=prior;
  if(/^\s*BEGIN\b/i.test(sql)){stream.workResult=false;stream.matched=false;}
  if(sql.includes("SET state='WORK_COMMITTED'"))stream.workResult=true;
  if(armed?.matchSql?.test(sql))stream.matched=true;
  if(/^\s*COMMIT\s*$/i.test(sql)){
   commits++;if(armed&&(!armed.onlyWorkResult||stream.workResult)&&(!armed.matchSql||stream.matched)){
    if(armed.skipMatches){armed.skipMatches--;return stream.client.execute({sql,args}).then(result=>{stream.inTransaction=false;return result;});}
    const attack=armed;armed=null;
    evidence.push({event:'commit_pending',at:Date.now(),commit:commits});await attack.before?.(stream.client);
    // Recheck at the actual COMMIT boundary after an awaited fault hook. A
    // durable COMMIT followed by a delayed/lost ACK remains indeterminate.
    await assertTransactionAge(stream);
    const result=await stream.client.execute({sql,args});stream.inTransaction=false;
    evidence.push({event:'commit_durable',at:Date.now(),commit:commits});await attack.after?.();
    if(attack.loseAcknowledgement)throw Error('SYNTHETIC_COMMIT_ACK_LOST');
    return result;
   }
  }
  let result;try{result=await stream.client.execute({sql,args});}catch(e){
   evidence.push({event:'sql_error',template,code:e.code??'SYNTHETIC_TRANSPORT_ERROR',connectionId:stream.id,role:stream.role,verb:sqlLabel(sql).verb,
    lockHolders:[...streams.values()].filter(s=>s!==stream&&s.inTransaction).map(s=>({connectionId:s.id,role:s.role,transactionId:s.trace?.id,mode:s.beginMode,hasWritten:s.hasWritten,ageMs:Date.now()-s.transactionStartedAt,last:s.lastLabel})),
    assertionLabel:/ELSE '([A-Z0-9_]+)'/.exec(sql)?.[1],table:/FROM "?([a-z0-9_]+)"?/i.exec(sql)?.[1],expectedRows:sql.includes('SHORT_TRANSACTION_ZERO_ROW_REJECTED')?Number(args[0]):undefined,prior:stream.priorStatement});throw e;
  }
  stream.priorStatement={template,prefix:sql.slice(0,180),rowsAffected:result.rowsAffected,...(/^DELETE FROM resource_locks/.test(sql)?{lockFamily:String(args[0]).split(':')[0]}:{})};
  stream.lastLabel=sqlLabel(sql);
  if(/^\s*BEGIN\b/i.test(sql)){stream.inTransaction=true;stream.transactionStartedAt=Date.now();stream.beginMode=/\b(IMMEDIATE|EXCLUSIVE)\b/i.exec(sql)?.[1]?.toUpperCase()??'DEFERRED';stream.hasWritten=false;}
  if(stream.inTransaction&&/^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql))stream.hasWritten=true;
  if(/^\s*(COMMIT|ROLLBACK)\b/i.test(sql))stream.inTransaction=false;
  return result;
 };
 const serialized=r=>({cols:r.columns.map((name,i)=>({name,decltype:r.columnTypes[i]??null})),
  rows:r.rows.map(row=>r.columns.map((_,i)=>encode(row[i]))),affected_row_count:r.rowsAffected,
  last_insert_rowid:r.lastInsertRowid===undefined?null:String(r.lastInsertRowid)});
 const error=e=>({message:e.message,code:e.code??'SYNTHETIC_TRANSPORT_ERROR'});
 const condition=(c,results,errors,stream)=>!c?true:c.type==='ok'?results[c.step]!==null:c.type==='error'?errors[c.step]!==null:
  c.type==='not'?!condition(c.cond,results,errors,stream):c.type==='and'?c.conds.every(v=>condition(v,results,errors,stream)):
  c.type==='or'?c.conds.some(v=>condition(v,results,errors,stream)):c.type==='is_autocommit'?!stream.inTransaction:false;
 const fetch=async(request,{role='UNSCOPED'}={})=>{
  counts.httpRequests++;
  const category=operation();counts.byOperation[category]=(counts.byOperation[category]??0)+1;
  const body=await request.json();let [id,stream]=body.baton?[body.baton,streams.get(body.baton)]:open(role);
  if(!stream)throw Error('UNKNOWN_SYNTHETIC_BATON');
  stream.http=counts.httpRequests;
  const results=[];
  const httpFamilies=new Set();
  for(const item of body.requests){
   let response;
   try{
    if(item.type==='execute')response={type:'execute',result:serialized(await statement(stream,item.stmt,httpFamilies))};
    else if(item.type==='batch'){
     const step_results=[],step_errors=[];
     for(const step of item.batch.steps){
      if(!condition(step.condition,step_results,step_errors,stream)){step_results.push(null);step_errors.push(null);continue;}
      try{step_results.push(serialized(await statement(stream,step.stmt,httpFamilies)));step_errors.push(null);}
      catch(e){if(e.message==='SYNTHETIC_COMMIT_ACK_LOST')throw e;step_results.push(null);step_errors.push(error(e));}
     }response={type:'batch',result:{step_results,step_errors}};
    }else if(item.type==='store_sql'){stream.sql.set(item.sql_id,item.sql);response={type:'store_sql'};}
    else if(item.type==='close_sql'){stream.sql.delete(item.sql_id);response={type:'close_sql'};}
    else if(item.type==='close'){
     // A real Hrana stream close rolls back its open SQLite transaction. The
     // native test driver's deferred finalizer cannot stand in for that server
     // lifecycle; perform the protocol's rollback before closing the receiver.
     if(stream.inTransaction){await stream.client.execute('ROLLBACK');stream.inTransaction=false;}
     stream.client.close();streams.delete(id);id=null;response={type:'close'};
    }
    else if(item.type==='get_autocommit')response={type:'get_autocommit',is_autocommit:!stream.inTransaction};
    else throw Error(`UNIMPLEMENTED_HRANA_REQUEST:${item.type}`);
    results.push({type:'ok',response});
   }catch(e){if(e.message==='SYNTHETIC_COMMIT_ACK_LOST')throw e;results.push({type:'error',error:error(e)});}
  }
  const mix=[...httpFamilies].sort().join('+')||'PROTOCOL_ONLY';
  counts.byHttpMix[mix]=(counts.byHttpMix[mix]??0)+1;
  for(const family of httpFamilies)counts.byHttpFamily[family]=(counts.byHttpFamily[family]??0)+1;
  return new Response(JSON.stringify({baton:id,base_url:null,results}),{headers:{'content-type':'application/json'}});
 };
 return {fetch,evidence,counts,transactions,setTransactionMaxMs:ms=>{if(ms!==Infinity&&(!Number.isSafeInteger(ms)||ms<1))throw Error('SYNTHETIC_TRANSACTION_LIMIT_INVALID');transactionMaxMs=ms;},arm:attack=>{armed=attack;},close:()=>{for(const stream of streams.values())stream.client.close();streams.clear();}};
}
