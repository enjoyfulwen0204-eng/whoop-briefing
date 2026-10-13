// Author verification only. Adapted from the prior Stage 7 review harness.
import {fileURLToPath} from 'node:url';import {execFileSync} from 'node:child_process';
const legacyRoot='/Users/kelvin/Desktop/whoop-briefing/tmp/stage6-p0-20261013/worktree/';
assertLegacy();
function assertLegacy(){
 const head=execFileSync('git',['rev-parse','HEAD'],{cwd:legacyRoot,encoding:'utf8'}).trim();
 if(head!=='2340e8bc305c6acde29bbfa540753e79dbd34408')throw Error('PINNED_V32_FIXTURE_SOURCE_REQUIRED');
 if(execFileSync('git',['status','--porcelain','--','src','test','package.json'],{cwd:legacyRoot,encoding:'utf8'}).trim())throw Error('CLEAN_V32_FIXTURE_SOURCE_REQUIRED');
}
import {SCHEMA_VERSION} from '../src/schema.js';
// AUTHOR isolated physical-transport diagnostic. Synthetic data only; no provider.
import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {verifyV27RouteSource} from '../src/phase4ReceiptRouting.js';
import {bodySha256} from '../src/briefingTriggerAuth.js';
let sourceRoot='/Users/kelvin/Desktop/whoop-briefing/tmp/stage6-p0-20261013/worktree/';const mod=p=>import(sourceRoot+p);
let {createOwnedDb}=await mod('test/stage5OwnedDb.js'),{fixtureKeys}=await mod('test/localDb.js'),{createDb}=await mod('src/db.js'),{hranaTransport}=await mod('test/hranaTransport.js'),{bodyInput,seedBodyInput}=await mod('test/bodyEnergyFixture.js'),{bodyHealthDate}=await mod('src/bodyEnergyInputs.js'),{createPhase4Foundation}=await mod('src/phase4Foundation.js'),{createPublicBetaRuntime,authorizePublicBetaRuntime}=await mod('src/publicBeta.js'),{createPhase4Stage6,authorizeStage6ShadowWorker}=await mod('src/phase4Reanalysis.js'),{runExecutionPhase}=await mod('src/phase4Execution.js'),{configurationProof}=await mod('src/phase4ExecutionStore.js'),{runningReleaseSha}=await mod('src/phase4Release.js'),{publicBetaConfiguration}=await mod('src/publicBetaConfig.js'),{OWNER_PILOT_APPROVAL_SHA256}=await mod('src/betaPilotAllowance.js'),{requireCurrentBetaPilotAttempt}=await mod('src/betaPilotPermit.js');
const latencyMs=Number(process.env.DOMAIN_COLD_LATENCY_MS??0);assert.ok(Number.isSafeInteger(latencyMs)&&latencyMs>=0&&latencyMs<=150);
const BUDGET={maxJobs:1,maxItems:1,maxItemsPerTenant:1,maxWallMs:45000,safetyMarginMs:15000};
test('original 2340 v32 DOMAIN and cursor survive first v34 migration, then new exact code advances immutable DOMAIN across a fresh request',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'body-item-whole-')),url='file:'+join(dir,'db.sqlite');const seed=createOwnedDb({url});await seed.migrate({targetVersion:32});await seed.raw.execute('PRAGMA journal_mode=WAL');seed.close();const transport=hranaTransport(url);let latency=0,currentDb;
 const fresh=()=>createDb({url:'https://isolated.invalid',phase4Keys:fixtureKeys,fetch:async r=>{if(latency)await new Promise(x=>setTimeout(x,latency));return transport.fetch(r)}});
 t.after(async()=>{currentDb?.close();transport.close();await rm(dir,{recursive:true,force:true})});currentDb=fresh();await currentDb.createUser({id:'a',displayName:'Synthetic',timezone:'Asia/Taipei',status:'ACTIVE'});await currentDb.setLocale('a','en');await currentDb.ensureOnboarding('a',{state:'READY'});const admission=await currentDb.admitRuntime();const stores=await createPhase4Foundation({db:currentDb,keys:fixtureKeys,admission});await stores.initializeTenant('a','SHADOW');const input=bodyInput({asOf:Date.now()-1000,days:30});for(const s of input.sources.sleep){s.health_date=bodyHealthDate(Date.parse(s.end_at),input.timezone);input.sources.recovery.find(r=>r.sleep_id===s.id).health_date=s.health_date;}for(const r of input.sources.recovery.slice(1,4))r.user_calibrating=1;await currentDb.transaction(()=>seedBodyInput(currentDb,input));await stores.queue.sourceChanged(await stores.captureControl('a'));
 const environment={PHASE4_BETA_SHADOW_RUNTIME:'on',PHASE4_PUBLIC_BETA_MODE:'off',PHASE4_BETA_PILOT_ID:'a'.repeat(64),PHASE4_BETA_PILOT_USER_ID:'a',PHASE4_BETA_PILOT_START_AT:new Date(Date.now()-1000).toISOString(),PHASE4_BETA_PILOT_CONSENT_SHA256:'b'.repeat(64),PHASE4_BETA_PILOT_ALLOWANCE_ID:OWNER_PILOT_APPROVAL_SHA256};let releaseSha=runningReleaseSha(),proof=configurationProof(fixtureKeys,publicBetaConfiguration(environment),environment,releaseSha);const req=phase=>({requestId:crypto.randomUUID(),releaseSha,configProof:proof,executionMode:'SHADOW',triggerSource:'manual',phase});let syncReq=req('SYNC');const common=()=>({db:currentDb,keys:fixtureKeys,environment,env:{dryRun:false}});let sync=await runExecutionPhase({...common(),request:syncReq,deps:{runBriefing:async()=>({syncComplete:true,syncOutcome:'NO_NEW_DATA_SUCCESS'})}});assert.equal(sync.body.syncComplete,true);const evidence=[];let domainBeforeReplay;
 for(let leg=1;leg<=9;leg++){
  currentDb.close();currentDb=fresh();const preItems=Number((await currentDb.raw.execute('SELECT count(*) n FROM evidence_items')).rows[0].n),preRun=[...(await currentDb.raw.execute('SELECT state FROM evidence_runs')).rows][0]?.state??null;const preAuthorities=Number((await currentDb.raw.execute("SELECT count(*) n FROM phase4_evidence_result_authorities WHERE result_scope='METRIC'")).rows[0].n),preDomains=Number((await currentDb.raw.execute("SELECT count(*) n FROM phase4_operation_receipts WHERE operation_kind='analyzeMetric'")).rows[0].n);const intendedUnit=leg===1?'SOURCE_AND_DIRECTORY':preRun===null?'RUN_START':preRun==='STARTED'?'RUN_COMPLETE':preItems===0?'ITEM':preAuthorities===0?'AUTHORITY':preDomains===0?'DOMAIN':'DOMAIN_REPLAY';latency=['ITEM','AUTHORITY','DOMAIN','DOMAIN_REPLAY'].includes(intendedUnit)?latencyMs:0;let sourceAck=false,origin,entered,ready,unitStart;
  if(leg===1)transport.arm({matchSql:/INSERT INTO body_energy_results\(/,after:()=>currentDb.afterProcessingCommit(()=>{sourceAck=true})});
  const before=structuredClone(transport.counts),start=performance.now();const request={...req('STAGE6_DRAIN'),syncRequestId:syncReq.requestId,handoff:sync.body.handoff};
  const runtime={phase4Stage6:{drain:async args=>{entered={at:performance.now()-start,http:transport.counts.httpRequests-before.httpRequests};const pilotGrant=requireCurrentBetaPilotAttempt('a',currentDb.raw),admission=await currentDb.admitRuntime();let worker;if(leg===1)worker=await createPhase4Stage6({db:currentDb,keys:fixtureKeys,admission,executionMode:'SHADOW',pilotGrant,workerCapability:authorizeStage6ShadowWorker({executionMode:'SHADOW'}),monotonicNow:()=>{const now=performance.now();origin??=now;return sourceAck?origin+30000:now}});else worker=(await createPublicBetaRuntime({db:currentDb,keys:fixtureKeys,admission,executionMode:'SHADOW',pilotGrant,runtimeCapability:authorizePublicBetaRuntime({executionMode:'SHADOW'})})).phase4Stage6;ready={at:performance.now()-start,http:transport.counts.httpRequests-before.httpRequests};unitStart=performance.now();return worker.drain({...args,budget:BUDGET})}}};
  const result=await runExecutionPhase({...common(),request,deps:{runtime}});const measured={leg,intendedUnit,preItems,preRun,preAuthorities,preDomains,latencyMs:latency,wholeMs:performance.now()-start,http:transport.counts.httpRequests-before.httpRequests,sql:transport.counts.sqlStatements-before.sqlStatements,entered,ready,workerMs:performance.now()-unitStart,outcome:result.body.result.outcome,settlement:result.body.result.settlementState,units:result.body.result.unitsCommitted??0,sourceItems:result.body.result.itemsProcessed??0};latency=0;measured.postItems=Number((await currentDb.raw.execute('SELECT count(*) n FROM evidence_items')).rows[0].n);measured.postRun=[...(await currentDb.raw.execute('SELECT state FROM evidence_runs')).rows][0]?.state??null;const executed=(await currentDb.raw.execute({sql:'SELECT * FROM phase4_executions WHERE execution_id=?',args:[request.requestId]})).rows[0],receipts=[...(await currentDb.raw.execute({sql:'SELECT * FROM phase4_execution_work_receipts WHERE execution_id=?',args:[request.requestId]})).rows];measured.workReceiptCount=receipts.length;measured.workReceiptKeysEqual=receipts.every(r=>r.step_key===r.receipt_key);evidence.push(measured);console.log('AUTHOR_WHOLE_COLD '+JSON.stringify(measured));assert.equal(result.body.result.settlementState,'FINALIZED_SUCCESS');latency=0;if(intendedUnit==='ITEM'){assert.equal(measured.postItems,1);assert.equal(measured.units,1);}if(intendedUnit==='AUTHORITY'){assert.equal(Number((await currentDb.raw.execute("SELECT count(*) n FROM phase4_evidence_result_authorities WHERE result_scope='METRIC'")).rows[0].n),1);assert.equal(measured.units,1);}if(intendedUnit==='DOMAIN'){
   const domains=(await currentDb.raw.execute("SELECT * FROM phase4_operation_receipts WHERE operation_kind='analyzeMetric'")).rows;
   assert.equal(domains.length,1);const domain=domains[0];verifyV27RouteSource(fixtureKeys,domain);
   const step=fixtureKeys.lookup(['phase4-logical-work-v1','domain.operation',['a','SHADOW',domain.input_generation,'analyzeMetric',domain.operation_key]]),
    key=fixtureKeys.lookup(['execution-work-step-v2',executed.identity_digest,executed.scope_key,['named',step]]),ack=receipts.find(row=>row.receipt_key===key);
   assert.ok(ack,'the actual DOMAIN transaction has its original named work ACK');
   assert.equal(ack.execution_id,request.requestId);assert.equal(ack.generation,executed.generation);
   assert.equal(ack.request_digest,executed.identity_digest);assert.equal(ack.scope_key,executed.scope_key);
   assert.ok(ack.committed_at<=executed.deadline_at&&ack.committed_at<=executed.finalized_at);
   assert.equal(executed.state,'FINALIZED_SUCCESS');assert.equal(bodySha256(executed.result_json),executed.result_digest);
   const producer=(await currentDb.raw.execute({sql:'SELECT * FROM phase4_execution_producers WHERE producing_execution_id=?',args:[request.requestId]})).rows[0];
   assert.equal(producer.input_generation,domain.input_generation);assert.equal(producer.execution_seq,executed.execution_seq);
   assert.equal(producer.tenant_proof,fixtureKeys.lookup(['execution-producer-v1','a','SHADOW',domain.input_generation,request.requestId,executed.execution_seq,producer.producing_generation]));
   console.log('STAGE6_DOMAIN_COMMIT_PROOF '+JSON.stringify({domainReceiptHmacValid:true,namedDomainAck:true,currentGenerationProducer:true,producerFinalizedSuccess:true,unitCounter:measured.units,jobCompleted:false}));domainBeforeReplay=JSON.stringify(domain);
   const snapshot=async db=>Object.fromEntries(await Promise.all(['phase4_operation_receipts','phase4_execution_work_receipts','phase4_executions','phase4_execution_producers','phase4_jobs','phase4_computation_state','body_energy_results'].map(async table=>[table,JSON.stringify((await db.raw.execute('SELECT * FROM '+table)).rows.map(row=>JSON.stringify(row)).sort())])));
   const oldSnapshot=await snapshot(currentDb),oldLookup=fixtureKeys.lookupCheckpoint(),oldAudit=fixtureKeys.auditCheckpoint();
   currentDb.close();sourceRoot=fileURLToPath(new URL('..',import.meta.url));
   ({createOwnedDb}=await mod('test/stage5OwnedDb.js'));
   ({fixtureKeys}=await mod('test/localDb.js'));
   ({createDb}=await mod('src/db.js'));
   ({hranaTransport}=await mod('test/hranaTransport.js'));
   ({bodyInput,seedBodyInput}=await mod('test/bodyEnergyFixture.js'));
   ({bodyHealthDate}=await mod('src/bodyEnergyInputs.js'));
   ({createPhase4Foundation}=await mod('src/phase4Foundation.js'));
   ({createPublicBetaRuntime,authorizePublicBetaRuntime}=await mod('src/publicBeta.js'));
   ({createPhase4Stage6,authorizeStage6ShadowWorker}=await mod('src/phase4Reanalysis.js'));
   ({runExecutionPhase}=await mod('src/phase4Execution.js'));
   ({configurationProof}=await mod('src/phase4ExecutionStore.js'));
   ({runningReleaseSha}=await mod('src/phase4Release.js'));
   ({publicBetaConfiguration}=await mod('src/publicBetaConfig.js'));
   ({OWNER_PILOT_APPROVAL_SHA256}=await mod('src/betaPilotAllowance.js'));
   ({requireCurrentBetaPilotAttempt}=await mod('src/betaPilotPermit.js'));
   assert.equal(fixtureKeys.lookupCheckpoint(),oldLookup);assert.equal(fixtureKeys.auditCheckpoint(),oldAudit);
   const migrationDb=createOwnedDb({url});await migrationDb.migrate({targetVersion:34});await migrationDb.migrate({targetVersion:34});
   assert.deepEqual(await snapshot(migrationDb),oldSnapshot,'all original receipt/producer/job/currentness/body bytes remain unchanged');
   assert.deepEqual((await migrationDb.raw.execute('PRAGMA foreign_key_check')).rows,[]);assert.equal((await migrationDb.raw.execute('PRAGMA integrity_check')).rows[0].integrity_check,'ok');await migrationDb.close();
   currentDb=fresh();const freshStores=await createPhase4Foundation({db:currentDb,keys:fixtureKeys,admission:await currentDb.admitRuntime()});
   const oldView=await freshStores.withContext('a',{executionMode:'SHADOW',providerRequired:true},context=>freshStores.bodyEnergy.readForPublication(context,{healthDate:bodyHealthDate(Date.now(),'Asia/Taipei'),asOfEpochMs:Date.now(),presentationPolicy:'body-energy-owner-provisional-v1'}));
   assert.equal(oldView.status,'PROVISIONAL','exact v32 persisted Body/source receipt remains authenticated and current under qualified v34 reader');
   releaseSha=runningReleaseSha();proof=configurationProof(fixtureKeys,publicBetaConfiguration(environment),environment,releaseSha);
   syncReq=req('SYNC');sync=await runExecutionPhase({...common(),request:syncReq,deps:{runBriefing:async()=>({syncComplete:true,syncOutcome:'NO_NEW_DATA_SUCCESS'})}});assert.equal(sync.body.syncComplete,true);
   console.log('CROSS_SCHEMA_PRESERVATION '+JSON.stringify({originalSchema:32,currentSchema:34,rawRowsUnchanged:true,originalKeysUnchanged:true,oldBodySourceUnitCurrent:true,foreignKeysValid:true,integrityValid:true}));
continue;
  }
  if(intendedUnit==='DOMAIN_REPLAY'){
   assert.equal(measured.sourceItems,1,'a fresh admitted owner advances the original USER cursor');
   const domains=(await currentDb.raw.execute("SELECT * FROM phase4_operation_receipts WHERE operation_kind='analyzeMetric'")).rows;
   assert.equal(domains.length,1);assert.equal(JSON.stringify(domains[0]),domainBeforeReplay,'replay preserves the immutable original DOMAIN');
   verifyV27RouteSource(fixtureKeys,domains[0]);
   const job=(await currentDb.raw.execute("SELECT * FROM phase4_jobs WHERE user_id='a' AND full_scan_cursor IS NOT NULL")).rows[0];
   assert.equal(job.full_scan_cursor,JSON.stringify(['USER','a']));
   assert.equal(job.claimed_generation,job.requested_generation);
   assert.ok(receipts.length>=4,'claim/family/cursor settlement retains real named work receipts');
   console.log('STAGE6_CURSOR_REPLAY_PROOF '+JSON.stringify({cursorAdvanced:true,immutableDomainUnchanged:true,finalizedSuccess:true,sourceItems:measured.sourceItems,jobCompleted:false}));break;
  }
 }
 assert.equal(evidence.filter(x=>x.intendedUnit==='DOMAIN_REPLAY').length,1);
 assert.equal(evidence.filter(x=>x.intendedUnit==='DOMAIN').length,1);const rows={runs:[...(await currentDb.raw.execute("SELECT state,count(*) n FROM evidence_runs GROUP BY state")).rows],items:Number((await currentDb.raw.execute('SELECT count(*) n FROM evidence_items')).rows[0].n)};const out={declaration:'ISOLATED_INSTALLED_HRANA_SYNTHETIC_NOT_PRODUCTION_OR_CLINICAL',evidence,rows,publication:false,providerCalls:0};console.log('STAGE6_DOMAIN_COLD_COUNTS '+JSON.stringify(out));
});
