import {BODY_ENERGY_PROVISIONAL_POLICY as PROVISIONAL} from '../src/bodyEnergyProvisionalPolicy.js';
import {assertBodyEnergyPublication} from '../src/bodyEnergyQualificationAuthority.js';
import {renderBodyEnergy} from '../src/bodyEnergyPresentation.js';
import test from 'node:test';import assert from 'node:assert/strict';
import {syntheticPhase4Fixture} from './phase4Fixture.js';
import Database from 'libsql';import {createDb} from '../src/db.js';
import {fixtureKeys} from './localDb.js';
import {createPhase4Foundation} from '../src/phase4Foundation.js';import {bodyInput,seedBodyInput} from './bodyEnergyFixture.js';
import {bodyHealthDate} from '../src/bodyEnergyInputs.js';
import {createPhase4Stage6,authorizeStage6ShadowWorker} from '../src/phase4Reanalysis.js';
import {request,claim,authority} from './v32ReviewFixture.js';
import {commitPhaseWork,finalizePhaseWork} from '../src/phase4ExecutionStore.js';import {withDurableExecution,currentDurableExecution} from '../src/phase4ExecutionContext.js';
import {authorizeBodyEnergyPublication,authorizeBodyEnergyFixturePublication} from '../src/bodyEnergyQualificationAuthority.js';
import {createBodyEnergyIntegration} from '../src/bodyEnergyIntegration.js';
import {canonicalJson} from '../src/phase4EntityStore.js';import {OPERATION_RECEIPT_VERSION} from '../src/phase4V27Schema.js';

async function setup(t,{applicationMemory=false,days=30,unequal=false}={}){
 let db;
 if(applicationMemory){
  // Only this case uses the actual application factory + existing strict
  // fixture grant. The other cases own independent pinned named memories;
  // no shared fixed-memory name is reused across cases or caller inputs.
  const anchor=new Database('file::memory:?cache=shared');db=createDb({url:'file::memory:?cache=shared',phase4Keys:fixtureKeys});
  t.after(async()=>{global.gc?.();await new Promise(resolve=>setImmediate(resolve));db.close();anchor.close();global.gc?.();await new Promise(resolve=>setImmediate(resolve));});
  await db.migrate();for(const id of ['a','b'])await db.createUser({id,displayName:'Synthetic',timezone:'Asia/Taipei',status:'ACTIVE'},{now:new Date()});
 }else{const fixture=await syntheticPhase4Fixture(t,{targetVersion:30,now:()=>new Date()});db=fixture.db;await db.migrate({targetVersion:32});}
 for(const id of ['a','b'])await db.setLocale(id,id==='a'?'zh-TW':'vi');
 const stores=await createPhase4Foundation({db,keys:fixtureKeys,admission:await db.admitRuntime()});for(const id of ['a','b'])await stores.initializeTenant(id,'SHADOW');
 const input=bodyInput({asOf:Date.now()-1000,days});
 if(unequal)input.sources.recovery[1].hrv_rmssd_milli=null;
 const captureAt=new Date(input.asOfEpochMs).toISOString();
 input.sources.workout.push({user_id:'a',id:'workout-ongoing',start_at:captureAt,end_at:null,strain:1,
  created_at:captureAt,updated_at:captureAt,synced_at:captureAt});
 for(const row of input.sources.sleep){row.health_date=bodyHealthDate(Date.parse(row.end_at),input.timezone);input.sources.recovery.find(r=>r.sleep_id===row.id).health_date=row.health_date;}
 await db.transaction(()=>seedBodyInput(db,input));await db.ensureOnboarding('a',{state:'READY'});
 await stores.queue.sourceChanged(await stores.captureControl('a'));
 const worker=await createPhase4Stage6({db,keys:fixtureKeys,executionMode:'SHADOW',workerCapability:authorizeStage6ShadowWorker({executionMode:'SHADOW'})});
 const sync=request(),sc=await claim(db,sync);await commitPhaseWork(db,sync,sc,{outcome:'NO_NEW_DATA_SUCCESS'},authority);
 const complete=await finalizePhaseWork(db,sync,sc,fixtureKeys,authority),r=request({phase:'STAGE6_DRAIN',syncRequestId:sync.requestId,handoff:complete.handoff}),c=await claim(db,r);
 const drained=await withDurableExecution({claim:c,keys:fixtureKeys,pending:new Set(),authority},()=>worker.drain({budget:{maxJobs:1,maxItems:1,maxItemsPerTenant:1}}));
 assert.equal(drained.outcome,'PARTIAL');assert.equal(drained.completedJobs,0);assert.equal(drained.failedJobs,0);
 const finish=async()=>{await commitPhaseWork(db,r,c,{outcome:drained.outcome,itemsProcessed:drained.processedItems,jobsCompleted:0,jobsFailed:0,remainingJobs:drained.remainingJobs,completion:'PARTIAL'},authority);
  const parent=await finalizePhaseWork(db,r,c,fixtureKeys,authority);assert.equal(parent.settlementState,'FINALIZED_SUCCESS');assert.equal(parent.outcome,'PARTIAL');};
 const read=async(userId='a',presentationPolicy=null)=>stores.withContext(userId,{executionMode:'SHADOW',providerRequired:true},context=>stores.bodyEnergy.readForPublication(context,
  {healthDate:bodyHealthDate(Date.now(),'Asia/Taipei'),asOfEpochMs:Date.now(),presentationPolicy}));
 const metadata=async()=>({state:(await db.raw.execute("SELECT input_generation,last_completed_generation,source_generation_seen FROM phase4_computation_state WHERE user_id='a' AND execution_mode='SHADOW'")).rows[0],
  jobs:(await db.raw.execute("SELECT job_kind,state,scope_kind,full_scan_cursor,requested_generation,completed_generation,lease_owner FROM phase4_jobs WHERE user_id='a' ORDER BY job_kind")).rows});
 return {db,stores,input,worker,finish,read,metadata,r,c};
}

