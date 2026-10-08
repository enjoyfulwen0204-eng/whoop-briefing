import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,request,claim,authority,fixtureKeys,environment} from './v32ReviewFixture.js';
import {readExecution} from '../src/phase4ExecutionStore.js';
import {databaseNowMs,withDurableExecution,currentDurableExecution} from '../src/phase4ExecutionContext.js';
import {bodySha256} from '../src/briefingTriggerAuth.js';
import {runExecutionPhase} from '../src/phase4Execution.js';
const context=c=>({claim:c,keys:fixtureKeys,pending:new Set(),authority});
const expire=(db,r)=>db.raw.execute({sql:`UPDATE phase4_executions SET lease_until=${databaseNowMs}-1,deadline_at=${databaseNowMs}-1 WHERE execution_id=?`,args:[r.requestId]});
const rawWork=(db,r,c)=>{
 const result={version:2,releaseSha:r.releaseSha,phase:r.phase,source:r.triggerSource,outcome:'NO_NEW_DATA_SUCCESS',identity:c.identity,configProof:r.configProof,executionMode:r.executionMode};
 const json=JSON.stringify(result);
 return db.raw.execute({sql:`UPDATE phase4_executions SET state='WORK_COMMITTED',result_json=?,result_digest=?,work_committed_at=${databaseNowMs},updated_at=${databaseNowMs} WHERE execution_id=? AND owner=? AND generation=? AND state='ESTABLISHED'`,args:[json,bodySha256(json),r.requestId,c.owner,c.generation]});
};
test('NEW-H01: direct SQL work transition after DB lease/deadline expiry rejects and cannot supply an adopted SYNC success',async t=>{
 const {db}=await fixture(t),r=request(),c=await claim(db,r);await expire(db,r);
 await assert.rejects(()=>rawWork(db,r,c));
 const rejected=await readExecution(db,r.requestId);
 assert.equal(rejected.state,'ESTABLISHED');assert.equal(rejected.result_json,null);assert.equal(rejected.result_digest,null);let callbacks=0;
 const response=await runExecutionPhase({db,request:r,environment,keys:fixtureKeys,env:{dryRun:true},deps:{runBriefing:async()=>{callbacks++;return {syncComplete:true,syncOutcome:'NO_NEW_DATA_SUCCESS'};}}});
 assert.equal(callbacks,1,'a fresh authorized execution must perform legitimate work, not adopt rejected SQL');
 assert.equal(response.body.syncComplete,true);assert.equal((await readExecution(db,r.requestId)).generation,c.generation+1);
});
test('M01: generic UNKEYED mutation of a recognized Phase 4 table rejects before business effect or receipt',async t=>{
 const {db}=await fixture(t);await db.createUser({id:'generic',displayName:'Synthetic',timezone:'Asia/Taipei',status:'ACTIVE'});
 await db.raw.execute("INSERT INTO user_notification_preferences(user_id,preference_version,created_at,updated_at) VALUES('generic',1,'2026-10-08','2026-10-08')");
 const r=request(),c=await claim(db,r);let callbacks=0;
 await assert.rejects(()=>withDurableExecution(context(c),()=>db.transaction(async()=>{callbacks++;await db.raw.execute("UPDATE user_notification_preferences SET preference_version=preference_version+1 WHERE user_id='generic'");})),/WORK_STEP_REQUIRED/);
 assert.equal(callbacks,0);assert.equal((await db.raw.execute("SELECT preference_version v FROM user_notification_preferences WHERE user_id='generic'")).rows[0].v,1);
 assert.equal((await db.raw.execute('SELECT count(*) n FROM phase4_execution_work_receipts')).rows[0].n,0);
 assert.equal((await readExecution(db,r.requestId)).state,'ESTABLISHED');
});

