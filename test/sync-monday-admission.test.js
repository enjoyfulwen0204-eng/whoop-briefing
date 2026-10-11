import test from 'node:test';
import assert from 'node:assert/strict';
import {processingTransactions,readOnlyProcessingCheck,syncRuntimeProcessingCheck} from '../src/processingTransaction.js';
import {withDurableExecution} from '../src/phase4ExecutionContext.js';
import {createExecutionBudget,withExecutionBudget} from '../src/executionBudget.js';
import {syncShouldYield} from '../src/syncContinuation.js';
import {fixture} from './v32ReviewFixture.js';

const execution=()=>({claim:{request:{phase:'SYNC'}},receipts:false,pending:new Set(),authority:{assert(){}},
 syncContinuation:true,syncYieldReserveMs:30_000});
const ownerSql='SELECT 1 FROM resource_locks WHERE name=? AND owner=? AND expires_at=? AND expires_at>?';

test('a peer 30s yield records unfinished work while another original 15s boundary remains admitted',()=>{
 let clock=1000;const budget=createExecutionBudget({budgetMs:120_000,nowMs:()=>clock,startedAtMs:1000}),ctx=execution();
 try{withDurableExecution(ctx,()=>withExecutionBudget(budget,()=>{
  clock=1000+95_000;assert.equal(syncShouldYield(),true);assert.equal(ctx.syncYieldRequested,true);
  assert.equal(syncShouldYield({reserveMs:15_000}),false);assert.equal(ctx.syncYieldRequested,true,'pending work marker is retained');
  clock=1000+106_000;assert.equal(syncShouldYield({reserveMs:15_000}),true);
  assert.equal(ctx.syncYieldReserveReachedMs,15_000);assert.equal(syncShouldYield(),true);
  clock=1000+120_000;assert.throws(()=>syncShouldYield({reserveMs:15_000}),error=>error.code==='SYNC_TIMEOUT');
 }));}finally{budget.close();}
});
test('parent cancellation denies every smaller boundary and a fresh later leg uses its own live budget',()=>{
 const parent=new AbortController(),ctx=execution(),budget=createExecutionBudget({budgetMs:120_000,signal:parent.signal});
 try{ctx.syncYieldRequested=true;parent.abort();
  assert.throws(()=>withDurableExecution(ctx,()=>withExecutionBudget(budget,()=>syncShouldYield({reserveMs:15_000}))),e=>e.code==='SYNC_CANCELLED');
 }finally{budget.close();}
 const next=createExecutionBudget({budgetMs:120_000});
 try{assert.equal(withDurableExecution(execution(),()=>withExecutionBudget(next,()=>syncShouldYield())),false);}finally{next.close();}
});
test('expired parent authority always denies a smaller boundary even with remaining work time',()=>{
 const budget=createExecutionBudget({budgetMs:120_000}),ctx=execution();ctx.syncYieldRequested=true;
 ctx.authority={assert(){throw Object.assign(Error('PARENT_EXPIRED'),{code:'SYNC_TIMEOUT'});}};
 try{assert.throws(()=>withDurableExecution(ctx,()=>withExecutionBudget(budget,()=>syncShouldYield({reserveMs:15_000}))),e=>e.code==='SYNC_TIMEOUT');}
 finally{budget.close();}
});

