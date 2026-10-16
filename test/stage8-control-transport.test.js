import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createOwnedDb} from './stage5OwnedDb.js';
import {fixtureKeys} from './localDb.js';
import {hranaTransport} from './hranaTransport.js';
import {createDb} from '../src/db.js';
import {buildPhase4Core} from '../src/phase4Core.js';
import {createPhase4Stage6} from '../src/phase4Reanalysis.js';
import {authorizeStage8LiveProducer} from '../src/stage8LiveProducerAuthority.js';
import {createStage8LiveProducer} from '../src/stage8LiveProducer.js';
import {createStage8PostSync,recordStage8SyncSubject} from '../src/stage8PostSync.js';
import {createExecutionBudget,withExecutionBudget} from '../src/executionBudget.js';
import {createSync} from '../src/sync.js';
import {runExecutionPhase} from '../src/phase4Execution.js';
import {configurationProof,EXECUTION_WORK_MAX_AGE_MS} from '../src/phase4ExecutionStore.js';
import {runningReleaseSha} from '../src/phase4Release.js';

const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const normalized=sql=>sql.replace(/\s+/g,' ').trim();
const isScope=sql=>sql.startsWith('SELECT u.status,u.timezone,u.lifecycle_generation');
const isLock=sql=>sql.startsWith('SELECT 1 FROM resource_locks WHERE name = ? AND owner = ?');
const isParent=sql=>sql==='SELECT state,result_digest,generation FROM phase4_executions WHERE execution_id=?';
const isReady=sql=>sql.startsWith('SELECT u.status,o.state,COALESCE(t.auth_generation,0)');
function sqls(body){
 const out=[];function visit(value){if(!value||typeof value!=='object')return;if(typeof value.sql==='string')out.push(normalized(value.sql));for(const child of Object.values(value))if(child&&typeof child==='object')visit(child);}visit(body);return out;
}
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'stage8-control-')),url=`file:${join(dir,'synthetic.db')}`,seed=createOwnedDb({url});
 let db,transport;t.after(async()=>{db?.close();transport?.close();await rm(dir,{recursive:true,force:true});});
 const environment={PHASE4_BETA_SHADOW_RUNTIME:'off',PHASE4_PUBLIC_BETA_MODE:'off'},releaseSha=runningReleaseSha();
 const request={phase:'SYNC',triggerSource:'manual',requestId:randomUUID(),releaseSha,executionMode:'OFF',configProof:configurationProof(fixtureKeys,{runtime:'off',mode:'off'},environment)};
 try{
  await seed.migrate({targetVersion:35});await seed.createUser({id:'a',displayName:'Synthetic',timezone:'Asia/Taipei',status:'ACTIVE'});
  const admission=await seed.admitRuntime(),core=await buildPhase4Core({keys:fixtureKeys,admission,processing:{client:seed.raw,transaction:seed.transaction,active:seed.processingTransactionActive,afterCommit:seed.afterProcessingCommit,afterCompletion:seed.afterProcessingCompletion},authorizeMode(mode){assert.equal(mode,'SHADOW');}});
  await core.initializeTenant('a','SHADOW');
  await seed.saveTokens('a',{accessToken:'SYNTHETIC_NOT_A_TOKEN',refreshToken:'SYNTHETIC_NOT_A_TOKEN',expiresAt:new Date(Date.now()+3600000).toISOString(),scope:''});
  await seed.ensureOnboarding('a',{state:'READY'});
  for(const resource of ['sleep','recovery','cycle','workout'])await seed.saveSyncState('a',resource,{backfillComplete:true,lastSuccessAt:new Date().toISOString()});
  const response=await runExecutionPhase({db:seed,keys:fixtureKeys,request,environment,env:{dryRun:true,timezone:'Asia/Taipei',telegramBotToken:'SYNTHETIC_NOT_A_TOKEN'},deps:{runBriefing:async()=>{
   const whoop={sleeps:async()=>[],recoveries:async()=>[],cycles:async()=>[],workouts:async()=>[],bodyMeasurement:async()=>({})};
   const sync=await createSync({db:seed,whoop,userId:'a',timezone:'Asia/Taipei',expectedLifecycleGeneration:1}).syncAll({force:true});
   assert.equal(sync.complete,true);await recordStage8SyncSubject({db:seed,userId:'a',sync});
   return {syncComplete:true,syncOutcome:sync.outcome,users:1,failed:0};
  }}});assert.equal(response.body.syncComplete,true);
  // Prepare genuine empty LIVE jobs, without draining or fabricating any work,
  // so both measured legs enter exactly the same existing-generation path.
  const capability=await authorizeStage8LiveProducer({db:seed,keys:fixtureKeys,admission,releaseSha,configProof:'b'.repeat(64),enabled:()=>true,eligible:id=>id==='a'});
  const liveCore=await buildPhase4Core({keys:fixtureKeys,admission,liveProducingAuthority:capability,processing:{client:seed.raw,transaction:seed.transaction,active:seed.processingTransactionActive,afterCommit:seed.afterProcessingCommit,afterCompletion:seed.afterProcessingCompletion},authorizeMode(){}});
  await liveCore.initializeTenant('a','LIVE');
  const worker=await createPhase4Stage6({db:seed,keys:fixtureKeys,admission,executionMode:'LIVE',liveProducingAuthority:capability});await worker.rolloutAlgorithm({userId:'a'});
 }finally{await seed.close();}
 transport=hranaTransport(url);const events=[];
 db=createDb({url:'https://isolated.invalid',phase4Keys:fixtureKeys,fetch:async request=>{
  assert.equal(new URL(request.url).hostname,'isolated.invalid');const body=await request.clone().json();events.push(sqls(body));return transport.fetch(request);
 }});
 return {db,keys:fixtureKeys,environment,request,events,admission:await db.admitRuntime(),
  mutate:async statement=>{const writer=createOwnedDb({url});try{return await writer.raw.execute(statement);}finally{await writer.close();}}};
}
const app=(f,producer,extra={})=>createStage8PostSync({...f,producer,userIds:['a'],eligible:id=>id==='a',enabled:()=>true,...extra});
const invoke=(f,value)=>value.run({executionId:f.request.requestId,userId:'a'});

