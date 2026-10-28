import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,open} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createOwnedFileDb,createDb,createStage6OwnedMemoryDb} from '../src/db.js';
import {createClient} from '@libsql/client/sqlite3';
import {fixtureKeys} from './localDb.js';
import {hranaTransport} from './hranaTransport.js';
import {createPhase4Foundation} from '../src/phase4Foundation.js';
import {createStage8LiveProducer} from '../src/stage8LiveProducer.js';
import {authorizeStage8LiveProducer} from '../src/stage8LiveProducerAuthority.js';
import {createStage8LiveExecutionRunner} from '../src/stage8LiveExecution.js';
import {createStage8LivePreparedWorker} from '../src/stage8LivePreparedWork.js';
import {buildPhase4Core} from '../src/phase4Core.js';
import {composePhase4Stores} from '../src/phase4Repositories.js';
import {createPhase4Stage6} from '../src/phase4Reanalysis.js';
import {publishStage8Live} from '../src/stage8LivePublication.js';
import {createStage8DerivedReader,stage8DerivedSelection} from '../src/stage8DerivedReader.js';
import {createScopedHealthContext} from '../src/scopedHealthContext.js';
import {issueStage8LiveAuthority} from '../src/stage8LiveAuthority.js';
import {currentDurableExecution,withDurableExecution} from '../src/phase4ExecutionContext.js';
import {createPhase4ContextRegistry} from '../src/phase4Cache.js';
import {runExecutionPhase} from '../src/phase4Execution.js';
import {configurationProof} from '../src/phase4ExecutionStore.js';
import {runningReleaseSha} from '../src/phase4Release.js';
import {createSync} from '../src/sync.js';
import {recordStage8SyncSubject} from '../src/stage8PostSync.js';
import {readOnlyProcessingCheck,readObservationProcessingCheck} from '../src/processingTransaction.js';
import {bodyInput,seedBodyInput} from './bodyEnergyFixture.js';
import {log} from '../src/logger.js';
for(const name of ['info','warn','error'])log[name]=()=>{};

async function fixture(t,{days=0,recoveryDeviation=false}={}){
 const dir=await mkdtemp(join(tmpdir(),'r22-live-prepared-')),url='file:'+join(dir,'fixture.sqlite');
 const seed=createOwnedFileDb({url,phase4Keys:fixtureKeys}),control=createClient({url});let db,transport;
 t.after(async()=>{try{await db?.close();seed.close();control.close();}finally{transport?.close();await rm(dir,{recursive:true,force:true});}});
 await seed.migrate({targetVersion:35});await seed.raw.execute('PRAGMA journal_mode=WAL');
 await seed.createUser({id:'a',displayName:'Synthetic',timezone:'Asia/Taipei',status:'ACTIVE'});
 const foundation=await createPhase4Foundation({db:seed,keys:fixtureKeys,admission:await seed.admitRuntime()});await foundation.initializeTenant('a','SHADOW');
 const input=bodyInput({asOf:Date.now()-1000,days});
 // The existing approved Stage5 severe-single synthetic recovery pattern.
 if(recoveryDeviation)for(const [index,row]of input.sources.recovery.entries())row.recovery_score=index===0?15:[40,45,50,55,60][(index-1)%5];
 await seed.transaction(()=>seedBodyInput(seed,input));
 await seed.ensureOnboarding('a',{state:'READY'});await seed.linkTelegram({userId:'a',chatId:'10001'});await seed.setLocale('a','en');
 transport=hranaTransport(url,{transactionMaxMs:5000,traceTransactions:true});
 db=createDb({url:'https://isolated.invalid',phase4Keys:fixtureKeys,fetch:request=>transport.fetch(request)});
 return {db,keys:fixtureKeys,transport,seed,control};
}

async function runner(f,work){
 const admission=await f.db.admitRuntime(),capability=await authorizeStage8LiveProducer({...f,admission,releaseSha:'a'.repeat(40),configProof:'b'.repeat(64),enabled:()=>true,eligible:id=>id==='a'});
 const core=await buildPhase4Core({keys:f.keys,admission,liveProducingAuthority:capability,
  processing:{client:f.db.raw,transaction:f.db.transaction,active:f.db.processingTransactionActive,assertFences:f.db.assertRuntimeFences,afterCommit:f.db.afterProcessingCommit,afterCompletion:f.db.afterProcessingCompletion},authorizeMode(){}});
 await core.initializeTenant('a','LIVE');
 const canonicalWorker=await createPhase4Stage6({...f,admission,executionMode:'LIVE',liveProducingAuthority:capability});await canonicalWorker.rolloutAlgorithm({userId:'a'});
 const prepared=createStage8LivePreparedWorker({...f,capability});
 const run=createStage8LiveExecutionRunner({...f,capability,capture:id=>core.capture(id,{executionMode:'LIVE',providerRequired:true}),assertContext:ctx=>core.assertContext(ctx),work:async(id,context)=>{
  const result=await work({prepared,userId:id,context,execution:currentDurableExecution()});
  return {outcome:result.outcome,itemsProcessed:result.processedItems,unitsCommitted:result.unitsCommitted,jobsCompleted:result.completedJobs,jobsFailed:result.failedJobs,remainingJobs:result.remainingJobs};
 }});
 return Object.assign(run,{core,capability,admission});
}
async function graph(f){
 const tables=(await f.control.execute("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'stage8_live_%' OR name IN ('phase4_jobs','phase4_computation_state','body_energy_results','health_insights','evidence_runs','evidence_items')) AND name NOT IN ('stage8_live_executions','stage8_live_execution_work_receipts') ORDER BY name")).rows.map(r=>r.name),out=[];
 for(const table of tables)out.push([table,(await f.control.execute('SELECT * FROM '+table)).rows.map(r=>JSON.stringify(r)).sort()]);return out;
}