const dbClock=async db=>Number((await db.raw.execute(`SELECT ${databaseNowMs} AS now`)).rows[0].now);
const limits=(db,r,leaseDelta,deadlineDelta)=>db.raw.execute({sql:`UPDATE phase4_executions SET lease_until=${databaseNowMs}+?,deadline_at=${databaseNowMs}+? WHERE execution_id=?`,args:[leaseDelta,deadlineDelta,r.requestId]});
test('NEW-H01: raw SQL DB-time boundaries, deadline-only expiry, stale owner/generation, and no same-generation authority restamp',async t=>{
 const {db}=await fixture(t);
 for(const [name,lease,deadline,valid] of [['clearly-before',30000,30000,true],['lease-boundary',0,0,false],['after-lease',-1,-1,false],['deadline-only',10000,-1,false]]){
  const r=request(),c=await claim(db,r);await limits(db,r,lease,deadline);
  const row=await readExecution(db,r.requestId),clock=await dbClock(db);
  if(valid){assert.ok(row.lease_until>clock&&row.deadline_at>clock);assert.equal((await rawWork(db,r,c)).rowsAffected,1);}
  else{assert.ok(row.lease_until<=clock||row.deadline_at<=clock);await assert.rejects(()=>rawWork(db,r,c),/p4_execution_transition/);assert.equal((await readExecution(db,r.requestId)).state,'ESTABLISHED',name);}
 }
 const impossible=request(),ci=await claim(db,impossible);
 await assert.rejects(()=>limits(db,impossible,-1,10000),/CHECK/,'deadline-valid/lease-expired is unrepresentable by the required deadline<=lease contract');
 const stale=request(),cs=await claim(db,stale);assert.equal((await rawWork(db,stale,{...cs,owner:'stale'})).rowsAffected,0);assert.equal((await rawWork(db,stale,{...cs,generation:cs.generation-1})).rowsAffected,0);
 await expire(db,stale);
 await assert.rejects(()=>limits(db,stale,10000,10000),/p4_execution_transition/,'an expired generation cannot restamp its authority without a fresh ownership generation');
 await assert.rejects(()=>db.raw.execute({sql:`UPDATE phase4_executions SET state='WORK_COMMITTED',result_json='{}',result_digest=?,work_committed_at=${databaseNowMs},lease_until=${databaseNowMs}+10000,deadline_at=${databaseNowMs}+10000 WHERE execution_id=?`,args:['a'.repeat(64),stale.requestId]}));
});
for(const delayed of ['commit','ack','lost-ack'])test(`NEW-H01: valid DB-time work submission then ${delayed} past expiry preserves reconcilable truth`,async t=>{
 const {db,transport,url}=await fixture(t),r=request(),c=await claim(db,r);
 const {createClient}=await import('@libsql/client/sqlite3');const witness=createClient({url});t.after(()=>witness.close());
 const now=async()=>Number((await witness.execute(`SELECT ${databaseNowMs} AS n`)).rows[0].n);
 await limits(db,r,1500,1500);const cutoff=(await readExecution(db,r.requestId)).deadline_at;
 let submittedAt;
 const wait=async()=>{while(await now()<cutoff)await new Promise(resolve=>setTimeout(resolve,10));};
 transport.arm({onlyWorkResult:true,before:async()=>{submittedAt=await now();assert.ok(submittedAt<cutoff,'the authoritative work statement ran while DB authority was valid');if(delayed==='commit')await wait();},
  after:async()=>{if(delayed!=='commit')await wait();},loseAcknowledgement:delayed==='lost-ack'});
 const pending=db.transaction(()=>rawWork(db,r,c));
 if(delayed==='lost-ack')await assert.rejects(()=>pending,/COMMIT_INDETERMINATE/);else await pending;
 assert.ok(await now()>=cutoff);assert.equal((await readExecution(db,r.requestId)).state,'WORK_COMMITTED');
 let work=0;const fresh=await runExecutionPhase({db,request:r,environment,keys:fixtureKeys,env:{dryRun:true},deps:{runBriefing:async()=>{work++;throw Error('NO_BUSINESS_REPLAY');}}});
 assert.equal(work,0);assert.equal(fresh.body.syncComplete,true);assert.equal(fresh.body.drainAuthorized,true);assert.ok(fresh.body.handoff);
 assert.equal((await readExecution(db,r.requestId)).state,'FINALIZED_SUCCESS');
});

test('M01: caught unkeyed known-table mutation cannot turn into finalized SYNC success or a handoff',async t=>{
 const {db}=await fixture(t),r=request();let callback=0;
 const response=await runExecutionPhase({db,request:r,environment,keys:fixtureKeys,env:{dryRun:true},deps:{runBriefing:async()=>{
  try{await db.transaction(async()=>{callback++;await db.raw.execute("UPDATE phase4_user_state SET source_generation=source_generation+1");});}catch{}
  return {syncComplete:true,syncOutcome:'NO_NEW_DATA_SUCCESS'};
 }}});
 assert.equal(callback,0);assert.equal(response.body.syncComplete,false);assert.equal(response.body.drainAuthorized,false);assert.equal(response.body.handoff,undefined);
 assert.notEqual((await readExecution(db,r.requestId)).state,'FINALIZED_SUCCESS');
});

