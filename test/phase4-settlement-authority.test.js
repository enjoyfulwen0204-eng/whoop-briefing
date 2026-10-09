import {createClient} from '@libsql/client';
import test from 'node:test';import assert from 'node:assert/strict';import {Hmac,randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createDb as privateDb} from '../src/db.js';import {hranaTransport} from './hranaTransport.js';
import {createOwnedDb} from './stage5OwnedDb.js';import {fixtureKeys} from './localDb.js';
import {runExecutionPhase} from '../src/phase4Execution.js';import {runningReleaseSha} from '../src/phase4Release.js';
import {createExecutionBudget,currentExecutionBudget} from '../src/executionBudget.js';
import {configurationProof,readPhaseProgress,claimPhaseRequest,settlePhaseRequest,recordPhaseEvent} from '../src/phase4ExecutionStore.js';
const environment={PHASE4_BETA_SHADOW_RUNTIME:'on',PHASE4_PUBLIC_BETA_MODE:'off'},env={timezone:'Asia/Taipei',dryRun:true,maxUserConcurrency:1};
const request=(phase='SYNC',extra={})=>({requestId:randomUUID(),releaseSha:runningReleaseSha(),phase,triggerSource:'manual',executionMode:'SHADOW',
 configProof:configurationProof(fixtureKeys,{runtime:'on',mode:'off'},environment),...extra});
const success=()=>({syncComplete:true,syncOutcome:'NO_NEW_DATA_SUCCESS',users:0,failed:0});
async function fixture(t){const dir=await mkdtemp(join(tmpdir(),'p4-settlement-')),url=`file:${join(dir,'isolated.db')}`,seed=createOwnedDb({url});
 await seed.migrate({targetVersion:32});await seed.close();const transport=hranaTransport(url),db=privateDb({url:'https://isolated.invalid',fetch:transport.fetch,phase4Keys:fixtureKeys});
 t.after(async()=>{db.close();transport.close();await rm(dir,{recursive:true,force:true});});db.isolatedFixtureUrl=url;return db;}
const run=(db,value,extra={})=>runExecutionPhase({db,request:value,environment,env,keys:fixtureKeys,deps:{runBriefing:success},...extra});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const denied=response=>{assert.equal(response.body.ok,false);assert.notEqual(response.body.syncComplete,true);assert.notEqual(response.body.drainAuthorized,true);assert.equal(response.body.handoff,undefined);};
test('R2 authority: overall expiry during admission starts no work or durable phase writes',async t=>{
 const db=await fixture(t),admit=db.admitRuntime;let work=0;db.admitRuntime=async(...a)=>{await pause(100);return admit(...a);};
 const r=await run(db,request(),{overallBudgetMs:50,deps:{runBriefing:async()=>{work++;return success();}}});denied(r);assert.equal(r.body.result.outcome,'TIMEOUT');
 await pause(140);assert.equal(work,0);assert.equal((await readPhaseProgress(db,'SYNC','manual')).state,'NOT_ENTERED');
});
test('R2 authority: overall expiry during WHOOP/tenant work cannot complete or authorize',async t=>{
 const db=await fixture(t);const r=await run(db,request(),{overallBudgetMs:100,deps:{runBriefing:async()=>{await pause(180);return success();}}});
 denied(r);assert.equal(r.body.result.outcome,'TIMEOUT');await pause(200);assert.notEqual((await readPhaseProgress(db,'SYNC','manual')).complete?.outcome,'NO_NEW_DATA_SUCCESS');
});
for(const attack of ['cancel','expire'])test(`R2 authority: ${attack} during handoff HMAC cannot survive settlement`,async t=>{
 const db=await fixture(t),controller=new AbortController(),update=Hmac.prototype.update;let armed=false,hit=false;
 Hmac.prototype.update=function(value,...args){if(armed&&String(value).includes('phase4-sync-handoff-v3')){hit=true;if(attack==='cancel')controller.abort();else{const end=currentExecutionBudget().deadlineAt+1;while(Date.now()<end){}}}return update.call(this,value,...args);};
 try{const r=await run(db,request(),{signal:controller.signal,budgetMs:5000,overallBudgetMs:2000,deps:{runBriefing:async()=>{armed=true;return success();}}});denied(r);assert.equal(hit,true);
 const progress=await readPhaseProgress(db,'SYNC','manual');assert.equal(progress.settlementState,'FINALIZED_SUCCESS','cancellation after finalized read is not retroactive rollback');}finally{Hmac.prototype.update=update;}
});
test('R2 authority: request generation lost after durable work cannot settle or release successor',async t=>{
 const db=await fixture(t),value=request();const r=await run(db,value,{deps:{runBriefing:async()=>{
 const other=createClient({url:db.isolatedFixtureUrl});try{
  await other.execute({sql:'UPDATE phase4_executions SET lease_until=?,deadline_at=? WHERE execution_id=?',args:[Date.now()-1,Date.now()-1,value.requestId]});
  await other.execute({sql:'UPDATE phase4_executions SET owner=?,generation=generation+1,lease_until=?,deadline_at=? WHERE execution_id=?',args:['successor',Date.now()+30000,Date.now()+30000,value.requestId]});
 }finally{other.close();}return success();}}});
 denied(r);assert.equal((await db.raw.execute({sql:'SELECT owner FROM phase4_executions WHERE execution_id=?',args:[value.requestId]})).rows[0].owner,'successor');
 assert.equal((await readPhaseProgress(db,'SYNC','manual')).complete,null);
});
for(const outcome of ['NO_WORK','PARTIAL','COMPLETE'])test(`R2 authority: Stage 6 ${outcome} cancellation before completion remains aborted with only durable counts`,async t=>{
 const db=await fixture(t),sync=request(),s=await run(db,sync),drain=request('STAGE6_DRAIN',{syncRequestId:sync.requestId,handoff:s.body.handoff});
 const controller=new AbortController(),execute=db.raw.execute;let injected=false;
 db.raw.execute=async stmt=>{const args=stmt?.args??[];if(!injected&&String(stmt?.sql).includes("SET state='WORK_COMMITTED'")&&args.some(a=>typeof a==='string'&&a.includes(`"outcome":"${outcome}"`))){
 injected=true;controller.abort();}return execute(stmt);};
 const worker={drain:async({onProgress})=>{await onProgress({event:'discovery_start'});await onProgress({event:'discovery_complete',jobsConsidered:outcome==='NO_WORK'?0:1});
 await onProgress({event:'drain_start'});return {outcome,jobsConsidered:1,itemsAttempted:outcome==='NO_WORK'?0:3,processedItems:outcome==='NO_WORK'?0:3,
 completedJobs:outcome==='COMPLETE'?1:0,remainingJobs:outcome==='PARTIAL'?1:0,completion:outcome==='PARTIAL'?'PARTIAL':'COMPLETE'};}};
 const r=await run(db,drain,{signal:controller.signal,deps:{runtime:{phase4Stage6:worker}}});assert.equal(injected,true);denied(r);
 const p=await readPhaseProgress(db,'STAGE6_DRAIN','manual');assert.equal(p.state,'RESUMABLE_PENDING');assert.equal(p.execution.abort_outcome,'CANCELLED');assert.notEqual(p.settlementState,'FINALIZED_SUCCESS');assert.equal(p.complete,null);
});
test('R2 authority: valid same-release success settles normally and emits one successful heartbeat',async t=>{
 const db=await fixture(t),value=request(),r=await run(db,value);assert.equal(r.body.ok,true);assert.equal(r.body.result.releaseSha,runningReleaseSha());
 assert.equal((await readPhaseProgress(db,'SYNC','manual')).state,'NO_NEW_DATA_SUCCESS');assert.deepEqual(await run(db,value),r);
});