test('original LIVE producer publishes genuine prepared work through its owned Hrana processing root',async t=>{
 const f=await fixture(t),producer=await createStage8LiveProducer({...f,admission:await f.db.admitRuntime(),userIds:['a'],enabled:()=>true,eligible:id=>id==='a'});
 const before=(await f.db.raw.execute('SELECT count(*) n FROM stage8_live_execution_work_receipts')).rows[0].n;
 const value=await producer.run({userId:'a',requestId:'r22-first-original-prepared'});
 assert.equal(value.replayed,false);assert.equal(value.result.jobsFailed,0);
 assert.ok(value.result.unitsCommitted||value.result.itemsProcessed||value.result.jobsCompleted);
 assert.ok((await f.db.raw.execute('SELECT count(*) n FROM stage8_live_execution_work_receipts')).rows[0].n>before);
 const row=(await f.db.raw.execute('SELECT * FROM stage8_live_executions')).rows[0];
 assert.equal(row.state,'FINALIZED_SUCCESS');assert.equal(row.generation,1);assert.equal(row.deadline_at-row.created_at,45000);assert.equal(row.lease_until-row.created_at,60000);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM outbound_messages')).rows[0].n,0);
 assert.equal((await f.db.raw.execute("SELECT count(*) n FROM system_heartbeats WHERE component LIKE 'phase4_beta_pilot_permit%'")).rows[0].n,0);
 console.log('R22_PREPARED_FIRST '+JSON.stringify({outcome:value.result.outcome,units:value.result.unitsCommitted,items:value.result.itemsProcessed,jobs:value.result.jobsCompleted,http:f.transport.counts.httpRequests,transactions:f.transport.transactions.length,productionEvidence:false,transport:'INSTALLED_HTTP_DRIVER_WITH_NATIVE_SQLITE_PROTOCOL_FIXTURE_NOT_REAL_SQLD'}));
});

for(const attack of ['SOURCE','AUTH','PURGE','OWNER','LOCK'])test('prepared publication rejects original '+attack+' revocation before any copied graph is durable',async t=>{
 const f=await fixture(t);let before,attempted=false;
 const lock='stage8:synthetic-original-subject',owner=await f.db.acquireLock(lock,{ttlMs:60000}),expiry=Date.now()+59000;
 const run=await runner(f,async({prepared,userId,context,execution})=>{
  const plan=await prepared.prepare({userId,context});before=await graph(f);attempted=true;
  if(attack==='SOURCE')await f.control.execute("UPDATE phase4_user_state SET source_generation=source_generation+1 WHERE user_id='a'");
  if(attack==='AUTH')await f.control.execute("UPDATE user_whoop_tokens SET auth_generation=auth_generation+1 WHERE user_id='a'");
  if(attack==='PURGE')await f.control.execute("UPDATE phase4_user_state SET pending_purge_count=1 WHERE user_id='a'");
  if(attack==='OWNER'){
   // Canonical execution ownership itself is immutable; do not disable its
   // trigger to manufacture an authority transition which cannot occur.
   await assert.rejects(f.control.execute({sql:'UPDATE stage8_live_executions SET owner=? WHERE execution_id=?',args:['synthetic-other-owner',execution.claim.executionId]}),/transition|immutable/i);
   try{return await withDurableExecution({...execution,claim:{...execution.claim,owner:'synthetic-other-owner'}},()=>prepared.publish(plan));}
   finally{await prepared.dispose(plan);}
  }
  if(attack==='LOCK')await f.control.execute({sql:'DELETE FROM resource_locks WHERE name=?',args:[lock]});
  return prepared.publish(plan);
 });
 const fence=readObservationProcessingCheck(readOnlyProcessingCheck(async()=>{if(!await f.db.holdsLock(lock,owner))throw Error('SYNTHETIC_ORIGINAL_SUBJECT_REVOKED');}),()=>{assert.ok(Date.now()<expiry);});
 await assert.rejects(f.db.withRuntimeFence(fence,()=>run({userId:'a',requestId:'r22-original-revoked-'+attack})),error=>{
  if(['SOURCE','AUTH','PURGE'].includes(attack))return error.code==='SQLITE_ERROR'&&f.transport.evidence.some(e=>e.event==='sql_error'&&e.assertionLabel==='LIVE_PREPARED_AUTHORITY_REVOKED');
  return /PREPARED_|OWNER_FENCED|PHASE4_AUTH|SYNTHETIC_ORIGINAL_SUBJECT_REVOKED/.test(error.message);
 });
 assert.equal(attempted,true);assert.deepEqual(await graph(f),before);
 const execution=(await f.control.execute('SELECT state,result_json,generation FROM stage8_live_executions')).rows[0];assert.equal(execution.state,'ESTABLISHED');assert.equal(execution.result_json,null);assert.equal(execution.generation,1);
});

