import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {deliveryFixture,fixtureKeys} from './deliveryDefaultFixture.js';
import {claimPhaseRequest} from '../src/phase4ExecutionStore.js';
import {withDurableExecution} from '../src/phase4ExecutionContext.js';
import {createExecutionBudget} from '../src/executionBudget.js';
import {runningReleaseSha} from '../src/phase4Release.js';

async function context(t){
 const {db}=await deliveryFixture(t);
 await db.createUser({id:'alice',status:'ACTIVE',displayName:'Alice'});
 const request={requestId:randomUUID(),releaseSha:runningReleaseSha(),phase:'SYNC',triggerSource:'cloudflare',executionMode:'OFF',configProof:'a'.repeat(64)};
 const claim=await claimPhaseRequest(db,request,JSON.stringify(request),{deadlineAt:Date.now()+120000});
 const authority=createExecutionBudget({budgetMs:10000});t.after(()=>authority.close());
 return {db,run:fn=>withDurableExecution({claim,keys:fixtureKeys,pending:new Set(),authority},fn)};
}
test('a different reconciliation owner cannot replay a live lease grant',async t=>{
 const {db,run}=await context(t);
 const args={userId:'alice',resource:'sleep',leaseMs:60000,lifecycleGeneration:1};
 await run(async()=>{
  assert.equal(await db.claimReconciliation({...args,owner:'first'}),true);
  assert.equal(await db.claimReconciliation({...args,owner:'second'}),false);
 });
 assert.equal((await db.getReconciliationState('alice','sleep')).owner,'first');
});
test('an expired resource lease is actually acquired for the successor owner',async t=>{
 const {db,run}=await context(t);
 const args={userId:'alice',resource:'sleep',leaseMs:60000,lifecycleGeneration:1};
 await run(()=>db.claimReconciliation({...args,owner:'first'}));
 await db.raw.execute({sql:'UPDATE whoop_reconciliation_state SET lease_expires_at=? WHERE user_id=? AND resource=?',args:[new Date(Date.now()-1).toISOString(),'alice','sleep']});
 assert.equal(await run(()=>db.claimReconciliation({...args,owner:'second'})),true);
 assert.equal((await db.getReconciliationState('alice','sleep')).owner,'second');
 assert.equal(await db.holdsReconciliation({...args,owner:'first'}),false);
 assert.equal(await db.holdsReconciliation({...args,owner:'second'}),true);
});
test('same-owner replay checks the live lease instead of renewing expired authority',async t=>{
 const {db,run}=await context(t);
 const args={userId:'alice',resource:'sleep',leaseMs:60000,lifecycleGeneration:1,owner:'first'};
 assert.equal(await run(()=>db.claimReconciliation(args)),true);
 assert.equal(await run(()=>db.claimReconciliation(args)),true);
 const expired=new Date(Date.now()-1).toISOString();
 await db.raw.execute({sql:'UPDATE whoop_reconciliation_state SET lease_expires_at=? WHERE user_id=? AND resource=?',args:[expired,'alice','sleep']});
 assert.equal(await run(()=>db.claimReconciliation(args)),false);
 assert.equal((await db.getReconciliationState('alice','sleep')).leaseExpiresAt,expired);
});
