import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {deliveryFixture,fixtureKeys} from './deliveryDefaultFixture.js';
import {readOnlyProcessingCheck} from '../src/processingTransaction.js';
import {createExecutionBudget,withExecutionBudget} from '../src/executionBudget.js';
import {runExecutionPhase} from '../src/phase4Execution.js';
import {canonicalPhaseRequest,configurationProof,readExecution} from '../src/phase4ExecutionStore.js';
import {runningReleaseSha} from '../src/phase4Release.js';
import {createBriefingEndpoint} from '../src/briefingEndpoint.js';
import {signTriggerRequest} from '../src/briefingTriggerAuth.js';

for(const cancel of [false,true])test(`synchronous read-check rejection settles in-flight installed HTTP reads before rollback (cancellation=${cancel})`,async t=>{
 const {db}=await deliveryFixture(t);await db.admitRuntime();let settled=false,entered=false,after=false;
 const controller=new AbortController(),budget=createExecutionBudget({budgetMs:5000,signal:controller.signal});t.after(()=>budget.close());
 const sibling=readOnlyProcessingCheck(async client=>{if(!client)return;try{await client.execute('SELECT 11 value');}finally{await new Promise(resolve=>setTimeout(resolve,40));settled=true;}});
 const failure=readOnlyProcessingCheck(client=>{if(!client)return;if(cancel)controller.abort();throw Error('SYNC_DECLARED_CHECK_REJECTED');});
 await assert.rejects(()=>withExecutionBudget(budget,()=>db.withRuntimeFence(sibling,()=>db.withRuntimeFence(failure,()=>db.transaction(async()=>{
  entered=true;await db.raw.execute("INSERT INTO telegram_state(key,value,updated_at) VALUES('forbidden_after_read','1','2026-10-11')");
 },{after:()=>{after=true;}})))),cancel?e=>e.code==='SYNC_CANCELLED':/SYNC_DECLARED_CHECK_REJECTED/);
 assert.equal(settled,true,'rollback/rejection cannot leave a sibling read in flight');assert.equal(entered,false);assert.equal(after,false);
 assert.equal((await db.raw.execute("SELECT COUNT(*) n FROM telegram_state WHERE key='forbidden_after_read'")).rows[0].n,0);
 await db.transaction(()=>db.raw.execute('SELECT 22 value'));
});

for(const status of ['telegram_failed','delivery_ambiguous'])test(`authenticated actual aggregation and v32 settlement deny full SYNC after ${status} and preserve old ACK/dedupe`,async t=>{
 const {db}=await deliveryFixture(t);await db.createUser({id:'alice',displayName:'Synthetic',status:'ACTIVE',timezone:'Asia/Taipei'});
 await db.linkTelegram({userId:'alice',chatId:'1001'});await db.setLocale('alice','en');await db.ensureOnboarding('alice',{state:'READY'});
 for(const [updateId,state] of [[71,'DELIVERED'],[72,'AMBIGUOUS']])await db.raw.execute({sql:'INSERT INTO telegram_operations(update_id,result_json,committed_at,delivery_state) VALUES(?,?,?,?)',args:[updateId,'{}',new Date().toISOString(),state]});
 const old=(await db.raw.execute('SELECT * FROM telegram_operations ORDER BY update_id')).rows;
 const environment={PHASE4_BETA_SHADOW_RUNTIME:'off',PHASE4_PUBLIC_BETA_MODE:'off',BRIEFING_CONTINUATION_SCOPE:'sync'},releaseSha=runningReleaseSha();
 const request={releaseSha,requestId:`p4s1_${randomUUID()}`,phase:'SYNC',triggerSource:'cloudflare',executionMode:'OFF',configProof:configurationProof(fixtureKeys,{runtime:'off',mode:'off'},environment)},body=canonicalPhaseRequest(request),secret='synthetic-review-negative-control-secret-32bytes';let users=0;
 const endpoint=createBriefingEndpoint({secret,environment,runPhase:options=>runExecutionPhase({...options,db,keys:fixtureKeys,environment,
  env:{dryRun:true,maxUserConcurrency:1,timezone:'Asia/Taipei',telegramBotToken:'synthetic',telegramChatId:'synthetic',repoLastCommitAt:new Date().toISOString()},
  deps:{drainWebhook:async()=>({claimed:0,processed:0,ignored:0,retryable:0,failed:0,remaining:0,budgetExhausted:false}),resumeOnboarding:async()=>[],guardian:async()=>null,
   runUser:async()=>{users++;return {errors:[],daily:{status},weekly:{status:'already_sent'},sync:{outcome:'COMPLETE_SUCCESS',complete:true,resources:[{resource:'sleep',status:'ok'}]}};}}})});
 const send=(bodyText=body,signedId=request.requestId,invalidSignature=false)=>{const timestamp=String(Date.now()),path='/internal/briefing/run';return endpoint({method:'POST',url:path,headers:{'content-type':'application/json','x-briefing-request-id':signedId,'x-briefing-timestamp':timestamp,'x-briefing-signature':invalidSignature?'v1=invalid':signTriggerRequest({timestamp,requestId:signedId,method:'POST',path,body:bodyText},secret)}},bodyText);};
 assert.equal((await send(body,request.requestId,true)).status,401);assert.equal(users,0);
 const reply=await send();assert.equal(reply.status,207);assert.equal(reply.body.syncComplete,false);assert.equal(reply.body.drainAuthorized,false);assert.equal(reply.body.handoff,undefined);assert.equal(reply.body.result.failed,1);assert.equal(reply.body.result.outcome,'PARTIAL');assert.equal(reply.body.result.yieldReason,undefined);assert.equal(reply.body.result.resumable,undefined);
 const row=await readExecution(db,request.requestId);assert.equal(row.state,'FINALIZED_FAILURE');const digest=row.result_digest;
 assert.deepEqual(await send(),reply);assert.equal(users,1,'same canonical authenticated retry never repeats ordinary report work');assert.equal((await readExecution(db,request.requestId)).result_digest,digest);
 assert.equal((await send(canonicalPhaseRequest({...request,configProof:'b'.repeat(64)}))).status,409);assert.equal((await send(body,randomUUID())).status,400);assert.equal(users,1);
 assert.deepEqual((await db.raw.execute('SELECT * FROM telegram_operations ORDER BY update_id')).rows,old,'preexisting delivered and ambiguous receipts remain immutable');
 assert.equal((await db.raw.execute('SELECT MAX(version) v FROM schema_version')).rows[0].v,32);
});