for(const lost of ['AFTER_COMMIT','BEFORE_COMMIT'])test('unknown '+lost+' acknowledgement never retries or finalizes the original LIVE request',async t=>{
 const f=await fixture(t);let original,planToken,preparedWorker;
 const run=await runner(f,async({prepared,userId,context,execution})=>{
  original=execution;preparedWorker=prepared;planToken=await prepared.prepare({userId,context});
  f.transport.arm({matchSql:/json_each\(\?\) AS __stage6_expected/,...(lost==='AFTER_COMMIT'?{loseAcknowledgement:true}:{before:()=>{throw Error('SYNTHETIC_UNKNOWN_BEFORE_COMMIT');}})});
  return prepared.publish(planToken);
 });
 const request={userId:'a',requestId:'r22-original-unknown-'+lost};await assert.rejects(run(request),error=>error.code==='COMMIT_INDETERMINATE');
 assert.equal(original.indeterminate,true);assert.equal(original.reconciliation.state,lost==='AFTER_COMMIT'?'PREPARED_UNIT_COMMITTED_UNFINALIZED':'RECONCILIATION_REQUIRED');
 const before=await graph(f),row=(await f.control.execute('SELECT * FROM stage8_live_executions')).rows[0];assert.equal(row.state,'ESTABLISHED');assert.equal(row.result_json,null);assert.equal(row.generation,1);
 await assert.rejects(preparedWorker.publish(planToken),/PLAN_REQUIRED/);
 await assert.rejects(run(request),/REQUEST_PENDING/);assert.deepEqual(await graph(f),before);assert.deepEqual((await f.control.execute('SELECT * FROM stage8_live_executions')).rows[0],row);
 const pending=(await f.control.execute("SELECT name,owner,expires_at FROM resource_locks WHERE name LIKE '%:prepared-disposal:%'")).rows;
 assert.equal(pending.length,1);assert.equal(preparedWorker.status().disposal.physicalJoin,'UNKNOWN');
 const registry=createPhase4ContextRegistry({client:f.control,keys:f.keys,now:()=>new Date('2099-01-01T00:00:00.000Z'),timestamp:()=> '2099-01-01T00:00:00.000Z',newId:()=>assert.fail('no new lease')});
 assert.equal(await registry.pending('a',1),1);assert.deepEqual((await f.control.execute({sql:'SELECT name,owner,expires_at FROM resource_locks WHERE name=?',args:[pending[0].name]})).rows,pending);
 console.log('R22_ACK '+JSON.stringify({lost,reconciliation:original.reconciliation.state,originalIndeterminateRetained:true,originalFinalization:false,productionEvidence:false}));
});

test('unknown cross-scope trigger is rejected before health snapshot payload is fetched',async t=>{
 const f=await fixture(t);let observed=false;
 const run=await runner(f,async({prepared,userId,context})=>{
  await f.control.execute("CREATE TRIGGER foreign_prepared_side_effect AFTER INSERT ON stage8_live_operation_receipts BEGIN UPDATE users SET display_name='unexpected' WHERE id<>'a'; END");
  const reads=f.transport.counts.byFamily.CANONICAL??0,before=await graph(f);
  await assert.rejects(prepared.prepare({userId,context}),error=>error.code==='PREPARED_UNEXPECTED_SCHEMA_OBJECT');
  assert.equal(f.transport.counts.byFamily.CANONICAL??0,reads);assert.deepEqual(await graph(f),before);
  assert.equal((await f.control.execute("SELECT count(*) n FROM resource_locks WHERE name LIKE '%:prepared-disposal:%'")).rows[0].n,0);
  observed=true;throw Error('EXPECTED_CATALOG_REJECTION');
 });
 await assert.rejects(run({userId:'a',requestId:'r22-unknown-trigger'}),/EXPECTED_CATALOG_REJECTION/);assert.equal(observed,true);
});

