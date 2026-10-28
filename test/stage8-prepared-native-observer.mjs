import assert from 'node:assert/strict';
// Metadata only, for the opt-in native gate. Missing observations fail the gate;
// successful timing of a subset can never establish transaction qualification.
export function createPreparedNativeObserver(){
 const streams=new Map(),transactions=[],counts={unknownSql:0,unknownReplies:0,unmatchedTerminals:0,unknownBatons:0,closeWithTransaction:0,begins:{},terminals:{}};
 function submitted(body,phase,at){
  let stream=streams.get(body.baton);if(body.baton&&!stream)counts.unknownBatons++;
  stream??={sql:new Map(),transaction:null};
  for(const item of body.requests??[])if(item.type==='store_sql')stream.sql.set(item.sql_id,item.sql);
  return {body,phase,at,stream};
 }
 function acknowledged({body,phase,at,stream},reply,end){
  if(!Array.isArray(reply.results)||reply.results.length!==body.requests.length){counts.unknownReplies++;return;}
  for(let i=0;i<body.requests.length;i++){
   const item=body.requests[i],observed=reply.results[i];
   if(!['execute','batch','store_sql','close_sql','close','get_autocommit'].includes(item.type)||!['ok','error'].includes(observed?.type)){counts.unknownReplies++;continue;}
   const stmts=item.type==='execute'?[item.stmt]:item.type==='batch'?item.batch.steps.map(s=>s.stmt):[];
   if(observed.type==='ok'&&observed.response?.type!==item.type)counts.unknownReplies++;
   if(item.type==='batch'&&observed.type==='ok'&&(!Array.isArray(observed.response.result?.step_results)||!Array.isArray(observed.response.result?.step_errors)||observed.response.result.step_results.length!==stmts.length||observed.response.result.step_errors.length!==stmts.length))counts.unknownReplies++;
   for(let j=0;j<stmts.length;j++){
    let sql=stmts[j]?.sql??stream.sql.get(stmts[j]?.sql_id);
    if(typeof sql==='string'){
     sql=sql.trimStart();while(sql.startsWith('--')||sql.startsWith('/*')){
      const n=sql.startsWith('--')?sql.indexOf('\n'):sql.indexOf('*/');if(n<0){sql='';break;}
      sql=sql.slice(n+(sql.startsWith('--')?1:2)).trimStart();
     }
    }
    const verb=typeof sql==='string'?/^([A-Z]+)/i.exec(sql)?.[1].toUpperCase():null;
    if(!verb){counts.unknownSql++;continue;}
    const ok=observed.type==='ok'&&(item.type==='execute'||observed.response?.result?.step_results?.[j]!=null);
    if(verb==='BEGIN'&&ok){
     if(stream.transaction)counts.unknownReplies++;
     stream.transaction={at,phase};counts.begins[phase]=(counts.begins[phase]??0)+1;
    }
    if(['COMMIT','ROLLBACK'].includes(verb)&&ok){
     if(!stream.transaction){counts.unmatchedTerminals++;continue;}
     const original=stream.transaction;transactions.push({phase:original.phase,outcome:verb,upperBoundMs:end-original.at});counts.terminals[original.phase]=(counts.terminals[original.phase]??0)+1;stream.transaction=null;
    }
   }
   if(item.type==='get_autocommit'&&observed.type==='ok'&&observed.response.is_autocommit===false&&!stream.transaction)counts.unknownReplies++;
   if(item.type==='close'&&observed.type==='ok'&&stream.transaction){counts.closeWithTransaction++;stream.transaction=null;}
   if(item.type==='close_sql')stream.sql.delete(item.sql_id);
  }
  if(body.baton)streams.delete(body.baton);if(reply.baton)streams.set(reply.baton,stream);
 }
 function assertComplete(phase){
  for(const key of ['unknownSql','unknownReplies','unmatchedTerminals','unknownBatons','closeWithTransaction'])assert.equal(counts[key],0,'NATIVE_OBSERVATION_'+key);
  assert.ok(counts.begins[phase]>0,'NATIVE_WORK_BEGIN_REQUIRED');assert.equal(counts.begins[phase],counts.terminals[phase],'EVERY_WORK_BEGIN_REQUIRES_ACKNOWLEDGED_TERMINAL');
  assert.ok([...streams.values()].every(s=>!s.transaction),'NATIVE_ACTIVE_TRANSACTION_UNKNOWN');
  const actual=transactions.filter(t=>t.phase===phase);assert.equal(actual.length,counts.begins[phase]);return actual;
 }
 return {submitted,acknowledged,assertComplete,streams,transactions,counts};
}
