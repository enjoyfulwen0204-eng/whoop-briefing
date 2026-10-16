import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {setup,env,deferred} from './review-fixture.mjs';
import {createStage8Runtime} from '../unattended-59cb-checkout/src/stage8Runtime.js';
import {createStage8ContinuationLoop} from '../unattended-59cb-checkout/src/stage8ContinuationLoop.js';
import {canonicalJson} from '../unattended-59cb-checkout/src/phase4EntityStore.js';
const sign=(keys,v)=>keys.lookup(['stage8-post-sync-metadata-v1',canonicalJson(v)]);
async function metadata(f){const rows=(await f.db.raw.execute("SELECT key,value FROM telegram_state WHERE key LIKE 'stage8:sync-%' ORDER BY key")).rows;const subject=rows.find(r=>r.key.startsWith('stage8:sync-subject:')),progress=rows.find(r=>r.key.startsWith('stage8:sync-progress:'));assert.ok(subject);assert.ok(progress);return {subject,progress,value:JSON.parse(subject.value)};}
async function protectedRows(f){const tables=['phase4_executions','phase4_jobs','phase4_computation_state','stage8_live_executions','stage8_live_execution_work_receipts','stage8_live_publications','outbound_messages'];return Object.fromEntries(await Promise.all(tables.map(async table=>[table,createHash('sha256').update(JSON.stringify((await f.db.raw.execute('SELECT * FROM '+table)).rows.map(r=>JSON.stringify(r)).sort())).digest('hex')])));}
async function unchanged(f,fn){const before=await protectedRows(f);await fn();assert.deepEqual(await protectedRows(f),before);}

test('real signed parent discovery fails closed on metadata, receipt, scope, owner and exact-age counterexamples',async t=>{
 const f=await setup(t),m=await metadata(f);
 for(const [name,key,raw] of [['subject HMAC',m.subject.key,JSON.stringify({...JSON.parse(m.subject.value),hmac:'0'.repeat(64)})],['progress HMAC including fake done',m.progress.key,JSON.stringify({...JSON.parse(m.progress.value),done:true})],['invalid progress ordinal',m.progress.key,(()=>{const p={ordinal:64,done:false};return canonicalJson({...p,hmac:sign(f.keys,{progressKey:m.progress.key,...p})});})()],['oversized progress',m.progress.key,'x'.repeat(2049)]])await t.test(name,async()=>{
  const prior=await f.db.getState(key);await f.db.setState(key,raw);try{await unchanged(f,()=>assert.rejects(f.app.analysis.resume(),/FINALIZED_SYNC_REQUIRED/));}finally{await f.db.setState(key,prior);}
 });
 await t.test('authentic HMAC subject pointing to nonexistent named receipt cannot produce',async()=>{
  const {hmac,...v}=JSON.parse(m.subject.value),bad={...v,receipt:'f'.repeat(64)};await f.db.setState(m.subject.key,canonicalJson({...bad,hmac:sign(f.keys,bad)}));
  try{await unchanged(f,()=>assert.rejects(f.app.analysis.resume(),/FINALIZED_SYNC_REQUIRED/));}finally{await f.db.setState(m.subject.key,m.subject.value);}
 });
 await t.test('original named receipts reject deletion by immutable DDL',async()=>{
  await unchanged(f,()=>assert.rejects(f.db.raw.execute({sql:'DELETE FROM phase4_execution_work_receipts WHERE receipt_key=?',args:[m.value.receipt]}),/p4_execution_receipt_no_delete/));
 });
 await t.test('same signed subject is stale after source snapshot changes',async()=>{
  await f.db.raw.execute("UPDATE phase4_user_state SET source_generation=source_generation+1 WHERE user_id='a'");
  try{await unchanged(f,async()=>assert.deepEqual(await f.app.analysis.resume(),{status:'IDLE',invoked:0}));}finally{await f.db.raw.execute("UPDATE phase4_user_state SET source_generation=source_generation-1 WHERE user_id='a'");}
 });
 await t.test('finalized parent generation cannot be mutated by existing DDL',async()=>{
  const before=(await f.db.raw.execute({sql:'SELECT * FROM phase4_executions WHERE execution_id=?',args:[f.parent.requestId]})).rows;
  await assert.rejects(f.db.raw.execute({sql:'UPDATE phase4_executions SET generation=generation+1 WHERE execution_id=?',args:[f.parent.requestId]}),/p4_execution_finalize_authority/);
  assert.deepEqual((await f.db.raw.execute({sql:'SELECT * FROM phase4_executions WHERE execution_id=?',args:[f.parent.requestId]})).rows,before);
 });
 await t.test('subject lock revoked after acquisition fences run before producer',async()=>{
  const acquire=f.db.acquireLock;let revoked=false;
  f.db.acquireLock=async function(...args){const owner=await acquire.apply(this,args);if(owner&&!revoked){revoked=true;await f.db.releaseLock(args[0],owner);}return owner;};
  try{await unchanged(f,()=>assert.rejects(f.app.analysis.resume(),/FINALIZED_SYNC_REQUIRED/));assert.equal(revoked,true);}finally{f.db.acquireLock=acquire;}
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

test('expired discovery retains BUSY and shutdown joins the actual metadata ACK before DB close',async t=>{
 const f=await setup(t),get=f.db.getState,entered=deferred(),release=deferred();let gate=false,ackSettled=false,stopped=false,metadataReads=0;
 const before=await f.counts(),beforeProtected=await protectedRows(f);
 f.db.getState=async function(key){metadataReads++;const value=await get.call(this,key);if(!gate&&key.startsWith('stage8:sync-subject:')){gate=true;entered.resolve();await release.promise;ackSettled=true;}return value;};
 let scheduled;const observed=[];const loop=createStage8ContinuationLoop({timers:{set(fn){scheduled=fn;return 1;},clear(){scheduled=null;}},resume:()=>f.app.analysis.resume(),onError:e=>observed.push(e.code)});
 loop.start();const tick=scheduled;scheduled=null;tick();await entered.promise;const stopping=loop.stop().then(()=>{stopped=true;});
 try{
  await new Promise(r=>setTimeout(r,5200));assert.equal(stopped,false);assert.equal(ackSettled,false);assert.deepEqual(await f.app.analysis.resume(),{status:'BUSY',invoked:0});
 }finally{release.resolve();await stopping;f.db.getState=get;}
 assert.equal(ackSettled,true);assert.equal(metadataReads,1,'late ACK cannot issue another metadata read');assert.deepEqual(observed,['SYNC_TIMEOUT']);assert.equal(scheduled,null);assert.deepEqual(await f.counts(),before);assert.deepEqual(await protectedRows(f),beforeProtected);
});
