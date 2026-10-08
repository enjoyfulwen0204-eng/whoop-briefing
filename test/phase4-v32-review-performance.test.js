import test from 'node:test';import assert from 'node:assert/strict';
import {fixture,request,claim,authority,fixtureKeys} from './v32ReviewFixture.js';
import {withDurableExecution,readWorkStep} from '../src/phase4ExecutionContext.js';
import {commitPhaseWork,finalizePhaseWork,reconcileExecution} from '../src/phase4ExecutionStore.js';
test('repaired v32 monotonic allocation, named receipt lookup, definite settlement and reconciliation timings',async t=>{
 const {db}=await fixture(t),execute=db.raw.execute;let latencyMs=0,queries=0;
 db.raw.execute=async q=>{queries++;if(latencyMs)await new Promise(resolve=>setTimeout(resolve,latencyMs));return execute(q);};
 const measure=async(kind,fn)=>{queries=0;const at=performance.now(),result=await fn();const durationMs=performance.now()-at;
  assert.ok(durationMs<10000,kind);console.log(JSON.stringify({measurement:kind,latencyMs,queries,durationMs}));return result;};
 for(latencyMs of [0,20,50,150]){
  const r=request(),c=await measure('execution_sequence_allocation',()=>claim(db,r));
  const context={claim:c,keys:fixtureKeys,pending:new Set(),authority};
  await withDurableExecution(context,()=>db.transaction(async()=>{await db.raw.execute("INSERT INTO telegram_state(key,value,updated_at) VALUES('perf_counter','1','2026-10-08') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1");return 1;},{workStep:'perf-counter'}));
  const receipt=await measure('deterministic_receipt_lookup',()=>withDurableExecution(context,()=>readWorkStep(db.raw,['named','perf-counter'])));assert.ok(receipt);
  await measure('definite_settlement',async()=>{await commitPhaseWork(db,r,c,{outcome:'NO_NEW_DATA_SUCCESS'},authority);return finalizePhaseWork(db,r,c,fixtureKeys,authority);});
  assert.equal((await measure('finalized_reconciliation',()=>reconcileExecution(db,r))).state,'FINALIZED_SUCCESS');
 }
});
