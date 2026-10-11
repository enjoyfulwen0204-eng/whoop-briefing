import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,fixtureKeys,request,claim,authority} from './v32ReviewFixture.js';
import {bodyInput,seedBodyInput} from './bodyEnergyFixture.js';
import {bodyHealthDate} from '../src/bodyEnergyInputs.js';
import {buildPhase4Core} from '../src/phase4Core.js';
import {composePhase4Stores} from '../src/phase4Repositories.js';
import {createReanalysisQueue} from '../src/phase4ReanalysisQueue.js';
import {createBodyEnergyStore,issueNewBodySourceCapture,requireNewBodySourceCapture} from '../src/bodyEnergyStore.js';
import {createResultAuthority} from '../src/phase4ResultAuthority.js';
import {withDurableExecution,currentExecutionReceiptTransactionMarker} from '../src/phase4ExecutionContext.js';
import {commitPhaseWork,finalizePhaseWork} from '../src/phase4ExecutionStore.js';
import {betaPilotConfiguration,createBetaPilotPermit,withBetaPilotAttempt} from '../src/betaPilotPermit.js';
import {OWNER_PILOT_APPROVAL_SHA256,reviewedPilotAllowance} from '../src/betaPilotAllowance.js';

// Real installed Hrana, schema-v32 and original pilot/parent/job admissions.
// Synthetic data and fault mutations remain in isolated fixture transactions.
const sqlOf=statement=>typeof statement==='string'?statement:statement?.sql??'';
const captureSelect=sql=>'SELECT * FROM body_energy_results WHERE user_id=? AND execution_mode=? AND privacy_artifact_id=?'===sql;
async function setup(t,{mature=false}={}){
 const {db,transport}=await fixture(t);
 for(const id of ['a','b'])await db.createUser({id,displayName:'Synthetic',timezone:'Asia/Taipei',status:'ACTIVE'});
 await db.ensureOnboarding('a',{state:'READY'});
 const core=await buildPhase4Core({keys:fixtureKeys,admission:await db.admitRuntime(),authorizeMode:mode=>assert.equal(mode,'SHADOW'),
  processing:{client:db.raw,transaction:db.transaction,active:db.processingTransactionActive,withReadSnapshot:db.withProcessingReadSnapshot,
   assertFences:db.assertRuntimeFences,afterCommit:db.afterProcessingCommit,afterCompletion:db.afterProcessingCompletion}});
 const stores=composePhase4Stores(core),queue=createReanalysisQueue(core);
 for(const id of ['a','b'])await stores.initializeTenant(id,'SHADOW');
 const input=bodyInput({asOf:Date.now()-1000,days:mature?30:7});
 for(const row of input.sources.sleep){row.health_date=bodyHealthDate(Date.parse(row.end_at),input.timezone);
  input.sources.recovery.find(r=>r.sleep_id===row.id).health_date=row.health_date;}
 if(mature){const at=new Date(input.asOfEpochMs).toISOString();input.sources.workout.push({user_id:'a',id:'notification-workout',
  start_at:at,end_at:null,strain:1,created_at:at,updated_at:at,synced_at:at});}
 await db.transaction(()=>seedBodyInput(db,input));await stores.queue.sourceChanged(await stores.captureControl('a'));
 const config=betaPilotConfiguration({PHASE4_BETA_PILOT_ID:'a'.repeat(64),PHASE4_BETA_PILOT_USER_ID:'a',
  PHASE4_BETA_PILOT_START_AT:new Date(Date.now()-1000).toISOString(),PHASE4_BETA_PILOT_CONSENT_SHA256:'b'.repeat(64),
  PHASE4_BETA_PILOT_ALLOWANCE_ID:OWNER_PILOT_APPROVAL_SHA256});
 const permit=createBetaPilotPermit({db,keys:fixtureKeys,config,reservation:reviewedPilotAllowance(OWNER_PILOT_APPROVAL_SHA256)});
 const sync=request(),syncOwner=await claim(db,sync);await commitPhaseWork(db,sync,syncOwner,{outcome:'NO_NEW_DATA_SUCCESS'},authority);
 const synced=await finalizePhaseWork(db,sync,syncOwner,fixtureKeys,authority);
 let cancel=false;const sourceKeys=new Set();
 const run=async work=>{
  const r=request({phase:'STAGE6_DRAIN',syncRequestId:sync.requestId,handoff:synced.handoff}),owner=await claim(db,r),grant=await permit.reserve();
  const execution={claim:owner,keys:fixtureKeys,pending:new Set(),authority:{assert(){if(cancel)throw Error('SYNTHETIC_PARENT_CANCELLED');}}};
  return withBetaPilotAttempt(grant,'a',()=>db.withRuntimeFence(client=>grant.assert(client),()=>withDurableExecution(execution,
   ()=>stores.withContext('a',{executionMode:'SHADOW',providerRequired:true},async context=>{
    const lease=await queue.claim(context,'RECOMPUTE_DERIVED');assert.ok(lease);
    try{return await work({context,lease,execution,r,owner});}
    finally{cancel=false;if(execution.indeterminate)await queue.abandon(lease);else await queue.release(context,lease);}
   }))));
 };
 return {db,transport,core,stores,queue,input,run,sourceKeys,cancel:()=>{cancel=true;}};
}
const durableCounts=async f=>({body:Number((await f.db.raw.execute("SELECT count(*) n FROM body_energy_results WHERE user_id='a'")).rows[0].n),
 domain:Number((await f.db.raw.execute("SELECT count(*) n FROM phase4_operation_receipts WHERE user_id='a' AND operation_kind='BODY_ENERGY_COMPUTE'")).rows[0].n),
 source:(await f.db.raw.execute('SELECT step_key FROM phase4_execution_work_receipts')).rows.filter(row=>f.sourceKeys.has(row.step_key)).length});
