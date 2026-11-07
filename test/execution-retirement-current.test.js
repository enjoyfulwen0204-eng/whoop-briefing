import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {recoveryFixture,fixtureKeys} from './round4Fixture.js';
import {runningReleaseSha} from '../src/phase4Release.js';
import {canonicalPhaseRequest,claimPhaseRequest,commitPhaseWork,reconcileExecution,
 assertExecutionReconciliationAge,EXECUTION_RECONCILIATION_MAX_AGE_MS as DAY} from '../src/phase4ExecutionStore.js';
import {discoverPhaseContinuation} from '../src/phase4Continuation.js';
import {classifyExecutionRetirement,classifySubjectReceipt,EXECUTION_READ_PATHS} from '../src/executionRetirement.js';
import {ERASURE_TABLES,assertErasureTables,classifyErasureKey,userErrorClearReceiptKey} from '../src/erasureCatalog.js';
import {readdirSync,readFileSync} from 'node:fs';
import {withDurableExecution,workStepKey} from '../src/phase4ExecutionContext.js';
import {workStepOptions} from '../src/phase4WorkStep.js';
import {planExecutionErasure,receiptDeleteBatch} from '../src/erasureReceiptPlan.js';

const authority={assert(){}};
const makeRequest=(phase='SYNC')=>({requestId:(phase==='SYNC'?'p4s1_':'p4c1_')+randomUUID(),
 phase,releaseSha:runningReleaseSha(),triggerSource:'cloudflare',executionMode:'OFF',configProof:'a'.repeat(64),
 ...(phase==='STAGE6_DRAIN'?{syncRequestId:'parent_'+randomUUID(),handoff:'b'.repeat(64)}:{})});
