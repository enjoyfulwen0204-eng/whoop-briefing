// Isolated original Hrana LIVE component progression. The first three genuine
// units gate the remaining bounded cycles; no Production/pilot authority.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {open} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {createDb} from '../src/db.js';
import {createPhase4Foundation} from '../src/phase4Foundation.js';
import {authorizeStage8LiveProducer} from '../src/stage8LiveProducerAuthority.js';
import {buildPhase4Core} from '../src/phase4Core.js';
import {createPhase4Stage6} from '../src/phase4Reanalysis.js';
import {createStage8LiveExecutionRunner,verifyLiveExecutionResult} from '../src/stage8LiveExecution.js';
import {createStage8LivePreparedWorker} from '../src/stage8LivePreparedWork.js';
import {publishStage8Live,verifyStage8LivePublication,assertStage8LiveJobsFinalized} from '../src/stage8LivePublication.js';
import {createStage8DerivedReader} from '../src/stage8DerivedReader.js';
import {createScopedHealthContext} from '../src/scopedHealthContext.js';
import {STAGE8_LIVE_DRAIN_BUDGET} from '../src/stage8LiveDrainPolicy.js';
import {fixtureKeys as keys} from './localDb.js';
import {seedBodyInput} from './bodyEnergyFixture.js';
import {ownedFileScenario,scenarioInput,assertPreservedGenerations} from './stage6-owned-file-scenario.mjs';
import {createPreparedNativeObserver} from './stage8-prepared-native-observer.mjs';
import {nativePreparedResultDigest} from './stage8-prepared-native-result.mjs';
import {assertPreparedNativeFinalObservation} from './stage8-prepared-native-final-observation.mjs';
import {log} from '../src/logger.js';
for(const name of ['info','warn','error'])log[name]=()=>{};
const mode=process.argv[2];assert.ok(['WORK_TO_EOF','COLD_REPLAY'].includes(mode));assert.equal(process.argv.length,3);
assert.equal(process.version,'v22.23.2');assert.equal(process.platform,'linux');
for(const [name,value] of Object.entries(process.env))if(/^(?:GIT_|TURSO_|WHOOP_|TELEGRAM_|OPENROUTER_|PHASE4_|RENDER_|CLOUDFLARE_)/.test(name))assert.ok(!value,'NO_EXTERNAL_ENVIRONMENT');
const root=resolve(new URL('..',import.meta.url).pathname),manifest=JSON.parse(readFileSync(resolve(root,'source-manifest.json'),'utf8')),statePath=resolve(root,'..','native-progression-ack.json');
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex'),canonical=row=>Object.keys(row).sort().map(k=>[k,row[k]]);
for(const [path,sha] of Object.entries(manifest.files))assert.equal(createHash('sha256').update(readFileSync(resolve(root,path))).digest('hex'),sha,'EXACT_LOADED_SOURCE');
const scenario=ownedFileScenario('three-tenant'),url='http://127.0.0.1:18083',nativeFetch=globalThis.fetch.bind(globalThis),observer=createPreparedNativeObserver();
let phase='SETUP',requests=0,pending=0,errors=0,callbackEntered=false;
const fetchOwned=async(input,init)=>{
 const req=new Request(input,init);assert.equal(new URL(req.url).origin,url);const body=await req.clone().json(),event=observer.submitted(body,phase,performance.now());requests++;pending++;
 try{
  const response=await nativeFetch(req,{signal:AbortSignal.any([req.signal,AbortSignal.timeout(10000)]),redirect:'error'}),reply=await response.clone().json();assert.ok(response.ok);observer.acknowledged(event,reply,performance.now());
  for(const item of reply.results??[]){if(item.type==='error')errors++;for(const error of item.response?.result?.step_errors??[])if(error)errors++;}
  return response;
 }finally{pending--;}
};
globalThis.fetch=fetchOwned;const db=createDb({url,phase4Keys:keys,fetch:fetchOwned});let report,failure,pendingAckBody;
const readRows=async table=>(await db.raw.execute('SELECT * FROM '+table)).rows;
async function snapshot(){
 const tables=(await db.raw.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")).rows.map(r=>r.name);assert.ok(tables.length<=128);
 tables.forEach(n=>assert.match(n,/^[a-z0-9_]+$/));
 const results=await db.raw.batch(tables.map(name=>'SELECT * FROM '+name+' LIMIT 4097'),'deferred');assert.ok(results.every(r=>r.rows.length<=4096));
 const all=[],source=[],tenants=Object.fromEntries(scenario.users.map(id=>[id,[]])),originals={},executions={};let sourceRows=0;
 for(let i=0;i<tables.length;i++){
  const table=tables[i],rows=results[i].rows,values=rows.map(canonical).map(JSON.stringify).sort();
  if(table==='resource_locks')continue;all.push([table,values]);
  if(table.startsWith('whoop_')||['users','user_whoop_tokens','phase4_user_state'].includes(table))source.push([table,values]);
  if(['whoop_sleeps','whoop_recoveries','whoop_cycles','whoop_workouts'].includes(table))sourceRows+=rows.length;
  for(const uid of scenario.users)tenants[uid].push([table,rows.filter(r=>table==='users'?r.id===uid:r.user_id===uid).map(canonical).map(JSON.stringify).sort()]);
  if(table==='stage8_live_executions')for(const row of rows){assert.equal(row.state,'FINALIZED_SUCCESS');assert.equal(row.generation,1);assert.equal(row.deadline_at-row.created_at,45000);assert.equal(row.lease_until-row.created_at,60000);verifyLiveExecutionResult(keys,row);executions[row.execution_id]=digest(canonical(row));}
  const primary={stage8_live_execution_work_receipts:['receipt_key'],stage8_live_operation_receipts:['user_id','execution_mode','operation_kind','operation_key'],stage8_live_execution_producers:['user_id','execution_mode','input_generation','producing_execution_id'],phase4_execution_producers:['user_id','execution_mode','input_generation','producing_execution_id'],phase4_execution_work_receipts:['receipt_key'],phase4_operation_receipts:['user_id','execution_mode','operation_kind','operation_key']}[table];
  if(primary)originals[table]=Object.fromEntries(rows.map(r=>[JSON.stringify(primary.map(k=>r[k])),digest(canonical(r))]));
 }
 const schema=(await db.raw.execute("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type,name")).rows;
 return {allDigest:digest(all),sourceDigest:digest(source),schemaDigest:digest(schema),sourceRows,executions,originals,jobAuthority:digest((await db.raw.execute("SELECT user_id,job_kind,requested_generation,scope_revision FROM phase4_jobs WHERE execution_mode='LIVE' ORDER BY user_id,job_kind")).rows),tenantDigests:Object.fromEntries(Object.entries(tenants).map(([id,rows])=>[id,digest(rows)])),generations:Object.fromEntries((await db.raw.execute('SELECT user_id,execution_mode,input_generation,source_generation_seen,algorithm_set_version FROM phase4_computation_state ORDER BY user_id,execution_mode')).rows.map(r=>[JSON.stringify([r.user_id,r.execution_mode]),digest(canonical(r))]))};
}
function preserve(before,after,uid){
 assert.equal(after.sourceRows,23);assert.equal(after.sourceDigest,before.sourceDigest);assert.equal(after.schemaDigest,before.schemaDigest);assertPreservedGenerations(before.generations,after.generations);assert.equal(after.jobAuthority,before.jobAuthority,'ORIGINAL_JOB_AUTHORITY_CHANGED');
 for(const [table,entries]of Object.entries(before.originals))for(const [id,sha]of Object.entries(entries))assert.equal(after.originals[table][id],sha,'ORIGINAL_RECEIPT_CHANGED');
 for(const [id,sha]of Object.entries(before.executions))assert.equal(after.executions[id],sha,'ORIGINAL_FINALIZED_EXECUTION_CHANGED');
 if(uid!==null)for(const other of scenario.users.filter(id=>id!==uid))assert.equal(after.tenantDigests[other],before.tenantDigests[other],'OTHER_TENANT_CHANGED');
}
function checkedTransactions(name){const actual=observer.assertComplete(name);assert.ok(actual.every(t=>t.outcome==='COMMIT'&&t.upperBoundMs<5000),'ALL_EXPLICIT_WORK_TX_BELOW_5S');return actual;}
async function jobs(){const rows=(await db.raw.execute("SELECT * FROM phase4_jobs WHERE execution_mode='LIVE' ORDER BY user_id,job_kind")).rows;assert.equal(rows.length,6);for(const r of rows){assert.equal(r.attempt,0);assert.ok(r.completed_generation<=r.requested_generation);}return rows;}
try{
 const prior=mode==='COLD_REPLAY'?JSON.parse(readFileSync(statePath,'utf8')):null;
 if(prior){const {seal,...body}=prior;assert.equal(seal,keys.lookup(['r22-native-progression-ack-v1',body]));assert.equal(prior.contract,'r22-native-six-original-eof-ack-v1');assert.notEqual(prior.pid,process.pid);assert.equal(prior.manifestDigest,digest(manifest));}
 if(!prior){
  assert.equal((await db.raw.execute("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")).rows[0].n,0);await db.migrate({targetVersion:35});const foundation=await createPhase4Foundation({db,keys,admission:await db.admitRuntime()});
  for(const [i,id]of scenario.users.entries()){await db.createUser({id,displayName:'Synthetic native progression '+id,timezone:'Asia/Taipei',status:'ACTIVE'});await foundation.initializeTenant(id,'SHADOW');await db.transaction(()=>seedBodyInput(db,scenarioInput(scenario,id,Date.now()-1000)));await db.ensureOnboarding(id,{state:'READY'});await db.linkTelegram({userId:id,chatId:String(10001+i)});await db.setLocale(id,'en');}
 }
 const admission=await db.admitRuntime(),capability=await authorizeStage8LiveProducer({db,keys,admission,releaseSha:manifest.baseCommit,configProof:keys.lookup(['isolated-r22-native-progression',manifest.files]),enabled:()=>true,eligible:id=>scenario.users.includes(id)});
 const core=await buildPhase4Core({keys,admission,liveProducingAuthority:capability,processing:{client:db.raw,transaction:db.transaction,active:db.processingTransactionActive,assertFences:db.assertRuntimeFences,afterCommit:db.afterProcessingCommit,afterCompletion:db.afterProcessingCompletion},authorizeMode(mode,client,id){assert.equal(mode,'LIVE');assert.equal(client,db.raw);assert.ok(scenario.users.includes(id));}});
 if(!prior){const canonical=await createPhase4Stage6({db,keys,admission,executionMode:'LIVE',liveProducingAuthority:capability});for(const id of scenario.users){await core.initializeTenant(id,'LIVE');await canonical.rolloutAlgorithm({userId:id});}await jobs();}
 const prepared=createStage8LivePreparedWorker({db,keys,capability}),run=createStage8LiveExecutionRunner({db,keys,capability,capture:id=>core.capture(id,{executionMode:'LIVE',providerRequired:true}),assertContext:c=>core.assertContext(c),work:async(userId,context)=>{
  callbackEntered=true;assert.equal(mode,'WORK_TO_EOF','COLD_REPLAY_MUST_NOT_ENTER_WORK');const value=await prepared.drain({userId,context});return {outcome:value.outcome,itemsProcessed:value.processedItems,unitsCommitted:value.unitsCommitted,jobsCompleted:value.completedJobs,jobsFailed:value.failedJobs,remainingJobs:value.remainingJobs};
 }});
 if(prior){
  phase='COLD_VERIFY';const before=await snapshot();assert.deepEqual(before,prior.state,'DB_CHANGED_BETWEEN_PHYSICAL_PROCESSES');
  phase='COLD_REPLAY';for(const id of scenario.users){const result=await run({userId:id,requestId:prior.firstRequests[id]});assert.equal(result.replayed,true);assert.equal(nativePreparedResultDigest(result.result),prior.firstResults[id]);}
  assert.equal(callbackEntered,false);checkedTransactions('COLD_REPLAY');phase='COLD_VERIFY';assert.deepEqual(await snapshot(),before,'SAME_RID_COLD_REPLAY_MUTATED_DURABLE_GRAPH');checkedTransactions('COLD_VERIFY');
  report={status:'THREE_ORIGINAL_IDENTITIES_COLD_REPLAY_UNCHANGED',producerPid:prior.pid,coldPid:process.pid,workCallbackEntered:false,originalGraphDigest:before.allDigest,sourceAndOriginalGenerationsPreserved:true,fullEOFComponent:true,fullProducerQualified:false,stage6HranaQualified:false,productionEvidence:false};
 }else{
  phase='VERIFY';let state=await snapshot();assert.equal(state.sourceRows,23);const firstRequests={},firstResults={},progression=[],complete=new Set(),typed={};const start=performance.now();
  for(let ordinal=1;ordinal<=20;ordinal++){
   // First three cover every tenant. Later invocations only serve unfinished
   // canonical jobs. These are test cycles, not retries of an old RID.
   const id=ordinal<=3?scenario.users[ordinal-1]:scenario.users.find(id=>!complete.has(id));assert.ok(id,'NO_UNFINISHED_TENANT');
   const requestId='r22-native-six-original-'+ordinal,workPhase='WORK_'+ordinal;phase=workPhase;const before=requests,at=performance.now(),value=await run({userId:id,requestId}),elapsedMs=performance.now()-at,workHttp=requests-before;
   assert.equal(value.replayed,false);assert.equal(value.result.jobsFailed,0);assert.notEqual(value.result.outcome,'FAILED');assert.ok(value.result.unitsCommitted||value.result.itemsProcessed||value.result.jobsCompleted,'NO_REAL_COMMITTED_PROGRESS');assert.ok(value.result.itemsProcessed+value.result.unitsCommitted<=STAGE8_LIVE_DRAIN_BUDGET.maxItemsPerTenant);
   const tx=checkedTransactions(workPhase),publication=prepared.status().publication;assert.equal(publication.commit,'ACKNOWLEDGED');assert.ok(publication.transactionUpperBoundMs<5000);assert.equal(prepared.status().disposal.holdReleased,true);
   firstRequests[id]??=requestId;firstResults[id]??=nativePreparedResultDigest(value.result);
   phase='VERIFY';const currentJobs=await jobs(),mine=currentJobs.filter(r=>r.user_id===id);
   if(mine.every(r=>r.state==='COMPLETED')){for(const row of mine){assert.equal(row.scope_kind,'NONE');assert.equal(row.full_scan_cursor,null);assert.equal(row.completed_generation,row.requested_generation);assert.equal(row.lease_owner,null);}const ctx=await core.capture(id,{executionMode:'LIVE',providerRequired:true});await assertStage8LiveJobsFinalized(core,ctx);complete.add(id);}
   assert.equal((await db.raw.execute("SELECT count(*) n FROM resource_locks WHERE name LIKE '%:prepared-disposal:%'")).rows[0].n,0);
   const after=await snapshot();preserve(state,after,id);assert.equal(Object.keys(after.executions).length,ordinal);checkedTransactions('VERIFY');state=after;
   const packet={ordinal,tenantOrdinal:scenario.users.indexOf(id)+1,result:value.result,workHttp,elapsedMs,publication,transactions:tx,completedJobs:currentJobs.filter(r=>r.state==='COMPLETED').length,completedTenants:complete.size,sourceRows:23,sourceAndOriginalGenerationsPreserved:true,otherTenantsUnchanged:true,originalReceiptsPreserved:true};progression.push(packet);console.log('R22_NATIVE_SIX_PROGRESS '+JSON.stringify(packet));
   if(ordinal===3)console.log('R22_NATIVE_SIX_PREFIX '+JSON.stringify({status:'REPRESENTATIVE_THREE_TENANT_PREFIX_PASS',workInvocations:3,original45s60s:true,sourceAndGenerationsPreserved:true,boundedCommittedProgress:true,fullEOFQualified:false,productionEvidence:false}));
   if(complete.size===3)break;
  }
  assert.equal(complete.size,3,'FULL_SOURCE_FAMILY_EOF_NOT_REACHED_WITHIN_TWENTY_ORIGINAL_CYCLES');
  const allJobs=await jobs();assert.ok(allJobs.every(r=>r.state==='COMPLETED'&&r.scope_kind==='NONE'&&r.full_scan_cursor===null&&r.completed_generation===r.requested_generation&&r.lease_owner===null));
  // Separate existing atomic publication and scoped readers after authentic
  // canonical EOF/completion receipts and original execution finalization.
  for(const id of scenario.users){phase='PUBLICATION_'+id;const ctx=await core.capture(id,{executionMode:'LIVE',providerRequired:true});await publishStage8Live(core,ctx,capability);assert.equal(await verifyStage8LivePublication(core,ctx),true);checkedTransactions(phase);
   phase='READER_'+id;const reader=createStage8DerivedReader({db,keys,admission,eligible:uid=>uid===id}),scopes=await createScopedHealthContext({db,keys,admission,derivedReader:reader});typed[id]=[];
   for(const kind of ['BODY_ENERGY','EPISODES','EVIDENCE','INSIGHTS']){const scope=await scopes.open({user:await db.getUser(id),chatId:String(10001+scenario.users.indexOf(id)),text:'/insights'}),result=await scopes.derived(scope,kind);assert.equal(result.status,'CURRENT');typed[id].push({kind,items:result.items.length});if(kind==='INSIGHTS')assert.equal(result.items.length,0,'NO_MANUFACTURED_INSIGHT');if(kind==='BODY_ENERGY'){if(id==='a')assert.ok(result.items.length>0);else assert.equal(result.items.length,0);assert.ok(result.items.every(item=>item.quality==='LIMITED'&&item.provisional===true&&item.estimated===true&&Number.isInteger(item.value)&&item.value>=0&&item.value<=100));}}
   checkedTransactions(phase);
  }
  phase='VERIFY';assert.equal((await db.raw.execute('SELECT count(*) n FROM outbound_messages')).rows[0].n,0);assert.equal((await db.raw.execute("SELECT count(*) n FROM system_heartbeats WHERE component LIKE 'phase4_beta_pilot_permit%'")).rows[0].n,0);const finalState=await snapshot();preserve(state,finalState,null);checkedTransactions('VERIFY');
  pendingAckBody={contract:'r22-native-six-original-eof-ack-v1',manifestDigest:digest(manifest),pid:process.pid,firstRequests,firstResults,state:finalState,progression,typed};
  report={status:'NATIVE_SIX_JOB_FULL_EOF_COMPONENT_PASS',tenants:3,sourceRows:23,applicableJobs:6,completedJobs:6,trueSourceAndFamilyEOF:true,workInvocations:progression.length,elapsedMs:performance.now()-start,original45sDeadline60sLeasePreserved:true,sourceAndOriginalGenerationsPreserved:true,originalReceiptsAndExecutionsPreserved:true,currentAtomicPublications:3,typed,fullProducerQualified:false,stage6HranaQualified:false,actualProviderEvidence:false,productionEvidence:false,absoluteServerInterruption:'UNKNOWN'};
 }
}catch(error){failure=error;report={status:'NATIVE_SIX_PROGRESSION_FAILED',mode,phase,errorCode:error.code??error.name,message:String(error.message).slice(0,300),productionEvidence:false,fullEOFQualified:false};}
finally{
 try{
  db.close();const until=performance.now()+4000;while((observer.streams.size||pending)&&performance.now()<until)await new Promise(r=>setTimeout(r,20));assert.equal(observer.streams.size,0,'NATIVE_STREAMS_NOT_JOINED');assert.equal(pending,0,'NATIVE_PENDING_REQUESTS');
  assertPreparedNativeFinalObservation(observer,pending);assert.equal(errors,0,'NATIVE_SQL_RESPONSE_ERRORS');
  if(!failure&&pendingAckBody){const body={...pendingAckBody,transportJoined:true,allRuntimeObservationComplete:true},file=await open(statePath,'wx',0o600);try{await file.writeFile(JSON.stringify({...body,seal:keys.lookup(['r22-native-progression-ack-v1',body])}));await file.sync();}finally{await file.close();}const directory=await open(resolve(statePath,'..'),'r');try{await directory.sync();}finally{await directory.close();}}
 }catch(error){failure??=error;}

 console.log('R22_NATIVE_SIX_WORKER '+JSON.stringify({...report,status:failure?'NATIVE_SIX_PROGRESSION_FAILED':report.status,cleanupError:failure?.message,mode,requests,errors,openStreams:observer.streams.size,pendingRequests:pending,transactions:observer.transactions,observation:observer.counts}));
}
if(failure)process.exitCode=1;