const sourceUnit=(f,{context,lease,execution})=>{
 const facts=['USER','a',JSON.stringify(['USER','a']),lease.asOfUtc],step=fixtureKeys.lookup(['phase4-logical-work-v1','stage6.body-source',
  [context.userId,context.executionMode,lease.binding.jobKind,lease.binding.requestedGeneration,lease.binding.scopeRevision,facts]]);
 f.sourceKeys.add(fixtureKeys.lookup(['execution-work-step-v2',execution.claim.identity,execution.claim.scopeKey,['named',step]]));
 return f.queue.owned(context,lease,()=>f.stores.bodyEnergy.computeForCurrentDrain(context),{workKind:'stage6.body-source',workFacts:facts});
};

test('genuine same-root new Body brand produces the exact original manifest including notification workout and every actual extra edge',async t=>{
 const f=await setup(t,{mature:true}),body=createBodyEnergyStore(f.core),roots=createResultAuthority(f.core);
 let marker;
 await f.run(({context,lease})=>f.queue.owned(context,lease,async()=>{
  marker=currentExecutionReceiptTransactionMarker();assert.ok(marker);assert.deepEqual(Object.keys(marker),[]);
  const produced=await body.compute(context,{asOfEpochMs:Date.now()-1});assert.equal(produced.created,true);
  for(const clone of [{created:true,row:produced.row},structuredClone(produced)])assert.equal(issueNewBodySourceCapture(f.core,context,clone),null);
  assert.equal(issueNewBodySourceCapture(f.core,{...context},produced),null,'a wrong context consumes no usable authority');
  // A fresh genuine persist supplies a new, independently bound result.
  const actual=await body.compute(context,{asOfEpochMs:Date.now()});
  const token=issueNewBodySourceCapture(f.core,context,actual);assert.ok(token);
  const ref=f.core.reference(context,'body_energy_results',actual.row.privacy_artifact_id,'SHADOW',actual.row);
  await f.db.raw.execute({sql:`INSERT INTO phase4_source_links(user_id,artifact_execution_mode,artifact_type,artifact_id,
   source_execution_mode,source_type,source_id,relationship,linked_at) VALUES('a','SHADOW','body_energy_results',?,'SHARED','USER','a','CONTROL_EXTRA',?)`,
   args:[actual.row.privacy_artifact_id,new Date().toISOString()]});
  const salt=actual.row.content_digest_salt;
  const bundled=await roots.captureNewBodySourceRoots(context,[ref],salt,token),original=await roots.captureRoots(context,[ref],salt);
  assert.deepEqual(bundled,original);assert.ok(bundled.roots.some(root=>root.type==='workout'&&root.id==='notification-workout'));
  assert.equal(bundled.roots.some(root=>root.type==='USER'),false,'an extra actual edge is validated without inventing a calculation input');
  await assert.rejects(()=>roots.captureNewBodySourceRoots(context,[ref],salt,token),/NEW_SOURCE_CAPTURE_REQUIRED/);
  for(const fake of [{},true,structuredClone(token)])assert.throws(()=>requireNewBodySourceCapture(f.core,context,fake,
   f.core.validateReferences(context,[ref])[0]),/NEW_SOURCE_CAPTURE_REQUIRED/);
  return null;
 },{workKind:'synthetic.body-source-manifest-control',workFacts:['equivalence']}));
 assert.equal(currentExecutionReceiptTransactionMarker(),null);assert.equal((await durableCounts(f)).domain,0);
});