// Fixture-only time travel; restore the exact guard before trusted admission.
async function age(db,id,ms){
 const guard=(await db.raw.execute("SELECT sql FROM sqlite_schema WHERE name='p4_execution_identity_immutable'")).rows[0].sql;
 await db.raw.execute('DROP TRIGGER p4_execution_identity_immutable');
 await db.raw.execute({sql:'UPDATE phase4_executions SET created_at=?,lease_until=MIN(lease_until,?),deadline_at=MIN(deadline_at,?) WHERE execution_id=?',args:[Date.now()-ms,Date.now()-1,Date.now()-1,id]});
 await db.raw.execute(guard);
}
test('24-hour boundary rejects only unfinished reconciliation; finalized source proofs retain their historical lifetime',()=>{
 const now=2*DAY;
 for(const state of ['ESTABLISHED','WORK_COMMITTED']){
  assert.doesNotThrow(()=>assertExecutionReconciliationAge({state,created_at:now-DAY+1},now));
  assert.throws(()=>assertExecutionReconciliationAge({state,created_at:now-DAY},now),{code:'EXECUTION_RECONCILIATION_EXPIRED'});
 }
 for(const state of ['FINALIZED_SUCCESS','FINALIZED_FAILURE','ABORTED'])assert.doesNotThrow(()=>assertExecutionReconciliationAge({state,created_at:0},now));
});
for(const terminal of [false,true])test(`atomic subject receipt deletion preserves sibling and exact guard (${terminal?'finalized':'dead'})`,async t=>{
 const {db}=await recoveryFixture(t),request=makeRequest(),claim=await claimPhaseRequest(db,request,canonicalPhaseRequest(request),{keys:fixtureKeys});
 const users=[{id:'subject',lifecycle_generation:1},{id:'other',lifecycle_generation:1}];
 let execution=(await db.raw.execute({sql:'SELECT * FROM phase4_executions WHERE execution_id=?',args:[request.requestId]})).rows[0];
 const receiptKeys=users.map(u=>userErrorClearReceiptKey(fixtureKeys,execution,u.id,1));
 for(const key of receiptKeys)await db.raw.execute({sql:'INSERT INTO phase4_execution_work_receipts(execution_id,receipt_key,scope_key,request_digest,step_key,generation,committed_at,result_json) VALUES(?,?,?,?,?,?,?,NULL)',args:[request.requestId,key,claim.scopeKey,claim.identity,key,claim.generation,Date.now()]});
 if(terminal){
  await commitPhaseWork(db,request,claim,{outcome:'NO_NEW_DATA_SUCCESS'},authority);
  const {finalizePhaseWork}=await import('../src/phase4ExecutionStore.js');await finalizePhaseWork(db,request,claim,fixtureKeys,authority);
 }else await age(db,request.requestId,DAY+1000);
 const successor=makeRequest();await claimPhaseRequest(db,successor,canonicalPhaseRequest(successor),{keys:fixtureKeys});
 const executions=(await db.raw.execute('SELECT * FROM phase4_executions')).rows;
 const receipts=(await db.raw.execute('SELECT * FROM phase4_execution_work_receipts')).rows;
 const references=new Map(executions.map(e=>[e.execution_id,{execution:[],receipts:new Map(receipts.filter(r=>r.execution_id===e.execution_id).map(r=>[r.receipt_key,[]]))}]));
 const input={keys:fixtureKeys,users,executions,receipts,now:Date.now(),references};
 assert.deepEqual(planExecutionErasure(input).retireExecutions,[]);
 const plan=planExecutionErasure({...input,subject:users[0]});assert.deepEqual(plan.removeReceipts,[receiptKeys[0]]);assert.deepEqual(plan.pendingReceipts,[]);
 const guard=(await db.raw.execute("SELECT name,tbl_name,sql FROM sqlite_schema WHERE name='p4_execution_receipt_no_delete'")).rows[0];
 await db.raw.batch(receiptDeleteBatch({receiptKeys:plan.removeReceipts,guard}),'write');
 assert.deepEqual((await db.raw.execute('SELECT receipt_key FROM phase4_execution_work_receipts')).rows.map(r=>r.receipt_key),[receiptKeys[1]]);
 assert.equal((await db.raw.execute('SELECT count(*) n FROM phase4_executions')).rows[0].n,2);
 assert.deepEqual((await db.raw.execute("SELECT name,tbl_name,sql FROM sqlite_schema WHERE name='p4_execution_receipt_no_delete'")).rows[0],guard);
 assert.deepEqual((await db.raw.execute('PRAGMA foreign_key_check')).rows,[]);
 await assert.rejects(db.raw.execute('DELETE FROM phase4_execution_work_receipts'),/p4_execution_receipt_no_delete/);
});
for(const committed of [false,true])test(`expired ${committed?'WORK_COMMITTED':'ESTABLISHED'} cannot replay, renew lease, or be discovered`,async t=>{
 const {db}=await recoveryFixture(t),request=makeRequest(),body=canonicalPhaseRequest(request);
 const claim=await claimPhaseRequest(db,request,body,{keys:fixtureKeys});
 if(committed)await commitPhaseWork(db,request,claim,{outcome:'NO_NEW_DATA_SUCCESS'},authority);
 await age(db,request.requestId,DAY+1000);
 const before=(await db.raw.execute({sql:'SELECT * FROM phase4_executions WHERE execution_id=?',args:[request.requestId]})).rows[0];
 await assert.rejects(reconcileExecution(db,request,claim.identity),{code:'EXECUTION_RECONCILIATION_EXPIRED'});
 await assert.rejects(claimPhaseRequest(db,request,body,{keys:fixtureKeys}),{code:'EXECUTION_RECONCILIATION_EXPIRED'});
 const query={releaseSha:request.releaseSha,executionMode:'OFF',triggerSource:'cloudflare',configProof:request.configProof,scope:'sync'};
 const found=await discoverPhaseContinuation({query,db,keys:fixtureKeys,releaseSha:query.releaseSha,mode:'OFF',configProof:query.configProof,scope:'sync'});
 assert.equal(found.body.state,'NONE');
 assert.deepEqual((await db.raw.execute({sql:'SELECT * FROM phase4_executions WHERE execution_id=?',args:[request.requestId]})).rows[0],before);
});
test('young WORK_COMMITTED remains discoverable and may reconcile without granting fresh work',async t=>{
 const {db}=await recoveryFixture(t),request=makeRequest(),body=canonicalPhaseRequest(request);
 const claim=await claimPhaseRequest(db,request,body,{keys:fixtureKeys});
 await commitPhaseWork(db,request,claim,{outcome:'NO_NEW_DATA_SUCCESS'},authority);
 await age(db,request.requestId,DAY-60000);
 const query={releaseSha:request.releaseSha,executionMode:'OFF',triggerSource:'cloudflare',configProof:request.configProof,scope:'sync'};
 const found=await discoverPhaseContinuation({query,db,keys:fixtureKeys,releaseSha:query.releaseSha,mode:'OFF',configProof:query.configProof,scope:'sync'});
 assert.equal(found.body.state,'WORK_COMMITTED_UNFINALIZED');
 const resumed=await claimPhaseRequest(db,request,body,{keys:fixtureKeys});
 assert.equal(resumed.workCommitted,true);assert.equal(resumed.generation,claim.generation+1);
});
test('receipt-backed DRAIN remains available below 24h and is excluded above 24h',async t=>{
 const {db}=await recoveryFixture(t),parent={...makeRequest(),executionMode:'SHADOW'};
 await claimPhaseRequest(db,parent,canonicalPhaseRequest(parent),{keys:fixtureKeys});
 const request={...makeRequest('STAGE6_DRAIN'),executionMode:'SHADOW',syncRequestId:parent.requestId};
 const claim=await claimPhaseRequest(db,request,canonicalPhaseRequest(request),{keys:fixtureKeys});
 await db.raw.execute({sql:`INSERT INTO phase4_execution_work_receipts
  (execution_id,receipt_key,scope_key,request_digest,step_key,generation,committed_at,result_json) VALUES(?,?,?,?,?,?,?,NULL)`,
 args:[request.requestId,'c'.repeat(64),claim.scopeKey,claim.identity,'c'.repeat(64),claim.generation,Date.now()]});
 const query={releaseSha:request.releaseSha,executionMode:'SHADOW',triggerSource:'cloudflare',configProof:request.configProof,scope:'stage6-shadow'};
 const discover=()=>discoverPhaseContinuation({query,db,keys:fixtureKeys,releaseSha:query.releaseSha,mode:'SHADOW',configProof:query.configProof,scope:query.scope});
 await age(db,request.requestId,DAY-60000);
 assert.equal((await discover()).body.workReceipts,1);
 await age(db,request.requestId,DAY+1000);
 assert.equal((await discover()).body.state,'NONE');
 assert.equal((await db.raw.execute('SELECT count(*) n FROM phase4_execution_work_receipts')).rows[0].n,1);
});
test('retirement denies incomplete evidence, latest, live leases and retained references',()=>{
 const now=Date.parse('2026-11-07T00:00:00Z'),row={execution_seq:1,state:'ESTABLISHED',created_at:now-2*DAY,lease_until:now-1,deadline_at:now-1};
 const evidence={now,latestSequence:2,readPathsClosed:true,retainedReferences:[],existingUserReceiptCount:0};
 assert.deepEqual(classifyExecutionRetirement(row,evidence),{dead:true,retirable:true,reasons:[]});
 for(const changes of [{latestSequence:1},{retainedReferences:['SYNTHETIC_REFERENCE']},{readPathsClosed:false},{latestSequence:undefined}])assert.equal(classifyExecutionRetirement(row,{...evidence,...changes}).retirable,false);
 for(const changes of [{created_at:now-DAY},{lease_until:now},{deadline_at:now},{state:'UNKNOWN'}])assert.equal(classifyExecutionRetirement({...row,...changes},evidence).retirable,false);
 assert.equal(classifyExecutionRetirement({...row,state:'FINALIZED_SUCCESS'},evidence).retirable,false);
 assert.equal(classifyExecutionRetirement({...row,state:'FINALIZED_SUCCESS',created_at:now-31*DAY},evidence).retirable,true);
});
test('dead and finalized executions containing any existing-user receipt are preserved as a whole',()=>{
 const now=Date.parse('2026-11-07T00:00:00Z');
 for(const state of ['ESTABLISHED','WORK_COMMITTED','FINALIZED_SUCCESS','FINALIZED_FAILURE','ABORTED']){
  const row={execution_seq:1,state,created_at:now-31*DAY,lease_until:now-1,deadline_at:now-1};
  const evidence={now,latestSequence:2,readPathsClosed:true,retainedReferences:[]};
  assert.equal(classifyExecutionRetirement(row,evidence).retirable,false);
  assert.equal(classifyExecutionRetirement(row,{...evidence,existingUserReceiptCount:0}).retirable,true);
  const protectedResult=classifyExecutionRetirement(row,{...evidence,existingUserReceiptCount:1});
  assert.equal(protectedResult.retirable,false);assert.deepEqual(protectedResult.reasons,['EXISTING_USER_RECEIPT']);
  assert.equal(protectedResult.dead,['ESTABLISHED','WORK_COMMITTED'].includes(state));
 }
});
test('subject-only receipt disposition does not inherit the whole-execution existing-user exclusion',()=>{
 const now=Date.parse('2026-11-07T00:00:00Z');
 const evidence={now,latestSequence:2,readPathsClosed:true,retainedReferences:[],ownershipVerified:true,retainedReceiptReferences:[],existingUserReceiptCount:1};
 for(const state of ['ESTABLISHED','WORK_COMMITTED','FINALIZED_SUCCESS','FINALIZED_FAILURE','ABORTED']){
  const row={execution_seq:1,state,created_at:now-31*DAY,lease_until:now-1,deadline_at:now-1};
  assert.equal(classifySubjectReceipt(row,evidence).action,'DELETE');
  assert.equal(classifySubjectReceipt(row,{...evidence,retainedReceiptReferences:['other-user-proof']}).action,'BLOCKED');
  assert.equal(classifySubjectReceipt(row,{...evidence,ownershipVerified:false}).action,'BLOCKED');
 }
});
test('alive subject receipts stay pending until terminal or dead; latest and retained parents stay protected',()=>{
 const now=Date.parse('2026-11-07T00:00:00Z');
 const row={execution_seq:1,state:'ESTABLISHED',created_at:now,lease_until:now+225000,deadline_at:now+225000};
 const evidence={now,latestSequence:2,readPathsClosed:true,retainedReferences:[],ownershipVerified:true,retainedReceiptReferences:[]};
 assert.equal(classifySubjectReceipt(row,evidence).action,'PENDING');
 assert.equal(classifySubjectReceipt({...row,state:'FINALIZED_SUCCESS'},evidence).action,'DELETE');
 assert.equal(classifySubjectReceipt(row,{...evidence,now:now+DAY+1}).action,'DELETE');
 assert.equal(classifySubjectReceipt(row,{...evidence,now:now+DAY+1,latestSequence:1}).action,'PENDING');
 assert.equal(classifySubjectReceipt(row,{...evidence,now:now+DAY+1,retainedReferences:['retained-producer']}).action,'PENDING');
});
test('v33 tables and execution source files cannot silently escape the explicit inventory',async t=>{
 const {db}=await recoveryFixture(t);
 const names=(await db.raw.execute("SELECT name FROM sqlite_schema WHERE type='table'")).rows.map(r=>r.name);
 assert.deepEqual(names.filter(n=>!ERASURE_TABLES[n]),[]);
 assert.deepEqual(Object.keys(ERASURE_TABLES).filter(n=>!names.includes(n)).sort(),['app_state','whoop_tokens']);
 assertErasureTables([...names,'app_state','whoop_tokens']);
 assertErasureTables(names);assert.equal(Object.keys(ERASURE_TABLES).length,97);
 assert.throws(()=>assertErasureTables([...names,'future_personal_data']),{code:'ERASURE_SCHEMA_UNCLASSIFIED'});
 assert.equal(classifyErasureKey('morning-snapshot:synthetic'),'USER');
 assert.throws(()=>classifyErasureKey('new-user-prefix:synthetic'),{code:'ERASURE_KV_UNCLASSIFIED'});
 for(const file of readdirSync(new URL('../src/',import.meta.url)).filter(f=>f.endsWith('.js'))){
  if(/phase4_execution(?:s|_work_receipts|_producers)/.test(readFileSync(new URL('../src/'+file,import.meta.url),'utf8')))
   assert.ok(EXECUTION_READ_PATHS[file],`Unclassified reader: ${file}`);
 }
});
test('user receipt derivation equals the actual workStepOptions + workStepKey chain',async()=>{
 const row={identity_digest:'a'.repeat(64),scope_key:'b'.repeat(64)};
 const context={keys:fixtureKeys,claim:{identity:row.identity_digest,scopeKey:row.scope_key}};
 await withDurableExecution(context,()=>{
  const options=workStepOptions('api:clearUserErrorNotify',['synthetic-user','whoop_auth',{expectedLifecycleGeneration:3}]);
  assert.equal(userErrorClearReceiptKey(fixtureKeys,row,'synthetic-user',3),workStepKey(context,['named',options.workStep]));
  assert.notEqual(userErrorClearReceiptKey(fixtureKeys,row,'synthetic-other',3),workStepKey(context,['named',options.workStep]));
 });
});
