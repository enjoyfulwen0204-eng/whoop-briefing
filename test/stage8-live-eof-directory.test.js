import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {syntheticPhase4Fixture} from './phase4Fixture.js';
import {createOwnedDb} from './stage5OwnedDb.js';
import {fixtureKeys} from './localDb.js';
import {hranaTransport} from './hranaTransport.js';
import {createDb} from '../src/db.js';
import {buildPhase4Core} from '../src/phase4Core.js';
import {createPhase4Stage6,authorizeStage6ShadowWorker} from '../src/phase4Reanalysis.js';
import {authorizeStage8LiveProducer} from '../src/stage8LiveProducerAuthority.js';
import {createStage8LiveExecutionRunner} from '../src/stage8LiveExecution.js';
import {createFamilyDirectory} from '../src/phase4FamilyDirectory.js';
import {PHASE4_METRICS,INTELLIGENCE_VERSIONS} from '../src/phase4IntelligenceRegistry.js';
import {runningReleaseSha} from '../src/phase4Release.js';
import {workStepOptions} from '../src/phase4WorkStep.js';

const counts=async db=>{
 const out={};for(const table of ['stage8_live_execution_work_receipts','stage8_live_operation_receipts','stage8_live_family_directory_manifests','stage8_live_job_completions','stage8_live_publications'])
  out[table]=Number((await db.raw.execute(`SELECT count(*) n FROM ${table}`)).rows[0].n);return out;
};
const jobs=async db=>(await db.raw.execute("SELECT * FROM phase4_jobs WHERE user_id='a' AND execution_mode='LIVE' ORDER BY job_kind")).rows;
async function kernel(db,keys){
 if(!(await db.raw.execute("SELECT 1 FROM user_whoop_tokens WHERE user_id='a'")).rows.length)
  await db.saveTokens('a',{accessToken:'SYNTHETIC_NOT_A_TOKEN',refreshToken:'SYNTHETIC_NOT_A_TOKEN',expiresAt:'2099-01-01T00:00:00.000Z',scope:''});
 await db.ensureOnboarding('a',{state:'READY'});
 const admission=await db.admitRuntime(),capability=await authorizeStage8LiveProducer({db,keys,admission,releaseSha:runningReleaseSha(),configProof:'b'.repeat(64),enabled:()=>true,eligible:id=>id==='a'});
 const core=await buildPhase4Core({keys,admission,liveProducingAuthority:capability,
  processing:{client:db.raw,transaction:db.transaction,active:db.processingTransactionActive,afterCommit:db.afterProcessingCommit,afterCompletion:db.afterProcessingCompletion},authorizeMode(){}});
 await core.initializeTenant('a','LIVE');const worker=await createPhase4Stage6({db,keys,admission,executionMode:'LIVE',liveProducingAuthority:capability});await worker.rolloutAlgorithm({userId:'a'});
 const runner=work=>createStage8LiveExecutionRunner({db,keys,capability,capture:id=>core.capture(id,{executionMode:'LIVE'}),assertContext:ctx=>core.assertContext(ctx),work});
 const observedWork=[];
 const work=async(budget={})=>{const value=await worker.drain({userId:'a',budget});observedWork.push(value);return {outcome:value.outcome,itemsProcessed:value.processedItems,jobsCompleted:value.completedJobs,jobsFailed:value.failedJobs,remainingJobs:value.remainingJobs,unitsCommitted:value.unitsCommitted};};
 let ordinal=0;
 const drain=async(budget={})=>runner(()=>work(budget))({userId:'a',requestId:`synthetic-eof-${++ordinal}`});
 return {db,keys,core,worker,runner,work,observedWork,drain,directory:createFamilyDirectory(db.raw,keys,{live:true})};
}
async function fixture(t){
 const f=await syntheticPhase4Fixture(t,{targetVersion:35,ownedConnection:true,now:()=>new Date()});return {...f,...await kernel(f.db,f.keys)};
}
async function checkpointBoth(f){
 for(let n=0;n<2;n++){const r=await f.drain({maxItemsPerTenant:1});assert.equal(r.result.itemsProcessed,1);assert.equal(r.result.outcome,'PARTIAL');}
 const rows=await jobs(f.db);assert.equal(rows.length,2);assert.ok(rows.every(row=>row.full_scan_cursor===JSON.stringify(['USER','a'])&&row.state==='PENDING'&&row.completed_generation===0));return rows;
}

