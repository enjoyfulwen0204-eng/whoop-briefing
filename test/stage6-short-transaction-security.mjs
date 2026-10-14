import {createHash} from 'node:crypto';
import test from 'node:test';import assert from 'node:assert/strict';
import {residualFixture,fixtureKeys} from './stage6JournalBoundaryFixture.js';
import {request,claim} from './v32ReviewFixture.js';
import {commitPhaseWork,finalizePhaseWork,reconcileExecution} from '../src/phase4ExecutionStore.js';
import {withDurableExecution,requireSettledOperation,databaseNowMs} from '../src/phase4ExecutionContext.js';
import {createExecutionBudget,withExecutionBudget} from '../src/executionBudget.js';
import {isolatedPublicationClient,prepareIsolatedUnit,publishIsolatedUnit,disposeIsolatedPlan} from './stage6ShortTransactionPrototype.mjs';
async function fixture(t,rewrite){
 const f=await residualFixture(t),a={assert(){}};let req=request(),owner=await claim(f.db,req);await commitPhaseWork(f.db,req,owner,{outcome:'NO_NEW_DATA_SUCCESS'},a);const sync=await finalizePhaseWork(f.db,req,owner,fixtureKeys,a);
 req=request({phase:'STAGE6_DRAIN',syncRequestId:req.requestId,handoff:sync.handoff});owner=await claim(f.db,req);
 const budget=createExecutionBudget({budgetMs:30000}),context={claim:owner,keys:fixtureKeys,pending:new Set(),authority:{assert:()=>budget.assert()}},client=isolatedPublicationClient(async r=>f.syntheticFetch(await rewrite?.(r)??r));
 t.after(()=>{budget.close();client.close();});const run=fn=>withDurableExecution(context,()=>withExecutionBudget(budget,()=>budget.run(fn)));
 return {f,req,owner,budget,context,client,run};
}
for(const [name,sql] of [
 ['input generation',"UPDATE phase4_computation_state SET input_generation=input_generation+1 WHERE user_id='a' AND execution_mode='SHADOW'"],
 ['source generation',"UPDATE phase4_user_state SET source_generation=source_generation+1 WHERE user_id='a'"],
 ['revoked authorization',"UPDATE users SET status='DISABLED',lifecycle_generation=lifecycle_generation+1 WHERE id='a'"],
 ['purge',"UPDATE phase4_user_state SET purge_generation=purge_generation+1 WHERE user_id='a'"],
 ['invalid job lease',"UPDATE phase4_jobs SET lease_owner='other-owner',lease_expires_at='2099-01-01T00:00:00.000Z' WHERE user_id='a' AND job_kind='RECOMPUTE_DERIVED'"],
 ['same-generation raw content',"UPDATE whoop_cycles SET strain=strain+0.000000000001 WHERE user_id='a' AND id='cycle-current'"],
])test('fresh publication rejects '+name+' without source progress',async t=>{
 const x=await fixture(t),before=await x.f.jobs();await x.run(async()=>{const plan=await prepareIsolatedUnit({client:x.client});await x.f.db.raw.execute(sql);await assert.rejects(publishIsolatedUnit(x.client,plan));});
 const jobs=await x.f.jobs();assert.ok(jobs.every(j=>j.full_scan_cursor===null));assert.equal((await x.f.counts()).domain,0);assert.ok(before.every(j=>j.full_scan_cursor===null));
});
test('fresh authoritative clock expiry rejects issued temporal authority',async t=>{
 let advance=false;const x=await fixture(t,async r=>{if(!advance)return r;const body=await r.clone().json();const visit=v=>{if(v&&typeof v==='object')for(const [k,a] of Object.entries(v)){if(k==='sql'&&typeof a==='string')v[k]=a.replaceAll(databaseNowMs,'('+databaseNowMs+'+65000)');else visit(a);}};visit(body);return new Request(r,{body:JSON.stringify(body)});});
 await x.run(async()=>{const plan=await prepareIsolatedUnit({client:x.client});advance=true;await assert.rejects(publishIsolatedUnit(x.client,plan));});assert.ok((await x.f.jobs()).every(j=>j.full_scan_cursor===null));
});
test('private capability rejects tenant change and copied/tampered plan',async t=>{
 const x=await fixture(t);await x.run(async()=>{await assert.rejects(prepareIsolatedUnit({client:x.client,userId:'peer'}),/ISOLATED_TENANT_SCOPE_REQUIRED/);const plan=await prepareIsolatedUnit({client:x.client});await assert.rejects(publishIsolatedUnit(x.client,{...plan}),/PREPARATION_CAPABILITY_REQUIRED/);await disposeIsolatedPlan(plan);});assert.ok((await x.f.jobs()).every(j=>j.full_scan_cursor===null));
});
test('zero-row conditional write aborts the installed driver entire atomic batch',async t=>{
 const x=await fixture(t),before=await x.f.jobs();await assert.rejects(x.client.batch([
  {sql:"UPDATE phase4_jobs SET full_scan_cursor=? WHERE user_id='a'",args:[JSON.stringify(['cycle','synthetic-would-be-unauthorized'])]},
  {sql:"UPDATE phase4_jobs SET scope_revision=scope_revision+1 WHERE user_id='missing'",args:[]},
  {sql:"SELECT json(CASE WHEN changes()=1 THEN 'true' ELSE 'ZERO_ROW_REJECTED' END)",args:[]},
 ],'write'));const query="SELECT json(CASE WHEN changes()=1 THEN 'true' ELSE 'ZERO_ROW_REJECTED' END)",key=createHash('sha256').update(query).digest('hex');assert.equal(x.f.transport.counts.byTemplate[key].count,1,'zero-row assertion must actually execute');assert.deepEqual(await x.f.jobs(),before);
});
test('post-durable ACK loss fences continuation until exact receipt reconciliation',async t=>{
 const x=await fixture(t);let result;
 await x.run(async()=>{const plan=await prepareIsolatedUnit({client:x.client});result=plan.result;x.f.transport.arm({matchSql:/UPDATE phase4_jobs SET full_scan_cursor=/,loseAcknowledgement:true});await assert.rejects(publishIsolatedUnit(x.client,plan),/COMMIT_INDETERMINATE/);assert.equal(x.context.indeterminate,true);assert.ok(x.context.pending.size>0);assert.throws(requireSettledOperation,/COMMIT_INDETERMINATE/);await assert.rejects(prepareIsolatedUnit({client:x.client}),/COMMIT_INDETERMINATE/);});
 const reconciled=await reconcileExecution(x.f.db,x.req);assert.equal(reconciled.state,'WORK_COMMITTED_UNFINALIZED');assert.ok(reconciled.receipts.length>0);
 const a={assert(){}};await commitPhaseWork(x.f.db,x.req,x.owner,{outcome:result.outcome,itemsProcessed:result.processedItems,jobsCompleted:result.completedJobs,jobsFailed:result.failedJobs,unitsCommitted:result.unitsCommitted},a);await finalizePhaseWork(x.f.db,x.req,x.owner,fixtureKeys,a);
 assert.ok((await x.f.jobs()).some(j=>j.full_scan_cursor));
});

