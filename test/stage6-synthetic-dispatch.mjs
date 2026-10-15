import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {createHmac} from 'node:crypto';import {createClient} from '@libsql/client';
import {encodeState} from './stage6SyntheticState.mjs';
import {createSyntheticDispatchJournal,dispatchSyntheticRequest,runSyntheticDispatch} from './stage6SyntheticDispatch.mjs';
const keys={lookup:x=>createHmac('sha256','synthetic-dispatch-deterministic-tests-only').update(JSON.stringify(x)).digest('hex')},binding={origin:'a'.repeat(64),databaseId:'s6syn-test-only',manifestDigest:'b'.repeat(64),codeSha:'c'.repeat(40),tenantIds:['s6syn-alpha','s6syn-bravo','s6syn-charlie']};
const request=()=>({requestId:'synthetic-request-1',phase:'STAGE6_DRAIN',executionMode:'SHADOW',triggerSource:'manual',releaseSha:binding.codeSha,configProof:'d'.repeat(64),syncRequestId:'synthetic-parent',handoff:'synthetic-only'}),userId='s6syn-alpha';
const timeout={status:503,body:{ok:false,error:'DRAIN_CHILD_READY_TIMEOUT'}},success={status:200,body:{ok:true,result:{unitsCommitted:1,itemsProcessed:0,jobsFailed:0,jobsCompleted:0}}};
const observation=()=>({child:null,childLifecycle:{readyMs:null,spawnError:null,events:[],stderrBytes:0,stderrStreamClosed:true,exit:{code:null,signal:'SIGTERM',elapsedMs:5200}}});
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'s6-dispatch-')),path=join(root,'db.sqlite'),connections=[];
 const connect=()=>{const client=createClient({url:'file:'+path});let tx;const db={raw:{execute:s=>(tx??client).execute(s),batch:(s,m)=>tx?tx.batch(s):client.batch(s,m)},async transaction(fn){assert.equal(tx,undefined);const owned=await client.transaction('write');tx=owned;try{const result=await fn();await owned.commit();return result;}catch(e){await owned.rollback().catch(()=>{});throw e;}finally{tx=undefined;owned.close();}},close:()=>client.close()};connections.push(db);return db;};
 const now=Date.now(),originalCounter=encodeState({version:1,manifestDigest:binding.origin,databaseId:binding.databaseId,startAt:now-1000,endAt:now-1000+86400000,attempts:314,lastObservedAt:now-500,closed:false,scopes:{control:3,qualification:311}},keys);
 let db=connect();await db.raw.execute('PRAGMA journal_mode=WAL');await db.raw.batch([
 'CREATE TABLE system_heartbeats(scope TEXT NOT NULL,component TEXT NOT NULL,last_ok_at TEXT NOT NULL,last_detail TEXT,updated_at TEXT NOT NULL,PRIMARY KEY(scope,component))',
 'CREATE TABLE phase4_jobs(user_id TEXT,job_kind TEXT,state TEXT,requested_generation INTEGER,scope_revision INTEGER,completed_generation INTEGER,full_scan_cursor TEXT,lease_owner TEXT,last_error_code TEXT,attempt INTEGER)',
 'CREATE TABLE phase4_executions(execution_id TEXT PRIMARY KEY)',
 'CREATE TABLE phase4_execution_work_receipts(execution_id TEXT)',
 'CREATE TABLE phase4_execution_producers(producing_execution_id TEXT PRIMARY KEY)',
 'CREATE TABLE resource_locks(name TEXT PRIMARY KEY)',
 ...['RECOMPUTE_DERIVED','REPAIR_CURRENTNESS'].map(kind=>({sql:'INSERT INTO phase4_jobs VALUES(?,?,?,?,?,?,?,?,?,?)',args:[userId,kind,'PENDING',11,10,0,'retained-source',null,null,7]})),
 {sql:'INSERT INTO system_heartbeats VALUES(?,?,?,?,?)',args:['global','original-exhausted-production-control','retained','12/12-never-modified','retained']},
 {sql:'INSERT INTO system_heartbeats VALUES(?,?,?,?,?)',args:['global','stage6_local_synthetic_http_v1:'+binding.origin,'retained',originalCounter,'retained']},
 ]);
 const jobs=async()=>(await db.raw.execute('SELECT * FROM phase4_jobs ORDER BY user_id,job_kind')).rows;
 const journal=(other=db)=>createSyntheticDispatchJournal({db:other,keys,...binding});
 return {originalCounter,get db(){return db;},journal,connect,jobs,async reopen(){db.close();db=connect();return journal();},async close(){for(const c of connections)c.close();await rm(root,{recursive:true,force:true});}};
}
const withFixture=fn=>async()=>{const f=await fixture();try{await fn(f);}finally{await f.close();}};
const reserve=async(f,j,req=request())=>j.reserve({userId,request:req,beforeJobs:await f.jobs()});
const deliver=async(j,a,response=timeout,run=async()=>response)=>runSyntheticDispatch({journal:j,userId,request:request(),dispatchId:a.id,run,observation});