test('M01: recognized-table counter 1 -> 2 exactly once across lost ACK, expiry, fresh admission and repeated retry',async t=>{
 const {db,transport}=await fixture(t);await db.createUser({id:'counter',displayName:'Synthetic',timezone:'Asia/Taipei',status:'ACTIVE'});
 await db.raw.execute("INSERT INTO user_notification_preferences(user_id,preference_version,created_at,updated_at) VALUES('counter',1,'2026-10-08','2026-10-08')");
 const r=request();let c=await claim(db,r),callbacks=0;
 const work=()=>{const execute=()=>db.transaction(async()=>{callbacks++;await db.raw.execute("UPDATE user_notification_preferences SET preference_version=preference_version+1 WHERE user_id='counter'");return 17;},{workStep:'known-counter/increment-1'});return currentDurableExecution()?execute():withDurableExecution(context(c),execute);};
 transport.arm({loseAcknowledgement:true});await assert.rejects(work,/COMMIT_INDETERMINATE/);
 for(let i=0;i<3;i++){await expire(db,r);await db.admitRuntime({fresh:true});c=await claim(db,r);assert.equal(await work(),17);}
 assert.equal(callbacks,1);assert.equal((await db.raw.execute("SELECT preference_version v FROM user_notification_preferences WHERE user_id='counter'")).rows[0].v,2);
 assert.equal((await db.raw.execute({sql:'SELECT count(*) n FROM phase4_execution_work_receipts WHERE execution_id=?',args:[r.requestId]})).rows[0].n,1);
 await expire(db,r);
 const response=await runExecutionPhase({db,request:r,environment,keys:fixtureKeys,env:{dryRun:true},deps:{runBriefing:async()=>{assert.equal(await work(),17);return {syncComplete:true,syncOutcome:'NO_NEW_DATA_SUCCESS'};}}});
 assert.equal(response.body.syncComplete,true);assert.equal(callbacks,1);
});

test('M01: explicitly read-only roots cannot smuggle CTE/quoted/commented business mutations or use a coordination command as caller SQL',async t=>{
 const {db}=await fixture(t);for(const sql of ["WITH x AS (SELECT 1) UPDATE user_notification_preferences SET preference_version=preference_version+1",'/* SELECT */ UPDATE "user_notification_preferences" SET preference_version=preference_version+1']){
  const r=request(),c=await claim(db,r);await assert.rejects(()=>withDurableExecution(context(c),()=>db.transaction(()=>db.raw.execute(sql),{readOnly:true})),/WORK_STEP_REQUIRED/);
 }
 const {executeCoordination}=await import('../src/phase4Coordination.js');await assert.rejects(Promise.resolve().then(()=>executeCoordination(db.raw,'UPDATE user_notification_preferences',[])),/COORDINATION_INVALID/);
 const r=request(),c=await claim(db,r);
 await withDurableExecution(context(c),()=>db.transaction(async()=>{assert.equal((await db.raw.execute("WITH x AS (SELECT 'UPDATE' AS v) SELECT v FROM x")).rows[0].v,'UPDATE');},{readOnly:true}));
});

async function counterFixture(t){const f=await fixture(t);await f.db.createUser({id:'counter',displayName:'Synthetic',timezone:'Asia/Taipei',status:'ACTIVE'});
 await f.db.raw.execute("INSERT INTO user_notification_preferences(user_id,preference_version,created_at,updated_at) VALUES('counter',1,'2026-10-08','2026-10-08')");return f;}