test('genuine new Body brand cannot cross an owned root, job binding, durable owner or pending COMMIT',async t=>{
 const f=await setup(t),body=createBodyEnergyStore(f.core);let token,source,closedMarker;
 await f.run(async({context,lease,execution})=>{
  await f.queue.owned(context,lease,async()=>{
   const produced=await body.compute(context,{asOfEpochMs:Date.now()-1});closedMarker=currentExecutionReceiptTransactionMarker();
   token=issueNewBodySourceCapture(f.core,context,produced);
   source=f.core.validateReferences(context,[f.core.reference(context,'body_energy_results',produced.row.privacy_artifact_id,'SHADOW',produced.row)])[0];return null;
  },{workKind:'synthetic.body-source-brand-control',workFacts:['closed-root']});
  await f.queue.owned(context,lease,async()=>{
   assert.notEqual(currentExecutionReceiptTransactionMarker(),closedMarker);
   assert.throws(()=>requireNewBodySourceCapture(f.core,context,token,source),/NEW_SOURCE_CAPTURE_REQUIRED/);
   const bind=async()=>{const produced=await body.compute(context,{asOfEpochMs:Date.now()});
    return {token:issueNewBodySourceCapture(f.core,context,produced),source:f.core.validateReferences(context,[
     f.core.reference(context,'body_energy_results',produced.row.privacy_artifact_id,'SHADOW',produced.row)])[0]};};
   const wrongJob=await bind();
   await f.core.withJobFence(Object.freeze({purpose:'SYNTHETIC_OTHER_JOB'}),async()=>{},()=>
    assert.throws(()=>requireNewBodySourceCapture(f.core,context,wrongJob.token,wrongJob.source),/NEW_SOURCE_CAPTURE_REQUIRED/));
   const wrongExecution=await bind();
   await withDurableExecution({...execution},()=>assert.throws(()=>requireNewBodySourceCapture(f.core,context,
    wrongExecution.token,wrongExecution.source),/NEW_SOURCE_CAPTURE_REQUIRED/));
   const pending=await bind();
   execution.indeterminate=true;
   assert.throws(()=>requireNewBodySourceCapture(f.core,context,pending.token,pending.source),/COMMIT_INDETERMINATE/);
   execution.indeterminate=false;return null;
  },{workKind:'synthetic.body-source-brand-control',workFacts:['new-root']});
 });
 assert.equal((await durableCounts(f)).domain,0);
});

