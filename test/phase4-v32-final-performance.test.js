import test from 'node:test';import assert from 'node:assert/strict';
import {fixture,request,claim,authority,fixtureKeys} from './v32ReviewFixture.js';
import {readWorkStep,withDurableExecution} from '../src/phase4ExecutionContext.js';
import {commitPhaseWork,reconcileExecution} from '../src/phase4ExecutionStore.js';
test('final blocker impact: bounded admission, indexed receipt lookup, deterministic step, expiry transition and lost-ACK reconciliation',async t=>{
 const {db,transport}=await fixture(t);await db.createUser({id:'perf',displayName:'Synthetic',timezone:'Asia/Taipei',status:'ACTIVE'});
 await db.raw.execute("INSERT INTO user_notification_preferences(user_id,preference_version,created_at,updated_at) VALUES('perf',1,'2026-10-08','2026-10-08')");
 const execute=db.raw.execute;let latency=0,queries=0;
 db.raw.execute=async(...args)=>{queries++;if(latency)await new Promise(r=>setTimeout(r,latency));return execute(...args);};
 const measured=async(name,call)=>{queries=0;const start=performance.now(),result=await call();console.log(JSON.stringify({measurement:name,latencyMs:latency,queries,durationMs:performance.now()-start}));return result;};
 for(latency of [0,20,50,150]){
  await measured('v32_admission',()=>db.admitRuntime({fresh:true}));assert.equal(queries,5);
  const r=request(),c=await claim(db,r),ctx={claim:c,keys:fixtureKeys,pending:new Set(),authority};
  await measured('deterministic_work_step',()=>withDurableExecution(ctx,()=>db.transaction(async()=>{await db.raw.execute("UPDATE user_notification_preferences SET preference_version=preference_version+1 WHERE user_id='perf'");return 1;},{workStep:'performance-step'})));
  await measured('receipt_lookup',()=>withDurableExecution(ctx,()=>db.transaction(()=>readWorkStep(db.raw,['named','performance-step']),{readOnly:true})));
  await measured('expiry_enforced_transition',()=>commitPhaseWork(db,r,c,{outcome:'NO_NEW_DATA_SUCCESS'},authority));
  const second=request(),owner=await claim(db,second),lost={claim:owner,keys:fixtureKeys,pending:new Set(),authority};
  transport.arm({matchSql:/UPDATE user_notification_preferences/,loseAcknowledgement:true});
  await assert.rejects(()=>measured('lost_ack_work_step',()=>withDurableExecution(lost,()=>db.transaction(async()=>{await db.raw.execute("UPDATE user_notification_preferences SET preference_version=preference_version+1 WHERE user_id='perf'");return 1;},{workStep:'lost-performance-step'}))),/COMMIT_INDETERMINATE/);
  const reconciled=await measured('lost_ack_reconciliation',()=>reconcileExecution(db,second));assert.equal(reconciled.state,'WORK_COMMITTED_UNFINALIZED');
 }
});
