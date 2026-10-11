import test from 'node:test';import assert from 'node:assert/strict';import Database from 'libsql';
import {createDb} from '../src/db.js';import {fixtureKeys} from './localDb.js';
import {createPhase4Foundation} from '../src/phase4Foundation.js';
import {bodyInput,seedBodyInput} from './bodyEnergyFixture.js';import {bodyHealthDate} from '../src/bodyEnergyInputs.js';
import {authorizeBodyEnergyFixturePublication} from '../src/bodyEnergyQualificationAuthority.js';
import {createBodyEnergyIntegration} from '../src/bodyEnergyIntegration.js';
import {BODY_MORNING_MARKER_TYPE,bodyMorningNextTick} from '../src/bodyEnergyMorningReadiness.js';
import {OWNER_PILOT_APPROVAL_SHA256} from '../src/betaPilotAllowance.js';
import {createExecutionBudget} from '../src/executionBudget.js';
import {configurationProof,commitPhaseWork,finalizePhaseWork,abortPhaseExecution,readExecution,reconcileExecution} from '../src/phase4ExecutionStore.js';
import {withDurableExecution} from '../src/phase4ExecutionContext.js';
import {withSyncOwnership} from '../src/syncOwnership.js';import {runBriefing} from '../src/index.js';import {runDaily} from '../src/daily.js';
import {createPhase4Stage6,authorizeStage6ShadowWorker} from '../src/phase4Reanalysis.js';
import {request,claim,authority,fixture as protocolFixture} from './v32ReviewFixture.js';import {createDataSource} from '../src/dataSource.js';
import {fakeCoach} from './fakes.js';
import {spawnSync,execFileSync} from 'node:child_process';
import {profileRevisionKey} from '../src/profileRevision.js';
import {workStepOptions} from '../src/phase4WorkStep.js';
import {ExecutionBudgetError} from '../src/executionBudget.js';
import {invoke as invokeWorker} from '../cloudflare/briefing-scheduler/worker.js';
import {createBetaPilotPermit,betaPilotConfiguration,reviewedPilotAdmission} from '../src/betaPilotPermit.js';

// The installed native receiver can retain an unnamed shared-memory handle
// after close. Each scenario owns the ORIGINAL strict empty-filename fixture
// in a separate process; no file/provider fixture grant is introduced.
function scenario(name,work){test(name,process.env.BODY_MORNING_ISOLATED_CASE==='1'?work:()=>{
 const escaped=name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
 const result=spawnSync(process.execPath,['--expose-gc','--test','--test-concurrency=1',`--test-name-pattern=^${escaped}$`,import.meta.filename],
  {env:{PATH:'/usr/bin:/bin',TZ:'UTC',BODY_MORNING_ISOLATED_CASE:'1'},encoding:'utf8',timeout:30000});
 assert.equal(result.status,0,result.stdout+result.stderr);assert.equal(result.error,undefined);
});}

/** Synthetic calendar-window substitution ONLY. All Node/SQLite timestamps,
 * leases, ownership, source capture and COMMIT ACKs remain their actual local
 * clocks. No provider/clinical/real scheduler/Telegram evidence is claimed. */
