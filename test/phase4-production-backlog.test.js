import { runningReleaseSha } from '../src/phase4Release.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fixtureKeys} from './localDb.js';
import {createOwnedDb as createDb} from './stage5OwnedDb.js';
import {createPhase4Foundation} from '../src/phase4Foundation.js';
import {createPhase4Stage6,authorizeStage6ShadowWorker} from '../src/phase4Reanalysis.js';
import {runExecutionPhase} from '../src/phase4Execution.js';
import {configurationProof,readPhaseProgress} from '../src/phase4ExecutionStore.js';
const environment={PHASE4_BETA_SHADOW_RUNTIME:'on',PHASE4_PUBLIC_BETA_MODE:'off'};
const now=new Date('2026-10-07T12:00:00Z'),env={dryRun:true};
const makeRequest=(phase='SYNC',extra={})=>({releaseSha:runningReleaseSha(),requestId:randomUUID(),phase,triggerSource:'github',executionMode:'SHADOW',
 configProof:configurationProof(fixtureKeys,{runtime:'on',mode:'off'},environment),...extra});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

test('three tenants / six jobs / 480 passes: bounded PARTIAL, real SIGKILL, restart resumes, repeated drains complete without duplicate receipts or delivery',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'p4-backlog-')),url=`file:${join(dir,'isolated.db')}`;let db=createDb({url});
 t.after(async()=>{await db.close();await rm(dir,{recursive:true,force:true});});await db.migrate({targetVersion:31});
 let admission=await db.admitRuntime();const stores=await createPhase4Foundation({db,keys:fixtureKeys,admission});
 for(const [id,count] of [['T1',23],['T2',115],['T3',99]]){
  await db.createUser({id,displayName:'Synthetic',timezone:'Asia/Taipei',status:'ACTIVE'});await stores.initializeTenant(id,'SHADOW');
  for(let i=0;i<count;i++){
   const at='2026-10-06T11:00:00Z',text=`caffeine at ${at}`;
   const result=await stores.journal.create(await stores.captureControl(id),{sourceEventKey:`item-${i}`,sourceText:text,
    candidate:{category:'caffeine',eventAt:at,valueKind:'PRESENCE',exposureState:'EXPOSED',extractionConfidence:1,excerptStart:0,excerptEnd:text.length}});
   assert.equal(result.status,'ACCEPT');
  }
 }
 assert.equal((await db.raw.execute("SELECT count(*) n FROM phase4_jobs WHERE execution_mode='SHADOW' AND scope_kind<>'NONE'")).rows[0].n,6);
 const worker=()=>createPhase4Stage6({db,keys:fixtureKeys,admission,executionMode:'SHADOW',workerCapability:authorizeStage6ShadowWorker({executionMode:'SHADOW'})});
 let runtime={phase4Stage6:await worker()};
 const run=(request,deps={})=>runExecutionPhase({request,db,keys:fixtureKeys,env,environment,now,deps:{runtime,...deps}});
 const syncRequest=makeRequest(),sync=await run(syncRequest,{runBriefing:async()=>({syncComplete:true,syncOutcome:'NO_NEW_DATA_SUCCESS',users:3,failed:0})});
 const drainRequest=()=>makeRequest('STAGE6_DRAIN',{syncRequestId:syncRequest.requestId,handoff:sync.body.handoff});
 const started=performance.now(),first=await run(drainRequest()),firstTiming=performance.now()-started;
 assert.equal(first.body.result.outcome,'PARTIAL');assert.equal(first.body.result.completion,'PARTIAL');
 assert.equal(first.body.result.itemsProcessed,24);assert.equal(first.body.result.jobsCompleted,0);assert.equal(first.body.result.remainingJobs,6);
 const cursors=(await db.raw.execute("SELECT user_id,job_kind,full_scan_cursor FROM phase4_jobs WHERE full_scan_cursor IS NOT NULL")).rows;
 assert.equal(cursors.length,3);let passes=24;
 const crashRequest=drainRequest(),child=fork(new URL('./phase4BacklogChild.js',import.meta.url),[url,JSON.stringify(crashRequest)],{execArgv:['--expose-gc'],stdio:['ignore','pipe','pipe','ipc']});
 t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
 const checkpoint=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(`child checkpoint timeout ${output}`)),20000);
 child.on('message',m=>{if(m.event==='committed_checkpoint'){clearTimeout(timer);resolve(m);}else if(m.event==='error'){clearTimeout(timer);reject(new Error(JSON.stringify(m)));}});});
 const exit=new Promise(resolve=>child.on('exit',(code,signal)=>resolve({code,signal})));await checkpoint;
 child.kill('SIGKILL');assert.equal((await exit).signal,'SIGKILL');passes++;
 assert.equal((await readPhaseProgress(db,'STAGE6_DRAIN','github')).state,'IN_PROGRESS','old invocation completion cannot stand for a killed newer invocation');
 const requestState=(await db.raw.execute({sql:'SELECT last_detail FROM system_heartbeats WHERE component=?',args:[`phase4_request:${crashRequest.requestId}`]})).rows[0];
 assert.equal(JSON.parse(requestState.last_detail).outcome,'PENDING','crash must not settle completion');
 const committed=(await db.raw.execute("SELECT full_scan_cursor FROM phase4_jobs WHERE state='RUNNING'")).rows;
 assert.equal(committed.length,1);assert.ok(committed[0].full_scan_cursor);
 await db.close();db=createDb({url});admission=await db.admitRuntime();runtime={phase4Stage6:await worker()};
 // Dead owner's tenant lease excludes that scope until its bounded expiry.
 assert.equal((await db.raw.execute({sql:"SELECT count(*) n FROM resource_locks WHERE name LIKE 'phase4-stage6-pass:%' AND expires_at>?",
  args:[new Date().toISOString()]})).rows[0].n,1);
 const heldUser=(await db.raw.execute("SELECT user_id FROM phase4_jobs WHERE state='RUNNING'")).rows[0].user_id;
 const blocked=await runtime.phase4Stage6.drain({triggerSource:'github',userId:heldUser});
 assert.equal(blocked.processedItems,0);assert.equal(blocked.completedJobs,0,'a restart cannot bypass the dead owner before lease expiry');
 await sleep(3100);
 let completed=0,iterations=1,someCompleted=false,last;
 for(;iterations<45;iterations++){
  last=await run(drainRequest());assert.equal(last.status,200,JSON.stringify(last));
  const result=last.body.result;assert.ok(result.itemsProcessed<=24);assert.ok(result.itemsAttempted<=24);
  passes+=result.itemsProcessed;completed+=result.jobsCompleted;someCompleted ||= result.jobsCompleted>0 && result.outcome==='PARTIAL';
  if(result.outcome==='COMPLETE')break;
  assert.equal(result.outcome,'PARTIAL');assert.equal(result.completion,'PARTIAL');
 }
 assert.equal(last.body.result.outcome,'COMPLETE');assert.equal(last.body.result.remainingJobs,0);assert.equal(passes,480);
 assert.equal(completed,6);assert.equal(someCompleted,true);
 const jobs=(await db.raw.execute('SELECT state,scope_kind,completed_generation,requested_generation,last_error_code FROM phase4_jobs')).rows;
 assert.ok(jobs.every(j=>j.state==='COMPLETED'&&j.scope_kind==='NONE'&&j.completed_generation===j.requested_generation));
 assert.ok(jobs.every(j=>j.last_error_code===null),'normal budget exhaustion must not need repair');
 const receiptCount=(await db.raw.execute('SELECT count(*) n FROM phase4_operation_receipts')).rows[0].n;
 assert.equal((await db.raw.execute('SELECT count(*) n FROM (SELECT user_id,execution_mode,operation_kind,operation_key,count(*) c FROM phase4_operation_receipts GROUP BY 1,2,3,4 HAVING c>1)')).rows[0].n,0);
 assert.equal((await db.raw.execute('SELECT count(*) n FROM outbound_messages')).rows[0].n,0);
 assert.equal((await db.raw.execute("SELECT count(*) n FROM phase4_jobs WHERE execution_mode='LIVE'")).rows[0].n,0);
 const empty=await run(drainRequest());assert.equal(empty.body.result.outcome,'NO_WORK');assert.equal(empty.body.result.itemsProcessed,0);
 assert.equal((await db.raw.execute('SELECT count(*) n FROM phase4_operation_receipts')).rows[0].n,receiptCount);
 console.log(JSON.stringify({measurement:'production_like_backlog',firstMs:firstTiming,firstProcessed:24,firstCompleted:0,totalPasses:passes,jobsCompleted:completed,iterations,kill:'SIGKILL',receipts:receiptCount}));
});
