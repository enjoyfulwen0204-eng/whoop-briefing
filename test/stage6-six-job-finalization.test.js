import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createOwnedFileDb} from '../src/db.js';
import {fixtureKeys} from './localDb.js';
import {createPhase4Foundation} from '../src/phase4Foundation.js';
import {createStage8LiveProducer} from '../src/stage8LiveProducer.js';
import {offlineLiveFixtureInput} from './stage8LiveLinuxFixture.js';
import {seedBodyInput} from './bodyEnergyFixture.js';
import {verifyLiveExecutionResult} from '../src/stage8LiveExecution.js';
import {createFamilyDirectory} from '../src/phase4FamilyDirectory.js';

test('bounded original worker progression reaches all six genuine empty-job completions and preserves finalized executions',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'stage6-six-empty-jobs-')),url='file:'+join(directory,'fixture.db');
 let db=createOwnedFileDb({url,phase4Keys:fixtureKeys});t.after(async()=>{global.gc?.();await new Promise(r=>setImmediate(r));db.close();await rm(directory,{recursive:true,force:true});});
 await db.migrate({targetVersion:35});
 const admission=await db.admitRuntime(),foundation=await createPhase4Foundation({db,keys:fixtureKeys,admission}),ids=['a','b','c'];
 for(const id of ids){await db.createUser({id,displayName:'Synthetic',timezone:'Asia/Taipei',status:'ACTIVE'});await db.ensureOnboarding(id,{state:'READY'});await foundation.initializeTenant(id,'SHADOW');const input=offlineLiveFixtureInput({profile:'empty',userId:id,asOf:Date.now()-1000});await db.transaction(()=>seedBodyInput(db,input));}
 let producer=await createStage8LiveProducer({db,keys:fixtureKeys,admission,userIds:ids,enabled:()=>true,eligible:id=>ids.includes(id)});
 const prior=new Map(),calls=[];
 for(let pass=0;pass<6;pass++){
  for(const id of ids){
   const done=(await db.raw.execute({sql:"SELECT count(*) n FROM phase4_jobs WHERE user_id=? AND execution_mode='LIVE' AND state='COMPLETED' AND completed_generation=requested_generation AND scope_kind='NONE'",args:[id]})).rows[0].n;
   if(done===2)continue;
   const result=await producer.run({userId:id,requestId:`synthetic-six-jobs-${id}-${pass}`});assert.equal(result.replayed,false);assert.equal(result.result.jobsFailed,0);
   calls.push({pass,user:id,outcome:result.result.outcome,completedJobs:result.result.jobsCompleted,remainingJobs:result.result.remainingJobs});
   const rows=(await db.raw.execute('SELECT * FROM stage8_live_executions ORDER BY execution_id')).rows;
   for(const row of rows){assert.equal(row.state,'FINALIZED_SUCCESS');verifyLiveExecutionResult(fixtureKeys,row);if(prior.has(row.execution_id))assert.equal(JSON.stringify(row),prior.get(row.execution_id));prior.set(row.execution_id,JSON.stringify(row));}
  }
  const jobs=(await db.raw.execute("SELECT * FROM phase4_jobs WHERE execution_mode='LIVE'")).rows;
  if(jobs.length===6&&jobs.every(j=>j.state==='COMPLETED'))break;
  if(pass===0){global.gc?.();await new Promise(r=>setImmediate(r));db.close();db=createOwnedFileDb({url,phase4Keys:fixtureKeys});producer=await createStage8LiveProducer({db,keys:fixtureKeys,admission:await db.admitRuntime(),userIds:ids,enabled:()=>true,eligible:id=>ids.includes(id)});}
 }
 const jobs=(await db.raw.execute("SELECT * FROM phase4_jobs WHERE execution_mode='LIVE' ORDER BY user_id,job_kind")).rows;
 assert.equal(jobs.length,6);for(const j of jobs){assert.equal(j.state,'COMPLETED',JSON.stringify(calls));assert.equal(j.completed_generation,j.requested_generation);assert.equal(j.scope_kind,'NONE');assert.equal(j.lease_owner,null);assert.equal(j.attempt,0);}
 assert.equal((await db.raw.execute("SELECT count(*) n FROM phase4_computation_state WHERE execution_mode='LIVE' AND last_completed_generation=input_generation")).rows[0].n,3);
 console.log('SYNTHETIC_SIX_JOB_COMPLETION '+JSON.stringify({calls:calls.length,jobs:6,users:3,sourceRows:0,reopenedOwnedConnection:true,productionEvidence:false,linuxCapacityQualified:false,realUserInteraction:false}));
});
test('read-only family completion cannot initialize or accept a missing signed directory',async()=>{
 let mutations=0;const directory=createFamilyDirectory({execute:async stmt=>{const sql=typeof stmt==='string'?stmt:stmt.sql;if(!/^SELECT/.test(sql))mutations++;return {rows:[]};}},fixtureKeys,{live:true});
 assert.equal(await directory.allComplete({userId:'a',executionMode:'LIVE'},'hrv',{create:false}),false);assert.equal(mutations,0);
});
test('one original EOF completion survives 115ms Hrana latency with the modeled five-second transaction bound',async t=>{
 const {createDb}=await import('../src/db.js'),{hranaTransport}=await import('./hranaTransport.js');
 const directory=await mkdtemp(join(tmpdir(),'stage6-eof-http-')),url='file:'+join(directory,'fixture.db');
 let db=createOwnedFileDb({url,phase4Keys:fixtureKeys}),transport,latency=0;
 t.after(async()=>{latency=0;global.gc?.();await new Promise(r=>setImmediate(r));db.close();await new Promise(r=>setTimeout(r,50));transport?.close();await rm(directory,{recursive:true,force:true});});
 await db.migrate({targetVersion:35});const admission=await db.admitRuntime(),foundation=await createPhase4Foundation({db,keys:fixtureKeys,admission});
 await db.createUser({id:'a',displayName:'Synthetic',timezone:'Asia/Taipei',status:'ACTIVE'});await db.ensureOnboarding('a',{state:'READY'});await foundation.initializeTenant('a','SHADOW');
 await db.transaction(()=>seedBodyInput(db,offlineLiveFixtureInput({profile:'empty',userId:'a',asOf:Date.now()-1000})));
 let producer=await createStage8LiveProducer({db,keys:fixtureKeys,admission,userIds:['a'],enabled:()=>true,eligible:id=>id==='a'});
 for(let n=0;n<2;n++)await producer.run({userId:'a',requestId:`synthetic-eof-prepare-${n}`});
 assert.equal((await db.raw.execute("SELECT count(*) n FROM phase4_jobs WHERE execution_mode='LIVE' AND state='COMPLETED'")).rows[0].n,1);
 const original=(await db.raw.execute('SELECT * FROM stage8_live_executions ORDER BY execution_id')).rows.map(r=>JSON.stringify(r));
 global.gc?.();await new Promise(r=>setImmediate(r));db.close();
 transport=hranaTransport(url,{transactionMaxMs:5000,traceTransactions:true});
 db=createDb({url:'https://isolated.invalid',phase4Keys:fixtureKeys,fetch:async r=>{if(latency)await new Promise(resolve=>setTimeout(resolve,latency));return transport.fetch(r);}});
 producer=await createStage8LiveProducer({db,keys:fixtureKeys,admission:await db.admitRuntime(),userIds:['a'],enabled:()=>true,eligible:id=>id==='a'});
 const before=transport.counts.httpRequests;latency=115;const started=performance.now();
 let result;
 try{result=await producer.run({userId:'a',requestId:'synthetic-eof-final-original'});}
 catch(error){latency=0;console.log('SYNTHETIC_EOF_FAILURE_PROFILE '+JSON.stringify({code:error.code,elapsedMs:performance.now()-started,httpRequests:transport.counts.httpRequests-before,byFamily:transport.counts.byFamily,transactions:transport.transactions.map(x=>({durationMs:x.finishedAt-x.startedAt,outcome:x.outcome,sqlOperations:x.sqlOperations,httpOperations:x.httpOperations,statementTables:x.statements.map(s=>s.table??s.verb)})),productionEvidence:false}));throw error;}
 const elapsedMs=performance.now()-started;latency=0;
 assert.equal(result.result.outcome,'COMPLETE',JSON.stringify(result.result));assert.equal(result.result.jobsCompleted,1);assert.equal(result.result.remainingJobs,0);
 const after=(await db.raw.execute('SELECT * FROM stage8_live_executions ORDER BY execution_id')).rows;
 for(const row of original)assert.ok(after.some(r=>JSON.stringify(r)===row));
 assert.equal((await db.raw.execute("SELECT count(*) n FROM phase4_jobs WHERE execution_mode='LIVE' AND state='COMPLETED' AND completed_generation=requested_generation")).rows[0].n,2);
 assert.ok(elapsedMs<45000);assert.equal(transport.evidence.filter(e=>e.event==='transaction_timeout').length,0);
 console.log('SYNTHETIC_EOF_HTTP_PROFILE '+JSON.stringify({elapsedMs,httpRequests:transport.counts.httpRequests-before,addedLatencyMs:115,modeledTransactionLimitMs:5000,productionEvidence:false,nativeLinuxQualified:false,originalRequestsReusedOrReset:false}));
});