test('ACKed complete Body source/domain with finalized PARTIAL parent is visible to a fresh readonly qualified consumer while whole generation/Beta remain pending',async t=>{
 const f=await setup(t,{applicationMemory:true});assert.equal(currentDurableExecution(),undefined);

 assert.equal((await f.read()).status,'PROCESSING');await f.finish();
 const before=await f.metadata();assert.ok(before.state.last_completed_generation<before.state.input_generation);
 assert.ok(before.jobs.every(j=>j.completed_generation<j.requested_generation&&j.lease_owner===null));
 const view=await f.read();assert.equal(view.status,'AVAILABLE');assert.equal(view.value,70);assert.ok(view.publicationProof);
 await assert.rejects(f.read('b'),/AUTH_FENCED/);
 assert.equal(view.provenance.included.loadKind,'CYCLE');
 assert.ok(view.provenance.sources.some(r=>r.type==='workout'&&r.id==='workout-ongoing'&&r.roles.includes('NOTIFICATION_EVENT_ONLY')));
 const drop=await f.stores.withContext('a',{executionMode:'SHADOW',providerRequired:true},context=>f.stores.bodyEnergy.readDropCandidate(context,
  {previousResultId:view.resultId,healthDate:view.healthDate,asOfEpochMs:Date.now()}));
 assert.equal(drop.view.status,'AVAILABLE');assert.equal(drop.eligible,false);assert.equal(drop.reason,'NO_NEW_RESULT');
 const cohort=await authorizeBodyEnergyFixturePublication({db:f.db,userIds:['a']}),ui=createBodyEnergyIntegration({db:f.db,stores:f.stores,keys:fixtureKeys,publicationCapability:cohort});
 for(const locale of ['zh-TW','vi','en']){await f.db.setLocale('a',locale);const result=await ui.query({text:'/energy',userId:'a'});
  assert.match(result.message,/Synthetic.*70\/100/);assert.equal(await result.verifyCurrent(),true);
  const morning=await ui.currentSection({userId:'a'});assert.equal(morning.status,'AVAILABLE');assert.equal(await morning.verifyCurrent(),true);}
 const beta=await f.stores.withContext('a',{executionMode:'SHADOW'},context=>f.stores.betaSummary.readCurrent(context,{asOfUtc:new Date().toISOString()}));
 assert.deepEqual(beta.episodes,[]);assert.deepEqual(beta.insights,[]);assert.deepEqual(await f.metadata(),before);
 const prepared=await ui.query({text:'/energy',userId:'a'}),user=await f.db.getUser('a');
 await f.db.updateUser('a',{displayName:'Synthetic ABA'});await f.db.updateUser('a',{displayName:user.displayName});
 await assert.rejects(prepared.verifyCurrent(),/RECIPIENT_FENCED/);
 const foreign=await ui.query({text:'/energy',userId:'b'});assert.equal(foreign.status,'QUALIFICATION_PENDING');assert.doesNotMatch(foreign.message,/70\/100/);
 assert.equal(authorizeBodyEnergyPublication({db:f.db,userIds:['a'],qualificationId:'on'}),null);
 const pending=createBodyEnergyIntegration({db:f.db,stores:f.stores,keys:fixtureKeys,publicationCapability:null});
 assert.equal((await pending.query({text:'/energy',userId:'a'})).status,'QUALIFICATION_PENDING');
});