function morningCalendar(t){const Original=Intl.DateTimeFormat;let lastSlot=false;
 t.mock.method(Intl,'DateTimeFormat',function(locale,options){const formatter=new Original(locale,options);
  if(options?.timeZone==='Asia/Taipei'&&options.hour==='2-digit'&&options.minute==='2-digit'&&options.hourCycle==='h23'){
   return {format:formatter.format,formatToParts:date=>formatter.formatToParts(date).map(part=>part.type==='hour'
     ?{...part,value:lastSlot&&date.getTime()>=bodyMorningNextTick(Date.now())?'12':lastSlot?'11':'08'}
     :part.type==='minute'&&lastSlot?{...part,value:'50'}:part)};
  }return formatter;});return {lastSlot:value=>{lastSlot=value;}};
}
async function setup(t){
 const anchor=new Database('file::memory:?cache=shared'),db=createDb({url:'file::memory:?cache=shared',phase4Keys:fixtureKeys});
 t.after(async()=>{global.gc?.();await new Promise(resolve=>setImmediate(resolve));db.close();anchor.close();global.gc?.();
  await new Promise(resolve=>setTimeout(resolve,30));global.gc?.();await new Promise(resolve=>setImmediate(resolve));});
 await db.migrate();await db.createUser({id:'a',displayName:'Synthetic',timezone:'Asia/Taipei',status:'ACTIVE'});
 await db.setLocale('a','zh-TW');await db.ensureOnboarding('a',{state:'READY'});await db.linkTelegram({userId:'a',chatId:'100001'});
 await db.getProfileRevision('a');
 const at=Date.now(),wake=at-31*60000,input=bodyInput({asOf:wake}),iso=ms=>new Date(ms).toISOString();
 for(const rows of Object.values(input.sources))for(const row of rows)row.synced_at=iso(at-1000);
 for(const row of input.sources.sleep){row.health_date=bodyHealthDate(Date.parse(row.end_at),input.timezone);input.sources.recovery.find(r=>r.sleep_id===row.id).health_date=row.health_date;}
 const rawSleep=input.sources.sleep.map(r=>({id:r.id,user_id:101,start:r.start_at,end:r.end_at,nap:false,score_state:'SCORED',updated_at:r.updated_at,
  score:{sleep_performance_percentage:r.sleep_performance_percentage,stage_summary:{total_light_sleep_time_milli:18000000,total_slow_wave_sleep_time_milli:3600000,total_rem_sleep_time_milli:7200000}}}));
 const rawRecovery=input.sources.recovery.map(r=>({sleep_id:r.sleep_id,user_id:101,cycle_id:'cycle-current',score_state:'SCORED',updated_at:r.updated_at,
  score:{hrv_rmssd_milli:r.hrv_rmssd_milli,resting_heart_rate:r.resting_heart_rate,recovery_score:99,user_calibrating:false}}));
 const rawCycle=input.sources.cycle.map(r=>({id:r.id,user_id:101,start:r.start_at,end:r.end_at,updated_at:r.updated_at,score_state:'SCORED',score:{strain:r.strain}}));
 input.sources.sleep=input.sources.sleep.slice(1);input.sources.recovery=input.sources.recovery.slice(1);
 await db.transaction(()=>seedBodyInput(db,input));await db.raw.execute("UPDATE user_whoop_tokens SET whoop_user_id=101 WHERE user_id='a'");
 const old=iso(at-61*60000);
 for(const resource of ['sleep','recovery','cycle','workout','body_measurement'])
  await db.saveSyncState('a',resource,{backfillComplete:true,lastSuccessAt:old},{now:new Date(at-61*60000)});
 const stores=await createPhase4Foundation({db,keys:fixtureKeys,admission:await db.admitRuntime()});await stores.initializeTenant('a','SHADOW');
 await stores.queue.sourceChanged(await stores.captureControl('a'));
 const environment={PHASE4_BETA_SHADOW_RUNTIME:'on',PHASE4_PUBLIC_BETA_MODE:'off',PHASE4_BETA_PILOT_ID:'1'.repeat(64),
  PHASE4_BETA_PILOT_USER_ID:'a',PHASE4_BETA_PILOT_START_AT:iso(at-60000),PHASE4_BETA_PILOT_CONSENT_SHA256:'2'.repeat(64),
  PHASE4_BETA_PILOT_ALLOWANCE_ID:OWNER_PILOT_APPROVAL_SHA256,PHASE4_BETA_PILOT_STOP:'off'};
 const grant=await authorizeBodyEnergyFixturePublication({db,userIds:['a']}),bodyEnergy=createBodyEnergyIntegration({db,stores,keys:fixtureKeys,publicationCapability:grant,environment});
 const r=request({triggerSource:'cloudflare',configProof:configurationProof(fixtureKeys,{runtime:'on',mode:'off'},environment)}),c=await claim(db,r);
 const controller=new AbortController(),budget=createExecutionBudget({budgetMs:150000,signal:controller.signal});t.after(()=>budget.close());
 const execution={claim:c,keys:fixtureKeys,pending:new Set(),authority};
 const owned=work=>withDurableExecution(execution,()=>withSyncOwnership({db,userId:'a',budget},work));
 const evidence={userId:'a',healthDate:bodyHealthDate(wake,input.timezone),wakeSleepId:'sleep-00',pollSleeps:rawSleep,pollRecoveries:rawRecovery,expectedLifecycleGeneration:1};
 const whoop={getAccessToken:async()=> 'SYNTHETIC_UNUSABLE',sleeps:async()=>rawSleep,recoveries:async()=>rawRecovery,cycles:async()=>rawCycle,workouts:async()=>[],
  apiGet:async path=>({records:path==='/activity/sleep'?rawSleep:path==='/recovery'?rawRecovery:path==='/cycle'?rawCycle:[],next_token:null}),
  bodyMeasurement:async()=>({height_meter:1.75,weight_kilogram:70,max_heart_rate:180})};
 const marker=async()=> (await db.raw.execute({sql:'SELECT * FROM briefing_evaluations WHERE user_id=? AND report_type=?',args:['a',BODY_MORNING_MARKER_TYPE]})).rows[0];
 return {db,stores,environment,bodyEnergy,r,c,budget,controller,execution,owned,evidence,whoop,marker,grant};
}
async function nextSync(f){await abortPhaseExecution(f.db,f.c,'CANCELLED');
 f.r=request({triggerSource:'cloudflare',configProof:f.r.configProof});f.c=await claim(f.db,f.r);
 f.execution={claim:f.c,keys:fixtureKeys,pending:new Set(),authority};
 f.owned=work=>withDurableExecution(f.execution,()=>withSyncOwnership({db:f.db,userId:'a',budget:f.budget},work));
}
const ordinaryDaily=(f,messages,coach=fakeCoach('synthetic'))=>f.owned(()=>runDaily({db:f.db,userId:'a',timezone:'Asia/Taipei',locale:'zh-TW',
 expectedLifecycleGeneration:1,source:createDataSource({whoop:f.whoop}),coach,bodyEnergy:f.bodyEnergy,
 telegram:{send:async(text,options)=>{if(options?.authorize)await options.authorize();messages.push(text);return {sent:true,messageId:910003};}}}));

