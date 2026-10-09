import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {deliveryFixture,fixtureKeys} from './deliveryDefaultFixture.js';import {makeDataset} from './fixtures.js';
import {claimPhaseRequest,canonicalPhaseRequest} from '../src/phase4ExecutionStore.js';import {runningReleaseSha} from '../src/phase4Release.js';
import {withDurableExecution} from '../src/phase4ExecutionContext.js';import {createExecutionBudget,withExecutionBudget} from '../src/executionBudget.js';import {createReconciler} from '../src/reconcile.js';import {createSync} from '../src/sync.js';
test('same-request partial reconciliation persists the next page instead of replaying the first page receipt',async t=>{
 const {db}=await deliveryFixture(t);await db.createUser({id:'alice',displayName:'Alice',status:'ACTIVE'});
 await db.getCapabilities('alice');
 const request={releaseSha:runningReleaseSha(),requestId:randomUUID(),phase:'SYNC',triggerSource:'cloudflare',executionMode:'OFF',configProof:'a'.repeat(64)};
 const claim=await claimPhaseRequest(db,request,canonicalPhaseRequest(request)),authority=createExecutionBudget({budgetMs:10000});t.after(()=>authority.close());
 const now=new Date(),rows=makeDataset({now,days:2,withNaps:false}).sleeps,seen=[];
 const whoop={apiGet:async(_path,q)=>{seen.push(q.nextToken??null);return q.nextToken?{records:[rows[1]],next_token:null}:{records:[rows[0]],next_token:'next-page'};}};
 const run=ownerId=>withDurableExecution({claim,keys:fixtureKeys,pending:new Set(),authority},()=>createReconciler({db,whoop,userId:'alice',timezone:'Asia/Taipei',expectedLifecycleGeneration:1,maxPagesPerRun:1,ownerId}).reconcileResource('sleep'));
 const first=await run('first');assert.equal(first.result,'PARTIAL');
 assert.equal((await db.getReconciliationState('alice','sleep')).continuationToken,'next-page');
 const second=await run('second');assert.equal(second.result,'SUCCESS');assert.deepEqual(seen,[null,'next-page']);
 const stored=(await db.raw.execute("SELECT id FROM whoop_sleeps WHERE user_id='alice' ORDER BY id")).rows.map(r=>r.id);
 assert.deepEqual(stored,rows.map(r=>r.id).sort());
 const state=await db.getReconciliationState('alice','sleep');assert.equal(state.continuationToken,null);assert.equal(state.continuationFrom,null);
});
test('authorization changes after provider response fence the old fragment before canonical persistence',async t=>{
 const {db}=await deliveryFixture(t);await db.createUser({id:'alice',displayName:'Alice',status:'ACTIVE',timezone:'Asia/Taipei'});
 await db.getCapabilities('alice');
 const request={releaseSha:runningReleaseSha(),requestId:randomUUID(),phase:'SYNC',triggerSource:'cloudflare',executionMode:'OFF',configProof:'a'.repeat(64)};
 const claim=await claimPhaseRequest(db,request,canonicalPhaseRequest(request)),authority=createExecutionBudget({budgetMs:10000});t.after(()=>authority.close());
 const mutate=db.mutateForReconciliation;let changed=false;
 db.mutateForReconciliation=async(...args)=>{
  if(!changed){changed=true;await db.saveTokens('alice',{accessToken:'synthetic-new-auth',refreshToken:'synthetic-new-refresh',expiresAt:new Date(Date.now()+3600000),whoopUserId:'synthetic-new-subject'});}
  return mutate(...args);
 };
 const result=await withDurableExecution({claim,keys:fixtureKeys,pending:new Set(),authority},()=>createReconciler({db,userId:'alice',timezone:'Asia/Taipei',expectedLifecycleGeneration:1,
  whoop:{bodyMeasurement:async()=>({height_meter:1.7,weight_kilogram:70})}}).reconcileResource('body_measurement'));
 assert.equal(changed,true);assert.equal(result.result,'FENCED');
 assert.equal((await db.raw.execute("SELECT count(*) n FROM whoop_body_measurements WHERE user_id='alice'")).rows[0].n,0);
});
test('incremental SYNC rejects the old authorization fragment and starts zero later resource requests',async t=>{
 const {db}=await deliveryFixture(t);await db.createUser({id:'alice',displayName:'Alice',status:'ACTIVE',timezone:'Asia/Taipei'});await db.getCapabilities('alice');
 const request={releaseSha:runningReleaseSha(),requestId:randomUUID(),phase:'SYNC',triggerSource:'cloudflare',executionMode:'OFF',configProof:'a'.repeat(64)};
 const claim=await claimPhaseRequest(db,request,canonicalPhaseRequest(request)),authority=createExecutionBudget({budgetMs:10000});t.after(()=>authority.close());let laterCalls=0;
 const result=await withDurableExecution({claim,keys:fixtureKeys,pending:new Set(),authority},()=>withExecutionBudget(authority,()=>createSync({db,userId:'alice',timezone:'Asia/Taipei',expectedLifecycleGeneration:1,
  whoop:{bodyMeasurement:async()=>{await db.saveTokens('alice',{accessToken:'synthetic-new-auth',refreshToken:'synthetic-new-refresh',expiresAt:new Date(Date.now()+3600000),whoopUserId:'synthetic-new-subject'});return {height_meter:1.7,weight_kilogram:70};},sleeps:async()=>{laterCalls++;return [];}}
 }).syncAll({force:true,resources:['body_measurement','sleep']})));
 assert.equal(result.outcome,'AUTH_FAILED');assert.equal(result.complete,false);assert.equal(laterCalls,0);
 assert.equal((await db.raw.execute("SELECT count(*) n FROM whoop_body_measurements WHERE user_id='alice'")).rows[0].n,0);
});
for(const boundary of ['empty-response','before-settlement','receipt-replay','before-next-page'])test(`reconciliation input authority covers ${boundary}`,async t=>{
 const {db}=await deliveryFixture(t);await db.createUser({id:'alice',displayName:'Alice',status:'ACTIVE',timezone:'Asia/Taipei'});await db.getCapabilities('alice');
 await db.saveTokens('alice',{accessToken:'synthetic-before',refreshToken:'synthetic-before',expiresAt:new Date(Date.now()+3600000),whoopUserId:'12345'});
 const request={releaseSha:runningReleaseSha(),requestId:randomUUID(),phase:'SYNC',triggerSource:'cloudflare',executionMode:'OFF',configProof:'a'.repeat(64)};
 const claim=await claimPhaseRequest(db,request,canonicalPhaseRequest(request)),authority=createExecutionBudget({budgetMs:10000});t.after(()=>authority.close());
 const now=new Date(),data=makeDataset({now,days:1,withNaps:false}).sleeps;let changed=false,requests=0,inject=boundary!=='receipt-replay';
 const bump=async()=>{changed=true;await db.saveTokens('alice',{accessToken:'synthetic-after',refreshToken:'synthetic-after',expiresAt:new Date(Date.now()+3600000),whoopUserId:'12345'}, {bumpAuthGeneration:true,expectedLifecycleGeneration:1});};
 const whoop={apiGet:async()=>{requests++;if(inject&&boundary!=='before-settlement')await bump();return {records:boundary==='empty-response'?[]:data,next_token:boundary==='before-next-page'?'next':null};}};
 const settle=db.settleReconciliation;db.settleReconciliation=async(...args)=>{if(inject&&boundary==='before-settlement'&&!changed)await bump();return settle(...args);};
 const run=ownerId=>withDurableExecution({claim,keys:fixtureKeys,pending:new Set(),authority},()=>createReconciler({db,whoop,userId:'alice',timezone:'Asia/Taipei',expectedLifecycleGeneration:1,ownerId})
  .reconcileResource('sleep',{explicitWindow:{from:new Date(now.getTime()-2*86400000),to:now}}));
 if(boundary==='receipt-replay'){assert.equal((await run('first')).result,'SUCCESS');inject=true;}
 const result=await run('successor');assert.equal(changed,true);assert.equal(result.result,'FENCED');
 const state=await db.getReconciliationState('alice','sleep');assert.equal(state.lastSuccessAt,null,'explicit windows and fenced observations cannot advance success currentness');
 if(boundary==='before-next-page')assert.equal(requests,1,'authorization loss must stop the second page');
 if(boundary==='empty-response')assert.equal((await db.raw.execute("SELECT count(*) n FROM whoop_sleeps WHERE user_id='alice'")).rows[0].n,0);
});
test('replayed canonical effect clears each successor resource lease before returning SUCCESS',async t=>{
 const {db}=await deliveryFixture(t);await db.createUser({id:'alice',displayName:'Alice',status:'ACTIVE',timezone:'Asia/Taipei'});await db.getCapabilities('alice');
 const request={releaseSha:runningReleaseSha(),requestId:randomUUID(),phase:'SYNC',triggerSource:'cloudflare',executionMode:'OFF',configProof:'a'.repeat(64)},claim=await claimPhaseRequest(db,request,canonicalPhaseRequest(request));
 const authority=createExecutionBudget({budgetMs:10000});t.after(()=>authority.close());const now=new Date(),data=makeDataset({now,days:1,withNaps:false}).sleeps;
 for(const ownerId of ['first','successor','third']){
  const result=await withDurableExecution({claim,keys:fixtureKeys,pending:new Set(),authority},()=>createReconciler({db,userId:'alice',timezone:'Asia/Taipei',expectedLifecycleGeneration:1,ownerId,whoop:{apiGet:async()=>({records:data,next_token:null})}})
   .reconcileResource('sleep',{explicitWindow:{from:new Date(now.getTime()-2*86400000),to:now}}));
  assert.equal(result.result,'SUCCESS');assert.equal((await db.getReconciliationState('alice','sleep')).owner,null);
 }
 assert.equal((await db.raw.execute("SELECT count(*) n FROM whoop_sleeps WHERE user_id='alice'")).rows[0].n,1);
});