function receiver({beginError,metadataError,lateMetadata,commitError,privateRuntime=true,phase='SYNC',runtimeFailure,unknownMetadata=false}={}){
 const events=[];let callbacks=0,opens=0,metadataCalls=0,batches=0;
 const base={protocol:'http',execute:async()=>({rows:[]}),transaction:async()=>{
  opens++;const tx={closed:false,execute:async statement=>{
   const sql=typeof statement==='string'?statement:statement.sql;events.push(sql);
   if(sql==='SELECT 1'){const error=typeof beginError==='function'?beginError():beginError;
    if(error){tx.closed=true;throw error;}return {rows:[]};}
   if(sql===ownerSql){metadataCalls++;await lateMetadata?.();if(metadataError)throw metadataError;return {rows:[{owner:1}]};}
   return {rows:[]};
  },commit:async()=>{events.push('COMMIT');if(commitError)throw commitError;},rollback:async()=>{events.push('ROLLBACK');},close(){this.closed=true;events.push('CLOSE');}};
  tx.batch=async statements=>{batches++;const rows=[];for(const statement of statements)rows.push(await tx.execute(statement));return rows;};return tx;
 }};
 const p=processingTransactions(base,{privateRuntime});
 const check=readOnlyProcessingCheck(async client=>{if(client)await client.execute(unknownMetadata?'SELECT unrelated_readonly':{sql:ownerSql,args:['synthetic','owner','expires','now']});});
 const work=before=>p.withFence(check,()=>p.transaction(async()=>{callbacks++;return 17;},{readOnly:true,before}));
 const run=before=>withDurableExecution({...execution(),claim:{request:{phase}}},()=>runtimeFailure
  ?p.withFence(syncRuntimeProcessingCheck(()=>{throw runtimeFailure;}),()=>work(before)):work(before));
 return {p,events,run,get callbacks(){return callbacks;},get opens(){return opens;},get metadataCalls(){return metadataCalls;},get batches(){return batches;}};
}
test('bundled BEGIN and original admission reads all acknowledge before business; unmarked before stays serial',async()=>{
 let release;const blocked=new Promise(resolve=>{release=resolve;});const f=receiver({lateMetadata:()=>blocked});
 const work=f.run();await new Promise(resolve=>setImmediate(resolve));assert.equal(f.callbacks,0);
 assert.deepEqual(f.events.slice(0,2),['SELECT 1',ownerSql]);release();assert.equal(await work,17);assert.equal(f.batches,1);
 assert.equal(f.callbacks,1);assert.equal(f.metadataCalls,2,'original entry and preCOMMIT owner observations remain');
 const g=receiver();await g.run(async()=>{g.events.push('UNMARKED_BEFORE');});
 assert.ok(g.events.indexOf('UNMARKED_BEFORE')>g.events.indexOf('SELECT 1'));
});
test('definite rejected initial BEGIN retries only fresh readonly admission, then enters business once',async()=>{
 let attempts=0;const busy=Object.assign(Error('BEGIN_BUSY'),{code:'SQLITE_BUSY'}),f=receiver({beginError:()=>++attempts===1?busy:null});
 assert.equal(await f.run(),17);assert.equal(f.opens,2);assert.equal(f.callbacks,1);assert.equal(f.metadataCalls,2);
});
test('unknown readonly first projection keeps separate ACK and original definite BEGIN retry',async()=>{
 let attempts=0;const busy=Object.assign(Error('BEGIN_BUSY'),{code:'SQLITE_BUSY'}),f=receiver({unknownMetadata:true,beginError:()=>++attempts===1?busy:null});
 assert.equal(await f.run(),17);assert.equal(f.opens,2);assert.equal(f.callbacks,1);assert.equal(f.batches,0);
});
for(const options of [{privateRuntime:false},{phase:'STAGE6_DRAIN'}])test('unowned receiver or non-SYNC phase retains original separate BEGIN acknowledgement',async()=>{
 const f=receiver(options);assert.equal(await f.run(),17);assert.equal(f.batches,0);assert.equal(f.callbacks,1);
});
test('BEGIN failure wins only after late metadata settles, without a business callback',async()=>{
 let settled=false;const first=Object.assign(Error('BEGIN_UNKNOWN'),{code:'SYNTHETIC_TRANSPORT_ERROR'}),second=Error('METADATA_FAILED');
 const f=receiver({beginError:first}),late=readOnlyProcessingCheck(async()=>{await new Promise(r=>setTimeout(r,5));settled=true;throw second;});
 await assert.rejects(f.run(late),e=>e===first);assert.equal(settled,true);assert.equal(f.callbacks,0);assert.equal(f.opens,1);
 assert.ok(f.events.includes('ROLLBACK'));
});
test('acknowledged BEGIN plus failed metadata never retries admission or business',async()=>{
 const error=Object.assign(Error('METADATA_BUSY'),{code:'SQLITE_BUSY'}),f=receiver({metadataError:error});
 await assert.rejects(f.run(),e=>e===error);assert.equal(f.opens,1);assert.equal(f.callbacks,0);assert.equal(f.metadataCalls,1);
});
test('runtime failure retains first sequential priority, with no later metadata or business callback',async()=>{
 const error=Error('RUNTIME_REVOKED'),f=receiver({runtimeFailure:error});await assert.rejects(f.run(),e=>e===error);
 assert.equal(f.metadataCalls,0);assert.equal(f.callbacks,0);
});
test('parent abort while original admission metadata settles prevents business after the ACK',async()=>{
 const budget=createExecutionBudget({budgetMs:120_000}),f=receiver({lateMetadata:()=>budget.cancel()});
 try{await assert.rejects(withExecutionBudget(budget,()=>f.run()),e=>e.code==='SYNC_CANCELLED');assert.equal(f.callbacks,0);}
 finally{budget.close();}
});
for(const mutation of [p=>p.client.execute('INSERT INTO forbidden VALUES(1)'),p=>p.outside('provider',()=>{throw Error('PROVIDER_RAN');})])
 test('bundled branded admission cannot perform a caught write or provider operation',async()=>{
  const f=receiver(),before=readOnlyProcessingCheck(async()=>{try{await mutation(f.p);}catch{}});
  await assert.rejects(f.run(before),/PROCESSING_READ_ONLY_CHECK_REQUIRED/);assert.equal(f.callbacks,0);
  assert.ok(!f.events.includes('INSERT INTO forbidden VALUES(1)'));assert.ok(!f.events.includes('COMMIT'));
 });
