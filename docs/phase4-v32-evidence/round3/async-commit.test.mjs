import test from 'node:test';import assert from 'node:assert/strict';
import {createClient} from '@libsql/client/http';import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {composeDb} from '../../src/db.js';import {fixtureKeys} from '../../test/localDb.js';
import {createOwnedDb} from '../../test/stage5OwnedDb.js';
import {configurationProof,claimPhaseRequest,settlePhaseRequest,recordPhaseEvent,readPhaseProgress,requireSyncHandoff} from '../../src/phase4ExecutionStore.js';
import {runningReleaseSha} from '../../src/phase4Release.js';import {createExecutionBudget} from '../../src/executionBudget.js';
import {runExecutionPhase} from '../../src/phase4Execution.js';import {hranaTransport} from './hrana-transport.mjs';
const environment={PHASE4_BETA_SHADOW_RUNTIME:'on',PHASE4_PUBLIC_BETA_MODE:'off'};
const request=(phase='SYNC')=>({requestId:randomUUID(),releaseSha:runningReleaseSha(),phase,triggerSource:'manual',executionMode:'SHADOW',
 ...(phase==='STAGE6_DRAIN'?{syncRequestId:randomUUID(),handoff:'a'.repeat(64)}:{}),
 configProof:configurationProof(fixtureKeys,{runtime:'on',mode:'off'},environment)});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function fixture(t){const dir=await mkdtemp(join(tmpdir(),'p4-r3-hrana-')),url=`file:${join(dir,'db.sqlite')}`,seed=createOwnedDb({url});
 await seed.migrate({targetVersion:31});await seed.close();
 const transport=hranaTransport(url),base=createClient({url:'https://isolated.invalid',fetch:transport.fetch}),db=composeDb(base,{phase4Keys:fixtureKeys});
 t.after(async()=>{db.close();transport.close();await rm(dir,{recursive:true,force:true});});
 return {db,transport};}
for(const phaseOutcome of ['SYNC:cancel','SYNC:deadline','SYNC:lease','STAGE6_DRAIN:NO_WORK','STAGE6_DRAIN:PARTIAL','STAGE6_DRAIN:COMPLETE','SYNC:ambiguous',
 'SYNC:cancel-after-server-commit','SYNC:deadline-after-server-commit'])
test(`R3 actual HTTP/libsql COMMIT must not persist unauthorized success: ${phaseOutcome}`,async t=>{
 const {db,transport}=await fixture(t),[phase,attack]=phaseOutcome.split(':'),value=request(phase);
 const claim=await claimPhaseRequest(db,value,JSON.stringify(value),{leaseMs:attack==='lease'?250:5000});
 await recordPhaseEvent(db,{phase,releaseSha:value.releaseSha,source:'manual',event:'start',identity:claim.identity,outcome:'PENDING'});
 const controller=new AbortController(),authority=createExecutionBudget({budgetMs:5000,signal:controller.signal});
 const outcome=phase==='SYNC'?'NO_NEW_DATA_SUCCESS':attack;
 let invalidated=false;
 const invalidate=async()=>{
  if(attack==='lease')await sleep(Math.max(0,Date.parse(claim.expiresAt)-Date.now())+30);
  else if(attack.startsWith('deadline'))await sleep(Math.max(0,authority.deadlineAt-Date.now())+20);
  else controller.abort();invalidated=true;
 };
 transport.arm({...(attack.endsWith('after-server-commit')?{after:invalidate}:{before:invalidate}),loseAcknowledgement:attack==='ambiguous'});
 let result,thrown;
 try{result=await settlePhaseRequest(db,value,claim,{outcome,...(phase==='STAGE6_DRAIN'?{completion:outcome==='PARTIAL'?'PARTIAL':'COMPLETE',itemsProcessed:outcome==='NO_WORK'?0:3}: {})},fixtureKeys,authority);}
 catch(e){thrown=e.code??e.message;}finally{authority.close();}
 const stored=JSON.parse((await db.raw.execute({sql:'SELECT last_detail FROM system_heartbeats WHERE component=?',args:[`phase4_request:${value.requestId}`]})).rows[0].last_detail);
 const progress=await readPhaseProgress(db,phase,'manual'),retry=await claimPhaseRequest(db,value,JSON.stringify(value));
 let drainAccepted=false;if(stored.handoff){try{await requireSyncHandoff(db,{...value,phase:'STAGE6_DRAIN',requestId:randomUUID(),syncRequestId:value.requestId,handoff:stored.handoff},fixtureKeys);drainAccepted=true;}catch{}}
 console.log(JSON.stringify({probe:phaseOutcome,invalidated,thrown:thrown??null,returnedOutcome:result?.outcome??null,
  durableOutcome:stored.outcome,completionHeartbeat:progress.state,retryCachedOutcome:retry.cached?.outcome??null,drainAccepted,transport:transport.evidence}));
 assert.equal(invalidated,true);assert.notEqual(stored.outcome,outcome,'invalidated async COMMIT must not become a durable successful finalization');
 assert.equal(stored.handoff,undefined);assert.notEqual(progress.state,outcome);assert.equal(drainAccepted,false);
});
test('R3 phase response stays aborted but identical retry must not discover cached success',async t=>{
 const {db,transport}=await fixture(t),value=request(),controller=new AbortController();
 const deps={runBriefing:async()=>{transport.arm({before:async()=>{controller.abort();await sleep(25);}});return {syncComplete:true,syncOutcome:'NO_NEW_DATA_SUCCESS',users:0,failed:0};}};
 const options={db,request:value,environment,env:{timezone:'Asia/Taipei',dryRun:true,maxUserConcurrency:1},keys:fixtureKeys,deps};
 const original=await runExecutionPhase({...options,signal:controller.signal});
 // Ensure the outstanding SQL transport has finished its definite COMMIT.
 await sleep(120);
 const retry=await runExecutionPhase(options);
 console.log(JSON.stringify({probe:'HTTP-phase-and-retry',original,retry,transport:transport.evidence}));
 assert.equal(original.body.ok,false);assert.equal(original.body.result.outcome,'CANCELLED');
 assert.equal(retry.body.syncComplete,false,'a cancelled original invocation must not mint cached successful authorization');
 assert.equal(retry.body.handoff,undefined);
});
