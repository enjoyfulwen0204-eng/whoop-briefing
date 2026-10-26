import test from 'node:test';
import assert from 'node:assert/strict';
import {syntheticPhase4Fixture} from './phase4Fixture.js';
import {bodyInput,seedBodyInput} from './bodyEnergyFixture.js';
import {createStage8LiveProducer} from '../src/stage8LiveProducer.js';
import {currentDurableExecution,workStepKey,currentExecutionReceiptTransactionMarker} from '../src/phase4ExecutionContext.js';
import {workStepOptions} from '../src/phase4WorkStep.js';
import {phase4Metric,INTELLIGENCE_VERSIONS} from '../src/phase4IntelligenceRegistry.js';
import {authorizeStage8LiveProducer} from '../src/stage8LiveProducerAuthority.js';
import {buildPhase4Core} from '../src/phase4Core.js';
import {composePhase4Stores} from '../src/phase4Repositories.js';
import {createStage8LiveExecutionRunner} from '../src/stage8LiveExecution.js';
import {createReanalysisInputs} from '../src/phase4ReanalysisInputs.js';
import {runningReleaseSha} from '../src/phase4Release.js';
import {createPhase4Stage6} from '../src/phase4Reanalysis.js';

for(const fault of ['MISSING_DOMAIN','CORRUPT_DOMAIN'])test('readonly raw request hint cannot authorize a family: '+fault,async t=>{
 const f=await syntheticPhase4Fixture(t,{targetVersion:35,ownedConnection:true,now:()=>new Date()});
 await f.db.transaction(()=>seedBodyInput(f.db,bodyInput({asOf:Date.now()-1000,days:0})));
 await f.db.ensureOnboarding('a',{state:'READY'});await f.db.linkTelegram({userId:'a',chatId:'10001'});
 const producer=await createStage8LiveProducer({...f,admission:await f.db.admitRuntime(),userIds:['a'],enabled:()=>true,eligible:id=>id==='a'});
 const prefix=await producer.run({userId:'a',requestId:'raw-request-boundary-original-prefix'});
 assert.ok(prefix.result.unitsCommitted>0);assert.notEqual(prefix.publication.status,'CURRENT');
 const original=f.db.raw.execute,before=(await original('SELECT * FROM stage8_live_execution_work_receipts ORDER BY 1,2')).rows;
 let hint=false,exact=false,injected=0,writesAfterHint=0,firstTypedReplayWrites=null;
 f.db.raw.execute=async stmt=>{
  const sql=typeof stmt==='string'?stmt:stmt.sql,result=await original(stmt);
  if(/json_extract\(CASE WHEN json_valid\(request_json\)/.test(sql)&&result.rows.length)hint=true;
  if(hint&&/^SELECT 1 FROM stage8_live_operation_receipts/.test(sql)&&/operation_key=\?/.test(sql)&&result.rows.length){exact=true;writesAfterHint=0;}
  if(exact&&/^(INSERT|UPDATE|DELETE)\b/.test(sql))writesAfterHint++;
  if(exact&&/^SELECT \* FROM stage8_live_operation_receipts WHERE user_id=\? AND execution_mode=\? AND operation_kind='analyzeMetric' AND operation_key=\?/.test(sql)
    &&result.rows.some(r=>JSON.parse(r.request_json).request.metricKey==='cycle_strain')){
   injected++;firstTypedReplayWrites??=writesAfterHint;
   return {...result,rows:fault==='MISSING_DOMAIN'?[]:result.rows.map(r=>({...r,receipt_hmac:'invalid-domain-seal'}))};
  }
  return result;
 };
 let value,error;try{value=await producer.run({userId:'a',requestId:'raw-request-boundary-fresh-attempt'});}catch(e){error=e;}finally{f.db.raw.execute=original;}
 assert.equal(hint,true);assert.equal(exact,true);assert.ok(injected>0,'actual exact DOMAIN replay must follow the scheduling hint');
 assert.equal(firstTypedReplayWrites,0,'request hint cannot mint an AUTHORITY receipt or mutate before typed replay');
 if(error)assert.match(String(error.code??error.message),/EXECUTION_DOMAIN_RECEIPT_MISSING|PHASE4_OPERATION_RECEIPT_INTEGRITY/);
 else{assert.ok(value.result.jobsFailed>0);assert.notEqual(value.publication.status,'CURRENT');}
 assert.equal((await original('SELECT count(*) n FROM stage8_live_publications')).rows[0].n,0);
 assert.equal((await original('SELECT count(*) n FROM outbound_messages')).rows[0].n,0);
 const after=new Set((await original('SELECT * FROM stage8_live_execution_work_receipts')).rows.map(r=>JSON.stringify(r)));
 for(const row of before)assert.ok(after.has(JSON.stringify(row)),'original named receipts remain byte-identical');
 const jobs=(await original("SELECT state,completed_generation,attempt FROM phase4_jobs WHERE user_id='a' AND execution_mode='LIVE'")).rows;
 assert.ok(jobs.every(j=>j.completed_generation===0));
});

test('existing same-execution named family receipt still requires the exact typed DOMAIN',async t=>{
 const f=await syntheticPhase4Fixture(t,{targetVersion:35,ownedConnection:true,now:()=>new Date()});
 const input=bodyInput({asOf:Date.now()-1000,days:30});
 input.sources.recovery.forEach((r,i)=>{r.recovery_score=i===0?15:40+(i%5)*5;});
 await f.db.transaction(()=>seedBodyInput(f.db,input));
 await f.db.ensureOnboarding('a',{state:'READY'});await f.db.linkTelegram({userId:'a',chatId:'10001'});
 const producer=await createStage8LiveProducer({...f,admission:await f.db.admitRuntime(),userIds:['a'],enabled:()=>true,eligible:id=>id==='a'});
 const original=f.db.raw.execute;let named=null,injected=0,sameTransactionReplay=false,last,error;
 f.db.raw.execute=async stmt=>{
  const sql=typeof stmt==='string'?stmt:stmt.sql,result=await original(stmt),execution=currentDurableExecution();
  if(!named&&execution&&/FROM stage8_live_executions e LEFT JOIN stage8_live_execution_work_receipts/.test(sql)
    &&result.rows[0]?.receipt_receipt_key){
   const domains=(await original("SELECT * FROM stage8_live_operation_receipts WHERE user_id='a' AND operation_kind='analyzeMetric'")).rows;
   const jobs=(await original("SELECT * FROM phase4_jobs WHERE user_id='a' AND execution_mode='LIVE'")).rows;
   for(const domain of domains){const req=JSON.parse(domain.request_json).request;
    const family=f.keys.lookup(['episode-family-v1','a',phase4Metric(req.metricKey).domain,req.metricKey,INTELLIGENCE_VERSIONS.algorithm,req.metricKey,req.windowFamily]);
    for(const job of jobs){const step=workStepOptions('stage6.family',['a','LIVE',job.job_kind,job.requested_generation,job.scope_revision,[req.metricKey,req.asOfUtc,family]]).workStep;
     if(workStepKey(execution,['named',step])===result.rows[0].receipt_receipt_key)
      named={row:{...result.rows[0]},request:req,marker:currentExecutionReceiptTransactionMarker()};
    }
   }
  }
  if(named&&/^SELECT \* FROM stage8_live_operation_receipts WHERE user_id=\? AND execution_mode=\? AND operation_kind='analyzeMetric' AND operation_key=\?/.test(sql)
    &&result.rows.some(r=>JSON.parse(r.request_json).request.metricKey===named.request.metricKey)){
   injected++;sameTransactionReplay||=named.marker===currentExecutionReceiptTransactionMarker();return {...result,rows:[]};
  }
  return result;
 };
 try{for(let leg=0;leg<12;leg++){last=await producer.run({userId:'a',requestId:'raw-named-family-boundary-'+leg});if(named&&last.result.jobsFailed>0)break;}}catch(e){error=e;}finally{f.db.raw.execute=original;}
 assert.ok(named,'must reach a genuine existing named family receipt in this execution');
 assert.ok(injected>0,'named replay must freshly read the exact typed DOMAIN');
 assert.equal(sameTransactionReplay,true,'typed read must occur inside the existing named receipt replay transaction');
 if(error)assert.match(String(error.code??error.message),/EXECUTION_DOMAIN_RECEIPT_MISSING/);
 else{assert.ok(last.result.jobsFailed>0);assert.notEqual(last.publication.status,'CURRENT');}
 const retained=(await original({sql:'SELECT * FROM stage8_live_execution_work_receipts WHERE receipt_key=?',args:[named.row.receipt_receipt_key]})).rows[0];
 for(const [key,value] of Object.entries(retained))assert.equal(named.row['receipt_'+key],value,'original committed family receipt stays identical');
 const sourceCursor=JSON.stringify([named.request.currentSource.source_type,named.request.currentSource.source_id]);
 const jobs=(await original("SELECT * FROM phase4_jobs WHERE user_id='a' AND execution_mode='LIVE'")).rows;
 assert.ok(jobs.every(j=>j.completed_generation===0&&(!j.full_scan_cursor||j.full_scan_cursor<sourceCursor)), 'failed replay cannot ACK this source or complete its job');
 assert.equal((await original('SELECT count(*) n FROM stage8_live_publications')).rows[0].n,0);
 assert.equal((await original('SELECT count(*) n FROM outbound_messages')).rows[0].n,0);
});

test('retained custom family cannot borrow the valid default DOMAIN',async t=>{
 const f=await syntheticPhase4Fixture(t,{targetVersion:35,ownedConnection:true,now:()=>new Date()});
 const asOf=Date.now()-1000,input=bodyInput({asOf,days:0}),iso=ms=>new Date(ms).toISOString();
 input.sources.cycle[0].strain=20;
 for(let n=1;n<=30;n++)input.sources.cycle.push({user_id:'a',id:'z-cycle-'+n,start_at:iso(asOf-n*86400000-3600000),
  end_at:iso(asOf-n*86400000),strain:4+n%3,updated_at:iso(asOf-n*86400000),synced_at:iso(asOf)});
 await f.db.transaction(()=>seedBodyInput(f.db,input));
 await f.db.ensureOnboarding('a',{state:'READY'});await f.db.linkTelegram({userId:'a',chatId:'10001'});
 const admission=await f.db.admitRuntime(),producer=await createStage8LiveProducer({...f,admission,userIds:['a'],enabled:()=>true,eligible:id=>id==='a'});
 const releaseSha=runningReleaseSha({}),configProof=f.keys.lookup(['stage8-live-server-config-v1',releaseSha,35,['a'],'phase4-stage5-canonical-v1']);
 const capability=await authorizeStage8LiveProducer({...f,admission,releaseSha,configProof,enabled:()=>true,eligible:id=>id==='a'});
 const core=await buildPhase4Core({keys:f.keys,admission,liveProducingAuthority:capability,
  processing:{client:f.db.raw,transaction:f.db.transaction,withReadSnapshot:f.db.withProcessingReadSnapshot,active:f.db.processingTransactionActive,
   assertFences:f.db.assertRuntimeFences,afterCommit:f.db.afterProcessingCommit,afterCompletion:f.db.afterProcessingCompletion},
  authorizeMode(mode,client,id){assert.equal(mode,'LIVE');assert.equal(client,f.db.raw);assert.equal(id,'a');}});
 await core.initializeTenant('a','LIVE');
 const worker=await createPhase4Stage6({...f,admission,executionMode:'LIVE',liveProducingAuthority:capability});
 await worker.rolloutAlgorithm({userId:'a'});
 const stores=composePhase4Stores(core),inputs=createReanalysisInputs(core,stores),windowFamily='CUSTOM_RETAINED_CYCLE';
 const run=createStage8LiveExecutionRunner({...f,capability,capture:id=>core.capture(id,{executionMode:'LIVE',providerRequired:true}),assertContext:ctx=>core.assertContext(ctx),work:()=>stores.withContext('a',{executionMode:'LIVE',providerRequired:true},async ctx=>{
  const request=await core.run(ctx,async()=>({...await inputs.metric(ctx,'cycle_strain',await core.root(ctx,'cycle','cycle-current'),new Date().toISOString()),windowFamily}));
  const initial=await stores.intelligence.analyzeMetric(ctx,request);assert.ok(initial.episode?.episode?.row);
  const prepared=await stores.intelligence.analyzeMetric(ctx,{...request,refresh:true});assert.equal(prepared.resultState,'REFRESH_PREPARED');
  return {outcome:'PARTIAL'};
 })});
 await run({userId:'a',requestId:'raw-custom-genuine-public-creation'});
 const custom=(await f.db.raw.execute("SELECT * FROM stage8_live_operation_receipts WHERE user_id='a' AND operation_kind='analyzeMetric'")).rows
  .find(r=>{const req=JSON.parse(r.request_json).request;return req.windowFamily===windowFamily&&req.refresh===true;});
 assert.ok(custom,'custom DOMAIN and retained family must come from public typed producers');
 const original=f.db.raw.execute;let injected=0,validDefault=false,last,error;
 f.db.raw.execute=async stmt=>{
  const sql=typeof stmt==='string'?stmt:stmt.sql,result=await original(stmt);
  if(/^SELECT \* FROM stage8_live_operation_receipts WHERE user_id=\? AND execution_mode=\? AND operation_kind=\? AND operation_key=\?/.test(sql)
    &&result.rows.some(r=>r.operation_key===custom.operation_key)){
   validDefault=(await original("SELECT request_json FROM stage8_live_operation_receipts WHERE user_id='a' AND operation_kind='analyzeMetric'")).rows
    .some(r=>{const req=JSON.parse(r.request_json).request;return req.metricKey==='cycle_strain'&&req.windowFamily!==windowFamily&&req.refresh===true;});
   assert.equal(validDefault,true,'genuine default DOMAIN must already exist before custom replay is rejected');
   injected++;return {...result,rows:result.rows.map(r=>({...r,receipt_hmac:'corrupt-custom-domain'}))};
  }
  return result;
 };
 try{for(let leg=0;leg<6;leg++){last=await producer.run({userId:'a',requestId:'raw-custom-replay-boundary-'+leg});if(last.result.jobsFailed>0)break;}}catch(e){error=e;}finally{f.db.raw.execute=original;}
 const disposition=(await original("SELECT job_kind,state,last_error_code,full_scan_cursor FROM phase4_jobs WHERE user_id='a' AND execution_mode='LIVE'")).rows;
 assert.ok(injected>0,'must read the custom DOMAIN independently of the valid default: '+JSON.stringify({error:error?.code,result:last?.result,jobs:disposition}));
 assert.equal(validDefault,true);
 if(error)assert.match(String(error.code??error.message),/PHASE4_OPERATION_RECEIPT_INTEGRITY/);
 else{assert.ok(last.result.jobsFailed>0);assert.notEqual(last.publication.status,'CURRENT');}
 const retained=(await original({sql:'SELECT * FROM stage8_live_operation_receipts WHERE operation_key=?',args:[custom.operation_key]})).rows[0];
 assert.deepEqual(retained,custom,'injected view must not rewrite the original custom receipt');
 assert.equal((await original('SELECT count(*) n FROM stage8_live_publications')).rows[0].n,0);
 assert.equal((await original('SELECT count(*) n FROM outbound_messages')).rows[0].n,0);
});