test('foreign result, provider-value correction, revoked auth, purge, inactive lifecycle and stale generation deny source-only publication',async t=>{
 const f=await setup(t);await f.finish();const view=await f.read();assert.equal(view.status,'AVAILABLE');
 await f.db.raw.execute("UPDATE whoop_cycles SET strain=18 WHERE user_id='a' AND id='cycle-current'");await assert.rejects(f.read(),/VERSION_MISMATCH/);
 await f.db.raw.execute("UPDATE whoop_cycles SET strain=0 WHERE user_id='a' AND id='cycle-current'");
 await f.db.raw.execute("UPDATE user_whoop_tokens SET auth_generation=auth_generation+1 WHERE user_id='a'");await assert.rejects(f.read(),/PARENT_STALE/);
 await f.db.raw.execute("UPDATE user_whoop_tokens SET auth_generation=auth_generation-1 WHERE user_id='a'");
 await f.db.raw.execute("UPDATE phase4_user_state SET pending_purge_count=1 WHERE user_id='a'");await assert.rejects(f.read(),/PURGE_FENCED/);
 await f.db.raw.execute("UPDATE phase4_user_state SET pending_purge_count=0 WHERE user_id='a'");
 await f.stores.queue.sourceChanged(await f.stores.captureControl('a'));assert.equal((await f.read()).status,'PROCESSING');
 await f.db.transitionUserLifecycle({userId:'a',targetStatus:'DISABLED'});await assert.rejects(f.read(),/LIFECYCLE_FENCED/);
});

const reseal=row=>{row.receipt_hmac=fixtureKeys.digest(row.content_digest_salt,canonicalJson([OPERATION_RECEIPT_VERSION,Object.fromEntries(Object.entries(row)
 .filter(([key])=>!['receipt_hmac','health_content_redacted_at','health_content_redaction_reason','source_subject_deleted_at'].includes(key)))]));return row;};
async function tamperReads(f,match,change,work){const original=f.db.raw.execute;f.db.raw.execute=async statement=>{
 const result=await original(statement),sql=typeof statement==='string'?statement:statement?.sql??'';
 return match(sql)?{...result,rows:result.rows.map(row=>change({...row}))}:result;};try{return await work();}finally{f.db.raw.execute=original;}}