scenario('first wake-ready qualified morning defers before claim/model, actual whole SYNC and separate finalized DRAIN produce Body, first delivered Morning includes it once',async t=>{
 morningCalendar(t);const f=await setup(t),messages=[];let models=0;
 const telegram={send:async(text,options)=>{if(options?.authorize&&await options.authorize()===false)return {suppressed:'ACCOUNT_INACTIVE',messageId:null};
   messages.push(text);return {sent:true,messageId:910001};},notifyError:async()=>false};
 const coach={...fakeCoach('synthetic'),narrativePlan:async()=>{models++;return [];}};
 const env={dryRun:true,timezone:'Asia/Taipei',maxUserConcurrency:1,telegramBotToken:'SYNTHETIC_UNUSABLE',telegramChatId:'100001'};
 const summary=await f.owned(()=>runBriefing({triggerSource:'cloudflare',deps:{db:f.db,env,runtimeAdmission:undefined,keepConnectionOpen:true,
  bodyEnergy:f.bodyEnergy,makeWhoop:()=>f.whoop,makeCoach:()=>coach,makeTelegram:()=>telegram,
  weekly:async()=>({status:'not_due'}),proactive:async()=>({status:'no_new'}),reap:async()=>({expired:0}),
  predictionCycle:async()=>({status:'disabled'}),healthspan:async()=>({status:'disabled'}),resumeOnboarding:async()=>[],
  drainWebhook:async()=>({claimed:0,processed:0}),guardian:async()=>({status:'not_due'}),executionBudget:f.budget}}));
 assert.equal(summary.perUser[0].daily,'DAILY_DEFERRED_BODY');assert.equal(summary.dailyDeferredBody,1);
 assert.equal(summary.syncComplete,true);assert.equal(summary.syncOutcome,'COMPLETE_SUCCESS');assert.equal(models,0);assert.equal(messages.length,0);
 assert.equal(Number((await f.db.raw.execute("SELECT count(*) n FROM report_claims WHERE user_id='a'")).rows[0].n),0);
 const marker=await f.marker();assert.equal(marker.reason,'BODY_SOURCE_FIRST_OBSERVATION');assert.ok(Buffer.byteLength(marker.detail)<=500);
 assert.equal(marker.content_state,'PRESENT');assert.equal(marker.source_linkage_state,'COMPLETE');
 assert.equal((await f.db.raw.execute({sql:"SELECT count(*) n FROM phase4_source_links WHERE user_id='a' AND artifact_type='briefing_evaluations' AND artifact_id=? AND source_type='TENANT_LEGACY'",args:[marker.privacy_artifact_id]})).rows[0].n,1);
 await f.db.recordBriefingEvaluation({userId:'a',evaluatedAt:new Date().toISOString(),localDate:f.evidence.healthDate,
  outcome:'READY',targetHealthDate:f.evidence.healthDate,detail:'ordinary evaluation'});
 assert.equal((await f.marker()).detail,marker.detail);
 await assert.rejects(f.db.recordBriefingEvaluation({userId:'a',reportType:BODY_MORNING_MARKER_TYPE,outcome:'READY'}),/MARKER_API_REQUIRED/);
 await commitPhaseWork(f.db,f.r,f.c,{outcome:summary.syncOutcome,dailyDeferredBody:summary.dailyDeferredBody},authority);
 const sync=await finalizePhaseWork(f.db,f.r,f.c,fixtureKeys,authority);assert.equal(sync.settlementState,'FINALIZED_SUCCESS');assert.equal(sync.dailyDeferredBody,1);assert.ok(sync.handoff);
 const dr=request({phase:'STAGE6_DRAIN',triggerSource:'cloudflare',configProof:f.r.configProof,syncRequestId:f.r.requestId,handoff:sync.handoff}),dc=await claim(f.db,dr);
 const worker=await createPhase4Stage6({db:f.db,keys:fixtureKeys,executionMode:'SHADOW',workerCapability:authorizeStage6ShadowWorker({executionMode:'SHADOW'})});
 const result=await withDurableExecution({claim:dc,keys:fixtureKeys,pending:new Set(),authority},()=>worker.drain({userId:'a',budget:{maxJobs:1,maxItems:1,maxItemsPerTenant:1}}));
 assert.equal(result.failedJobs,0);assert.equal(result.outcome,'PARTIAL');assert.equal(result.completedJobs,0);
 await commitPhaseWork(f.db,dr,dc,{outcome:result.outcome,jobsCompleted:0,remainingJobs:result.remainingJobs,completion:'PARTIAL'},authority);
 const completed=await finalizePhaseWork(f.db,dr,dc,fixtureKeys,authority);assert.equal(completed.settlementState,'FINALIZED_SUCCESS');
 const user=await f.db.getUser('a'),daily=()=>runDaily({db:f.db,userId:'a',timezone:user.timezone,locale:'zh-TW',expectedLifecycleGeneration:user.lifecycleGeneration,
  source:createDataSource({whoop:f.whoop}),coach,telegram,bodyEnergy:f.bodyEnergy});
 const nextRequest=request({triggerSource:'cloudflare',configProof:f.r.configProof}),nextClaim=await claim(f.db,nextRequest);
 const nextOwned=work=>withDurableExecution({claim:nextClaim,keys:fixtureKeys,pending:new Set(),authority},()=>withSyncOwnership({db:f.db,userId:'a',budget:f.budget},work));
 assert.equal((await nextOwned(daily)).status,'sent');assert.equal(messages.length,1);assert.match(messages[0],/Synthetic.*69\/100/);
 assert.equal((await daily()).status,'already_sent');assert.equal(messages.length,1);
 await abortPhaseExecution(f.db,nextClaim,'CANCELLED');
 assert.equal((await f.marker()).detail,marker.detail);
 const state=(await f.db.raw.execute("SELECT input_generation,last_completed_generation FROM phase4_computation_state WHERE user_id='a' AND execution_mode='SHADOW'")).rows[0];
 assert.ok(state.last_completed_generation<state.input_generation);
});