const attacks=[
 ['missing canonical source',"DELETE FROM whoop_sleeps WHERE user_id='a' AND id='sleep-00'",/SOURCE_NOT_FOUND/],
 ['corrupt canonical value',"UPDATE whoop_sleeps SET sleep_performance_percentage=51 WHERE user_id='a' AND id='sleep-00'",/VERSION_MISMATCH/],
 // The real schema forbids changing the retained hash. Execute the real SELECT
 // first, then corrupt only its returned observation to test this comparator.
 ['corrupt immutable Body hash observation',row=>{row.result_hash='bad';},/REPRODUCTION_CONFLICT/],
 ['resource access revoked',"UPDATE whoop_resource_access SET status='FORBIDDEN' WHERE user_id='a' AND resource='sleep'",/RESOURCE_FENCED/],
 ['resource capability revoked',"INSERT INTO whoop_capabilities(user_id,key,status,lifecycle_generation,last_probed_at) VALUES('a','sleep','UNAVAILABLE',1,'2026-10-12')",/CAPABILITY_FENCED/],
 ['source tombstoned',"INSERT INTO whoop_resource_tombstones(user_id,resource_type,resource_id,state,deleted_at,created_at,updated_at) VALUES('a','sleep','sleep-00','ACTIVE','2026-10-12','2026-10-12','2026-10-12')",/SOURCE_DELETED/],
 ['input generation changed',"UPDATE phase4_computation_state SET input_generation=input_generation+1 WHERE user_id='a' AND execution_mode='SHADOW'",/INPUT_FENCED/],
 ['source generation changed',"UPDATE phase4_user_state SET source_generation=source_generation+1 WHERE user_id='a'",/INPUT_FENCED/],
 ['lifecycle changed',"UPDATE users SET lifecycle_generation=lifecycle_generation+1 WHERE id='a'",/BETA_PILOT_DENIED/],
 ['auth changed',"UPDATE user_whoop_tokens SET auth_generation=auth_generation+1 WHERE user_id='a'",/AUTH_FENCED/],
 ['purge changed',"UPDATE phase4_user_state SET purge_generation=purge_generation+1 WHERE user_id='a'",/PURGE_FENCED/],
 ['job lease expired',"UPDATE phase4_jobs SET lease_expires_at='2000-01-01' WHERE user_id='a' AND job_kind='RECOMPUTE_DERIVED'",/LEASE_CAS_LOST/],
 ['execution owner expired',"UPDATE phase4_executions SET deadline_at=0,lease_until=0 WHERE phase='STAGE6_DRAIN'",/REQUEST_OWNER_FENCED/],
];
test('post-effect new source closure rejects actual missing/corrupt/control changes and rolls back Body/domain/source effects',async t=>{
 for(const [name,sql,code] of attacks)await t.test(name,async t=>{
  const f=await setup(t),execute=f.db.raw.execute.bind(f.db.raw);let armed=false,entered=false;
  f.db.raw.execute=async statement=>{const result=await execute(statement);
   if(armed&&captureSelect(sqlOf(statement))&&result.rows.length){armed=false;entered=true;
    if(typeof sql==='function')sql(result.rows[0]);else await execute(sql);}return result;};
  try{await assert.rejects(()=>f.run(async args=>{armed=true;return sourceUnit(f,args);}),code);
   assert.equal(entered,true,'fault reached the actual new post-effect capture SELECT');
  }finally{f.db.raw.execute=execute;}
  assert.deepEqual(await durableCounts(f),{body:0,domain:0,source:0});
 });
});