test('lost COMMIT acknowledgement still reports indeterminate and never retries the business callback',async()=>{
 const f=receiver({commitError:Error('ACK_LOST')});await assert.rejects(f.run(),e=>e.code==='COMMIT_INDETERMINATE');
 assert.equal(f.callbacks,1);assert.equal(f.opens,1);
});
test('actual installed Hrana first packet saves one physical request and preserves all owner/data/COMMIT observations',async t=>{
 const {db,transport}=await fixture(t);let checks=0;
 const expires=new Date(Date.now()+120_000).toISOString();
 await db.raw.execute({sql:'INSERT INTO resource_locks(name,owner,acquired_at,expires_at) VALUES(?,?,?,?)',args:['synthetic','owner',new Date().toISOString(),expires]});
 const check=async client=>{checks++;if(client)assert.equal((await client.execute({
  sql:'SELECT 1 FROM resource_locks WHERE name=? AND owner=? AND expires_at=? AND expires_at>?',
  args:['synthetic','owner',expires,new Date().toISOString()]})).rows.length,1);};
 const measure=async fn=>{
  const before=transport.counts.httpRequests;
  const result=await withDurableExecution(execution(),()=>db.withRuntimeFence(fn,()=>db.transaction(
   async()=>{assert.equal((await db.raw.execute('SELECT 23 admitted_data')).rows[0].admitted_data,23);return 29;},{readOnly:true})));
  assert.equal(result,29);return transport.counts.httpRequests-before;
 };
 const serial=await measure(check),bundled=await measure(readOnlyProcessingCheck(async client=>check(client)));
 assert.equal(serial-bundled,1);assert.equal(checks,8);console.log('SYNC_ADMISSION_PHYSICAL '+JSON.stringify({serial,bundled,originalOwnerChecks:checks}));
});
test('actual protected capture keeps missing-state initialization, inactive capability denial and privacy purge fencing',async t=>{
 const {db}=await fixture(t);await db.createUser({id:'a',displayName:'Synthetic',status:'ACTIVE',timezone:'Asia/Taipei'});
 await db.raw.execute("DELETE FROM phase4_computation_state WHERE user_id='a' AND execution_mode='SHADOW'");
 const control=syncRuntimeProcessingCheck(()=>{});
 const run=fn=>withDurableExecution(execution(),()=>db.withRuntimeFence(control,fn));
 assert.deepEqual(await run(()=>db.getCapabilities('a')),{});
 assert.equal((await db.raw.execute("SELECT COUNT(*) n FROM phase4_computation_state WHERE user_id='a' AND execution_mode='SHADOW'")).rows[0].n,1);
 await db.raw.execute("UPDATE phase4_user_state SET pending_purge_count=1 WHERE user_id='a'");
 await assert.rejects(run(()=>db.getCapabilities('a')),/PHASE4_PURGE_FENCED/);
 await db.raw.execute("UPDATE phase4_user_state SET pending_purge_count=0 WHERE user_id='a'");
 await db.transitionUserLifecycle({userId:'a',targetStatus:'DISABLED'});
 assert.deepEqual(await run(()=>db.getCapabilities('a')),{});
 await assert.rejects(run(()=>db.getRecoveries('a')),error=>error.code==='ACCOUNT_INACTIVE');
});