scenario('bounded marker/prerequisite negatives never reset authority or consume a report claim',async t=>{
 const calendar=morningCalendar(t),f=await setup(t),inspect=(body=f.bodyEnergy,e=f.evidence)=>f.owned(()=>body.beforeMorning(e));
 const pending=createBodyEnergyIntegration({db:f.db,stores:f.stores,keys:fixtureKeys,publicationCapability:null,environment:f.environment});
 assert.equal((await inspect(pending)).action,'ORDINARY');assert.equal(await f.marker(),undefined);
 f.environment.PHASE4_BETA_PILOT_STOP='on';assert.equal((await inspect()).action,'ORDINARY');f.environment.PHASE4_BETA_PILOT_STOP='off';
 calendar.lastSlot(true);assert.equal((await inspect()).action,'ORDINARY');calendar.lastSlot(false);
 assert.equal((await inspect(f.bodyEnergy,{...f.evidence,pollSleeps:[{...f.evidence.pollSleeps[0],user_id:202}]})).action,'ORDINARY');
 for(const override of [
  {pollSleeps:[{...f.evidence.pollSleeps[0],updated_at:new Date(Date.now()+60000).toISOString()}]},
  {pollSleeps:[f.evidence.pollSleeps[0],f.evidence.pollSleeps[0]]},
  {pollRecoveries:[{...f.evidence.pollRecoveries[0],score:{...f.evidence.pollRecoveries[0].score,user_calibrating:true}}]},
  {pollRecoveries:[{...f.evidence.pollRecoveries[0],score:{...f.evidence.pollRecoveries[0].score,hrv_rmssd_milli:null}}]},
 ])assert.equal((await inspect(f.bodyEnergy,{...f.evidence,...override})).action,'ORDINARY');
 assert.equal(await f.marker(),undefined);
 const old=(await f.db.raw.execute("SELECT last_success_at FROM whoop_sync_state WHERE user_id='a' AND resource='sleep'")).rows[0].last_success_at;
 await f.db.raw.execute({sql:"UPDATE whoop_sync_state SET last_success_at=? WHERE user_id='a' AND resource='sleep'",args:[new Date().toISOString()]});
 assert.equal((await inspect()).action,'ORDINARY');await f.db.raw.execute({sql:"UPDATE whoop_sync_state SET last_success_at=? WHERE user_id='a' AND resource='sleep'",args:[old]});
 assert.equal((await inspect()).action,'DEFER');const first=await f.marker();
 assert.equal((await inspect()).action,'ORDINARY','already committed same-execution marker work cannot mint a second wait');assert.equal((await f.marker()).detail,first.detail);
 await nextSync(f);assert.equal((await inspect()).action,'DEFER','fresh actual owner can read the same original bounded anchor');assert.equal((await f.marker()).detail,first.detail);
 await f.db.raw.execute({sql:"UPDATE briefing_evaluations SET detail='{}' WHERE user_id='a' AND report_type=?",args:[BODY_MORNING_MARKER_TYPE]});
 assert.equal((await inspect()).action,'ORDINARY');assert.equal((await f.marker()).detail,'{}');
 await f.db.raw.execute({sql:"UPDATE briefing_evaluations SET detail=? WHERE user_id='a' AND report_type=?",args:[first.detail,BODY_MORNING_MARKER_TYPE]});
 const user=await f.db.getUser('a');await f.db.updateUser('a',{displayName:'Synthetic ABA'});await f.db.updateUser('a',{displayName:user.displayName});
 assert.equal((await inspect()).action,'ORDINARY');assert.equal((await f.marker()).detail,first.detail);
 assert.equal(Number((await f.db.raw.execute("SELECT count(*) n FROM report_claims WHERE user_id='a'")).rows[0].n),0);
});

