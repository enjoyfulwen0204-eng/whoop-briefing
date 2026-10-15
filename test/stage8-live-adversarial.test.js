import test from 'node:test';import assert from 'node:assert/strict';
import {syntheticPhase4Fixture} from './phase4Fixture.js';import {bodyInput,seedBodyInput} from './bodyEnergyFixture.js';
import {createStage8LiveProducer} from '../src/stage8LiveProducer.js';import {createStage8DerivedReader} from '../src/stage8DerivedReader.js';
import {authorizeStage8LiveProducer} from '../src/stage8LiveProducerAuthority.js';import {createStage8LiveExecutionRunner} from '../src/stage8LiveExecution.js';
import {buildPhase4Core} from '../src/phase4Core.js';import {bindProducingExecution} from '../src/phase4ExecutionContext.js';import {workStepOptions} from '../src/phase4WorkStep.js';
import {runningReleaseSha} from '../src/phase4Release.js';
test('LIVE certificates reject corrupted origin, artifacts, clocks and failed executions before fresh canonical recomputation',async t=>{
 const f=await syntheticPhase4Fixture(t,{targetVersion:35,now:()=>new Date()});await f.db.ensureOnboarding('a',{state:'READY'});await f.db.transaction(()=>seedBodyInput(f.db,bodyInput({asOf:Date.now()-1000,days:2})));
 const options={...f,userIds:['a'],enabled:()=>true,eligible:id=>id==='a'},producer=await createStage8LiveProducer({...options,admission:await f.db.admitRuntime()});
 const complete=async prefix=>{let result;for(let i=0;i<25;i++){result=await producer.run({userId:'a',requestId:`${prefix}-leg-${i}`});if(result.publication.status==='CURRENT')return result;}assert.fail(JSON.stringify(result));};
 let current=await complete('first-valid');
 const read=async()=>createStage8DerivedReader({...f,admission:await f.db.admitRuntime(),eligible:id=>id==='a'})({scope:{userId:'a',permitted:true,purpose:'SELF_QA',executionMode:'LIVE',asOfUtc:new Date().toISOString()},kind:'BODY_ENERGY',inputGeneration:current.publication.inputGeneration});
 assert.equal((await read()).status,'CURRENT');
 // Deliberate corruption of a fresh synthetic fixture. Restore exact DDL
 // before re-admission; none of these altered records count as positive LIVE.
 const taint=async(table,sql)=>{const abort=Error('SYNTHETIC_ROLLBACK');try{await f.db.transaction(async()=>{const triggers=(await f.db.raw.execute({sql:"SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name=?",args:[table]})).rows;for(const trigger of triggers){assert.match(trigger.name,/^\w+$/);await f.db.raw.execute(`DROP TRIGGER ${trigger.name}`);}await f.db.raw.execute(sql);for(const trigger of triggers)await f.db.raw.execute(trigger.sql);await f.db.freshRuntimeAdmission();assert.equal((await read()).status,'ANALYSIS_UPDATING');throw abort;});}catch(e){if(e!==abort)throw e;}};
 for(const [name,table,sql] of [
  ['completion HMAC','stage8_live_job_completions',"UPDATE stage8_live_job_completions SET completion_hmac='"+'0'.repeat(64)+"'"],
  ['completion producer membership','stage8_live_execution_producers',"DELETE FROM stage8_live_execution_producers WHERE producing_execution_id=(SELECT execution_id FROM stage8_live_job_completions LIMIT 1)"],
  ['original ACK identity','stage8_live_execution_work_receipts',"UPDATE stage8_live_execution_work_receipts SET request_digest='"+'0'.repeat(64)+"' WHERE receipt_key IN (SELECT receipt_key FROM stage8_live_job_completions)"],
  ['signed result integrity','stage8_live_executions',"UPDATE stage8_live_executions SET result_digest='"+'0'.repeat(64)+"'"],
  ['exact artifact manifest','body_energy_results',"UPDATE body_energy_results SET value=12 WHERE execution_mode='LIVE'"],
  ['original deadline','stage8_live_job_completions',"UPDATE stage8_live_job_completions SET original_deadline_at=original_deadline_at+1"],
 ])await t.test(`rejects ${name}`,()=>taint(table,sql));
 await t.test('expired certificate is rejected under a forward clock probe',async()=>{const actual=Date.now;try{Date.now=()=>actual()+900001;assert.equal((await read()).status,'ANALYSIS_UPDATING');}finally{Date.now=actual;}});
 const coreOptions={keys:f.keys,admission:await f.db.admitRuntime(),processing:{client:f.db.raw,transaction:f.db.transaction,active:f.db.processingTransactionActive,afterCommit:f.db.afterProcessingCommit,afterCompletion:f.db.afterProcessingCompletion},authorizeMode(){}};
 const cap=await authorizeStage8LiveProducer({...f,admission:coreOptions.admission,releaseSha:runningReleaseSha(),configProof:'e'.repeat(64),enabled:()=>true,eligible:id=>id==='a'}),core=await buildPhase4Core({...coreOptions,liveProducingAuthority:cap});
 await t.test('failed original work is finalized as failure and forces real new generation',async()=>{
  const failed=createStage8LiveExecutionRunner({...f,capability:cap,capture:id=>core.capture(id,{executionMode:'LIVE',providerRequired:true}),assertContext:c=>core.assertContext(c),work:async(id,c)=>{await core.run(c,()=>bindProducingExecution(f.db.raw,c),workStepOptions('synthetic.failure',[id,c.inputGeneration],{discardResult:true}));return {outcome:'FAILED'};}});
  const failure=await failed({userId:'a',requestId:'synthetic-failed-analysis'});assert.equal(failure.result.outcome,'FAILED');
  assert.equal((await f.db.raw.execute("SELECT state FROM stage8_live_executions WHERE execution_id='synthetic-failed-analysis'")).rows[0].state,'FINALIZED_FAILURE');assert.equal((await read()).status,'ANALYSIS_UPDATING');
  const old=current.publication.inputGeneration,source=(await f.db.raw.execute("SELECT source_generation n FROM phase4_user_state WHERE user_id='a'")).rows[0].n;current=await complete('after-failure');assert.equal(current.publication.inputGeneration,old+1);assert.equal((await f.db.raw.execute("SELECT source_generation n FROM phase4_user_state WHERE user_id='a'")).rows[0].n,source);assert.equal((await read()).status,'CURRENT');
 });
 const samples=[],before=process.memoryUsage();for(let i=0;i<5;i++){const start=performance.now();assert.equal((await read()).status,'CURRENT');samples.push(performance.now()-start);}t.diagnostic(JSON.stringify({kind:'LIVE_CERTIFICATE_READER_RESOURCES',samplesMs:samples,before,after:process.memoryUsage(),maxRssKiB:process.resourceUsage().maxRSS}));
});