test('policy revocation at publish entry disposes prepared buffers and the known joined hold',async t=>{
 const f=await fixture(t);let revoke=false,observed=false;
 const fence=readObservationProcessingCheck(readOnlyProcessingCheck(async()=>{if(revoke)throw Error('SYNTHETIC_ENTRY_REVOKED');}),()=>{if(revoke)throw Error('SYNTHETIC_ENTRY_REVOKED');});
 const run=await runner(f,async({prepared,userId,context})=>{
  const plan=await prepared.prepare({userId,context}),before=await graph(f);revoke=true;
  await assert.rejects(prepared.publish(plan),/SYNTHETIC_ENTRY_REVOKED/);
  assert.deepEqual(await graph(f),before);assert.deepEqual(prepared.status().disposal,{buffersDropped:true,physicalJoin:'KNOWN',holdReleased:true,requiresPhysicalDisposalProof:false});
  await assert.rejects(prepared.publish(plan),/PLAN_REQUIRED/);
  assert.equal((await f.control.execute("SELECT count(*) n FROM resource_locks WHERE name LIKE '%:prepared-disposal:%'")).rows[0].n,0);
  observed=true;throw Error('EXPECTED_ENTRY_REJECTION');
 });
 await assert.rejects(f.db.withRuntimeFence(fence,()=>run({userId:'a',requestId:'r22-entry-revocation'})),/EXPECTED_ENTRY_REJECTION/);assert.equal(observed,true);
});

test('cancelled pre-COMMIT health response keeps the non-expiring purge hold after the late response joins',async t=>{
 const f=await fixture(t);let worker,delayed=false,lateJoined=false;
 const run=await runner(f,async({prepared,userId,context})=>{
  worker=prepared;const plan=await prepared.prepare({userId,context}),originalFetch=f.transport.fetch;
  f.transport.fetch=async request=>{
   const body=await request.clone().json();
   const health=JSON.stringify(body).includes('json_each(?) AS __stage6_expected');
   const response=await originalFetch(request);
   if(health&&!delayed){delayed=true;await new Promise(resolve=>setTimeout(resolve,5300));lateJoined=true;}
   return response;
  };
  return prepared.publish(plan);
 });
 await assert.rejects(run({userId:'a',requestId:'r22-precommit-delayed-health'}),error=>/SYNC_TIMEOUT|SYNC_CANCELLED|ABORT/.test(error.code??error.message));
 assert.equal(delayed,true);
 const until=Date.now()+2000;while(!lateJoined&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,20));assert.equal(lateJoined,true);
 const holds=(await f.control.execute("SELECT name,owner,expires_at FROM resource_locks WHERE name LIKE '%:prepared-disposal:%'")).rows;
 assert.equal(holds.length,1);assert.equal(worker.status().publication,null);assert.equal(worker.status().disposal.physicalJoin,'UNKNOWN');
 const registry=createPhase4ContextRegistry({client:f.control,keys:f.keys,now:()=>new Date('2099-01-01T00:00:00.000Z'),timestamp:()=> '2099-01-01T00:00:00.000Z'});
 assert.equal(await registry.pending('a',1),1);
 const execution=(await f.control.execute('SELECT state,result_json,generation FROM stage8_live_executions')).rows[0];
 assert.equal(execution.state,'ESTABLISHED');assert.equal(execution.result_json,null);assert.equal(execution.generation,1);
 assert.equal((await f.control.execute('SELECT count(*) n FROM stage8_live_publications')).rows[0].n,0);
});

test('memory seed failure and actual receiver close failure both survive constructor cleanup',async()=>{
 const original=Error('SYNTHETIC_SEED_FAILURE'),cleanup=Error('SYNTHETIC_CLOSE_ACK_FAILURE');let closed=false;
 await assert.rejects(createStage6OwnedMemoryDb(async client=>{
  const close=client.close.bind(client);client.close=()=>{close();closed=true;throw cleanup;};throw original;
 },fixtureKeys),error=>error instanceof AggregateError&&error.cause===original&&error.errors[0]===original&&error.errors[1]===cleanup);
 assert.equal(closed,true);
});