scenario('expired or exhausted original pilot never grants waiting or additional attempts and ordinary Morning still sends once',async t=>{
 morningCalendar(t);const f=await setup(t),start=f.environment.PHASE4_BETA_PILOT_START_AT;
 f.environment.PHASE4_BETA_PILOT_START_AT=new Date(Date.now()-25*3600000).toISOString();
 assert.equal((await f.owned(()=>f.bodyEnergy.beforeMorning(f.evidence))).action,'ORDINARY');assert.equal(await f.marker(),undefined);
 f.environment.PHASE4_BETA_PILOT_START_AT=start;
 const config=betaPilotConfiguration(f.environment),permit=createBetaPilotPermit({db:f.db,keys:fixtureKeys,config,reservation:reviewedPilotAdmission(config)});
 for(let n=0;n<config.maxAttempts;n++)await permit.reserve();
 assert.equal((await permit.availability()).possible,false);
 const before=(await f.db.raw.execute("SELECT last_detail FROM system_heartbeats WHERE component='phase4_beta_pilot_permit_v1'")).rows[0].last_detail;
 const messages=[];assert.equal((await ordinaryDaily(f,messages)).status,'sent');assert.equal(messages.length,1);assert.equal(await f.marker(),undefined);
 assert.equal((await f.db.raw.execute("SELECT last_detail FROM system_heartbeats WHERE component='phase4_beta_pilot_permit_v1'")).rows[0].last_detail,before);
});

