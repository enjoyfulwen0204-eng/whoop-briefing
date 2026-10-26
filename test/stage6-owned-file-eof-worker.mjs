// One original synthetic factory call per physical process. No fixture result,
// cursor, receipt, permit, generation, deadline or authority is installed.
import assert from 'node:assert/strict';
import {readFile,open,lstat,realpath} from 'node:fs/promises';
import {dirname,basename,join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {createOwnedFileDb} from '../src/db.js';
import {createPhase4Foundation} from '../src/phase4Foundation.js';
import {createStage8LiveProducer} from '../src/stage8LiveProducer.js';
import {verifyLiveExecutionResult} from '../src/stage8LiveExecution.js';
import {createStage8DerivedReader} from '../src/stage8DerivedReader.js';
import {createScopedHealthContext} from '../src/scopedHealthContext.js';
import {fixtureKeys as keys} from './localDb.js';
import {seedBodyInput} from './bodyEnergyFixture.js';
import {ownedFileScenario,scenarioInput,assertPreservedGenerations,assertCurrentOriginalReplay} from './stage6-owned-file-scenario.mjs';
import {observeOwnedFileTransactions} from './stage6-owned-file-observer.mjs';
const [supplied,mode,ordinalText,scenarioName]=process.argv.slice(2),scenario=ownedFileScenario(scenarioName);
assert.equal(process.argv.length,6);assert.ok(['INIT','WORK','REPLAY'].includes(mode));assert.match(ordinalText??'',/^(0|[1-9][0-9]?)$/);
const ordinal=Number(ordinalText);assert.ok(ordinal<24);assert.equal(mode==='INIT',ordinal===0);
assert.equal(process.version,'v22.23.2');
const directory=await realpath(supplied);assert.equal(directory,supplied);assert.equal((await lstat(supplied)).isSymbolicLink(),false);
assert.equal(dirname(directory),await realpath(tmpdir()));assert.match(basename(directory),/^healthos-owned-file-eof-[a-zA-Z0-9_-]+$/);
const sha=process.env.PHASE4_RELEASE_SHA;assert.match(sha??'',/^[a-f0-9]{40}$/);
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const rows=async table=>(await db.raw.execute('SELECT * FROM '+table)).rows;
const canonical=row=>Object.keys(row).sort().map(k=>[k,typeof row[k]==='bigint'?['bigint',String(row[k])]:row[k]]);
const requestId=n=>'owned-file-eof-original-'+n;
async function snapshot(){
 const tenants=Object.fromEntries(scenario.users.map(uid=>[uid,[]]));
 const names=(await db.raw.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")).rows.map(r=>r.name),all=[],source=[];
 for(const name of names){assert.match(name,/^[a-z0-9_]+$/);if(name==='resource_locks')continue;const data=await rows(name),values=data.map(canonical).map(JSON.stringify).sort();assert.ok(values.length<=4096);all.push([name,values]);for(const uid of scenario.users)tenants[uid].push([name,data.filter(row=>name==='users'?row.id===uid:row.user_id===uid).map(canonical).map(JSON.stringify).sort()]);if(name.startsWith('whoop_')||['users','user_whoop_tokens','phase4_user_state'].includes(name))source.push([name,values]);}
 const schema=(await db.raw.execute("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type,name")).rows.map(canonical);
 const executions=await rows('stage8_live_executions');for(const row of executions){assert.equal(row.state,'FINALIZED_SUCCESS');assert.equal(row.generation,1);assert.equal(row.deadline_at-row.created_at,45000);assert.equal(row.lease_until-row.created_at,60000);verifyLiveExecutionResult(keys,row);}
 const originals={};
 for(const [table,pk] of [['stage8_live_execution_work_receipts',['receipt_key']],['stage8_live_operation_receipts',['user_id','execution_mode','operation_kind','operation_key']],['stage8_live_execution_producers',['user_id','execution_mode','input_generation','producing_execution_id']],['phase4_execution_producers',['user_id','execution_mode','input_generation','producing_execution_id']],['phase4_execution_work_receipts',['receipt_key']],['phase4_operation_receipts',['user_id','execution_mode','operation_kind','operation_key']]]){
  originals[table]=Object.fromEntries((await rows(table)).map(row=>[JSON.stringify(pk.map(key=>row[key])),hash(canonical(row))]));
 }
 const sourceRows=(await db.raw.execute('SELECT (SELECT count(*) FROM whoop_sleeps)+(SELECT count(*) FROM whoop_recoveries)+(SELECT count(*) FROM whoop_cycles)+(SELECT count(*) FROM whoop_workouts) n')).rows[0].n;
 return {allDigest:hash(all),schemaDigest:hash(schema),sourceDigest:hash(source),sourceRows,executions:Object.fromEntries(executions.map(row=>[row.execution_id,hash(canonical(row))])),
  originals,receiptCount:(await db.raw.execute('SELECT count(*) n FROM stage8_live_execution_work_receipts')).rows[0].n,
  tenantDigests:Object.fromEntries(Object.entries(tenants).map(([uid,values])=>[uid,hash(values)])),
  generations:Object.fromEntries((await db.raw.execute("SELECT user_id,execution_mode,input_generation,source_generation_seen,algorithm_set_version FROM phase4_computation_state ORDER BY user_id,execution_mode")).rows.map(row=>[JSON.stringify([row.user_id,row.execution_mode]),hash(canonical(row))]))};
}
const observer=observeOwnedFileTransactions();let db,packet,failure,cleanupFailure,finalObservation,closed=false,prior;
try{
 const url=pathToFileURL(join(directory,'fixture.sqlite')).href;
 if(mode!=='INIT'){assert.equal((await lstat(join(directory,'fixture.sqlite'))).isSymbolicLink(),false);prior=JSON.parse(await readFile(join(directory,'ack-'+(ordinal-1)+'.json'),'utf8'));const {seal,...body}=prior;assert.equal(seal,keys.lookup(['owned-file-eof-ack-v1',body]));assert.equal(prior.sha,sha);assert.equal(prior.closed,true);assert.equal(prior.ordinal,ordinal-1);assert.equal(prior.scenario,scenario.name);if(mode!=='REPLAY')assert.notEqual(prior.mode,'REPLAY');}
 db=createOwnedFileDb({url,phase4Keys:keys});if(mode!=='INIT')observer.arm();
 if(mode==='INIT'){
  await db.migrate({targetVersion:35});const foundation=await createPhase4Foundation({db,keys,admission:await db.admitRuntime()});
  for(const [index,uid]of scenario.users.entries()){
   await db.createUser({id:uid,displayName:'Synthetic FILE EOF '+uid,timezone:'Asia/Taipei',status:'ACTIVE'});await foundation.initializeTenant(uid,'SHADOW');
   await db.transaction(()=>seedBodyInput(db,scenarioInput(scenario,uid,Date.now()-1000)));await db.ensureOnboarding(uid,{state:'READY'});await db.linkTelegram({userId:uid,chatId:String(10001+index)});await db.setLocale(uid,'en');
  }
  const state=await snapshot();assert.equal(state.sourceRows,scenario.sources);assert.equal(Object.keys(state.executions).length,0);packet={mode,ordinal,sha,scenario:scenario.name,state,ready:false,completedUsers:[],replayedUsers:[],firstOrdinals:{},firstResultDigests:{},typed:{}};
 }else{
  await db.admitRuntime();const before=await snapshot();assert.deepEqual(before,prior.state,'DURABLE_STATE_CHANGED_BETWEEN_PHYSICAL_PROCESSES');
  const producer=await createStage8LiveProducer({db,keys,admission:await db.admitRuntime(),userIds:scenario.users,enabled:()=>true,eligible:id=>scenario.users.includes(id)});
  const uid=mode==='REPLAY'?scenario.users.find(id=>!prior.replayedUsers.includes(id)):scenario.users.find(id=>!prior.completedUsers.includes(id));assert.ok(uid,'NO_PENDING_TENANT_REQUIRED');
  const value=await producer.run({userId:uid,requestId:requestId(mode==='REPLAY'?prior.firstOrdinals[uid]:ordinal)});assert.equal(value.result.jobsFailed,0);assert.equal(value.result.outcome==='FAILED',false);
  const jobs=(await db.raw.execute({sql:"SELECT job_kind,state,scope_kind,requested_generation,completed_generation,full_scan_cursor,attempt,lease_owner FROM phase4_jobs WHERE execution_mode='LIVE' AND user_id=? ORDER BY job_kind",args:[uid]})).rows;assert.equal(jobs.length,2);
  for(const row of jobs)assert.equal(row.attempt,0);
  const typed=structuredClone(prior.typed),completedUsers=[...prior.completedUsers],replayedUsers=[...prior.replayedUsers],firstOrdinals={...prior.firstOrdinals},firstResultDigests={...prior.firstResultDigests};if(value.publication.status==='CURRENT'){
   for(const row of jobs){assert.equal(row.state,'COMPLETED');assert.equal(row.scope_kind,'NONE');assert.equal(row.full_scan_cursor,null);assert.equal(row.completed_generation,row.requested_generation);assert.equal(row.lease_owner,null);}
   assert.equal((await db.raw.execute({sql:"SELECT count(*) n FROM phase4_computation_state WHERE execution_mode='LIVE' AND user_id=? AND input_generation=last_completed_generation",args:[uid]})).rows[0].n,1);
   // New Q&A requests create their own legitimate scoped-read audit rows.
   // Verify these on actual completion; duplicate-ID replay must be observed
   // alone so its entire durable-state equality includes every prior audit.
   if(!completedUsers.includes(uid))completedUsers.push(uid);
   if(mode!=='REPLAY'){typed[uid]=[];const admission=await db.admitRuntime(),reader=createStage8DerivedReader({db,keys,admission,eligible:id=>id===uid}),scopes=await createScopedHealthContext({db,keys,admission,derivedReader:reader});
   for(const kind of ['BODY_ENERGY','EPISODES','EVIDENCE','INSIGHTS']){
    const scope=await scopes.open({user:await db.getUser(uid),chatId:String(10001+scenario.users.indexOf(uid)),text:'/insights'}),result=await scopes.derived(scope,kind);assert.equal(result.status,'CURRENT');typed[uid].push({kind,items:result.items.length});
    if(kind==='INSIGHTS')assert.equal(result.items.length,0,'insufficient baseline must not manufacture Insights');
    if(kind==='BODY_ENERGY'){if(uid==='a')assert.ok(result.items.length>0);else assert.equal(result.items.length,0,'minimal sample must remain a valid empty Body Energy result');assert.ok(result.items.every(item=>item.quality==='LIMITED'&&item.provisional===true&&item.estimated===true&&Number.isInteger(item.value)&&item.value>=0&&item.value<=100));}
   }}
  }
  assert.equal((await db.raw.execute('SELECT count(*) n FROM outbound_messages')).rows[0].n,0);assert.equal((await db.raw.execute("SELECT count(*) n FROM system_heartbeats WHERE component LIKE 'phase4_beta_pilot_permit%'")).rows[0].n,0);
  const state=await snapshot();assert.equal(state.sourceDigest,prior.state.sourceDigest);assert.equal(state.schemaDigest,prior.state.schemaDigest);assert.equal(state.sourceRows,scenario.sources);
  for(const [table,entries] of Object.entries(prior.state.originals))for(const [id,digest] of Object.entries(entries))assert.equal(state.originals[table][id],digest,'ORIGINAL_RECEIPT_OR_PRODUCER_CHANGED:'+table);
  for(const [id,digest] of Object.entries(prior.state.executions))assert.equal(state.executions[id],digest,'ORIGINAL_FINALIZED_EXECUTION_CHANGED');
  assertPreservedGenerations(prior.state.generations,state.generations);
  for(const other of scenario.users.filter(id=>id!==uid))assert.equal(state.tenantDigests[other],prior.state.tenantDigests[other],'OTHER_TENANT_DURABLE_STATE_CHANGED');
  if(mode==='REPLAY'){assert.equal(prior.ready,true);assertCurrentOriginalReplay(value);assert.equal(hash(canonical(value.result)),prior.firstResultDigests[uid]);replayedUsers.push(uid);assert.deepEqual(state,prior.state,'ORIGINAL_ID_REPLAY_CHANGED_DURABLE_STATE');}
  else{assert.equal(value.replayed,false);assert.ok(value.result.itemsProcessed||value.result.unitsCommitted||value.result.jobsCompleted,'NO_DURABLE_PROGRESS_STOP');assert.equal(Object.keys(state.executions).length,ordinal);}
  if(mode!=='REPLAY'&&!Object.hasOwn(firstOrdinals,uid)){firstOrdinals[uid]=ordinal;firstResultDigests[uid]=hash(canonical(value.result));}
  const ready=completedUsers.length===scenario.users.length;
  if(ready){const allJobs=(await db.raw.execute("SELECT state,scope_kind,full_scan_cursor,requested_generation,completed_generation,lease_owner FROM phase4_jobs WHERE execution_mode='LIVE'")).rows;assert.equal(allJobs.length,scenario.jobs);for(const row of allJobs){assert.equal(row.state,'COMPLETED');assert.equal(row.scope_kind,'NONE');assert.equal(row.full_scan_cursor,null);assert.equal(row.requested_generation,row.completed_generation);assert.equal(row.lease_owner,null);}}
  packet={mode,ordinal,sha,scenario:scenario.name,state,ready,publicationStatus:value.publication.status,completedUsers,replayedUsers,firstOrdinals,firstResultDigests,result:{outcome:value.result.outcome,unitsCommitted:value.result.unitsCommitted,jobsCompleted:value.result.jobsCompleted,remainingJobs:value.result.remainingJobs},typed,observation:observer.snapshot()};
 }
}catch(error){failure=(error.code??error.name)+':'+String(error.stack??'').split('\n').find(line=>line.includes('eof-worker.mjs'));}
finally{
 try{await db?.close();closed=true;}catch(error){cleanupFailure=error.code??error.name;failure??='OWNED_DB_CLOSE_FAILED';}
 try{finalObservation=mode==='INIT'?observer.snapshot():observer.assertComplete();if(packet)packet.observation=finalObservation;}catch(error){finalObservation=observer.snapshot();cleanupFailure??='FINAL_NATIVE_OBSERVATION_FAILED';failure??='FINAL_NATIVE_OBSERVATION_FAILED';}
 observer.close();
}
if(!failure){const body={...packet,closed},file=await open(join(directory,'ack-'+ordinal+'.json'),'wx',0o600);
 try{await file.writeFile(JSON.stringify({...body,seal:keys.lookup(['owned-file-eof-ack-v1',body])}));await file.sync();}finally{await file.close();}
 const parent=await open(directory,'r');try{await parent.sync();}finally{await parent.close();}
}
console.log('OWNED_FILE_EOF_CHILD '+JSON.stringify({contract:'owned-file-eof-physical-child-v1',mode,ordinal,sha,scenario:scenario.name,closed,failed:Boolean(failure),failure:failure?String(failure).slice(0,180):null,cleanupFailure:cleanupFailure??null,
 ready:packet?.ready??false,publicationStatus:packet?.publicationStatus??null,observation:finalObservation??observer.snapshot(),explicitNativeBeginTransactionsOnly:true,absoluteTransactionInterruption:'UNKNOWN',implicitSQLiteTransactions:'UNKNOWN',productionEvidence:false,nativeHranaQualified:false,sixJobsQualified:false}));
process.exitCode=failure||!closed?1:0;