test('genuine finalized SYNC and subject ownership invoke one prepared HTTP leg without fabricating a parent',async t=>{
 const f=await fixture(t),environment={PHASE4_BETA_SHADOW_RUNTIME:'off',PHASE4_PUBLIC_BETA_MODE:'off',PHASE4_STAGE8_RUNTIME:'on',PHASE4_BETA_PILOT_USER_ID:'a',STAGE8_USER_IDS:'a',STAGE8_LIVE_ANALYSIS:'on',STAGE8_POST_SYNC:'on'};
 for(const resource of ['sleep','recovery','cycle','workout'])await f.db.saveSyncState('a',resource,{backfillComplete:true,lastSuccessAt:new Date().toISOString()});
 const request={phase:'SYNC',triggerSource:'manual',requestId:'r22-genuine-http-sync-parent',releaseSha:runningReleaseSha(),executionMode:'OFF',configProof:configurationProof(f.keys,{runtime:'off',mode:'off'},environment)};
 const response=await runExecutionPhase({...f,request,environment,env:{dryRun:true,timezone:'Asia/Taipei',telegramBotToken:'SYNTHETIC_NOT_A_TOKEN'},deps:{runBriefing:async()=>{
  const whoop={sleeps:async()=>[],recoveries:async()=>[],cycles:async()=>[],workouts:async()=>[],bodyMeasurement:async()=>({})};
  const sync=await createSync({...f,whoop,userId:'a',timezone:'Asia/Taipei',expectedLifecycleGeneration:1}).syncAll({force:true});
  assert.equal(sync.complete,true);await recordStage8SyncSubject({...f,userId:'a',sync});return {syncComplete:true,syncOutcome:sync.outcome,users:1,failed:0};
 }}});
 assert.equal(response.body.syncComplete,true);assert.equal(response.body.drainAuthorized,false);
 const executions=(await f.control.execute('SELECT state,generation FROM stage8_live_executions')).rows;
 assert.equal(executions.length,1);assert.equal(executions[0].state,'FINALIZED_SUCCESS');assert.equal(executions[0].generation,1);
 const progress=(await f.control.execute("SELECT value FROM telegram_state WHERE key LIKE 'stage8:sync-progress:%'")).rows.map(r=>JSON.parse(r.value));
 assert.equal(progress.length,1);assert.equal(progress[0].ordinal,1);assert.equal(progress[0].done,false);
 assert.equal((await f.control.execute('SELECT count(*) n FROM outbound_messages')).rows[0].n,0);

});

test('prepared Hrana work completes both canonical jobs including legitimate empty outcomes',async t=>{
 const f=await fixture(t),run=await runner(f,({prepared,userId,context})=>prepared.drain({userId,context}));
 let result;
 // Small synthetic fixture only. This cost ceiling is not an execution permit;
 // every cycle keeps the original twelve-unit/45s/60s application contract.
 for(let ordinal=0;ordinal<6;ordinal++){
  result=await run({userId:'a',requestId:'r22-small-both-jobs-'+ordinal});
  console.log('R22_SMALL_BOTH_PROGRESS '+JSON.stringify({ordinal,units:result.result.unitsCommitted,sourceACK:result.result.itemsProcessed,jobs:result.result.jobsCompleted,remaining:result.result.remainingJobs}));
  assert.equal(result.result.jobsFailed,0);assert.ok(result.result.itemsProcessed||result.result.unitsCommitted||result.result.jobsCompleted);
  if(result.result.remainingJobs===0)break;
 }
 assert.equal(result.result.remainingJobs,0);
 const rows=(await f.db.raw.execute("SELECT state,scope_kind,full_scan_cursor,requested_generation,completed_generation,attempt,lease_owner FROM phase4_jobs WHERE user_id='a' AND execution_mode='LIVE'")).rows;
 assert.equal(rows.length,2);assert.ok(rows.every(r=>r.state==='COMPLETED'&&r.scope_kind==='NONE'&&r.full_scan_cursor===null&&r.completed_generation===r.requested_generation&&r.attempt===0&&r.lease_owner===null));
 assert.equal((await f.db.raw.execute("SELECT count(*) n FROM phase4_computation_state WHERE user_id='a' AND execution_mode='LIVE' AND last_completed_generation=input_generation")).rows[0].n,1);
 assert.equal((await f.db.raw.execute("SELECT count(*) n FROM phase4_invalidations WHERE user_id='a' AND execution_mode='LIVE' AND scope_kind<>'NONE'")).rows[0].n,0);
 assert.equal((await f.db.raw.execute("SELECT count(*) n FROM resource_locks WHERE name LIKE '%:prepared-disposal:%'")).rows[0].n,0);
});