scenario('missing or malformed existing profile revision uses one ordinary durable Morning without initializing or poisoning execution',async t=>{
 morningCalendar(t);const f=await setup(t),messages=[];
 await f.db.raw.execute({sql:'DELETE FROM telegram_state WHERE key=?',args:[profileRevisionKey('a')]});
 assert.equal((await ordinaryDaily(f,messages)).status,'sent');assert.equal(messages.length,1);assert.doesNotMatch(messages[0],/69\/100/);
 assert.equal(f.execution.workRejected,undefined);assert.equal(await f.marker(),undefined);
 assert.equal((await f.db.raw.execute({sql:'SELECT 1 FROM telegram_state WHERE key=?',args:[profileRevisionKey('a')]})).rows.length,0);
 assert.equal((await f.db.raw.execute("SELECT delivery_state FROM report_claims WHERE user_id='a'")).rows[0].delivery_state,'DELIVERED');
 await f.db.raw.execute({sql:"INSERT INTO telegram_state(key,value,updated_at) VALUES(?,'malformed',?)",args:[profileRevisionKey('a'),new Date().toISOString()]});
 await nextSync(f);assert.equal((await f.owned(()=>f.bodyEnergy.beforeMorning(f.evidence))).action,'ORDINARY');assert.equal(f.execution.workRejected,undefined);
 assert.equal((await f.db.raw.execute({sql:'SELECT value FROM telegram_state WHERE key=?',args:[profileRevisionKey('a')]})).rows[0].value,'malformed');
});

scenario('original one-cadence expiry produces honest ordinary fallback and cannot reset across source generation or profile ABA',async t=>{
 morningCalendar(t);const f=await setup(t);assert.equal((await f.owned(()=>f.bodyEnergy.beforeMorning(f.evidence))).action,'DEFER');
 const first=await f.marker(),{signature,...state}=JSON.parse(first.detail);state.f=Date.now()-11*60000;state.d=bodyMorningNextTick(state.f);
 const detail=JSON.stringify({...state,signature:fixtureKeys.lookup(['body-morning-first-observation-v1',['a',state]])});
 await f.db.raw.execute({sql:'UPDATE briefing_evaluations SET detail=?,evaluated_at=? WHERE user_id=? AND report_type=?',
  args:[detail,new Date(state.f).toISOString(),'a',BODY_MORNING_MARKER_TYPE]});
 await nextSync(f);const messages=[];assert.equal((await ordinaryDaily(f,messages)).status,'sent');assert.equal(messages.length,1);
 assert.doesNotMatch(messages[0],/69\/100/);assert.equal((await f.marker()).detail,detail);
 await f.stores.queue.sourceChanged(await f.stores.captureControl('a'));await nextSync(f);
 assert.equal((await f.owned(()=>f.bodyEnergy.beforeMorning(f.evidence))).action,'ORDINARY');assert.equal((await f.marker()).detail,detail);
});

