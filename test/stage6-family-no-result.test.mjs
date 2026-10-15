import test from 'node:test';import assert from 'node:assert/strict';import {register} from 'node:module';
register(new URL('./stage6FamilyDiagnosticLoader.mjs',import.meta.url));
const {familyFixture}=await import('./stage6FamilyNoResultFixture.mjs');
const {createOperationReceipts}=await import('../src/phase4OperationReceipts.js');
const {createFamilyDirectory}=await import('../src/phase4FamilyDirectory.js');
const {guards}=await import('./stage5ReviewBFixture.js');
async function prime(f){for(let n=0;n<20;n++){const x=await f.leg();assert.equal(x.result.failedJobs,0);const rows=(await f.db.raw.execute("SELECT * FROM phase4_operation_receipts WHERE operation_kind='analyzeMetric'")).rows;if(rows.length)return rows[0];}assert.fail('Expected original DOMAIN receipt');}
async function untilFailure(f){for(let n=0;n<12;n++){const x=await f.leg();if(x.result.failedJobs)return x;assert.equal(x.result.processedItems,0,'corrupt mandatory inputs cannot become an empty completed source');}assert.fail('Expected fail-closed family processing');}
test('full v32 worker authenticates computed empty family without a fabricated durable family unit',async t=>{
 globalThis.__familyFailureDiagnostics=[];const f=await familyFixture(t);let failure,progress=0;
 for(let n=0;n<100;n++){const before=await f.jobs(),x=await f.leg(),after=await f.jobs();progress+=x.result.processedItems;if(x.result.failedJobs)console.log('FAMILY_FAILURE '+JSON.stringify({requestId:x.req.requestId,executionGeneration:x.owner.generation,result:x.result,diagnostics:globalThis.__familyFailureDiagnostics}));if(x.result.failedJobs){failure=x;break;}
  for(const j of after.filter(j=>j.full_scan_cursor&&j.full_scan_cursor!==before.find(b=>b.job_kind===j.job_kind).full_scan_cursor)){const e=(await f.db.raw.execute({sql:'SELECT * FROM phase4_executions WHERE execution_id=?',args:[x.req.requestId]})).rows[0],logical=f.keys.lookup(['phase4-logical-work-v1','stage6.checkpoint',['a','SHADOW',j.job_kind,j.requested_generation,j.scope_revision,[j.full_scan_cursor]]]),ack=f.keys.lookup(['execution-work-step-v2',e.identity_digest,e.scope_key,['named',logical]]);assert.ok((await f.db.raw.execute({sql:'SELECT 1 FROM phase4_execution_work_receipts WHERE execution_id=? AND receipt_key=? AND step_key=? AND generation=?',args:[x.req.requestId,ack,ack,e.generation]})).rows.length,'exact named cursor ACK required');}
  if(after.every(j=>j.completed_generation===j.requested_generation))break;}
 assert.equal(failure,undefined,JSON.stringify(globalThis.__familyFailureDiagnostics));assert.ok(progress>0);assert.ok((await f.jobs()).every(j=>j.completed_generation===j.requested_generation));
 const context=await f.stores.capture('a',{executionMode:'SHADOW'}),verifier=createOperationReceipts({client:f.db.raw,keys:f.keys,schemaVersion:32});
 const ops=(await f.db.raw.execute('SELECT * FROM phase4_operation_receipts')).rows;assert.ok(ops.some(r=>r.operation_kind==='analyzeMetric'));
 for(const op of ops){verifier.authenticate(context,op);assert.throws(()=>verifier.authenticate({...context,userId:'b'},op));assert.throws(()=>verifier.authenticate(context,{...op,receipt_hmac:'0'.repeat(64)}));}
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM observation_episodes')).rows[0].n,0);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM phase4_family_directory_entries')).rows[0].n,0);
 assert.equal((await f.db.raw.execute('SELECT deterministic_run_key FROM evidence_runs GROUP BY deterministic_run_key HAVING count(*)>1')).rows.length,0);
 const before=JSON.stringify((await f.db.raw.execute('SELECT * FROM phase4_operation_receipts ORDER BY operation_key')).rows);await f.restart();assert.equal(JSON.stringify((await f.db.raw.execute('SELECT * FROM phase4_operation_receipts ORDER BY operation_key')).rows),before);
 const replay=await f.leg();assert.equal(replay.result.processedItems,0);assert.equal(replay.result.unitsCommitted,0);
 for(const p of (await f.db.raw.execute('SELECT p.*,e.result_json,e.result_digest,e.state FROM phase4_execution_producers p JOIN phase4_executions e ON e.execution_id=p.producing_execution_id')).rows){assert.equal(p.state,'FINALIZED_SUCCESS');assert.equal(p.tenant_proof,f.keys.lookup(['execution-producer-v1','a','SHADOW',p.input_generation,p.producing_execution_id,p.execution_seq,p.producing_generation]));}
});
test('genuine positive non-Body family still commits its original signed complete tip',async t=>{
 const f=await familyFixture(t,{positive:true});let found=false;
 for(let n=0;n<160;n++){const x=await f.leg();assert.equal(x.result.failedJobs,0,JSON.stringify(globalThis.__familyFailureDiagnostics));
  const context=await f.stores.capture('a',{executionMode:'SHADOW'}),directory=createFamilyDirectory(f.db.raw,f.keys),inventory=await directory.inventory(context,'recovery_score',{create:false});
  if(inventory?.entries.length&&!(await directory.work(context,inventory.entries[0])).due){found=true;assert.equal(x.result.unitsCommitted,1);break;}}
 assert.equal(found,true);assert.ok((await f.db.raw.execute("SELECT count(*) n FROM observation_episodes WHERE subject_key='recovery_score'")).rows[0].n>0);
});
test('missing mandatory current source after authenticated DOMAIN fails closed',async t=>{
 const f=await familyFixture(t),op=await prime(f);await f.db.raw.execute("DELETE FROM whoop_cycles WHERE user_id='a'");await assert.rejects(f.readMetric(JSON.parse(op.request_json).request),/PHASE4_(SOURCE|ARTIFACT|REQUIRED|METRIC|ROW)/);
});
test('tampered DOMAIN receipt cannot become computed empty',async t=>{
 const f=await familyFixture(t),op=await prime(f);await guards(f,'phase4_operation_receipts',()=>f.db.raw.execute({sql:'UPDATE phase4_operation_receipts SET receipt_hmac=? WHERE operation_key=?',args:['0'.repeat(64),op.operation_key]}));await untilFailure(f);
});
test('corrupt signed empty directory cannot become computed empty',async t=>{
 const f=await familyFixture(t);await prime(f);const ctx=await f.stores.capture('a',{executionMode:'SHADOW'}),directory=createFamilyDirectory(f.db.raw,f.keys);
 await f.db.transaction(()=>directory.inventory(ctx,'cycle_strain'));await guards(f,'phase4_family_directory_manifests',()=>f.db.raw.execute({sql:'UPDATE phase4_family_directory_manifests SET manifest_hmac=?',args:['0'.repeat(64)]}));await untilFailure(f);
});