test('LIVE EOF directory preparation commits at the existing item bound, preserves original cursors and exact identity replay, then completes through genuine EOF proofs',async t=>{
 const f=await fixture(t),originalJobs=await checkpointBoth(f),before=await counts(f.db),other=(await f.db.raw.execute("SELECT * FROM phase4_computation_state WHERE user_id='b'")).rows;
 const request={userId:'a',requestId:'synthetic-eof-one-original'},run=f.runner(()=>f.work({maxItemsPerTenant:1}));
 const first=await run(request),after=await counts(f.db);
 assert.equal(first.result.unitsCommitted,1);assert.equal(first.result.itemsProcessed,0);assert.equal(first.result.jobsCompleted,0);assert.equal(first.result.outcome,'PARTIAL');
 assert.equal(after.stage8_live_family_directory_manifests-before.stage8_live_family_directory_manifests,1);
 assert.equal(after.stage8_live_operation_receipts,before.stage8_live_operation_receipts);assert.equal(after.stage8_live_job_completions,0);assert.equal(after.stage8_live_publications,0);
 const pending=await jobs(f.db);for(let i=0;i<pending.length;i++)for(const key of ['full_scan_cursor','requested_generation','completed_generation','scope_revision','attempt'])assert.equal(pending[i][key],originalJobs[i][key]);
 const executionRows=(await f.db.raw.execute('SELECT * FROM stage8_live_executions ORDER BY execution_seq')).rows;
 const replay=await run(request);assert.equal(replay.replayed,true);assert.equal(replay.result.unitsCommitted,1);assert.deepEqual(await counts(f.db),after);assert.deepEqual((await f.db.raw.execute('SELECT * FROM stage8_live_executions ORDER BY execution_seq')).rows,executionRows);
 const six=await f.drain();assert.equal(six.result.unitsCommitted,6);assert.equal((await counts(f.db)).stage8_live_family_directory_manifests,7);assert.equal((await counts(f.db)).stage8_live_job_completions,0);
 await f.drain();await f.drain();
 const final=await jobs(f.db);assert.ok(final.every(row=>row.state==='COMPLETED'&&row.scope_kind==='NONE'&&row.completed_generation===row.requested_generation&&row.full_scan_cursor===null));
 const computation=(await f.db.raw.execute("SELECT input_generation,last_completed_generation FROM phase4_computation_state WHERE user_id='a' AND execution_mode='LIVE'")).rows[0];assert.equal(computation.last_completed_generation,computation.input_generation);
 assert.equal((await counts(f.db)).stage8_live_family_directory_manifests,Object.keys(PHASE4_METRICS).length);assert.equal((await counts(f.db)).stage8_live_job_completions,2);
 assert.deepEqual((await f.db.raw.execute("SELECT * FROM phase4_computation_state WHERE user_id='b'")).rows,other);
});

test('fresh completion still refuses genuine due and unknown directories after missing siblings are prepared',async t=>{
 for(const kind of ['due','unknown'])await t.test(kind,async tt=>{
  const f=await fixture(tt);await checkpointBoth(f);
  const setup=f.runner(async(_id,ctx)=>{
   await f.core.run(ctx,()=>kind==='unknown'?f.directory.markUnknown(ctx,'recovery_score'):f.directory.register(ctx,
    {metric:'recovery_score',domain:PHASE4_METRICS.recovery_score.domain,algorithmMajor:INTELLIGENCE_VERSIONS.algorithm,subject:'recovery_score',windowFamily:'SYNTHETIC_REQUIRED_FAMILY'}),workStepOptions('synthetic.eof-required-family',[kind],{discardResult:true}));
   return {outcome:'PARTIAL'};
  });await setup({userId:'a',requestId:`synthetic-eof-${kind}-setup`});
  await f.drain();const result=await f.drain();assert.equal(result.result.outcome,'FAILED');
  const final=await jobs(f.db);assert.ok(final.every(row=>row.completed_generation===0&&row.full_scan_cursor===JSON.stringify(['USER','a'])));
  assert.equal((await counts(f.db)).stage8_live_job_completions,0);assert.equal((await counts(f.db)).stage8_live_publications,0);
 });
});