for(const point of ['availability','marker'])scenario(`parent cancellation during ${point} denies model send and report claim`,async t=>{
 morningCalendar(t);const f=await setup(t),execute=f.db.raw.execute.bind(f.db.raw);let fired=false,models=0;
 f.db.raw.execute=async statement=>{const result=await execute(statement),sql=typeof statement==='string'?statement:statement.sql;
  if(!fired&&(point==='availability'?sql.includes('SELECT u.lifecycle_generation FROM users u JOIN user_onboarding')
    :sql.includes('INSERT INTO briefing_evaluations')&&statement.args?.[1]===BODY_MORNING_MARKER_TYPE)){fired=true;f.budget.cancel();}return result;};
 const messages=[];await assert.rejects(ordinaryDaily(f,messages,{...fakeCoach('synthetic'),narrativePlan:async()=>{models++;return [];}}),/SYNC_CANCELLED/);
 assert.equal(fired,true);assert.equal(models,0);assert.equal(messages.length,0);
 assert.equal((await f.db.raw.execute("SELECT count(*) n FROM report_claims WHERE user_id='a'")).rows[0].n,0);assert.equal(await f.marker(),undefined);
});

for(const race of ['auth','purge','lifecycle','owner','deadline'])scenario(`fresh ${race} invalidation after readonly pilot observation denies optional wait and ordinary send`,async t=>{
 morningCalendar(t);const f=await setup(t),transaction=f.db.transaction;let changed=false,models=0;
 f.db.transaction=async(work,options)=>{const result=await transaction(work,options);
  if(!changed&&options?.readOnly&&result?.possible===true){changed=true;
   if(race==='deadline')f.controller.abort(new ExecutionBudgetError());
   else await transaction(async()=>{
    if(race==='auth')await f.db.raw.execute("UPDATE user_whoop_tokens SET auth_generation=auth_generation+1 WHERE user_id='a'");
    if(race==='purge')await f.db.raw.execute("UPDATE phase4_user_state SET purge_generation=purge_generation+1,pending_purge_count=1 WHERE user_id='a'");
    if(race==='lifecycle')await f.db.raw.execute("UPDATE users SET lifecycle_generation=lifecycle_generation+1 WHERE id='a'");
    if(race==='owner')await f.db.raw.execute({sql:'UPDATE phase4_executions SET lease_until=?,deadline_at=? WHERE execution_id=?',args:[Date.now()-1,Date.now()-1,f.c.executionId]});
   },workStepOptions(`fixture.body-morning-${race}-race`,[race]));
  }return result;};
 const messages=[];await assert.rejects(ordinaryDaily(f,messages,{...fakeCoach('synthetic'),narrativePlan:async()=>{models++;return [];}}));
 assert.equal(changed,true);assert.equal(models,0);assert.equal(messages.length,0);
 assert.equal((await f.db.raw.execute("SELECT count(*) n FROM report_claims WHERE user_id='a'")).rows[0].n,0);assert.equal(await f.marker(),undefined);
});