test('actual LIVE/PostSync readonly fences retain all fresh control SQL while sharing installed Hrana pipelines; BEGIN stays separate',async t=>{
 const f=await fixture(t);let unmark=false;
 // Counterfactual serialization removes only the transport marker, never a
 // guard or its fresh SQL; both runs use the actual closed producer and runner.
 const db={...f.db,withRuntimeFence:(check,fn)=>f.db.withRuntimeFence(unmark?async(...args)=>check(...args):check,fn)};
 const producer=await createStage8LiveProducer({...f,db,userIds:['a'],enabled:()=>true,eligible:id=>id==='a'}),postSync=app({...f,db},producer),measurements=[];
 for(const serial of [true,false]){
  unmark=serial;f.events.length=0;const parent=createExecutionBudget({budgetMs:14000});
  try{assert.equal((await withExecutionBudget(parent,()=>invoke(f,postSync))).status,'ANALYSIS_UPDATING');}finally{parent.close();}
  const statements=f.events.flat(),counts=Object.fromEntries(Object.entries({scope:isScope,lock:isLock,parent:isParent,ready:isReady}).map(([kind,match])=>[kind,statements.filter(match).length]));
  assert.equal(counts.scope,counts.lock);assert.equal(counts.scope,counts.parent);assert.ok(counts.scope>1&&counts.ready>1);
  const began=f.events.filter(values=>values.some(sql=>sql.startsWith('BEGIN')));
  assert.ok(began.length>0);assert.ok(began.every(values=>!values.some(sql=>isScope(sql)||isLock(sql)||isParent(sql)||isReady(sql))),'LIVE does not acquire SYNC-only bundled-BEGIN authority');
  measurements.push({serial,envelopes:f.events.length,counts,fourControlPipeline:f.events.some(values=>[isScope,isLock,isParent,isReady].every(match=>values.some(match)))});
 }
 assert.deepEqual(measurements[0].counts,measurements[1].counts,'no successful guard or fresh SQL observation is cached or removed');
 assert.ok(measurements[1].envelopes<measurements[0].envelopes);assert.equal(measurements[1].fourControlPipeline,true);
 for(const table of ['stage8_live_execution_work_receipts','stage8_live_job_completions','stage8_live_publications'])assert.equal((await f.db.raw.execute(`SELECT count(*) n FROM ${table}`)).rows[0].n,0);
 assert.ok((await f.db.raw.execute('SELECT result_json FROM stage8_live_executions')).rows.every(row=>JSON.parse(row.result_json).outcome==='BUDGET_EXHAUSTED'));
 t.diagnostic(JSON.stringify({kind:'SYNTHETIC_LOGICAL_HRANA_CONTROL_TRANSPORT_ONLY',measurements}));
});

