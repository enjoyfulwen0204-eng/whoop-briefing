import test from 'node:test';
import assert from 'node:assert/strict';
import {syntheticPhase4Fixture} from './phase4Fixture.js';
import {bodyInput,seedBodyInput} from './bodyEnergyFixture.js';
import {createStage8LiveProducer} from '../src/stage8LiveProducer.js';
import {currentExecutionReceiptTransactionMarker,currentDurableExecution} from '../src/phase4ExecutionContext.js';

for(const fault of ['REDACTED_RESULT','REVOKED_OWNER','REVOKED_SOURCE_GENERATION'])test('raw metric readonly scheduling retains original boundary: '+fault,async t=>{
 const f=await syntheticPhase4Fixture(t,{targetVersion:35,ownedConnection:true,now:()=>new Date()});
 await f.db.transaction(()=>seedBodyInput(f.db,bodyInput({asOf:Date.now()-1000,days:0})));
 await f.db.ensureOnboarding('a',{state:'READY'});await f.db.linkTelegram({userId:'a',chatId:'10001'});
 const p=await createStage8LiveProducer({...f,admission:await f.db.admitRuntime(),userIds:['a'],enabled:()=>true,eligible:id=>id==='a'});
 const prefix=await p.run({userId:'a',requestId:'raw-read-boundary-original-prefix'});
 assert.notEqual(prefix.publication.status,'CURRENT');assert.ok(prefix.result.unitsCommitted>0);
 const before=(await f.db.raw.execute('SELECT * FROM stage8_live_execution_work_receipts ORDER BY 1,2')).rows;
 const original=f.db.raw.execute;let injected=false,effectsAfterFault=0;const effects=[],markers=new Map(),faultMarkers=new Set();
 const markerId=value=>{if(!value)return null;if(!markers.has(value))markers.set(value,markers.size+1);return markers.get(value);};
 const markFault=()=>{const marker=currentExecutionReceiptTransactionMarker();if(marker){faultMarkers.add(marker);markerId(marker);}};
 f.db.raw.execute=async stmt=>{
  const sql=typeof stmt==='string'?stmt:stmt.sql;
  if(injected&&/^(?:INSERT INTO|UPDATE) (?:evidence_|stage8_live_execution_work_receipts|stage8_live_operation_receipts|stage8_live_publications|outbound_messages)/.test(sql)){
   const claim=currentDurableExecution()?.claim;
   const originalOwner=claim?(await original({sql:'SELECT deadline_at FROM stage8_live_executions WHERE execution_id=?',args:[claim.executionId]})).rows[0]:null;
   effectsAfterFault++;effects.push({marker:markerId(currentExecutionReceiptTransactionMarker()),markerIdentity:currentExecutionReceiptTransactionMarker(),
    table:/^(?:INSERT INTO|UPDATE) (\w+)/.exec(sql)[1],receiptKey:sql.startsWith('INSERT INTO stage8_live_execution_work_receipts')?stmt.args[1]:null,
    expected:claim?{executionId:claim.executionId,identity:claim.identity,scopeKey:claim.scopeKey,generation:claim.generation,deadlineAt:originalOwner?.deadline_at}:null});
  }
  const result=await original(stmt);
  if(injected&&fault==='REVOKED_SOURCE_GENERATION'&&/SELECT u.id,u.status,u.timezone,u.lifecycle_generation/.test(sql)){
   markFault();return {...result,rows:result.rows.map(r=>({...r,source_generation:r.source_generation+1}))};
  }
  if(injected&&fault==='REVOKED_OWNER'
    &&(/^SELECT \* FROM stage8_live_executions WHERE execution_id=\? AND owner=\? AND generation=\?/.test(sql)
      ||/FROM stage8_live_executions e LEFT JOIN stage8_live_execution_work_receipts/.test(sql)))
   {markFault();return {...result,rows:[]};}
  // The real factory has already produced the signed raw metric DOMAIN.
  // Corrupt only the later exact typed row observation, never seed a result,
  // cursor, receipt, completion, authority token or replacement worker.
  if(/^SELECT \* FROM evidence_runs WHERE user_id=\? AND execution_mode=\?\s+AND run_id=\?/.test(sql)
    &&result.rows[0]?.subject_key==='cycle_strain'){
   injected=true;
   if(fault==='REDACTED_RESULT'){markFault();return {...result,rows:result.rows.map(r=>({...r,health_content_redacted_at:new Date().toISOString()}))};}
   // Every subsequent fresh owner observation sees revocation. The injected
   // transport never issues an otherwise unauthorized control-table write.
  }
  return result;
 };
 let value,error;
 try{value=await p.run({userId:'a',requestId:'raw-read-boundary-fresh-attempt'});}catch(e){error=e;}finally{f.db.raw.execute=original;}
 assert.equal(injected,true,'actual signed cycle metric typed replay must be reached');
 if(error)assert.match(String(error.code??error.message),fault==='REVOKED_SOURCE_GENERATION'?/INPUT_FENCED/:/CONTENT_REDACTED|OWNER_FENCED|STAGE8_LIVE|METRIC_PREPARATION_CAPTURE_REQUIRED/);
 else{assert.ok(value.result.jobsFailed>0);assert.notEqual(value.publication.status,'CURRENT');}
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM stage8_live_publications')).rows[0].n,0);
 for(const effect of effects)if(effect.receiptKey){
  const rows=(await original({sql:`SELECT r.*,e.state,e.observed_outcome,e.result_json final_result,e.deadline_at,e.created_at,e.finalized_at,
   e.identity_digest,e.scope_key final_scope_key,e.generation final_generation,e.execution_seq final_seq,
   p.execution_seq,p.producing_generation,p.input_generation,p.tenant_proof
   FROM stage8_live_execution_work_receipts r JOIN stage8_live_executions e ON e.execution_id=r.execution_id
   JOIN stage8_live_execution_producers p ON p.producing_execution_id=r.execution_id WHERE r.receipt_key=?`,args:[effect.receiptKey]})).rows;
  effect.durable=rows.length;
  if(rows.length){
   assert.equal(rows.length,1);const row=rows[0];assert.equal(row.state,'FINALIZED_SUCCESS');
   assert.equal(JSON.parse(row.final_result).outcome,'PARTIAL');assert.equal(row.result_json,null);
   assert.equal(row.request_digest,row.identity_digest);assert.equal(row.scope_key,row.final_scope_key);
   assert.equal(row.execution_id,effect.expected.executionId);assert.equal(row.request_digest,effect.expected.identity);
   assert.equal(row.scope_key,effect.expected.scopeKey);assert.equal(row.generation,effect.expected.generation);
   assert.equal(row.deadline_at,effect.expected.deadlineAt);assert.equal(row.step_key,effect.receiptKey);
   assert.equal(row.generation,row.producing_generation);assert.equal(row.producing_generation,row.final_generation);
   assert.equal(row.execution_seq,row.final_seq);assert.ok(row.created_at<=row.committed_at&&row.committed_at<=row.finalized_at&&row.finalized_at<=row.deadline_at);
   assert.equal(row.tenant_proof,f.keys.lookup(['execution-producer-v1','a','LIVE',row.input_generation,row.execution_id,row.execution_seq,row.producing_generation]));
   effect.originalAuthorityAndDeadline=true;effect.outcome='PARTIAL';
  }
 }
 console.log('RAW_BOUNDARY_EFFECT_ATTRIBUTION '+JSON.stringify({fault,faultMarkers:[...faultMarkers].map(markerId),effects:effects.map(({receiptKey,expected,markerIdentity,...safe})=>({...safe,inAnyFaultRoot:faultMarkers.has(markerIdentity)}))}));
 assert.ok(faultMarkers.size,'the actual rejected reads must belong to original owned receipt transactions');
 assert.equal(effects.filter(x=>faultMarkers.has(x.markerIdentity)).length,0,'no effect in any root containing an actually rejected projection');
 if(fault!=='REDACTED_RESULT')assert.equal(effectsAfterFault,0,'global owner/source-generation revocation prevents every later unit effect');
 else assert.ok(effects.every(x=>x.table==='stage8_live_execution_work_receipts'&&x.durable===1&&x.originalAuthorityAndDeadline),
  'a local row fault may leave only independently authorized scalar progress in another root, never a derived health effect');
 if(value)assert.equal(value.result.jobsCompleted,0,'partial independent progress cannot complete either job');
 const after=new Set((await f.db.raw.execute('SELECT * FROM stage8_live_execution_work_receipts')).rows.map(r=>JSON.stringify(r)));
 for(const row of before)assert.ok(after.has(JSON.stringify(row)),'original receipt remains byte-identical');
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM outbound_messages')).rows[0].n,0);
});