test('fresh same-snapshot byte gate rejects row growth before any health payload SELECT',async t=>{
 let x,armed=true,payloadSql;
 x=await fixture(t,async r=>{const body=await r.clone().json(),steps=body.requests.flatMap(q=>q.batch?.steps??[]),sql=steps.map(s=>s.stmt?.sql??'');
  if(armed&&sql.some(s=>s.includes('PREPARATION_FRESH_PAGE_BOUNDS'))){armed=false;payloadSql=sql.find(s=>/^SELECT "/.test(s)&&s.includes(' FROM "users" WHERE '));assert.ok(payloadSql);await x.f.db.raw.execute({sql:"UPDATE users SET display_name=? WHERE id='a'",args:['x'.repeat(2*1024*1024+1)]});}
  return r;
 });
 await x.run(()=>assert.rejects(prepareIsolatedUnit({client:x.client}),/malformed JSON|PREPARATION_FRESH_PAGE_BOUNDS/));assert.equal(armed,false);
 const key=createHash('sha256').update(payloadSql.replace(/\s+/g,' ').trim()).digest('hex');assert.equal(x.f.transport.counts.byTemplate[key]?.count??0,0,'no DATA statement may run after a failed envelope');assert.ok((await x.f.jobs()).every(j=>j.full_scan_cursor===null));
});
test('lost context-registration ACK fences work before health projection',async t=>{
 const x=await fixture(t);x.f.transport.arm({matchSql:/INSERT INTO resource_locks\(name,owner,acquired_at,expires_at\) SELECT/,loseAcknowledgement:true});
 await x.run(async()=>{await assert.rejects(prepareIsolatedUnit({client:x.client}),/COMMIT_INDETERMINATE/);assert.equal(x.context.indeterminate,true);assert.ok(x.context.pending.size>0);await assert.rejects(prepareIsolatedUnit({client:x.client}),/COMMIT_INDETERMINATE/);});assert.ok((await x.f.jobs()).every(j=>j.full_scan_cursor===null));
});


test('in-flight publication retains health context and rejects concurrent disposal/republication',async t=>{
 const x=await fixture(t);await x.run(async()=>{const plan=await prepareIsolatedUnit({client:x.client}),prefix=`p4ctx:${fixtureKeys.lookup(['context-tenant-v1','a'])}:short:${x.owner.executionId}`;
  const result=await publishIsolatedUnit(x.client,plan,{beforeCommit:async()=>{await assert.rejects(disposeIsolatedPlan(plan),/PREPARATION_IN_FLIGHT/);await assert.rejects(publishIsolatedUnit(x.client,plan),/PREPARATION_IN_FLIGHT/);assert.equal((await x.f.db.raw.execute({sql:'SELECT count(*) n FROM resource_locks WHERE name=?',args:[prefix]})).rows[0].n,1);}});
  assert.ok(result.result.processedItems||result.result.unitsCommitted);assert.equal((await x.f.db.raw.execute({sql:'SELECT count(*) n FROM resource_locks WHERE name=?',args:[prefix]})).rows[0].n,0);
 });
});