test('terminal invalidation publication rejects a changed authoritative preimage without settling the last job',async t=>{
 const f=await fixture(t);let calls=0,attacked=false,before,preparedWorker;
 const state=async()=>({jobs:(await f.control.execute("SELECT * FROM phase4_jobs WHERE user_id='a' AND execution_mode='LIVE' ORDER BY job_kind")).rows,
  computation:(await f.control.execute("SELECT * FROM phase4_computation_state WHERE user_id='a' AND execution_mode='LIVE'")).rows,
  invalidations:(await f.control.execute("SELECT * FROM phase4_invalidations WHERE user_id='a' AND execution_mode='LIVE'")).rows,
  completions:(await f.control.execute("SELECT * FROM stage8_live_job_completions WHERE user_id='a' ORDER BY job_kind")).rows});
 const run=await runner(f,async({prepared,userId,context})=>{
  calls++;const plan=await prepared.prepare({userId,context});
  if(calls===6){
   preparedWorker=prepared;const changed=await f.control.execute("UPDATE phase4_invalidations SET updated_at='2099-01-01T00:00:00.000Z' WHERE user_id='a' AND execution_mode='LIVE'");assert.equal(changed.rowsAffected,1);attacked=true;before=await state();
   assert.equal(before.completions.length,1);
   await assert.rejects(prepared.publish(plan),error=>error.code==='SQLITE_ERROR'&&f.transport.evidence.some(e=>e.event==='sql_error'&&e.assertionLabel==='SHORT_TRANSACTION_CONDITION_REJECTED'));
   assert.deepEqual(await state(),before);throw Error('EXPECTED_CHANGED_INVALIDATION_REJECTION');
  }
  return prepared.publish(plan);
 });
 for(let ordinal=0;ordinal<5;ordinal++)await run({userId:'a',requestId:'r22-terminal-invalidation-'+ordinal});
 await assert.rejects(run({userId:'a',requestId:'r22-terminal-invalidation-final'}),/EXPECTED_CHANGED_INVALIDATION_REJECTION/);assert.equal(attacked,true);assert.equal(calls,6);
 const execution=(await f.control.execute("SELECT state,result_json,generation FROM stage8_live_executions WHERE execution_id='r22-terminal-invalidation-final'")).rows[0];assert.equal(execution.state,'ESTABLISHED');assert.equal(execution.result_json,null);assert.equal(execution.generation,1);
 assert.equal(preparedWorker.status().disposal.holdReleased,false);assert.equal((await f.control.execute("SELECT count(*) n FROM resource_locks WHERE name LIKE '%:prepared-disposal:%'")).rows[0].n,1);
});


test('prepared canonical metric work preserves a genuine qualifying LIVE Episode and its complete revision graph',async t=>{
 const f=await fixture(t,{days:30,recoveryDeviation:true}),run=await runner(f,({prepared,userId,context})=>prepared.drain({userId,context}));let episodes=0,calls=0;
 for(let ordinal=0;ordinal<4;ordinal++){
  const value=await run({userId:'a',requestId:'r22-small-qualified-episode-'+ordinal});calls++;assert.equal(value.result.jobsFailed,0);
  assert.ok(value.result.itemsProcessed||value.result.unitsCommitted||value.result.jobsCompleted);
  episodes=(await f.control.execute("SELECT count(*) n FROM observation_episodes WHERE user_id='a' AND execution_mode='LIVE' AND state='OPEN'")).rows[0].n;
  if(episodes)break;
 }
 assert.equal(episodes,1);
 // Stage6 uses the canonical episodes.open contract, which requires its
 // source/evidence links, event, semantic event and signed revision. The
 // analyzeMetric facade's optional observation/link tables are not invented.
 for(const table of ['episode_events','episode_semantic_events','phase4_episode_revisions'])assert.ok((await f.control.execute("SELECT count(*) n FROM "+table+" WHERE user_id='a' AND execution_mode='LIVE'")).rows[0].n>0,table+' genuine graph required');
 assert.ok((await f.control.execute("SELECT count(*) n FROM evidence_runs WHERE user_id='a' AND execution_mode='LIVE' AND state='COMPLETED' AND subject_key='recovery_score' AND sample_count=30")).rows[0].n>0);
 const row=(await f.control.execute("SELECT episode_id FROM observation_episodes WHERE user_id='a' AND execution_mode='LIVE'")).rows[0],context=await run.core.capture('a',{executionMode:'LIVE',providerRequired:true});
 const stores=composePhase4Stores(run.core),read=await stores.readArtifact(context,'observation_episodes',{episode_id:row.episode_id});assert.equal(read.row.episode_id,row.episode_id);assert.equal(read.row.state,'OPEN');
 const revision=await stores.episodes.readRevision(context,{episodeId:row.episode_id,revision:read.row.revision});assert.equal(revision.row.episode_id,row.episode_id);assert.equal(revision.row.revision,read.row.revision);assert.equal(revision.row.state,'OPEN');
 assert.equal((await f.control.execute("SELECT count(*) n FROM observation_episodes WHERE execution_mode='SHADOW'")).rows[0].n,0);
 assert.equal((await f.control.execute('SELECT count(*) n FROM outbound_messages')).rows[0].n,0);
 console.log('R22_PREPARED_QUALIFIED_EPISODE '+JSON.stringify({calls,episodes,source:'APPROVED_SYNTHETIC_RECOVERY_PATTERN',originalAlgorithmsUnchanged:true,fullEOFQualified:false,productionEvidence:false}));
});