test('R2 authority: nested settlement retains original authority through the outermost COMMIT',async t=>{
 const db=await fixture(t),value=request(),claim=await claimPhaseRequest(db,value,JSON.stringify(value)),controller=new AbortController();
 await recordPhaseEvent(db,{phase:'SYNC',releaseSha:value.releaseSha,source:'manual',event:'start',outcome:'PENDING',identity:claim.identity});
 const authority=createExecutionBudget({signal:controller.signal});
 try{await assert.rejects(()=>db.transaction(async()=>{
   await settlePhaseRequest(db,value,claim,{outcome:'NO_NEW_DATA_SUCCESS'},fixtureKeys,authority);controller.abort();
 }),/EXECUTION_SETTLEMENT_MUST_BE_ROOT/);assert.equal((await readPhaseProgress(db,'SYNC','manual')).complete,null);
 const stored=(await db.raw.execute({sql:'SELECT state FROM phase4_executions WHERE execution_id=?',args:[value.requestId]})).rows[0];
 assert.equal(stored.state,'ESTABLISHED');}finally{authority.close();}
});
test('R2 authority: helper lease expiry during settlement cannot commit heartbeat or handoff',async t=>{
 const db=await fixture(t),value=request(),claim=await claimPhaseRequest(db,value,JSON.stringify(value),{leaseMs:80}),execute=db.raw.execute;
 await recordPhaseEvent(db,{phase:'SYNC',releaseSha:value.releaseSha,source:'manual',event:'start',outcome:'PENDING',identity:claim.identity});
 let delayed=false;db.raw.execute=async stmt=>{if(!delayed&&String(stmt?.sql).includes("SET state='WORK_COMMITTED'")&&JSON.stringify(stmt?.args).includes('NO_NEW_DATA_SUCCESS')){
 delayed=true;await pause(120);}return execute(stmt);};const authority=createExecutionBudget({budgetMs:1000});
 try{await assert.rejects(()=>settlePhaseRequest(db,value,claim,{outcome:'NO_NEW_DATA_SUCCESS'},fixtureKeys,authority),/REQUEST_OWNER_FENCED/);
 assert.equal(delayed,true);assert.equal((await readPhaseProgress(db,'SYNC','manual')).complete,null);}finally{authority.close();}
});