test('P1 CLOSED: two definite startup timeouts plus repeated restart never dispatch a third time',withFixture(async f=>{
 let j=f.journal(),calls=0;const call=()=>dispatchSyntheticRequest({journal:j,userId,request:request(),beforeJobs:awaitJobs,send:async a=>{calls++;return deliver(j,a);},reconcile:async()=>{throw Error('NO_RECONCILIATION');}}),awaitJobs=await f.jobs();
 await call();let a=(await j.current()).attempts.at(-1);await j.allowRetry({userId,request:request(),dispatchId:a.id});await call();assert.equal(calls,2);
 for(let n=0;n<4;n++){j=await f.reopen();const out=await call();assert.equal(out.transport,'DURABLE_RESPONSE_RECONCILIATION');await assert.rejects(j.allowRetry({userId,request:request(),dispatchId:out.dispatch.id}),/RETRY_SPENT/);await assert.rejects(reserve(f,j),/SPENT_OR_UNCERTAIN/);assert.equal(calls,2);assert.equal((await j.current()).attempts.length,2);}
}));
test('crash after reserve before dispatch stays spent across restart; no worker or ACK inferred',withFixture(async f=>{
 let j=f.journal();await reserve(f,j);j=await f.reopen();let calls=0;await assert.rejects(dispatchSyntheticRequest({journal:j,userId,request:request(),beforeJobs:await f.jobs(),send:async()=>{calls++;},reconcile:async()=>{calls++;}}),/SPENT_OR_UNCERTAIN/);assert.equal(calls,0);assert.equal((await j.current()).completed,false);
}));
test('crash after server acceptance cannot dispatch or claim completion without original reconciliation',withFixture(async f=>{
 let j=f.journal(),a=await reserve(f,j);await j.accept({userId,request:request(),dispatchId:a.id});j=await f.reopen();let calls=0;
 await assert.rejects(dispatchSyntheticRequest({journal:j,userId,request:request(),beforeJobs:await f.jobs(),send:async()=>{calls++;},reconcile:async()=>{throw Error('ORIGINAL_RESULT_INDETERMINATE');}}),/INDETERMINATE/);assert.equal(calls,0);assert.equal((await j.current()).completed,false);await assert.rejects(reserve(f,j),/SPENT_OR_UNCERTAIN/);
}));
test('lost HTTP ACK after durable server outcome is recovered without another dispatch or producer',withFixture(async f=>{
 let j=f.journal(),calls=0,workers=0;await assert.rejects(dispatchSyntheticRequest({journal:j,userId,request:request(),beforeJobs:await f.jobs(),send:async a=>{calls++;await deliver(j,a,success,async()=>{workers++;await f.db.raw.execute({sql:'INSERT INTO phase4_execution_producers VALUES(?)',args:[request().requestId]});return success;});throw Error('LOST_HTTP_ACK');}}),/LOST_HTTP_ACK/);
 j=await f.reopen();const out=await dispatchSyntheticRequest({journal:j,userId,request:request(),beforeJobs:await f.jobs(),send:async()=>{calls++;},reconcile:async()=>{throw Error('UNUSED');}});assert.deepEqual(out.response,success);assert.equal(out.transport,'DURABLE_RESPONSE_RECONCILIATION');assert.equal((await j.current()).completed,false);await j.complete({userId,request:request(),dispatchId:out.dispatch.id,response:out.response});assert.equal(calls,1);assert.equal(workers,1);assert.equal((await f.db.raw.execute('SELECT count(*) n FROM phase4_execution_producers')).rows[0].n,1);
}));
test('commit before response persistence uses original metadata reconciliation, never resend',withFixture(async f=>{
 let j=f.journal(),a=await reserve(f,j);await j.accept({userId,request:request(),dispatchId:a.id});j=await f.reopen();let calls=0,verified=0;
 const out=await dispatchSyntheticRequest({journal:j,userId,request:request(),beforeJobs:await f.jobs(),send:async()=>{calls++;},reconcile:async()=>{verified++;return success;}});assert.equal(out.metadataReconciliation,true);assert.equal((await j.current()).completed,false);await j.complete({userId,request:request(),dispatchId:a.id,response:out.response,metadataReconciliation:true});assert.equal(calls,0);assert.equal(verified,1);assert.equal((await j.current()).completionKind,'ORIGINAL_RUNTIME_RECONCILIATION');
}));
test('two SQLite connections contend atomically: one reservation and one server/worker admission',withFixture(async f=>{
 const first=f.journal(),second=f.journal(f.connect()),beforeJobs=await f.jobs();
 const all=await Promise.allSettled([first.reserve({userId,request:request(),beforeJobs}),second.reserve({userId,request:request(),beforeJobs})]);assert.equal(all.filter(x=>x.status==='fulfilled').length,1);const a=all.find(x=>x.status==='fulfilled').value;let workers=0;
 const accept=journal=>runSyntheticDispatch({journal,userId,request:request(),dispatchId:a.id,run:async()=>{workers++;return success;},observation});const delivered=await Promise.allSettled([accept(first),accept(second)]);assert.equal(delivered.filter(x=>x.status==='fulfilled').length,1);assert.equal(workers,1);assert.equal((await first.current()).attempts.length,1);
}));
test('active campaign pointer prevents competing request IDs; rollback leaves no abandoned reservation',withFixture(async f=>{
 const j=f.journal();await reserve(f,j);const changed={...request(),requestId:'synthetic-competing-request'};await assert.rejects(reserve(f,j,changed),/ACTIVE_REQUEST/);assert.equal((await j.current()).request.requestId,request().requestId);assert.equal((await f.db.raw.execute("SELECT count(*) n FROM system_heartbeats WHERE component LIKE 'stage6_local_dispatch_v1:%'")).rows[0].n,2);
}));
test('fresh retry proof rejects changed authority, work, lease and generation; caller telemetry is insufficient',withFixture(async f=>{
 const j=f.journal(),a=await reserve(f,j);await assert.rejects(j.allowRetry({userId,request:request(),dispatchId:a.id}),/RETRY_SPENT/);await deliver(j,a);
 await f.db.raw.execute({sql:'INSERT INTO phase4_executions VALUES(?)',args:[request().requestId]});await assert.rejects(j.allowRetry({userId,request:request(),dispatchId:a.id}),/NOT_PROVEN/);await f.db.raw.execute('DELETE FROM phase4_executions');
 await j.allowRetry({userId,request:request(),dispatchId:a.id});await f.db.raw.execute('UPDATE phase4_jobs SET requested_generation=12');await assert.rejects(reserve(f,j),/NOT_PROVEN/);assert.equal((await j.current()).attempts.length,1);
}));
test('one valid definite-failure retry survives restart and still requires the exact original identity',withFixture(async f=>{
 let j=f.journal(),a=await reserve(f,j);await deliver(j,a);await j.allowRetry({userId,request:request(),dispatchId:a.id});j=await f.reopen();
 await assert.rejects(j.reserve({userId,request:{...request(),handoff:'forged'},beforeJobs:await f.jobs()}),/IDENTITY_MISMATCH/);const retry=await reserve(f,j);assert.equal(retry.number,2);assert.notEqual(retry.id,a.id);await deliver(j,retry,success);await j.complete({userId,request:request(),dispatchId:retry.id,response:success});await assert.rejects(reserve(f,j),/SPENT_OR_UNCERTAIN/);
 const retained=(await f.db.raw.execute("SELECT component,last_detail FROM system_heartbeats WHERE component LIKE 'original-%' OR component LIKE 'stage6_local_synthetic_http_v1:%' ORDER BY component")).rows;assert.deepEqual(retained.map(x=>x.last_detail),['12/12-never-modified',f.originalCounter]);
}));
test('zero-row CAS and lost DB COMMIT acknowledgment never authorize a dispatch',withFixture(async f=>{
 for(const fault of ['zero','lostAck']){const inner=f.db,db={raw:{...inner.raw,execute:async stmt=>fault==='zero'&&stmt.sql?.startsWith('INSERT INTO system_heartbeats')?{rowsAffected:0}:inner.raw.execute(stmt)},transaction:async fn=>{const out=await inner.transaction(fn);if(fault==='lostAck')throw Error('INDETERMINATE_DB_COMMIT');return out;}};const j=createSyntheticDispatchJournal({db,keys,...binding});let calls=0;await assert.rejects(dispatchSyntheticRequest({journal:j,userId,request:request(),beforeJobs:await f.jobs(),send:async()=>{calls++;}}),fault==='zero'?/CAS_REJECTED/:/INDETERMINATE_DB_COMMIT/);assert.equal(calls,0);}
 const reopened=await f.reopen();assert.equal((await reopened.current()).attempts.at(-1).state,'RESERVED');await assert.rejects(reserve(f,reopened),/SPENT_OR_UNCERTAIN/);
}));
test('tampering, endpoint/code/tenant mismatch and duplicate acceptance fail closed',withFixture(async f=>{
 const j=f.journal(),a=await reserve(f,j);await assert.rejects(j.accept({userId:'s6syn-bravo',request:request(),dispatchId:a.id}),/IDENTITY_MISMATCH/);await assert.rejects(j.accept({userId,request:request(),dispatchId:'forged'}),/OWNER_REJECTED/);
 await f.db.raw.execute("UPDATE system_heartbeats SET last_detail=replace(last_detail,'RESERVED','UNUSED') WHERE component LIKE 'stage6_local_dispatch_v1:%'");await assert.rejects(j.current(),/RECORD_INVALID/);assert.throws(()=>createSyntheticDispatchJournal({db:f.db,keys,...binding,endpoint:'https://example.com/'}),/BINDING_REQUIRED/);
}));

