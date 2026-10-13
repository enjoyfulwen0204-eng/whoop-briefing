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

test('six of seven real Journal roots preserve their v32 cursor and remaining seventh root progresses under v34',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'journal-v32-v34-')),url='file:'+join(dir,'db.sqlite');let db=createOwnedDb({url});await db.migrate({targetVersion:32});
 t.after(async()=>{await db.close();await rm(dir,{recursive:true,force:true});});
 await db.createUser({id:'a',displayName:'Synthetic',timezone:'Asia/Taipei',status:'ACTIVE'});await db.setLocale('a','en');await db.ensureOnboarding('a',{state:'READY'});
 let stores=await createPhase4Foundation({db,keys:fixtureKeys,admission:await db.admitRuntime()});await stores.initializeTenant('a','SHADOW');
 const input=bodyInput({asOf:Date.now()-1000,days:7});await db.transaction(()=>seedBodyInput(db,input));
 for(let i=0;i<7;i++){const phrase='caffeine '+(100+i)+'mg',eventAt=new Date(Date.now()-3600000).toISOString(),text=phrase+' at '+eventAt;const saved=await stores.journal.create(await stores.captureControl('a'),{sourceEventKey:'migration-fact-'+i,sourceText:text,candidate:{category:'caffeine',eventAt,valueKind:'NUMERIC',numericValue:100+i,unit:'mg',exposureState:'EXPOSED',extractionConfidence:1,excerptStart:0,excerptEnd:phrase.length}});assert.equal(saved.status,'ACCEPT');}
 await stores.queue.sourceChanged(await stores.captureControl('a'));
 const environment={PHASE4_BETA_SHADOW_RUNTIME:'on',PHASE4_PUBLIC_BETA_MODE:'off',PHASE4_BETA_PILOT_ID:'a'.repeat(64),PHASE4_BETA_PILOT_USER_ID:'a',PHASE4_BETA_PILOT_START_AT:new Date(Date.now()-1000).toISOString(),PHASE4_BETA_PILOT_CONSENT_SHA256:'b'.repeat(64),PHASE4_BETA_PILOT_ALLOWANCE_ID:OWNER_PILOT_APPROVAL_SHA256};
 const run=async maxItems=>{
  const releaseSha=runningReleaseSha(),configProof=configurationProof(fixtureKeys,publicBetaConfiguration(environment),environment,releaseSha),req=phase=>({requestId:crypto.randomUUID(),releaseSha,configProof,executionMode:'SHADOW',triggerSource:'manual',phase}),syncRequest=req('SYNC');
  const sync=await runExecutionPhase({db,keys:fixtureKeys,environment,env:{dryRun:false},request:syncRequest,deps:{runBriefing:async()=>({syncComplete:true,syncOutcome:'NO_NEW_DATA_SUCCESS'})}});assert.equal(sync.body.syncComplete,true);
  const request={...req('STAGE6_DRAIN'),syncRequestId:syncRequest.requestId,handoff:sync.body.handoff};
  const result=await runExecutionPhase({db,keys:fixtureKeys,environment,env:{dryRun:false},request,deps:{runtime:{phase4Stage6:{drain:async args=>{
   const worker=await createPhase4Stage6({db,keys:fixtureKeys,admission:await db.admitRuntime(),executionMode:'SHADOW',pilotGrant:requireCurrentBetaPilotAttempt('a',db.raw),workerCapability:authorizeStage6ShadowWorker({executionMode:'SHADOW'})});
   return worker.drain({...args,budget:{maxJobs:1,maxItems,maxItemsPerTenant:maxItems,maxWallMs:45000,safetyMarginMs:15000}});
  }}}}});assert.equal(result.body.result.settlementState,'FINALIZED_SUCCESS');assert.equal(result.body.result.jobsFailed,0);return result;
 };
 await run(6);
 const before=(await db.raw.execute("SELECT job_kind,input_generation,full_scan_cursor FROM phase4_jobs JOIN phase4_computation_state USING(user_id,execution_mode) WHERE full_scan_cursor IS NOT NULL ORDER BY job_kind")).rows;
 assert.equal(before.length,1);assert.equal(JSON.parse(before[0].full_scan_cursor)[0],'JOURNAL_FACT');
 const roots=(await db.raw.execute("SELECT privacy_artifact_id FROM journal_events WHERE user_id='a' AND fact_status='ACTIVE' ORDER BY privacy_artifact_id")).rows;
 assert.equal(JSON.parse(before[0].full_scan_cursor)[1],roots[5].privacy_artifact_id);
 const snapshot=JSON.stringify((await db.raw.execute('SELECT * FROM phase4_jobs ORDER BY job_kind')).rows),receipts=JSON.stringify((await db.raw.execute('SELECT * FROM phase4_execution_work_receipts')).rows);
 await db.close();sourceRoot=fileURLToPath(new URL('..',import.meta.url));
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
 db=createOwnedDb({url});await db.migrate({targetVersion:34});assert.equal(JSON.stringify((await db.raw.execute('SELECT * FROM phase4_jobs ORDER BY job_kind')).rows),snapshot);assert.equal(JSON.stringify((await db.raw.execute('SELECT * FROM phase4_execution_work_receipts')).rows),receipts);
 // Claim fairness may choose sibling job first; resume the captured original by
 // waiting until its ordinary queue ordering returns it, bounded by 2 jobs.
 let advanced=false;for(let i=0;i<2;i++){await run(1);const row=(await db.raw.execute({sql:'SELECT full_scan_cursor,requested_generation FROM phase4_jobs WHERE job_kind=?',args:[before[0].job_kind]})).rows[0];if(row.full_scan_cursor!==before[0].full_scan_cursor){assert.equal(JSON.parse(row.full_scan_cursor)[0],'JOURNAL_FACT');assert.equal(JSON.parse(row.full_scan_cursor)[1],roots[6].privacy_artifact_id);assert.equal(row.requested_generation,before[0].input_generation);advanced=true;break;}}
 assert.equal(advanced,true);console.log('JOURNAL_PREFIX_MIGRATION',{beforeProcessed:6,afterProcessed:7,generationUnchanged:true,receiptHistoryUnchanged:true,manuallyRewound:false});
});