test('producer claim alone, missing domain/source ACK, bad HMAC/schema/closure or malformed parent cannot authorize a numeric view',async t=>{
 const f=await setup(t);await f.finish();assert.equal((await f.read()).status,'AVAILABLE');
 const domain=sql=>/SELECT \* FROM phase4_operation_receipts WHERE user_id/.test(sql);
 await tamperReads(f,domain,row=>({...row,receipt_hmac:'0'.repeat(64)}),()=>assert.rejects(f.read(),/RECEIPT_INTEGRITY/));
 await tamperReads(f,domain,row=>{const value=JSON.parse(row.schema_contract_json);value.body_energy_results[0].type='SYNTHETIC_WRONG_SCHEMA';row.schema_contract_json=canonicalJson(value);return reseal(row);},()=>assert.rejects(f.read(),/RESULT_UNAVAILABLE/));
 await tamperReads(f,domain,row=>{const value=JSON.parse(row.required_roots_json);value.roots=value.roots.filter(r=>!(r.type==='sleep'&&r.id==='sleep-00'));
  value.root_count=value.roots.length;value.serialized_bytes=Buffer.byteLength(canonicalJson(value.roots));row.required_roots_json=canonicalJson(value);return reseal(row);},()=>assert.rejects(f.read(),/ROOTS_INCOMPLETE/));
 await tamperReads(f,domain,row=>{const value=JSON.parse(row.required_roots_json);value.roots=value.roots.filter(r=>r.type!=='workout');
  value.root_count=value.roots.length;value.serialized_bytes=Buffer.byteLength(canonicalJson(value.roots));row.required_roots_json=canonicalJson(value);return reseal(row);},()=>assert.rejects(f.read(),/ROOTS_INCOMPLETE/));
 await tamperReads(f,domain,row=>{const value=JSON.parse(row.required_roots_json);value.roots.push({...value.roots[0],content_hash:'0'.repeat(64)});
  value.root_count=value.roots.length;value.serialized_bytes=Buffer.byteLength(canonicalJson(value.roots));row.required_roots_json=canonicalJson(value);return reseal(row);},()=>assert.rejects(f.read(),/ROOTS_AMBIGUOUS/));
 const work=sql=>/SELECT \* FROM phase4_execution_work_receipts WHERE execution_id/.test(sql);
 await tamperReads(f,work,row=>({...row,receipt_key:'0'.repeat(64)}),()=>assert.rejects(f.read(),/RECEIPT_INVALID/));
 const producer=sql=>/FROM phase4_execution_producers p JOIN phase4_executions/.test(sql);
 await tamperReads(f,producer,row=>({...row,result_digest:'0'.repeat(64)}),()=>assert.rejects(f.read(),/PARENT_INVALID/));
 await tamperReads(f,producer,row=>({...row,state:'WORK_COMMITTED'}),async()=>assert.equal((await f.read()).status,'PROCESSING'));
 await tamperReads(f,producer,row=>({...row,state:'FINALIZED_FAILURE'}),async()=>assert.equal((await f.read()).status,'PROCESSING'));
 await tamperReads(f,producer,row=>({...row,tenant_proof:'0'.repeat(64)}),()=>assert.rejects(f.read(),/PRODUCER_INVALID/));
 assert.equal((await f.read()).status,'AVAILABLE');
});

test('non-score workout closure still requires exact owned current canonical values, source access and original captured freshness',async t=>{
 const f=await setup(t);await f.finish();assert.equal((await f.read()).status,'AVAILABLE');
 await f.db.raw.execute("UPDATE whoop_workouts SET strain=2 WHERE user_id='a' AND id='workout-ongoing'");await assert.rejects(f.read(),/VERSION_MISMATCH/);
 await f.db.raw.execute("UPDATE whoop_workouts SET strain=1 WHERE user_id='a' AND id='workout-ongoing'");
 await f.db.raw.execute("UPDATE whoop_resource_access SET status='FORBIDDEN' WHERE user_id='a' AND resource='workout'");await assert.rejects(f.read(),/RESOURCE_FENCED/);
 await f.db.raw.execute("UPDATE whoop_resource_access SET status='ACCESSIBLE' WHERE user_id='a' AND resource='workout'");
 const captured=f.input.sources.workout[0],fields=Object.keys(captured);
 await f.db.raw.execute("DELETE FROM whoop_workouts WHERE user_id='a' AND id='workout-ongoing'");await assert.rejects(f.read(),/SOURCE_NOT_FOUND/);
 await f.db.raw.execute({sql:`INSERT INTO whoop_workouts(${fields.join(',')}) VALUES(${fields.map(()=>'?').join(',')})`,args:fields.map(k=>captured[k])});
 await f.db.raw.execute({sql:"UPDATE whoop_workouts SET synced_at=? WHERE user_id='a' AND id='workout-ongoing'",args:[new Date(Date.now()+60000).toISOString()]});
 await assert.rejects(f.read(),/VERSION_MISMATCH/);
 await f.db.raw.execute({sql:"UPDATE whoop_workouts SET synced_at=? WHERE user_id='a' AND id='workout-ongoing'",args:[captured.synced_at]});
 assert.equal((await f.read()).status,'AVAILABLE');
 const restarted=await createPhase4Foundation({db:f.db,keys:fixtureKeys,admission:await f.db.admitRuntime()});
 const view=await restarted.withContext('a',{executionMode:'SHADOW',providerRequired:true},context=>restarted.bodyEnergy.readForPublication(context,
  {healthDate:bodyHealthDate(Date.now(),'Asia/Taipei'),asOfEpochMs:Date.now()}));assert.equal(view.status,'AVAILABLE');
 assert.equal((await f.metadata()).jobs.filter(j=>j.lease_owner!==null).length,0);
 const futureClock=await createPhase4Foundation({db:f.db,keys:fixtureKeys,admission:await f.db.admitRuntime(),now:()=>new Date(Date.now()+60000)});
 await assert.rejects(futureClock.withContext('a',{executionMode:'SHADOW',providerRequired:true},context=>futureClock.bodyEnergy.readForPublication(context,
  {healthDate:bodyHealthDate(Date.now(),'Asia/Taipei'),asOfEpochMs:Date.now()})),/FUTURE_REQUEST/);
});