test('a generation change inside a new directory unit rolls back that unit and cannot manufacture completion',async t=>{
 const f=await fixture(t);await checkpointBoth(f);const before=await counts(f.db),originalJobs=await jobs(f.db),execute=f.db.raw.execute.bind(f.db.raw);let changed=false;
 f.db.raw.execute=async statement=>{
  const value=await execute(statement),sql=typeof statement==='string'?statement:statement.sql;
  if(!changed&&sql.startsWith('INSERT INTO stage8_live_family_directory_manifests')){changed=true;await execute("UPDATE phase4_computation_state SET input_generation=input_generation+1 WHERE user_id='a' AND execution_mode='LIVE'");}
  return value;
 };
 let result,error;try{result=await f.drain({maxItemsPerTenant:1});}catch(value){error=value;}finally{f.db.raw.execute=execute;}
 assert.equal(changed,true);assert.equal(error,undefined);assert.equal(result.result.outcome,'FAILED');assert.equal(result.result.unitsCommitted,0);
 assert.equal(f.observedWork.at(-1).failures[0].code,'STALE_GENERATION');assert.equal((await counts(f.db)).stage8_live_family_directory_manifests,before.stage8_live_family_directory_manifests);
 assert.equal((await counts(f.db)).stage8_live_job_completions,0);assert.equal((await counts(f.db)).stage8_live_publications,0);
 for(const row of await jobs(f.db)){const original=originalJobs.find(item=>item.job_kind===row.job_kind);assert.equal(row.full_scan_cursor,original.full_scan_cursor);assert.equal(row.completed_generation,0);assert.equal(row.requested_generation,original.requested_generation);}
});

test('unknown COMMIT acknowledgement of an actual EOF directory unit remains unknown and cannot be reported as completed analysis',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'stage8-eof-unknown-')),url=`file:${join(dir,'synthetic.db')}`,seed=createOwnedDb({url});let db,transport;
 t.after(async()=>{db?.close();transport?.close();await rm(dir,{recursive:true,force:true});});
 try{
  await seed.migrate({targetVersion:35});await seed.createUser({id:'a',displayName:'Synthetic',timezone:'Asia/Taipei',status:'ACTIVE'});
  const native=await kernel(seed,fixtureKeys);await checkpointBoth(native);
 }finally{await seed.close();}
 transport=hranaTransport(url);db=createDb({url:'https://isolated.invalid',phase4Keys:fixtureKeys,fetch:request=>{assert.equal(new URL(request.url).hostname,'isolated.invalid');return transport.fetch(request);}});
 const f=await kernel(db,fixtureKeys),before=await counts(db),run=f.runner(()=>f.work({maxItemsPerTenant:1}));
 transport.arm({matchSql:/INSERT INTO stage8_live_family_directory_manifests/,loseAcknowledgement:true});
 await assert.rejects(run({userId:'a',requestId:'synthetic-eof-unknown-ack'}),error=>error.code==='COMMIT_INDETERMINATE');
 const after=await counts(db);assert.equal(after.stage8_live_family_directory_manifests,before.stage8_live_family_directory_manifests+1);assert.equal(after.stage8_live_job_completions,0);assert.equal(after.stage8_live_publications,0);
 const latest=(await db.raw.execute('SELECT state,result_json FROM stage8_live_executions ORDER BY execution_seq DESC LIMIT 1')).rows[0];assert.equal(latest.state,'ESTABLISHED');assert.equal(latest.result_json,null);
 assert.ok((await jobs(db)).every(row=>row.completed_generation===0&&row.full_scan_cursor===JSON.stringify(['USER','a'])));
});

test('SHADOW EOF keeps its original atomic directory completion without the LIVE preparation units',async t=>{
 const f=await syntheticPhase4Fixture(t,{targetVersion:30,ownedConnection:true,now:()=>new Date()});
 await f.stores.queue.sourceChanged(await f.stores.captureControl('a'));
 const worker=await createPhase4Stage6({...f,executionMode:'SHADOW',workerCapability:authorizeStage6ShadowWorker({executionMode:'SHADOW'})});
 for(let n=0;n<2;n++)assert.equal((await worker.drain({userId:'a',budget:{maxItemsPerTenant:1}})).processedItems,1);
 const final=await worker.drain({userId:'a'});assert.equal(final.completedJobs,1);assert.equal(final.unitsCommitted,0);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM phase4_family_directory_manifests')).rows[0].n,Object.keys(PHASE4_METRICS).length);
});