scenario('new deferred count reconciles under exact old 207 and 16dc v32 decoders without rewriting authoritative DB; unchanged Worker accepts genuine Sync handoff',async t=>{
 // The unchanged local HTTP protocol fixture needs no Body grant/health rows.
 const {db}=await protocolFixture(t),r=request({triggerSource:'cloudflare'}),f={db,r,c:await claim(db,r)};
 await commitPhaseWork(f.db,f.r,f.c,{outcome:'NO_NEW_DATA_SUCCESS',dailyDeferredBody:1},authority);
 const completed=await finalizePhaseWork(f.db,f.r,f.c,fixtureKeys,authority),before=await readExecution(f.db,f.r.requestId);
 assert.equal(completed.dailyDeferredBody,1);assert.equal((await reconcileExecution(f.db,f.r)).result.dailyDeferredBody,1);
 for(const sha of ['20724cf7d5f9d936a448e1be657fc204f91d311c','16dc09befc74b5668f5fb2747148ded2f4280ec6']){
  const original=execFileSync('git',['show',`${sha}:src/phase4ExecutionStore.js`],{cwd:new URL('..',import.meta.url),encoding:'utf8'});
  // Only import resolution changes; exact old decoder/finalization source is
  // executed, preserving its raw JSON digest and original handoff checks.
  const resolved=original.replace(/from '(\.\/[A-Za-z0-9]+\.js)'/g,(_all,path)=>`from '${new URL(path,new URL('../src/',import.meta.url)).href}'`);
  const old=await import('data:text/javascript;base64,'+Buffer.from(resolved+`\n//# sourceURL=exact-old-execution-store-${sha}.mjs`).toString('base64'));
  const read=await old.reconcileExecution(f.db,f.r);assert.equal(read.state,'FINALIZED_SUCCESS');assert.equal(read.result.outcome,'NO_NEW_DATA_SUCCESS');
  assert.equal(read.result.dailyDeferredBody,undefined);
  const {cached:oldFinal}=await old.claimPhaseRequest(f.db,f.r,JSON.stringify(f.r),{keys:fixtureKeys});
  assert.equal(oldFinal.handoff,completed.handoff);assert.equal(oldFinal.finalizedAt,completed.finalizedAt);
  assert.deepEqual(await readExecution(f.db,f.r.requestId),before);
 }
 const observed=[],result=await invokeWorker({BRIEFING_ENDPOINT_URL:'https://synthetic.invalid/internal/briefing/run',
  BRIEFING_TRIGGER_SECRET:'synthetic-local-secret-at-least-32-chars',BRIEFING_EXECUTION_MODE:'SHADOW',
  BRIEFING_RELEASE_SHA:f.r.releaseSha,BRIEFING_CONFIG_PROOF:f.r.configProof},{fetchImpl:async(_url,options)=>{
   const req=JSON.parse(options.body);observed.push(req);
   if(req.phase==='SYNC')return new Response(JSON.stringify({ok:true,phase:'SYNC',source:'cloudflare',syncComplete:true,
    drainAuthorized:true,handoff:completed.handoff,result:completed}),{status:200});
   assert.equal(req.handoff,completed.handoff);return new Response(JSON.stringify({ok:true,phase:'STAGE6_DRAIN',source:'cloudflare',
    result:{outcome:'PARTIAL',settlementState:'FINALIZED_SUCCESS',dailyDeferredBody:1}}),{status:200});
  }});
 assert.equal(result.ok,true);assert.equal(result.phase,'STAGE6_DRAIN');assert.equal(observed.length,2);
 assert.deepEqual(await readExecution(f.db,f.r.requestId),before);
});

scenario('correcting the same owned sleep across a health-date boundary cannot reset its wait; a distinct later owned wake may create the next day anchor',async t=>{
 morningCalendar(t);const f=await setup(t);assert.equal((await f.owned(()=>f.bodyEnergy.beforeMorning(f.evidence))).action,'DEFER');
 const first=await f.marker(),{signature,...old}=JSON.parse(first.detail);old.e-=86400000;
 old.h=bodyHealthDate(old.e,'Asia/Taipei');old.f=old.e+31*60000;old.d=bodyMorningNextTick(old.f);
 old.w=fixtureKeys.lookup(['body-morning-owned-wake-v1','a','sleep-00',old.e]);
 const detail=JSON.stringify({...old,signature:fixtureKeys.lookup(['body-morning-first-observation-v1',['a',old]])});
 await f.db.raw.execute({sql:'UPDATE briefing_evaluations SET detail=?,evaluated_at=?,target_health_date=? WHERE user_id=? AND report_type=?',
  args:[detail,new Date(old.f).toISOString(),old.h,'a',BODY_MORNING_MARKER_TYPE]});
 await nextSync(f);assert.equal((await f.owned(()=>f.bodyEnergy.beforeMorning(f.evidence))).action,'ORDINARY');
 assert.equal((await f.marker()).detail,detail,'same provider sleep identity cannot become a new-day anchor by correction');
 await nextSync(f);const evidence={...f.evidence,wakeSleepId:'distinct-new-day-sleep',
  pollSleeps:[{...f.evidence.pollSleeps[0],id:'distinct-new-day-sleep'}],
  pollRecoveries:[{...f.evidence.pollRecoveries[0],sleep_id:'distinct-new-day-sleep'}]};
 assert.equal((await f.owned(()=>f.bodyEnergy.beforeMorning(evidence))).action,'DEFER');
 const current=JSON.parse((await f.marker()).detail);assert.equal(current.h,f.evidence.healthDate);assert.notEqual(current.q,old.q);
 assert.ok(current.f>old.f);assert.equal(current.d,bodyMorningNextTick(current.f));
});