test('actual unexpected foreign edge, missing graph and complex derived cycle retain original ordered graph rejection',async t=>{
 for(const [name,type,id,code] of [['foreign raw edge','USER','b',/CROSS_TENANT_REFERENCE/],
  ['foreign derived parent','body_energy_results','foreign',/PARENT_STALE/],['complex derived cycle','body_energy_results',null,/PROVENANCE_CYCLE/],
  ['missing graph',null,null,/INCOMPLETE_PROVENANCE/]])await t.test(name,async t=>{
  const f=await setup(t),execute=f.db.raw.execute.bind(f.db.raw);let armed=false,entered=false;
  f.db.raw.execute=async statement=>{const result=await execute(statement);
   if(armed&&captureSelect(sqlOf(statement))&&result.rows.length){armed=false;entered=true;const row=result.rows[0];
    if(type===null)await execute("DELETE FROM phase4_source_links WHERE user_id='a' AND artifact_type='body_energy_results'");
    else await execute({sql:`INSERT INTO phase4_source_links(user_id,artifact_execution_mode,artifact_type,artifact_id,
     source_execution_mode,source_type,source_id,relationship,linked_at) VALUES('a','SHADOW','body_energy_results',?,?,?,?, 'CONTROL_BAD',?)`,
     args:[row.privacy_artifact_id,type==='USER'?'SHARED':'SHADOW',type,id??row.privacy_artifact_id,new Date().toISOString()]});
   }return result;};
  try{await assert.rejects(()=>f.run(async args=>{armed=true;return sourceUnit(f,args);}),code);assert.equal(entered,true);}
  finally{f.db.raw.execute=execute;}
  assert.deepEqual(await durableCounts(f),{body:0,domain:0,source:0});
 });
});

test('late parent cancellation after source union starts and late job/owner expiry after domain insertion deny COMMIT',async t=>{
 for(const late of ['cancel-after-union-read','expire-after-domain-insert','expire-owner-after-domain-insert'])await t.test(late,async t=>{
  const f=await setup(t),execute=f.db.raw.execute.bind(f.db.raw);let capture=false,fired=false;
  f.db.raw.execute=async statement=>{const result=await execute(statement),sql=sqlOf(statement);
   if(captureSelect(sql)&&result.rows.length)capture=true;
   if(capture&&!fired&&(late==='cancel-after-union-read'?/^SELECT \* FROM whoop_sleeps WHERE/.test(sql):/^INSERT INTO phase4_operation_receipts\(/.test(sql))){
    fired=true;if(late==='cancel-after-union-read')f.cancel();
    else if(late==='expire-owner-after-domain-insert')await execute("UPDATE phase4_executions SET deadline_at=0,lease_until=0 WHERE phase='STAGE6_DRAIN'");
    else await execute("UPDATE phase4_jobs SET lease_expires_at='2000-01-01' WHERE user_id='a' AND job_kind='RECOMPUTE_DERIVED'");
   }return result;};
  try{await assert.rejects(()=>f.run(args=>sourceUnit(f,args)),late==='cancel-after-union-read'?/SYNTHETIC_PARENT_CANCELLED/:
   late==='expire-owner-after-domain-insert'?/REQUEST_OWNER_FENCED/:/LEASE_CAS_LOST/);
   assert.equal(fired,true);
  }finally{f.db.raw.execute=execute;}
  assert.deepEqual(await durableCounts(f),{body:0,domain:0,source:0});
 });
});

test('actual lost new-source COMMIT acknowledgement retains durable Body/domain but no accepted work result or consumer authority',async t=>{
 const f=await setup(t);f.transport.arm({matchSql:/INSERT INTO body_energy_results\(/,loseAcknowledgement:true});
 await assert.rejects(()=>f.run(args=>sourceUnit(f,args)),/COMMIT_INDETERMINATE/);
 assert.deepEqual(await durableCounts(f),{body:1,domain:1,source:1});
 const parent=(await f.db.raw.execute("SELECT state,result_json,finalized_at FROM phase4_executions WHERE phase='STAGE6_DRAIN'")).rows[0];
 assert.equal(parent.state,'ESTABLISHED');assert.equal(parent.result_json,null);assert.equal(parent.finalized_at,null);
 const view=await f.stores.withContext('a',{executionMode:'SHADOW',providerRequired:true},context=>f.stores.bodyEnergy.readForPublication(context,
  {healthDate:bodyHealthDate(Date.now(),'Asia/Taipei'),asOfEpochMs:Date.now()}));assert.equal(view.status,'PROCESSING');assert.equal(Object.hasOwn(view,'value'),false);
});