test('canonical prepared EOF supports the authenticated Evidence reader on representative retained sources',async t=>{
 const f=await fixture(t,{days:7}),run=await runner(f,({prepared,userId,context})=>prepared.drain({userId,context}));let result,calls=0;
 for(let ordinal=0;ordinal<8;ordinal++){
  result=await run({userId:'a',requestId:'r22-reader-profile-'+ordinal});calls++;
  assert.equal(result.result.jobsFailed,0);assert.ok(result.result.unitsCommitted||result.result.itemsProcessed||result.result.jobsCompleted);
  if(result.result.remainingJobs===0)break;
 }
 assert.equal(result.result.remainingJobs,0,'GENUINE_CANONICAL_EOF_REQUIRED');
 // Optional isolated reader fixture: copy only actual synthetic canonical
 // computations, before any aggregate publication. It grants no native WORK
 // or Production qualification and never edits/creates a completion row.
 if(process.env.STAGE8_SYNTHETIC_READER_FIXTURE_OUTPUT){
  const schema=(await f.control.execute("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type,name")).rows.map(r=>({...r})),tables=[];
  for(const {name}of schema.filter(r=>r.type==='table')){const value=await f.control.execute('SELECT * FROM "'+name+'"');tables.push({name,columns:value.columns,rows:value.rows.map(row=>value.columns.map(c=>row[c]))});}
  assert.equal(tables.find(t=>t.name==='users').rows.length,1);assert.equal(tables.find(t=>t.name==='stage8_live_publications').rows.length,0);
  assert.ok(tables.find(t=>t.name==='user_whoop_tokens').rows.every(row=>row.includes('SYNTHETIC_NOT_A_TOKEN')));
  const payload={contract:'r22-canonical-synthetic-reader-fixture-v1',genuineWorkCalls:calls,sourceRows:17,schema,tables},file=await open(process.env.STAGE8_SYNTHETIC_READER_FIXTURE_OUTPUT,'wx',0o600);
  try{await file.writeFile(JSON.stringify({...payload,seal:f.keys.lookup(['r22-canonical-synthetic-reader-fixture-v1',payload])}));await file.sync();}finally{await file.close();}
 }
 const ctx=await run.core.capture('a',{executionMode:'LIVE',providerRequired:true});
 await publishStage8Live(run.core,ctx,run.capability);
 const reader=createStage8DerivedReader({...f,admission:run.admission,eligible:id=>id==='a'}),scopes=await createScopedHealthContext({...f,admission:run.admission,derivedReader:reader});
 const scope=await scopes.open({user:await f.db.getUser('a'),chatId:'10001',text:'/evidence'}),beforeHttp=f.transport.counts.httpRequests,beforeTx=f.transport.transactions.length,
  beforeSql=f.transport.counts.sqlStatements,at=performance.now(),value=await scopes.derived(scope,'EVIDENCE');
 assert.equal(value.status,'CURRENT');assert.equal(value.items.length,8);assert.ok(value.items.every(item=>item.evidence.length>0));
 const transactions=f.transport.transactions.slice(beforeTx);
 console.log('R22_CANONICAL_EVIDENCE_READER '+JSON.stringify({sources:17,originalWorkCalls:calls,items:value.items.length,http:f.transport.counts.httpRequests-beforeHttp,
  sql:f.transport.counts.sqlStatements-beforeSql,elapsedMs:performance.now()-at,transactions:transactions.map(tx=>({http:tx.httpOperations,sql:tx.sqlOperations,ms:tx.finishedAt-tx.beginSubmittedAt,outcome:tx.outcome})),
  transport:'INSTALLED_HTTP_DRIVER_NATIVE_SQLITE_PROTOCOL_FIXTURE_NOT_NATIVE_SQLD',productionEvidence:false}));
 assert.equal((await f.control.execute('SELECT count(*) n FROM outbound_messages')).rows[0].n,0);
 const negativeScope=await scopes.open({user:await f.db.getUser('a'),chatId:'10001',text:'/evidence'}),selected=(await f.db.raw.execute(stage8DerivedSelection('EVIDENCE',negativeScope,ctx.inputGeneration))).rows.map(r=>r.id),execute=f.db.raw.execute;
 assert.ok(selected.length>4,'A_LATER_GROUP_MUST_EXIST');const entered=new Set(),settled=new Set(),touched=new Set();
 f.db.raw.execute=async statement=>{
  if(typeof statement==='object'&&/^SELECT \* FROM evidence_runs WHERE user_id=\? AND execution_mode=\? AND run_id=\?$/.test(statement.sql)){
   const id=statement.args[2];touched.add(id);
   if(selected.slice(0,2).includes(id)&&!entered.has(id)){
    entered.add(id);await new Promise(resolve=>setTimeout(resolve,id===selected[0]?80:5));settled.add(id);throw Error(id===selected[0]?'SYNTHETIC_EVIDENCE_SLOW_FAILURE':'SYNTHETIC_EVIDENCE_FAST_FAILURE');
   }
  }
  return execute(statement);
 };
 try{await assert.rejects(scopes.derived(negativeScope,'EVIDENCE'),/SYNTHETIC_EVIDENCE_(?:SLOW|FAST)_FAILURE/);}
 finally{f.db.raw.execute=execute;}
 assert.equal(entered.size,2);assert.equal(settled.size,2,'ALL_SUBMITTED_FAILURES_MUST_SETTLE');
 assert.ok(selected.slice(4).every(id=>!touched.has(id)),'FAILED_GROUP_MUST_NOT_ENTER_NEXT_GROUP');
});