async function spawnCounter(t,url,r,step,mode='work'){
 const {fork}=await import('node:child_process');const process=fork(new URL('./v32FinalChild.js',import.meta.url),[url,JSON.stringify(r),step,mode],{execArgv:['--expose-gc'],stdio:['ignore','pipe','pipe','ipc']});
 t.after(()=>{if(process.exitCode===null&&process.signalCode===null)process.kill('SIGKILL');});let log='';process.stdout.on('data',x=>log+=x);process.stderr.on('data',x=>log+=x);
 const message=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('COUNTER_CHILD_TIMEOUT:'+log)),15000);process.once('message',m=>{clearTimeout(timer);resolve(m);});});
 const exit=new Promise(resolve=>process.once('exit',(code,signal)=>resolve({code,signal,log})));return {process,message,exit};
}
test('M01: two real processes race one known-table step; loser re-admits and reconciles; two distinct steps both commit',async t=>{
 const {db,url}=await counterFixture(t),r=request();await claim(db,r);await expire(db,r);
 const [a,b]=await Promise.all([spawnCounter(t,url,r,'same-counter-step'),spawnCounter(t,url,r,'same-counter-step')]);
 const messages=await Promise.all([a.message,b.message]);for(const p of [a,b])assert.equal((await p.exit).code,0);
 assert.ok(messages.every(m=>m.result===17),JSON.stringify(messages));assert.equal(messages.reduce((n,m)=>n+m.callbacks,0),1);
 assert.equal((await db.raw.execute("SELECT preference_version v FROM user_notification_preferences WHERE user_id='counter'")).rows[0].v,2);
 assert.equal((await db.raw.execute('SELECT count(*) n FROM phase4_execution_work_receipts')).rows[0].n,1);
 const [c,d]=await Promise.all([spawnCounter(t,url,request(),'distinct-A'),spawnCounter(t,url,request(),'distinct-B')]);
 const distinct=await Promise.all([c.message,d.message]);for(const p of [c,d])assert.equal((await p.exit).code,0);
 assert.equal(distinct.reduce((n,m)=>n+m.callbacks,0),2);assert.equal((await db.raw.execute("SELECT preference_version v FROM user_notification_preferences WHERE user_id='counter'")).rows[0].v,4);
 assert.equal((await db.raw.execute('SELECT count(*) n FROM phase4_execution_work_receipts')).rows[0].n,3);
});
test('M01: real SIGKILL after known-table COMMIT leaves one effect/receipt and fresh process never calls business work again',async t=>{
 const {db,url}=await counterFixture(t),r=request(),child=await spawnCounter(t,url,r,'death-counter-step','kill');
 const committed=await child.message;assert.equal(committed.event,'committed');assert.equal(committed.callbacks,1);child.process.kill('SIGKILL');assert.equal((await child.exit).signal,'SIGKILL');
 const row=await readExecution(db,r.requestId);while(await dbClock(db)<row.lease_until)await new Promise(r=>setTimeout(r,10));
 const retry=await spawnCounter(t,url,r,'death-counter-step'),result=await retry.message;assert.equal((await retry.exit).code,0);assert.equal(result.callbacks,0);assert.equal(result.result,17);
 assert.equal((await db.raw.execute("SELECT preference_version v FROM user_notification_preferences WHERE user_id='counter'")).rows[0].v,2);
 assert.equal((await db.raw.execute('SELECT count(*) n FROM phase4_execution_work_receipts')).rows[0].n,1);
});

test('M01: real sync-window retry skips both fetch and business mutation despite a later invocation clock',async t=>{
 const {db,transport}=await counterFixture(t),r=request();let c=await claim(db,r),fetches=0;
 const {createSync}=await import('../src/sync.js'),{LIFECYCLE_UNFENCED}=await import('../src/accountLifecycle.js');
 const make=now=>createSync({db,whoop:{sleeps:async()=>{fetches++;return []; }},userId:'counter',timezone:'Asia/Taipei',expectedLifecycleGeneration:LIFECYCLE_UNFENCED,now});
 transport.arm({matchSql:/INSERT INTO whoop_sync_state/,loseAcknowledgement:true});
 await assert.rejects(()=>withDurableExecution(context(c),()=>make(new Date('2026-10-08T06:00:00Z')).incremental('sleep')),/COMMIT_INDETERMINATE/);
 await expire(db,r);await db.admitRuntime({fresh:true});c=await claim(db,r);
 const replay=await withDurableExecution(context(c),()=>make(new Date('2026-10-08T07:00:00Z')).incremental('sleep'));
 assert.equal(fetches,1);assert.deepEqual(replay,{resource:'sleep',mode:'incremental',fetched:0,written:0});
 assert.equal((await db.getSyncState('counter','sleep')).latestSynced,'2026-10-08T06:00:00.000Z');
 assert.equal((await db.raw.execute({sql:'SELECT count(*) n FROM phase4_execution_work_receipts WHERE execution_id=?',args:[r.requestId]})).rows[0].n,2,'one effect receipt and one atomic aggregate-count receipt');
});

test('M01: claim-next APIs identify distinct canonical events, and replayed delivery/notification acquisition is not a fresh grant',async t=>{
 const {db}=await counterFixture(t);
 for(const resourceId of ['first','second'])await db.recordWhoopEvent({whoopUserId:'synthetic',eventType:'sleep.updated',resourceType:'sleep',resourceId,traceId:resourceId});
 const r=request(),c=await claim(db,r);await withDurableExecution(context(c),async()=>{
  const a=await db.claimWhoopEvent({owner:'synthetic-owner',leaseMs:30000}),b=await db.claimWhoopEvent({owner:'synthetic-owner',leaseMs:30000});
  assert.notEqual(a.id,b.id);assert.equal(a.attemptCount,1);assert.equal(b.attemptCount,1);
  assert.equal(await db.claimWhoopEvent({owner:'synthetic-owner',leaseMs:30000}),null);
  assert.equal(await db.claimLocalePrompt('counter'),true);assert.equal(await db.claimLocalePrompt('counter'),false,'durable old acquisition cannot grant another send');
 });
 assert.equal((await db.raw.execute('SELECT count(*) n FROM phase4_execution_work_receipts')).rows[0].n,3);
});