test('PostSync scope denial keeps priority over lock/parent errors and joins the late sibling before returning',{timeout:10000},async t=>{
 const f=await fixture(t);await f.db.raw.execute("UPDATE users SET timezone='UTC' WHERE id='a'");
 const execute=f.db.raw.execute.bind(f.db.raw),entered=deferred(),release=deferred();let parentSettled=false,producerCalls=0,settled=false,locks=0;
 f.db.raw.execute=async statement=>{
  const sql=normalized(typeof statement==='string'?statement:statement.sql),value=await execute(statement);
  if(isLock(sql)){locks++;throw Object.assign(Error('SYNTHETIC_LOCK_READ_FAILURE'),{code:'SYNTHETIC_LOCK_READ_FAILURE'});}
  if(isParent(sql)){entered.resolve();await release.promise;parentSettled=true;throw Error('SYNTHETIC_LATER_PARENT_READ_FAILURE');}
  return value;
 };
 const pending=invoke(f,app(f,{run:async()=>{producerCalls++;throw Error('PRODUCER_MUST_NOT_RUN');}}));pending.then(()=>{settled=true;},()=>{settled=true;});
 try{await entered.promise;await tick();assert.equal(settled,false);release.resolve();await assert.rejects(pending,error=>error.code==='STAGE8_FINALIZED_SYNC_REQUIRED');}
 finally{release.resolve();f.db.raw.execute=execute;}
 assert.equal(parentSettled,true);assert.equal(locks,1);assert.equal(producerCalls,0);
 assert.equal((await f.db.raw.execute("SELECT count(*) n FROM telegram_state WHERE key LIKE 'stage8:sync-progress:%'")).rows[0].n,0);
});

test('PostSync missing lock keeps priority over parent read failure and a rejected group permits no callback',async t=>{
 const f=await fixture(t),acquire=f.db.acquireLock.bind(f.db),execute=f.db.raw.execute.bind(f.db.raw);let parentRead=false,producerCalls=0;
 const db={...f.db,acquireLock:async(name,options)=>{const owner=await acquire(name,options);await f.db.releaseLock(name,owner);return owner;}};
 f.db.raw.execute=async statement=>{const sql=normalized(typeof statement==='string'?statement:statement.sql),value=await execute(statement);if(isParent(sql)){parentRead=true;throw Error('SYNTHETIC_LATER_PARENT_FAILURE');}return value;};
 try{await assert.rejects(invoke(f,app({...f,db},{run:async()=>{producerCalls++;throw Error('PRODUCER_MUST_NOT_RUN');}})),error=>error.code==='STAGE8_FINALIZED_SYNC_REQUIRED');}
 finally{f.db.raw.execute=execute;}
 assert.equal(parentRead,true);assert.equal(producerCalls,0);
});