for(const revoke of ['ELIGIBILITY','LEASE_CLOCK','AUTH_WRITE','SOURCE_WRITE','OTHER_CONTEXT'])test('canonical LIVE read controls reject '+revoke+' at the original terminal boundary',async t=>{
 const f=await fixture(t);await runner(f,()=>{throw Error('NO_WORK_MUST_RUN');});
 const admission=await f.db.admitRuntime();let enabled=true,at=Date.now();
 const liveAuthority=issueStage8LiveAuthority({...f,admission,userIds:['a'],enabled:()=>enabled}),core=await buildPhase4Core({keys:f.keys,admission,liveAuthority,now:()=>new Date(at),
  processing:{client:f.db.raw,transaction:f.db.transaction,withReadSnapshot:f.db.withProcessingReadSnapshot,active:f.db.processingTransactionActive,assertFences:f.db.assertRuntimeFences,afterCommit:f.db.afterProcessingCommit,afterCompletion:f.db.afterProcessingCompletion},authorizeMode(){}});
 const leaseRows=async()=>(await f.control.execute("SELECT name,owner FROM resource_locks WHERE name LIKE 'p4ctx:%' ORDER BY name")).rows.map(row=>({...row})),priorLeases=await leaseRows();
 const context=await core.capture('a',{executionMode:'LIVE',providerRequired:true}),contextLeases=(await leaseRows()).filter(row=>!priorLeases.some(old=>old.name===row.name));assert.equal(contextLeases.length,1);
 const beforeOther=await leaseRows(),other=revoke==='OTHER_CONTEXT'?await core.capture('a',{executionMode:'LIVE',providerRequired:true}):null;
 if(other){const added=(await leaseRows()).filter(row=>!beforeOther.some(old=>old.name===row.name));assert.equal(added.length,1);assert.notEqual(added[0].name,contextLeases[0].name);}
 const originalAuth=(await f.control.execute("SELECT auth_generation FROM user_whoop_tokens WHERE user_id='a'")).rows[0].auth_generation;
 const originalSource=(await f.control.execute("SELECT source_generation FROM phase4_user_state WHERE user_id='a'")).rows[0].source_generation;
 const sleepId=(await f.control.execute("SELECT id FROM whoop_sleeps WHERE user_id='a' ORDER BY id LIMIT 1")).rows[0].id;
 let callbackFinished=false;
 await assert.rejects(f.db.transaction(async()=>{
  for(let i=0;i<3;i++)await core.run(context,()=>core.root(context,'sleep',sleepId));
  if(other)await core.run(other,async()=>{});
  if(revoke==='ELIGIBILITY')enabled=false;
  if(revoke==='LEASE_CLOCK')at+=16*60*1000;
  if(revoke==='AUTH_WRITE')await f.db.raw.execute("UPDATE user_whoop_tokens SET auth_generation=auth_generation+1 WHERE user_id='a'");
  if(revoke==='SOURCE_WRITE')await f.db.raw.execute("UPDATE phase4_user_state SET source_generation=source_generation+1 WHERE user_id='a'");
  if(revoke==='OTHER_CONTEXT')assert.equal((await f.db.raw.execute({sql:'DELETE FROM resource_locks WHERE name=? AND owner=?',args:[contextLeases[0].name,contextLeases[0].owner]})).rowsAffected,1);
  callbackFinished=true;
 }),/PHASE4_(?:LIVE_FIXTURE_MEMORY_REQUIRED|CONTEXT_EXPIRED|AUTH_FENCED|INPUT_FENCED|CONTEXT_REVOKED)/);
 assert.equal(callbackFinished,true);assert.equal((await f.control.execute("SELECT auth_generation FROM user_whoop_tokens WHERE user_id='a'")).rows[0].auth_generation,originalAuth);
 assert.equal((await f.control.execute("SELECT source_generation FROM phase4_user_state WHERE user_id='a'")).rows[0].source_generation,originalSource);
 assert.ok((await leaseRows()).some(row=>row.name===contextLeases[0].name&&row.owner===contextLeases[0].owner),'REJECTED_ROOT_ROLLS_BACK_ITS_EXACT_LEASE_DELETION');
 assert.equal((await f.control.execute('SELECT count(*) n FROM outbound_messages')).rows[0].n,0);
});
