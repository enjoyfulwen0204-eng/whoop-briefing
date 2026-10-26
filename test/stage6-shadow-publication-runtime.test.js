import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {residualFixture,fixtureKeys} from './stage6JournalBoundaryFixture.js';
import {createDb} from '../src/db.js';
import {runExecutionPhase} from '../src/phase4Execution.js';
import {configurationProof,reconcileExecution} from '../src/phase4ExecutionStore.js';
import {publicBetaConfiguration} from '../src/publicBetaConfig.js';
import {runningReleaseSha} from '../src/phase4Release.js';
import {OWNER_PILOT_APPROVAL_SHA256} from '../src/betaPilotAllowance.js';
import {stage6CapacityStatus} from '../src/stage6CapacityRuntime.js';
import {verifyCurrentRuntimeProof} from './stage6RuntimeCurrentProof.mjs';

for(const attack of ['NONE','CONTENT','SOURCE_GENERATION','OWNER','CONTEXT','ACK_LOSS'])
 test(`actual schema34 SHADOW publication keeps original guards and authority: ${attack}`,{timeout:120000},async t=>{
  // Current v33 transition admission requires SHADOW OFF. Qualify the lawful
  // future schema34 path without weakening that production activation gate.
  const f=await residualFixture(t,{targetVersion:34});
  f.transport.setTransactionMaxMs(5000);
  let armed=false,injected=false,request,packedGuards=0,packedRows=0;
  const fetch=async r=>{
   const body=await r.clone().json(),steps=body.requests.flatMap(q=>q.batch?.steps??[]);
   const packed=steps.filter(s=>s.stmt?.sql?.includes('json_each(?) AS __stage6_expected'));
   if(packed.length){
    packedGuards+=packed.length;packedRows+=packed.reduce((n,s)=>n+JSON.parse(s.stmt.args[0].value).length,0);
    if(armed&&!injected&&['CONTENT','SOURCE_GENERATION','OWNER','CONTEXT'].includes(attack)){
     injected=true;
     if(attack==='CONTENT')await f.db.raw.execute("UPDATE whoop_cycles SET strain=strain+0.000000000001 WHERE user_id='a' AND id='cycle-current'");
     if(attack==='SOURCE_GENERATION')await f.db.raw.execute("UPDATE phase4_user_state SET source_generation=source_generation+1 WHERE user_id='a'");
     if(attack==='OWNER')await f.db.raw.execute({sql:"UPDATE phase4_executions SET owner='synthetic-revoked-owner' WHERE execution_id=?",args:[request.requestId]});
     if(attack==='CONTEXT')await f.db.raw.execute("DELETE FROM resource_locks WHERE name LIKE 'p4ctx:%:short:%'");
    }
   }
   return f.syntheticFetch(r);
  };
  let db=createDb({url:'https://isolated.invalid',phase4Keys:fixtureKeys,fetch});t.after(()=>db.close());
  const environment={PHASE4_BETA_SHADOW_RUNTIME:'on',PHASE4_PUBLIC_BETA_MODE:'off',PHASE4_BETA_PILOT_ID:'a'.repeat(64),PHASE4_BETA_PILOT_USER_ID:'a',PHASE4_BETA_PILOT_START_AT:new Date(Date.now()-1000).toISOString(),PHASE4_BETA_PILOT_CONSENT_SHA256:'b'.repeat(64),PHASE4_BETA_PILOT_ALLOWANCE_ID:OWNER_PILOT_APPROVAL_SHA256};
  const releaseSha=runningReleaseSha(environment),configProof=configurationProof(fixtureKeys,publicBetaConfiguration(environment),environment,releaseSha);
  const req=(phase,extra={})=>({requestId:randomUUID(),releaseSha,phase,triggerSource:'manual',executionMode:'SHADOW',configProof,...extra});
  const options=()=>({db,keys:fixtureKeys,environment,env:{timezone:'Asia/Taipei',dryRun:true,maxUserConcurrency:1,telegramBotToken:'SYNTHETIC',telegramChatId:'SYNTHETIC'}});
  const syncRequest=req('SYNC'),sync=await runExecutionPhase({...options(),request:syncRequest,deps:{runBriefing:async()=>({syncComplete:true,syncOutcome:'NO_NEW_DATA_SUCCESS',users:0,failed:0})}});assert.equal(sync.body.drainAuthorized,true);
  request=req('STAGE6_DRAIN',{syncRequestId:syncRequest.requestId,handoff:sync.body.handoff});
  const before=await f.jobs();armed=true;if(attack==='NONE')f.setLatency(115);
  if(attack==='ACK_LOSS')f.transport.arm({matchSql:/json_each\(\?\) AS __stage6_expected/,loseAcknowledgement:true});
  // The actual runtime constructs the branded permit and capacity worker.
  // No test prototype, injected worker, overridden budget or real provider is used.
  const start=performance.now(),result=await runExecutionPhase({...options(),request}),executionMs=performance.now()-start;f.setLatency(0);
  assert.ok(packedGuards>0,'must execute the changed production-source SQL');
  assert.equal(stage6CapacityStatus().active,false);assert.equal(f.transport.evidence.filter(e=>e.event==='transaction_timeout').length,0);
  if(['CONTENT','SOURCE_GENERATION','OWNER','CONTEXT'].includes(attack)){
   assert.equal(injected,true);assert.notEqual(result.body.ok,true,JSON.stringify(result));
   const after=await f.jobs();assert.deepEqual(after.map(j=>j.full_scan_cursor),before.map(j=>j.full_scan_cursor));assert.equal((await f.counts()).domain,0);
  }else if(attack==='ACK_LOSS'){
   assert.equal(result.body.result.outcome,'COMMIT_INDETERMINATE');const reconciled=await reconcileExecution(db,request);assert.equal(reconciled.state,'WORK_COMMITTED_UNFINALIZED');assert.ok(reconciled.receipts.length>0);
   await db.close();db=createDb({url:'https://isolated.invalid',phase4Keys:fixtureKeys,fetch});
   const deadline=(await db.raw.execute({sql:'SELECT deadline_at FROM phase4_executions WHERE execution_id=?',args:[request.requestId]})).rows[0].deadline_at;
   while(Date.now()<=deadline)await new Promise(resolve=>setTimeout(resolve,Math.min(1000,deadline-Date.now()+10)));
   const recovered=await runExecutionPhase({...options(),request});assert.equal(recovered.body.result.settlementState,'FINALIZED_SUCCESS');assert.equal(recovered.body.result.stopReason,'RECONCILIATION_ONLY');assert.deepEqual(await runExecutionPhase({...options(),request}),recovered);
  }else{
   assert.equal(result.body.ok,true,JSON.stringify(result));assert.ok(result.body.result.itemsProcessed||result.body.result.unitsCommitted||result.body.result.jobsCompleted);
   assert.equal(result.body.result.settlementState,'FINALIZED_SUCCESS');assert.deepEqual(await runExecutionPhase({...options(),request}),result);
   const fresh=async()=>{await db.close();db=createDb({url:'https://isolated.invalid',phase4Keys:fixtureKeys,fetch});};
   const proof=await verifyCurrentRuntimeProof(db,request.requestId,[]);assert.equal(proof.cursor.exactNamedAck,true);
   await fresh();assert.deepEqual(await verifyCurrentRuntimeProof(db,request.requestId,[]),proof);assert.deepEqual(await runExecutionPhase({...options(),request}),result);
   assert.ok(stage6CapacityStatus().lastPublication.transactionMs<5000);
  }
  console.log('SYNTHETIC_SCHEMA34_SHADOW_PUBLICATION '+JSON.stringify({attack,schema:34,addedRequestLatencyMs:attack==='NONE'?115:0,executionMs,elapsedMs:performance.now()-start,packedGuards,packedRows,avoidedRowStatements:packedRows-packedGuards,publication:attack==='NONE'?stage6CapacityStatus().lastPublication:undefined,outcome:result.body.result?.outcome,productionEvidence:false,linuxQualification:false,sixJobCompletion:false}));
 });