test('pointer CAS rollback is atomic with per-request reservation; response mismatch is never success',withFixture(async f=>{
 const inner=f.db,db={raw:{...inner.raw,execute:async stmt=>stmt.sql?.startsWith('INSERT INTO system_heartbeats')&&stmt.args[0].endsWith(':current')?{rowsAffected:0}:inner.raw.execute(stmt)},transaction:fn=>inner.transaction(fn)};
 const broken=createSyntheticDispatchJournal({db,keys,...binding});await assert.rejects(reserve(f,broken),/CAS_REJECTED/);assert.equal(await f.journal().current(),null);assert.equal((await inner.raw.execute("SELECT count(*) n FROM system_heartbeats WHERE component LIKE 'stage6_local_dispatch_v1:%'")).rows[0].n,0);
 const j=f.journal();await assert.rejects(dispatchSyntheticRequest({journal:j,userId,request:request(),beforeJobs:await f.jobs(),send:async a=>{await deliver(j,a);return success;}}),/RESPONSE_MISMATCH/);assert.equal((await j.current()).completed,false);assert.deepEqual((await j.current()).attempts[0].response.body,timeout.body);
}));
test('expired or exhausted original campaign denies dispatch without changing its ledger',withFixture(async f=>{
 const now=Date.now();for(const change of [{endAt:now-1,startAt:now-1-86400000},{attempts:4096,scopes:{control:3,qualification:4093}},{closed:true}]){
  const state={version:1,manifestDigest:binding.origin,databaseId:binding.databaseId,startAt:now-1000,endAt:now-1000+86400000,attempts:314,lastObservedAt:now-500,closed:false,scopes:{control:3,qualification:311},...change},raw=encodeState(state,keys);await f.db.raw.execute({sql:'UPDATE system_heartbeats SET last_detail=? WHERE component=?',args:[raw,'stage6_local_synthetic_http_v1:'+binding.origin]});let calls=0;
  await assert.rejects(dispatchSyntheticRequest({journal:f.journal(),userId,request:request(),beforeJobs:await f.jobs(),send:async()=>{calls++;}}));assert.equal(calls,0);assert.equal((await f.db.raw.execute({sql:'SELECT last_detail FROM system_heartbeats WHERE component=?',args:['stage6_local_synthetic_http_v1:'+binding.origin]})).rows[0].last_detail,raw);
 }
}));
for(const stage of ['RESERVED','ACCEPTED'])test('actual SIGKILL after '+stage+' preserves spent state in a fresh process',withFixture(async f=>{
 const {spawn}=await import('node:child_process');const path=(await f.db.raw.execute('PRAGMA database_list')).rows[0].file;
  const req={...request(),requestId:'synthetic-process-'+stage};
  const source=`import{createClient}from'@libsql/client';import{createHmac}from'node:crypto';import{createSyntheticDispatchJournal}from ${JSON.stringify(new URL('./stage6SyntheticDispatch.mjs',import.meta.url).href)};const c=createClient({url:${JSON.stringify('file:'+path)}});let tx;const db={raw:{execute:s=>(tx??c).execute(s),batch:(s,m)=>tx?tx.batch(s):c.batch(s,m)},transaction:async fn=>{const t=await c.transaction('write');tx=t;try{const out=await fn();await t.commit();return out;}catch(e){await t.rollback();throw e;}finally{tx=undefined;t.close();}}};const keys={lookup:x=>createHmac('sha256','synthetic-dispatch-deterministic-tests-only').update(JSON.stringify(x)).digest('hex')},j=createSyntheticDispatchJournal({db,keys,...${JSON.stringify(binding)}}),request=${JSON.stringify(req)},a=await j.reserve({userId:${JSON.stringify(userId)},request,beforeJobs:(await c.execute('SELECT * FROM phase4_jobs ORDER BY user_id,job_kind')).rows});if(${JSON.stringify(stage)}==='ACCEPTED')await j.accept({userId:${JSON.stringify(userId)},request,dispatchId:a.id});console.log('DURABLE_READY');setInterval(()=>{},1000);`;
  const child=spawn(process.execPath,['--input-type=module','--eval',source],{stdio:['ignore','pipe','pipe']});let stderr='';child.stderr.on('data',x=>{stderr+=x;});const exit=new Promise(r=>child.once('exit',(code,signal)=>r({code,signal})));let timer;
  try{await new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(Error('TEST_CHILD_BOUND_EXCEEDED')),5000);child.stdout.on('data',chunk=>{if(chunk.toString().includes('DURABLE_READY'))resolve();});child.once('exit',()=>reject(Error('TEST_CHILD_EXIT '+stderr)));});child.kill('SIGKILL');const result=await exit;assert.equal(result.signal,'SIGKILL');const j=await f.reopen();assert.equal((await j.current()).attempts[0].state,stage);let calls=0;await assert.rejects(dispatchSyntheticRequest({journal:j,userId,request:req,beforeJobs:await f.jobs(),send:async()=>{calls++;},reconcile:async()=>{throw Error('ORIGINAL_RESULT_UNKNOWN');}}),/SPENT_OR_UNCERTAIN|UNKNOWN/);assert.equal(calls,0);}finally{clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exit;}
}));
