import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {mod,fixtureKeys,residualFixture} from './stage6JournalBoundaryFixture.js';
const {runExecutionPhase}=await mod('src/phase4Execution.js');
const {configurationProof}=await mod('src/phase4ExecutionStore.js');const {runningReleaseSha}=await mod('src/phase4Release.js');
const {publicBetaConfiguration}=await mod('src/publicBetaConfig.js');const {OWNER_PILOT_APPROVAL_SHA256}=await mod('src/betaPilotAllowance.js');
const {requireCurrentBetaPilotAttempt}=await mod('src/betaPilotPermit.js');
const {createPublicBetaRuntime,authorizePublicBetaRuntime}=await mod('src/publicBeta.js');

const changes={
 auth:"UPDATE user_whoop_tokens SET auth_generation=auth_generation+1 WHERE user_id='a'",
 generation:"UPDATE phase4_computation_state SET input_generation=input_generation+1 WHERE user_id='a' AND execution_mode='SHADOW'",
 lease:"UPDATE phase4_jobs SET lease_owner='synthetic-successor' WHERE user_id='a' AND state='RUNNING'",
 purge:"UPDATE phase4_user_state SET purge_generation=purge_generation+1 WHERE user_id='a'",
};
for(const [name,sql] of Object.entries(changes))test('v32 source preparation rejects '+name+' change after latest read; peer stays untouched',async t=>{
 const f=await residualFixture(t,{http:true}),environment={PHASE4_BETA_SHADOW_RUNTIME:'on',PHASE4_PUBLIC_BETA_MODE:'off',PHASE4_BETA_PILOT_ID:'a'.repeat(64),PHASE4_BETA_PILOT_USER_ID:'a',PHASE4_BETA_PILOT_START_AT:new Date(Date.now()-1000).toISOString(),PHASE4_BETA_PILOT_CONSENT_SHA256:'b'.repeat(64),PHASE4_BETA_PILOT_ALLOWANCE_ID:OWNER_PILOT_APPROVAL_SHA256};
 const releaseSha=runningReleaseSha(),configProof=configurationProof(fixtureKeys,publicBetaConfiguration(environment),environment,releaseSha),request=phase=>({requestId:randomUUID(),releaseSha,configProof,executionMode:'SHADOW',triggerSource:'manual',phase});
 const common=()=>({db:f.db,keys:fixtureKeys,environment,env:{dryRun:false}}),syncReq=request('SYNC'),sync=await runExecutionPhase({...common(),request:syncReq,deps:{runBriefing:async()=>({syncComplete:true,syncOutcome:'NO_NEW_DATA_SUCCESS'})}});assert.equal(sync.body.syncComplete,true);

 const {createPhase4Foundation}=await mod('src/phase4Foundation.js');
 await f.db.createUser({id:'b',displayName:'Synthetic peer',timezone:'Asia/Taipei',status:'ACTIVE'});await f.db.ensureOnboarding('b',{state:'READY'});
 const stores=await createPhase4Foundation({db:f.db,keys:fixtureKeys,admission:await f.db.admitRuntime()});await stores.initializeTenant('b','SHADOW');await stores.queue.sourceChanged(await stores.captureControl('b'));
 const peer=async()=>[...(await f.db.raw.execute("SELECT * FROM phase4_jobs WHERE user_id='b' ORDER BY job_kind")).rows],originalPeer=await peer();
 let domain=false,hit=false;
 for(let leg=1;leg<=11;leg++){
  await f.fresh();const probe=domain;
  if(probe)f.transport.arm({matchSql:/ORDER BY COALESCE\(end_at,updated_at\) DESC,id COLLATE BINARY LIMIT 1/,before:async client=>{hit=true;await client.execute(sql);}});
  const req={...request('STAGE6_DRAIN'),syncRequestId:syncReq.requestId,handoff:sync.body.handoff};
  const runtime={phase4Stage6:{drain:async args=>{const pilotGrant=requireCurrentBetaPilotAttempt('a',f.db.raw),admission=await f.db.admitRuntime(),w=(await createPublicBetaRuntime({db:f.db,keys:fixtureKeys,admission,executionMode:'SHADOW',pilotGrant,runtimeCapability:authorizePublicBetaRuntime({executionMode:'SHADOW'})})).phase4Stage6;return w.drain(args);}}};
  const result=await runExecutionPhase({...common(),request:req,deps:{runtime}});
  const counts=await f.counts();domain=counts.domain>0;assert.deepEqual(await peer(),originalPeer);
  assert.equal(Number((await f.db.raw.execute("SELECT count(*) n FROM phase4_execution_producers WHERE user_id='b'")).rows[0].n),0);
  if(probe){
   assert.equal(hit,true,'fault must reach actual latest-source transaction');
   assert.ok(result.body.result?.jobsFailed>0||result.status>=400,'stale preparation must not succeed');
   assert.equal(counts.domain,1,'no source DOMAIN after authority changed');
   const jobs=await f.jobs();assert.ok(jobs.some(j=>j.full_scan_cursor===JSON.stringify(['USER','a'])));
   assert.ok(jobs.every(j=>!j.full_scan_cursor||JSON.parse(j.full_scan_cursor)[0]!=='cycle'));
   console.log('PREPARATION_FENCE '+JSON.stringify({fence:name,hit,peerUnchanged:true,extraDomain:false,outcome:result.body.result?.outcome,failed:result.body.result?.jobsFailed}));break;
  }
  assert.equal(result.body.result?.settlementState,'FINALIZED_SUCCESS');
 }
 assert.equal(hit,true);
});