test('PostSync never reuses a successful scope guard after another synthetic connection revokes auth, READY or purge eligibility',async t=>{
 for(const [name,change] of [
  ['auth',"UPDATE user_whoop_tokens SET auth_generation=auth_generation+1 WHERE user_id='a'"],
  ['READY',"UPDATE user_onboarding SET state='ACTION_REQUIRED' WHERE user_id='a'"],
  ['purge',"UPDATE phase4_user_state SET pending_purge_count=1 WHERE user_id='a'"],
 ])await t.test(name,async tt=>{
  // Each withdrawal owns a new genuine parent. Restoring READY would advance
  // enrollment_revision and correctly make the old signed subject stale.
  const f=await fixture(tt);
  let producerEntered=false,callbackEntered=false;
  const postSync=app(f,{run:async()=>{
   producerEntered=true;await f.mutate(change);
   await f.db.transaction(()=>{callbackEntered=true;});
   throw Error('REVOKED_CALLBACK_MUST_NOT_RUN');
  }});
  await assert.rejects(invoke(f,postSync),error=>error.code==='STAGE8_FINALIZED_SYNC_REQUIRED');
  assert.equal(producerEntered,true,'the first genuine signed scope check passed');assert.equal(callbackEntered,false,'the next boundary independently observes the concurrent revocation');
  assert.equal((await f.db.raw.execute("SELECT count(*) n FROM telegram_state WHERE key LIKE 'stage8:sync-progress:%'")).rows[0].n,0);
 });
});

test('a PostSync fence declared readonly rejects a helper mutation before SQL or the protected callback',async t=>{
 const f=await fixture(t);let inject=false,callbackEntered=false;
 const db={...f.db,holdsLock:async(...args)=>{
  if(inject)await f.db.raw.execute("INSERT INTO telegram_state(key,value,updated_at) VALUES('forbidden-control-write','x','2026-10-16')");
  return f.db.holdsLock(...args);
 }};
 const producer={run:async()=>{inject=true;await f.db.transaction(()=>{callbackEntered=true;});throw Error('PROTECTED_CALLBACK_MUST_NOT_RUN');}};
 await assert.rejects(invoke(f,app({...f,db},producer)),/PROCESSING_READ_ONLY_CHECK_REQUIRED/);
 assert.equal(callbackEntered,false);assert.equal((await f.db.raw.execute("SELECT count(*) n FROM telegram_state WHERE key='forbidden-control-write'")).rows[0].n,0);
});

test('PostSync rechecks exact acquired expiry, original parent age and policy after all metadata settle',async t=>{
 const f=await fixture(t),execute=f.db.raw.execute.bind(f.db.raw),acquire=f.db.acquireLock.bind(f.db),originalNow=Date.now;
 for(const fault of ['lease-expired','parent-expired','disabled','ineligible'])await t.test(fault,async()=>{
  let enabled=true,eligible=true,producerCalls=0,lockExpiresAt,lockAt,metadataCompleted=0,armed=true;
  const db={...f.db,acquireLock:async(name,options)=>{
   assert.ok(options.now instanceof Date);assert.equal(options.ttlMs,60000);lockAt=options.now.getTime();lockExpiresAt=lockAt+60000;
   const owner=await acquire(name,options),stored=(await execute({sql:'SELECT expires_at FROM resource_locks WHERE name=? AND owner=?',args:[name,owner]})).rows[0];
   assert.equal(Date.parse(stored.expires_at),lockExpiresAt);return owner;
  }};
  f.db.raw.execute=async statement=>{
   const sql=normalized(typeof statement==='string'?statement:statement.sql),value=await execute(statement);
   if([isScope,isLock,isParent].some(match=>match(sql)))metadataCompleted++;
   if(isParent(sql)&&armed){armed=false;
    if(fault==='lease-expired')Date.now=()=>lockExpiresAt;
    else if(fault==='parent-expired')Date.now=()=>lockAt+EXECUTION_WORK_MAX_AGE_MS;
    else if(fault==='disabled')enabled=false;
    else eligible=false;
   }
   return value;
  };
  try{await assert.rejects(invoke(f,app({...f,db},{run:async()=>{producerCalls++;throw Error('PRODUCER_MUST_NOT_RUN');}},{enabled:()=>enabled,eligible:id=>eligible&&id==='a'})),error=>error.code==='STAGE8_FINALIZED_SYNC_REQUIRED');}
  finally{Date.now=originalNow;f.db.raw.execute=execute;}
  assert.equal(metadataCompleted,3);assert.equal(producerCalls,0);assert.ok(lockExpiresAt===lockAt+60000);
 });
 assert.equal((await f.db.raw.execute("SELECT count(*) n FROM telegram_state WHERE key LIKE 'stage8:sync-progress:%'")).rows[0].n,0);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM stage8_live_executions')).rows[0].n,0);
});
