import test from 'node:test';import assert from 'node:assert/strict';
import {setup,env,deferred} from './review-fixture.mjs';
import {createStage8Runtime} from '../unattended-d9e-checkout/src/stage8Runtime.js';
import {createStage8ContinuationLoop} from '../unattended-d9e-checkout/src/stage8ContinuationLoop.js';
import {canonicalJson} from '../unattended-d9e-checkout/src/phase4EntityStore.js';
const sign=(keys,v)=>keys.lookup(['stage8-post-sync-metadata-v1',canonicalJson(v)]);
async function metadata(f){const rows=(await f.db.raw.execute("SELECT key,value FROM telegram_state WHERE key LIKE 'stage8:sync-%' ORDER BY key")).rows;const subject=rows.find(r=>r.key.startsWith('stage8:sync-subject:')),progress=rows.find(r=>r.key.startsWith('stage8:sync-progress:'));assert.ok(subject);assert.ok(progress);return {subject,progress,value:JSON.parse(subject.value)};}
async function unchanged(f,fn){const before=await f.counts();await fn();assert.deepEqual(await f.counts(),before);}

test('real signed parent discovery fails closed on metadata, receipt, scope, owner and exact-age counterexamples',async t=>{
 const f=await setup(t),m=await metadata(f);
 for(const [name,key,raw] of [['subject HMAC',m.subject.key,JSON.stringify({...JSON.parse(m.subject.value),hmac:'0'.repeat(64)})],['progress HMAC including fake done',m.progress.key,JSON.stringify({...JSON.parse(m.progress.value),done:true})],['invalid progress ordinal',m.progress.key,(()=>{const p={ordinal:64,done:false};return canonicalJson({...p,hmac:sign(f.keys,{progressKey:m.progress.key,...p})});})()],['oversized progress',m.progress.key,'x'.repeat(2049)]])await t.test(name,async()=>{
  const prior=await f.db.getState(key);await f.db.setState(key,raw);try{await unchanged(f,()=>assert.rejects(f.app.analysis.resume(),/FINALIZED_SYNC_REQUIRED/));}finally{await f.db.setState(key,prior);}
 });
 await t.test('authentic subject with missing named receipt cannot produce',async()=>{
  const receipt=(await f.db.raw.execute({sql:'SELECT * FROM phase4_execution_work_receipts WHERE receipt_key=?',args:[m.value.receipt]})).rows[0];assert.ok(receipt);
  await f.db.raw.execute({sql:'DELETE FROM phase4_execution_work_receipts WHERE receipt_key=?',args:[m.value.receipt]});
  try{await unchanged(f,()=>assert.rejects(f.app.analysis.resume(),/FINALIZED_SYNC_REQUIRED/));}finally{const cols=Object.keys(receipt);await f.db.raw.execute({sql:`INSERT INTO phase4_execution_work_receipts(${cols.join(',')}) VALUES(${cols.map(()=>'?').join(',')})`,args:cols.map(k=>receipt[k])});}
 });
 await t.test('same signed subject is stale after source snapshot changes',async()=>{
  await f.db.raw.execute("UPDATE phase4_user_state SET source_generation=source_generation+1 WHERE user_id='a'");
  try{await unchanged(f,async()=>assert.deepEqual(await f.app.analysis.resume(),{status:'IDLE',invoked:0}));}finally{await f.db.raw.execute("UPDATE phase4_user_state SET source_generation=source_generation-1 WHERE user_id='a'");}
 });
 await t.test('parent generation changes after lock ACK before first run fence',async()=>{
  const acquire=f.db.acquireLock;let ownerReturned=false;
  f.db.acquireLock=async function(...args){const owner=await acquire.apply(this,args);if(owner&&!ownerReturned){ownerReturned=true;await f.db.raw.execute({sql:'UPDATE phase4_executions SET generation=generation+1 WHERE execution_id=?',args:[f.parent.requestId]});}return owner;};
  try{await unchanged(f,()=>assert.rejects(f.app.analysis.resume(),/FINALIZED_SYNC_REQUIRED/));assert.equal(ownerReturned,true);}finally{f.db.acquireLock=acquire;if(ownerReturned)await f.db.raw.execute({sql:'UPDATE phase4_executions SET generation=generation-1 WHERE execution_id=?',args:[f.parent.requestId]});}
 });
 await t.test('another subject lock owner prevents any child execution',async()=>{
  const name='stage8:live-subject:'+f.keys.lookup(['stage8-live-subject-lock-v1','a']),owner=await f.db.acquireLock(name,{ttlMs:60000});assert.ok(owner);
  try{await unchanged(f,async()=>assert.deepEqual(await f.app.analysis.resume(),{status:'BUSY',invoked:1}));}finally{await f.db.releaseLock(name,owner);}
 });
 await t.test('exact original created+15min has no candidate and no renewed deadline',async()=>{
  const row=(await f.db.raw.execute({sql:'SELECT created_at FROM phase4_executions WHERE execution_id=?',args:[f.parent.requestId]})).rows[0],now=Date.now;Date.now=()=>row.created_at+15*60000;
  try{await unchanged(f,async()=>assert.deepEqual(await f.app.analysis.resume(),{status:'IDLE',invoked:0}));}finally{Date.now=now;}
 });
});

test('real ordinal63 work is spent; local suppression and recreated runtime never create ordinal64 or duplicate receipts',async t=>{
 const f=await setup(t),m=await metadata(f),p={ordinal:63,done:false};await f.db.setState(m.progress.key,canonicalJson({...p,hmac:sign(f.keys,{progressKey:m.progress.key,...p})}));
 const first=await f.app.analysis.resume();assert.equal(first.status,'EXHAUSTED');assert.equal(first.invoked,1);const after=await f.counts();
 assert.equal(JSON.parse(await f.db.getState(m.progress.key)).ordinal,63);
 assert.deepEqual(await f.app.analysis.resume(),{status:'IDLE',invoked:0});assert.deepEqual(await f.counts(),after);
 const restarted=await createStage8Runtime({...f,environment:f.environment,env});assert.equal((await restarted.analysis.resume()).status,'EXHAUSTED');assert.deepEqual(await f.counts(),after);assert.equal(f.syncs(),1);assert.equal(after.phase4_executions,1);
});

test('shutdown must join an outstanding genuine candidate metadata ACK after discovery budget expires',async t=>{
 const f=await setup(t),get=f.db.getState,entered=deferred(),release=deferred(),actualDone=deferred();let gate=false,ackSettled=false;
 f.db.getState=async function(key){const value=await get.call(this,key);if(!gate&&key.startsWith('stage8:sync-subject:')){gate=true;entered.resolve();try{await release.promise;}finally{ackSettled=true;actualDone.resolve();}}return value;};
 let scheduled;const observed=[];const loop=createStage8ContinuationLoop({timers:{set(fn){scheduled=fn;return 1;},clear(){scheduled=null;}},resume:()=>f.app.analysis.resume(),onError:e=>observed.push(e.code)});
 loop.start();const tick=scheduled;scheduled=null;tick();await entered.promise;const at=Date.now();
 try{await loop.stop();console.log('INDEPENDENT_DISCOVERY_JOIN_COUNTEREXAMPLE',JSON.stringify({stopElapsedMs:Date.now()-at,metadataAckStillOutstanding:!ackSettled,observed}));assert.equal(ackSettled,true,'loop.stop returned while its candidate metadata ACK was still outstanding');}
 finally{release.resolve();await actualDone.promise;await new Promise(r=>setImmediate(r));f.db.getState=get;}
});