for(const days of [7,27,29])test(`provisional ${days} day result requires real isolated DOMAIN and finalization, then supports owner query and next morning section`,async t=>{
 const f=await setup(t,{applicationMemory:true,days,unequal:days===27});
 assert.equal((await f.read('a',PROVISIONAL.version)).status,'PROCESSING');await f.finish();
 assert.equal((await f.read()).status,'LIMITED');
 const view=await f.read('a',PROVISIONAL.version);assert.equal(view.status,'PROVISIONAL');assert.equal(view.quality,'LIMITED');
 assert.equal(view.presentationPolicy,PROVISIONAL.version);assert.ok(Number.isFinite(view.value));
 const before=await f.metadata();assert.equal(before.state.last_completed_generation,0);
 const cap=await authorizeBodyEnergyFixturePublication({db:f.db,userIds:['a'],presentationPolicy:PROVISIONAL.version});
 const ui=createBodyEnergyIntegration({db:f.db,stores:f.stores,keys:fixtureKeys,publicationCapability:cap});
 const trial={en:'Trial estimate / personal baseline still being established','zh-TW':'試用估計／個人基準仍在建立中',vi:'Ước tính thử nghiệm / dữ liệu nền cá nhân đang được thiết lập'};
 for(const locale of ['zh-TW','vi','en']){
  await f.db.setLocale('a',locale);const query=await ui.query({text:'/energy',userId:'a'}),morning=await ui.currentSection({userId:'a'});
  assert.equal(query.status,'PROVISIONAL');assert.equal(morning.status,'PROVISIONAL');assert.equal(query.replyGuard.version,'body-energy-reply-v2');
  assert.equal(query.replyGuard.presentationPolicy,PROVISIONAL.version);assert.ok(query.message.includes(trial[locale]));
  assert.match(query.message,new RegExp(`HRV ${days-(days===27?1:0)}/30 · RHR ${days}/30`));
  assert.match(query.message,/LIMITED/);assert.match(query.message,/90/);assert.match(query.message,/Kelvin Health OS/);
  assert.equal(await query.verifyCurrent(),true);assert.equal(await morning.verifyCurrent(),true);
  assert.throws(()=>renderBodyEnergy(view,{locale,alert:true}),/PUBLIC_VIEW_INVALID/);
 }
 assert.deepEqual(await f.metadata(),before);await assert.rejects(assertBodyEnergyPublication(cap,f.db,'a',{purpose:'alerts'}),/NOT_QUALIFIED/);
 assert.equal((await ui.query({text:'/energy',userId:'b'})).status,'QUALIFICATION_PENDING');
 const prepared=await ui.query({text:'/energy',userId:'a'});const old=await f.db.getUser('a');
 await f.db.updateUser('a',{displayName:'ABA'});await f.db.updateUser('a',{displayName:old.displayName});
 await assert.rejects(prepared.verifyCurrent(),/RECIPIENT_FENCED/);
 await f.db.raw.execute("UPDATE phase4_user_state SET pending_purge_count=1 WHERE user_id='a'");await assert.rejects(f.read('a',PROVISIONAL.version),/PURGE_FENCED/);
 await f.db.raw.execute("UPDATE phase4_user_state SET pending_purge_count=0 WHERE user_id='a'");
 await f.stores.queue.sourceChanged(await f.stores.captureControl('a'));assert.equal((await f.read('a',PROVISIONAL.version)).status,'PROCESSING');
});
