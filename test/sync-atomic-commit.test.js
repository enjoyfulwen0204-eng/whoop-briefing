import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomUUID} from 'node:crypto';import {pathToFileURL} from 'node:url';
import {createOwnedDb} from './stage5OwnedDb.js';import {hranaTransport} from './hranaTransport.js';
import {withDurableExecution,currentDurableExecution} from '../src/phase4ExecutionContext.js';
import {prepareSyncCanonicalPayload,canonicalRawJSON} from '../src/syncCanonicalPreparation.js';
const root=process.env.SYNC_ATOMIC_BASELINE_ROOT?pathToFileURL(process.env.SYNC_ATOMIC_BASELINE_ROOT+'/'):new URL('../',import.meta.url);
const {fixtureKeys}=await import(new URL('test/localDb.js',root));
const {createDb}=await import(new URL('src/db.js',root)),{createSync}=await import(new URL('src/sync.js',root));
const {runExecutionPhase}=await import(new URL('src/phase4Execution.js',root));
const {configurationProof,canonicalPhaseRequest}=await import(new URL('src/phase4ExecutionStore.js',root));
const {runningReleaseSha}=await import(new URL('src/phase4Release.js',root));
const {currentExecutionBudget}=await import(new URL('src/executionBudget.js',root));
const {withSyncOwnership}=await import(new URL('src/syncOwnership.js',root));
const status=process.env.SYNC_ATOMIC_BASELINE_ROOT?()=>null:(await import('../src/syncCommitSnapshot.js')).syncCommitSnapshotStatus;
const now=new Date('2026-10-11T00:00:00Z'),payload=Array.from({length:7},(_,i)=>({id:'synthetic-'+i,user_id:1001,start:`2026-10-${String(10-i).padStart(2,'0')}T16:00:00Z`,end:`2026-10-${String(10-i).padStart(2,'0')}T23:00:00Z`,timezone_offset:'+08:00',nap:false,score_state:'SCORED',created_at:'2026-10-10T23:00:00Z',updated_at:'2026-10-10T23:00:00Z',score:{sleep_performance_percentage:85}}));
async function fixture(t,{latency=0}={}){
 const dir=await mkdtemp(join(tmpdir(),'sync-atomic-')),url='file:'+join(dir,'db.sqlite'),seed=createOwnedDb({url});
 await seed.migrate({targetVersion:32});await seed.createUser({id:'alice',displayName:'Synthetic',status:'ACTIVE',timezone:'Asia/Taipei'});
 await seed.saveTokens('alice',{accessToken:'synthetic',refreshToken:'synthetic',expiresAt:new Date(Date.now()+3600000),whoopUserId:'1001'});
 await seed.saveCapabilities('alice',[{key:'sleep',status:'SUPPORTED'}],{expectedLifecycleGeneration:1});
 await seed.upsertSleeps('alice',payload.slice(0,2),{timezone:'Asia/Taipei',now});
 await seed.saveSyncState('alice','sleep',{backfillComplete:true,lastSuccessAt:'2026-10-01T00:00:00Z'},{now});
 for(const resource of ['recovery','cycle'])await seed.saveSyncState('alice',resource,{backfillComplete:true,lastSuccessAt:'2026-10-01T00:00:00Z'},{now});
 const generation=(await seed.raw.execute("SELECT source_generation FROM phase4_user_state WHERE user_id='alice'")).rows[0].source_generation;await seed.close();
 const transport=hranaTransport(url,{transactionMaxMs:5000,traceTransactions:true}),db=createDb({url:'https://isolated.invalid',phase4Keys:fixtureKeys,fetch:async request=>{if(latency)await new Promise(r=>setTimeout(r,latency));return transport.fetch(request);}});
 t.after(async()=>{await db.close();transport.close();await rm(dir,{recursive:true,force:true});});return{db,transport,url,generation};
}
async function run(f,{onProvider,resources=['sleep','recovery','cycle'],budgetMs,overallBudgetMs,leaseMs}={}){
 const environment={PHASE4_BETA_SHADOW_RUNTIME:'off',PHASE4_PUBLIC_BETA_MODE:'off',BRIEFING_CONTINUATION_SCOPE:'sync'};
 const request={requestId:'p4s1_'+randomUUID(),releaseSha:runningReleaseSha(),phase:'SYNC',triggerSource:'cloudflare',executionMode:'OFF',configProof:configurationProof(fixtureKeys,{runtime:'off',mode:'off'},environment)};
 let result,calls=0;const options={db:f.db,keys:fixtureKeys,request,body:canonicalPhaseRequest(request),environment,env:{dryRun:true,timezone:'Asia/Taipei'},now,budgetMs,overallBudgetMs,deps:{runBriefing:async()=>{
  const provider=records=>async()=>{calls++;assert.equal(f.db.processingTransactionActive(),false);await onProvider?.();return structuredClone(records);};
  const sync=()=>createSync({db:f.db,userId:'alice',timezone:'Asia/Taipei',expectedLifecycleGeneration:1,now,budget:currentExecutionBudget(),whoop:{sleeps:provider(payload),recoveries:provider(payload.map((p,i)=>({sleep_id:p.id,cycle_id:1000+i,user_id:1001,created_at:p.created_at,updated_at:p.updated_at,score_state:'SCORED',score:{recovery_score:65}}))),cycles:provider(payload.map((p,i)=>({id:1000+i,user_id:1001,start:p.start,end:p.end,created_at:p.created_at,updated_at:p.updated_at,score_state:'SCORED',score:{strain:10}})))}}).syncAll({resources,force:true});
  result=leaseMs?await withSyncOwnership({db:f.db,userId:'alice',budget:currentExecutionBudget(),leaseMs},sync):await sync();
  return{syncComplete:result.complete,syncOutcome:result.outcome,users:1,failed:result.complete?0:1};
 }}};
 return{response:await runExecutionPhase(options),get result(){return result;},get calls(){return calls;},options};
}
test('115ms seven-record SYNC window publishes all dependent writes then replays once',async t=>{
 const f=await fixture(t,{latency:115}),at=performance.now(),r=await run(f),elapsedMs=performance.now()-at;
 const windowTransactions=f.transport.transactions.filter(tx=>tx.statements.some(s=>s.verb==='INSERT'&&['whoop_sleeps','whoop_recoveries','whoop_cycles'].includes(s.table)));
 console.log('SYNC_ATOMIC_MEASURE '+JSON.stringify({elapsedMs,response:r.response.status,outcome:r.result.outcome,result:r.result,snapshot:status(f.db),windows:windowTransactions.map(({statements,...tx})=>tx),http:f.transport.counts.httpRequests,sql:f.transport.counts.sqlStatements}));
 if(process.env.SYNC_ATOMIC_BASELINE_ROOT){assert.equal(r.response.body.syncComplete,false);assert.ok(f.transport.evidence.some(e=>e.event==='transaction_timeout'));return;}
 assert.equal(r.response.status,200,JSON.stringify(r.response));assert.equal(r.result.complete,true);assert.equal(r.calls,3);
 assert.ok(windowTransactions.length);assert.ok(windowTransactions.every(tx=>tx.outcome==='COMMITTED'&&tx.finishedAt-tx.startedAt<=4000));assert.ok(!f.transport.evidence.some(e=>e.event==='transaction_timeout'));
 assert.equal((await f.db.raw.execute("SELECT count(*) n FROM whoop_sleeps WHERE user_id='alice'")).rows[0].n,7);
 assert.equal((await f.db.raw.execute("SELECT source_generation FROM phase4_user_state WHERE user_id='alice'")).rows[0].source_generation,f.generation+3);
 assert.ok((await f.db.raw.execute("SELECT count(*) n FROM phase4_source_links WHERE user_id='alice' AND unlinked_at IS NULL")).rows[0].n>0);
 assert.equal((await f.db.raw.execute("SELECT last_success_at FROM whoop_sync_state WHERE user_id='alice' AND resource='sleep'")).rows[0].last_success_at,now.toISOString());
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM (SELECT execution_id,step_key FROM phase4_execution_work_receipts GROUP BY execution_id,step_key HAVING count(*)>1)')).rows[0].n,0);
 const count=f.transport.counts.sqlStatements;assert.deepEqual(await runExecutionPhase(r.options),r.response);assert.equal(r.calls,3);assert.ok(f.transport.counts.sqlStatements>count);
});
async function untouched(f){
 assert.equal((await f.db.raw.execute("SELECT count(*) n FROM whoop_sleeps WHERE user_id='alice'")).rows[0].n,2);
 assert.equal((await f.db.raw.execute("SELECT source_generation FROM phase4_user_state WHERE user_id='alice'")).rows[0].source_generation,f.generation);
 assert.equal((await f.db.raw.execute("SELECT last_success_at FROM whoop_sync_state WHERE user_id='alice' AND resource='sleep'")).rows[0].last_success_at,'2026-10-01T00:00:00Z');
}
for(const [name,mutation] of [
 ['lifecycle',"UPDATE users SET lifecycle_generation=lifecycle_generation+1 WHERE id='alice'"],
 ['auth',"UPDATE user_whoop_tokens SET auth_generation=auth_generation+1 WHERE user_id='alice'"],
 ['timezone',"UPDATE users SET timezone='UTC' WHERE id='alice'"],
 ['purge',"UPDATE phase4_user_state SET purge_generation=purge_generation+1 WHERE user_id='alice'"],
])test(`canonical trigger changing immutable ${name} poisons the root and rolls back data/authority/cursor`,async t=>{
 const f=await fixture(t);await f.db.raw.execute(`CREATE TRIGGER synthetic_authority_change AFTER INSERT ON whoop_sleeps WHEN NEW.id='synthetic-2' BEGIN ${mutation}; END`);
 const r=await run(f,{resources:['sleep']});assert.equal(r.response.body.syncComplete,false);await untouched(f);
 assert.ok(f.transport.evidence.some(e=>e.event==='sql_error'));
 assert.equal(f.transport.transactions.filter(tx=>tx.statements.some(s=>s.verb==='INSERT'&&s.table==='whoop_sleeps')).every(tx=>tx.outcome==='ROLLED_BACK'),true);
});
test('zero-row canonical CAS keeps original blocked semantics; receipt and cursor publish without invented source progress',async t=>{
 const f=await fixture(t);await f.db.raw.execute("CREATE TRIGGER synthetic_zero_row BEFORE INSERT ON whoop_sleeps WHEN NEW.id LIKE 'synthetic-%' BEGIN SELECT RAISE(IGNORE); END");
 const r=await run(f);assert.equal(r.response.status,200);assert.equal(r.result.resources[0].incremental.written,0);
 assert.equal((await f.db.raw.execute("SELECT count(*) n FROM whoop_sleeps WHERE user_id='alice'")).rows[0].n,2);
 // Recovery and cycle still process legitimately and advance their generations.
 assert.equal((await f.db.raw.execute("SELECT source_generation FROM phase4_user_state WHERE user_id='alice'")).rows[0].source_generation,f.generation+2);
 assert.equal((await f.db.raw.execute("SELECT last_success_at FROM whoop_sync_state WHERE user_id='alice' AND resource='sleep'")).rows[0].last_success_at,now.toISOString());
});
test('failure at named count receipt rolls canonical/provenance/source/cursor back together',async t=>{
 const f=await fixture(t);await f.db.raw.execute("CREATE TRIGGER synthetic_receipt_failure BEFORE INSERT ON phase4_execution_work_receipts BEGIN SELECT RAISE(ABORT,'SYNTHETIC_RECEIPT_FAILURE'); END");
 const r=await run(f);assert.equal(r.response.body.syncComplete,false);await untouched(f);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM phase4_execution_work_receipts')).rows[0].n,0);
});
test('fresh independent canonical writer before admission is incorporated without stale source overwrite',async t=>{
 const f=await fixture(t),peer=createOwnedDb({url:f.url});t.after(()=>peer.close());let changed=false;
 const r=await run(f,{onProvider:async()=>{if(changed)return;changed=true;await withDurableExecution(null,()=>peer.upsertSleeps('alice',[{...payload[0],id:'independent-source'}],{timezone:'Asia/Taipei',now}));}});
 assert.equal(r.response.status,200);assert.equal((await f.db.raw.execute("SELECT count(*) n FROM whoop_sleeps WHERE user_id='alice'")).rows[0].n,8);
 assert.equal((await f.db.raw.execute("SELECT source_generation FROM phase4_user_state WHERE user_id='alice'")).rows[0].source_generation,f.generation+4);
});
test('lost COMMIT acknowledgment leaves authentic work but cannot claim SYNC success',async t=>{
 const f=await fixture(t);f.transport.arm({matchSql:/INSERT INTO whoop_sleeps/,loseAcknowledgement:true});
 // Preserve the original 30s continuation yield reserve in this shorter
 // supported fixture; no headroom/deadline guard is disabled for recovery.
 const r=await run(f,{budgetMs:31_000,overallBudgetMs:33_000});assert.equal(r.response.status,503);assert.equal(r.response.body.result.outcome,'COMMIT_INDETERMINATE');
 assert.ok(f.transport.evidence.some(e=>e.event==='commit_durable'));
 assert.equal((await f.db.raw.execute("SELECT count(*) n FROM whoop_sleeps WHERE user_id='alice'")).rows[0].n,7);
 assert.equal((await f.db.raw.execute("SELECT last_success_at FROM whoop_sync_state WHERE user_id='alice' AND resource='sleep'")).rows[0].last_success_at,now.toISOString());
 await assert.rejects(runExecutionPhase(r.options),error=>error.code==='REQUEST_PENDING');
 assert.equal(r.calls,1);
 const prior=(await f.db.raw.execute({sql:'SELECT * FROM phase4_executions WHERE execution_id=?',args:[r.options.request.requestId]})).rows[0];
 const sourceLease=(await f.db.raw.execute("SELECT expires_at FROM resource_locks WHERE name='phase4:sync:alice'")).rows[0];
 await f.db.close();f.db=createDb({url:'https://isolated.invalid',phase4Keys:fixtureKeys,fetch:f.transport.fetch});r.options.db=f.db;
 // Natural expiration of a shorter supported test budget; no lease edits,
 // clock manipulation, queue reset or retry-timeout extension.
 await new Promise(resolve=>setTimeout(resolve,Math.max(0,Math.max(prior.deadline_at,Date.parse(sourceLease?.expires_at??'')||0)-Date.now()+20)));
 const resumed=await runExecutionPhase(r.options);assert.equal(resumed.status,200,JSON.stringify(resumed));assert.equal(resumed.body.syncComplete,true);
 assert.equal(r.calls,3,'committed sleep window must not be fetched or calculated again');
 assert.equal((await f.db.raw.execute("SELECT source_generation FROM phase4_user_state WHERE user_id='alice'")).rows[0].source_generation,f.generation+3);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM (SELECT execution_id,step_key FROM phase4_execution_work_receipts GROUP BY execution_id,step_key HAVING count(*)>1)')).rows[0].n,0);
 assert.deepEqual(await runExecutionPhase(r.options),resumed);assert.equal(r.calls,3);
});
test('expired source ownership lease is fresh even after immutable metadata was valid',async t=>{
 const f=await fixture(t);
 const original=f.db.raw.batch;let delayed=false;
 f.db.raw.batch=async(statements,...args)=>{if(!delayed&&statements.some(s=>/INSERT INTO whoop_sleeps/.test(typeof s==='string'?s:s.sql))){delayed=true;await new Promise(r=>setTimeout(r,400));}return original(statements,...args);};
 const r=await run(f,{resources:['sleep'],leaseMs:300});
 assert.equal(r.response.body.syncComplete,false);await untouched(f);
 assert.equal(status(f.db)?.outcome,'ROLLED_BACK');assert.ok(status(f.db)?.phases.snapshotMs>=0);
});
test('same-root unapproved authority mutation clears reuse before the fresh original checks',async t=>{
 const f=await fixture(t),original=f.db.raw.batch;let injected=false;
 f.db.raw.batch=async(statements,...args)=>{const result=await original(statements,...args);if(!injected&&statements.some(s=>/INSERT INTO whoop_sleeps/.test(typeof s==='string'?s:s.sql))){injected=true;await f.db.raw.execute("UPDATE user_whoop_tokens SET auth_generation=auth_generation+1 WHERE user_id='alice'");}return result;};
 const r=await run(f,{resources:['sleep']});assert.equal(r.response.body.syncComplete,false);await untouched(f);
 assert.equal((await f.db.raw.execute("SELECT auth_generation FROM user_whoop_tokens WHERE user_id='alice'")).rows[0].auth_generation,1);
});
test('pure preparation preserves original JSON and refuses lossy/accessor shapes without invoking getters',()=>{
 const frozen=prepareSyncCanonicalPayload(payload);assert.deepEqual(frozen,payload);assert.notEqual(frozen,payload);
 assert.equal(canonicalRawJSON(frozen[0]),JSON.stringify(payload[0]));assert.ok(Object.isFrozen(frozen[0].score));
 const hidden={...payload[0]};Object.defineProperty(hidden,'id',{value:payload[0].id,enumerable:false});assert.throws(()=>prepareSyncCanonicalPayload([hidden]),/SYNC_PROVIDER_JSON_REQUIRED/);
 const symbolic={...payload[0],[Symbol('unsupported')]:1};assert.throws(()=>prepareSyncCanonicalPayload([symbolic]),/SYNC_PROVIDER_JSON_REQUIRED/);
 let invoked=false;assert.throws(()=>prepareSyncCanonicalPayload([{get id(){invoked=true;return 'unsafe';}}]),/SYNC_PROVIDER_JSON_REQUIRED/);assert.equal(invoked,false);
});
