import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createDb} from '../src/db.js';
import {createOwnedDb} from './stage5OwnedDb.js';
import {fixtureKeys} from './localDb.js';
import {hranaTransport} from './hranaTransport.js';
import {makeDataset} from './fixtures.js';
import {loadDailyMetricsDetailed} from '../src/dailyMetrics.js';
import {runExecutionPhase} from '../src/phase4Execution.js';
import {configurationProof} from '../src/phase4ExecutionStore.js';
import {publicBetaConfiguration} from '../src/publicBetaConfig.js';
import {runningReleaseSha} from '../src/phase4Release.js';
import {randomUUID} from 'node:crypto';
import {WHOOP_SYNC} from '../src/config.js';
import {RECONCILE_RESULT} from '../src/schema.js';
import {staticDataSource} from '../src/dataSource.js';
import {fakeCoach} from './fakes.js';
import {backfillActuals,MODEL_VERSION} from '../src/prediction.js';

const now=new Date('2026-10-09T00:00:00Z'),window={timezone:'Asia/Taipei',from:'2026-10-04',to:'2026-10-09'};
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'p4-metric-snapshot-')),url=`file:${join(dir,'fixture.db')}`,seed=createOwnedDb({url});
 await seed.migrate({targetVersion:32});
 for(const id of ['alice','bob']){
  await seed.createUser({id,displayName:id,status:'ACTIVE',timezone:'Asia/Taipei'});
  const data=makeDataset({now,days:3,withNaps:false,overrides:id==='bob'?{0:{hrv:100}}:{}});
  await seed.upsertSleeps(id,data.sleeps,{timezone:'Asia/Taipei',now});
  await seed.upsertRecoveries(id,data.recoveries,{now});
  await seed.upsertCycles(id,data.cycles,{now});
  await seed.upsertBodyMeasurement(id,{height_meter:1.7,weight_kilogram:id==='bob'?90:70},{now});
 }
 await seed.close();const transport=hranaTransport(url);let calls=0,denyWorkout=false;
 const db=createDb({url:'https://isolated.invalid',phase4Keys:fixtureKeys,fetch:async request=>{
  calls++;if(denyWorkout){
   const body=await request.clone().json();let changed=false;
   const visit=value=>{
    if(!value||typeof value!=='object')return;
    if(typeof value.sql==='string'&&/FROM\s+whoop_workouts\b/i.test(value.sql)){
     value.sql='SELECT * FROM synthetic_missing_workout_table';changed=true;
    }
    for(const item of Object.values(value))if(item&&typeof item==='object')visit(item);
   };visit(body);
   if(changed)request=new Request(request,{body:JSON.stringify(body)});
  }return transport.fetch(request);
 }});
 t.after(async()=>{db.close();transport.close();await rm(dir,{recursive:true,force:true});});
 await db.admitRuntime();
 return {db,setDenyWorkout:v=>{denyWorkout=v;},resetCalls:()=>{calls=0;},calls:()=>calls};
}

test('one protected HTTP health observation preserves values, windows and tenant isolation with fewer round trips',async t=>{
 const f=await fixture(t),{db}=f,legacy=Object.create(db);legacy.getDailyMetricInputs=undefined;
 await loadDailyMetricsDetailed({...window,db,userId:'alice'}); // warm both paths equally
 f.resetCalls();const expected=await loadDailyMetricsDetailed({...window,db:legacy,userId:'alice'}),individual=f.calls();
 f.resetCalls();const actual=await loadDailyMetricsDetailed({...window,db,userId:'alice'}),batched=f.calls();
 assert.deepEqual(actual,expected);assert.equal(actual.complete,true);assert.equal(actual.rows.length,3);
 assert.ok(batched*2<individual,`HTTP calls: ${batched} versus ${individual}`);
 const bob=await loadDailyMetricsDetailed({...window,db,userId:'bob'});
 assert.notDeepEqual(actual.rows,bob.rows,'a peer cannot borrow the other tenant health values');
 console.log(JSON.stringify({measurement:'metric_input_http_round_trips',individual,batched}));
});

test('a failed workout query remains unavailable and cannot become a zero-workout fact',async t=>{
 const f=await fixture(t);f.setDenyWorkout(true);
 const result=await loadDailyMetricsDetailed({...window,db:f.db,userId:'alice'});
 assert.equal(result.complete,false);assert.equal(result.available.workouts,false);assert.equal(result.available.sleeps,true);
 assert.ok(result.rows.length>0);assert.ok(result.rows.every(row=>row.workout_count===null));
});

test('pending purge and inactive authority fence the whole grouped observation without borrowing peer data',async t=>{
 const {db}=await fixture(t);
 await db.raw.execute("UPDATE phase4_user_state SET pending_purge_count=1 WHERE user_id='alice'");
 await assert.rejects(loadDailyMetricsDetailed({...window,db,userId:'alice'}),/PHASE4_PURGE_FENCED/);
 assert.equal((await loadDailyMetricsDetailed({...window,db,userId:'bob'})).rows.length,3);
 await db.raw.execute("UPDATE users SET status='DISABLED' WHERE id='bob'");
 await assert.rejects(loadDailyMetricsDetailed({...window,db,userId:'bob'}));
});

for(const value of [null,[],[{status:'fulfilled',value:[]}],Array(5).fill({status:'bogus'}),Array(5).fill({status:'fulfilled'})])
 test('malformed grouped input cannot prove resource availability: '+JSON.stringify(value),async()=>{
  await assert.rejects(loadDailyMetricsDetailed({...window,userId:'alice',db:{getDailyMetricInputs:async()=>value}}),/DAILY_METRIC_INPUTS_INVALID/);
 });

test('an indeterminate grouped transaction never retries individual reads',async()=>{
 let reads=0;
 const failure=Object.assign(new Error('COMMIT_INDETERMINATE'),{code:'COMMIT_INDETERMINATE'});
 await assert.rejects(loadDailyMetricsDetailed({...window,userId:'alice',db:{
  getDailyMetricInputs:async()=>{throw failure;},getSleeps:async()=>{reads++;return [];},
 }}),/COMMIT_INDETERMINATE/);
 assert.equal(reads,0);
});

test('a fallback cannot retain batch values after the tenant becomes purge-fenced',async()=>{
 const failure=Object.assign(new Error('PHASE4_PURGE_FENCED'),{code:'PHASE4_PURGE_FENCED'});
 await assert.rejects(loadDailyMetricsDetailed({...window,userId:'alice',db:{
  getDailyMetricInputs:async()=>{throw Error('synthetic statement failure');},
  getSleeps:async()=>{throw failure;},getRecoveries:async()=>[],getCycles:async()=>[],
  getWorkouts:async()=>[],getLatestBodyMeasurement:async()=>null,
 }}),/PHASE4_PURGE_FENCED/);
});

test('prediction date observation reduces absent-day writes while retaining correction and tenant/model/date scope',async t=>{
 const {db}=await fixture(t),day='2026-10-08';
 for(const [user,metric,version,date] of [
  ['alice','recovery',MODEL_VERSION,day],['bob','recovery',MODEL_VERSION,day],
  ['alice','recovery','other-model',day],['alice','hrv',MODEL_VERSION,day],
  ['alice','recovery',MODEL_VERSION,'2026-10-01'],
 ])await db.savePrediction(user,{targetDate:date,targetMetric:metric,modelVersion:version,status:'CANDIDATE',predictedValue:60});
 assert.deepEqual(await db.getPredictionActualDates('alice',{targetMetric:'recovery',modelVersion:MODEL_VERSION,from:'2026-10-07',to:'2026-10-09'}),
  [{user_id:'alice',target_date:day}]);
 const rows=[{health_date:'2026-10-07',recovery:50},{health_date:day,recovery:65},{health_date:'2026-10-09',recovery:70}];
 assert.equal(await backfillActuals(db,'alice',rows,{now}),1);
 rows[1].recovery=68;assert.equal(await backfillActuals(db,'alice',rows,{now}),1,'an already-evaluated prediction still receives corrected actuals');
 const records=(await db.raw.execute('SELECT user_id,target_date,target_metric,model_version,actual_value FROM prediction_runs')).rows;
 assert.equal(records.filter(r=>r.actual_value!==null).length,1);
 assert.equal(records.find(r=>r.actual_value!==null).actual_value,68);
});

test('metric write batching retains every privacy link, replay identity and permanent redaction barrier',async t=>{
 const {db}=await fixture(t),metrics=Array.from({length:18},(_,i)=>({metricKey:`fixture_${i}`,value:i,availability:'AVAILABLE'}));
 assert.equal(await db.saveHealthspanMetrics('alice',metrics,{now}),18);
 let rows=(await db.raw.execute("SELECT * FROM healthspan_metrics WHERE user_id='alice' ORDER BY metric_key")).rows;
 assert.equal(rows.length,18);assert.ok(rows.every(r=>r.content_state==='PRESENT'&&r.source_linkage_state==='COMPLETE'&&r.privacy_artifact_id));
 const artifacts=rows.map(r=>r.privacy_artifact_id);
 assert.equal((await db.raw.execute("SELECT count(*) n FROM phase4_source_links WHERE user_id='alice' AND artifact_type='healthspan_metrics'")).rows[0].n,18);
 await db.saveHealthspanMetrics('alice',metrics.map(m=>({...m,value:m.value+1})),{now});
 rows=(await db.raw.execute("SELECT * FROM healthspan_metrics WHERE user_id='alice' ORDER BY metric_key")).rows;
 assert.deepEqual(rows.map(r=>r.privacy_artifact_id),artifacts);
 assert.equal((await db.raw.execute("SELECT count(*) n FROM phase4_source_links WHERE user_id='alice' AND artifact_type='healthspan_metrics'")).rows[0].n,18);
 await db.raw.execute("UPDATE healthspan_metrics SET content_state='REDACTED',source_linkage_state='DISCONNECTED',value=NULL WHERE user_id='alice' AND metric_key='fixture_0'");
 const before=(await db.raw.execute("SELECT * FROM healthspan_metrics WHERE user_id='alice' ORDER BY metric_key")).rows;
 await assert.rejects(db.saveHealthspanMetrics('alice',metrics,{now}),/CONTENT_REDACTED/);
 assert.deepEqual((await db.raw.execute("SELECT * FROM healthspan_metrics WHERE user_id='alice' ORDER BY metric_key")).rows,before,'the complete attempted batch rolls back');
 assert.equal((await db.raw.execute("SELECT count(*) n FROM healthspan_metrics WHERE user_id='bob'")).rows[0].n,0);
});

test('a malformed metric batch cannot commit earlier values or incomplete privacy metadata',async t=>{
 const {db}=await fixture(t);
 await assert.rejects(db.saveHealthspanMetrics('alice',[{metricKey:'valid',value:1,availability:'AVAILABLE'},{metricKey:null,value:2,availability:'AVAILABLE'}],{now}));
 assert.equal((await db.raw.execute("SELECT count(*) n FROM healthspan_metrics WHERE user_id='alice'")).rows[0].n,0);
 assert.equal((await db.raw.execute("SELECT count(*) n FROM phase4_source_links WHERE user_id='alice' AND artifact_type='healthspan_metrics'")).rows[0].n,0);
 await db.raw.execute("UPDATE phase4_user_state SET pending_purge_count=1 WHERE user_id='alice'");
 await assert.rejects(db.saveHealthspanMetrics('alice',[{metricKey:'valid',value:1,availability:'AVAILABLE'}],{now}),/PHASE4_PURGE_FENCED/);
});

for(const observed of [null,[null],[{user_id:'bob',target_date:'2026-10-08'}],[{user_id:'alice',target_date:'2020-01-01'}]])
 test('malformed prediction date observation falls back to the original protected writes: '+JSON.stringify(observed),async()=>{
  let writes=0;assert.equal(await backfillActuals({getPredictionActualDates:async()=>observed,recordPredictionActual:async()=>{writes++;return true;}},
   'alice',[{health_date:'2026-10-08',recovery:65}],{now}),1);assert.equal(writes,1);
 });

test('a failed prediction date lookup retains write authority errors; an uncertain commit never retries',async()=>{
 let writes=0;
 const db={getPredictionActualDates:async()=>{throw Error('synthetic read failure');},recordPredictionActual:async()=>{writes++;throw Error('PHASE4_PURGE_FENCED');}};
 await assert.rejects(backfillActuals(db,'alice',[{health_date:'2026-10-08',recovery:65}],{now}),/PHASE4_PURGE_FENCED/);
 assert.equal(writes,1);
 db.getPredictionActualDates=async()=>{throw Object.assign(Error('COMMIT_INDETERMINATE'),{code:'COMMIT_INDETERMINATE'});};
 await assert.rejects(backfillActuals(db,'alice',[{health_date:'2026-10-08',recovery:65}],{now}),/COMMIT_INDETERMINATE/);
 assert.equal(writes,1);
});

for(const allTenantsDue of [false,true])test(`the 120-second HTTP phase includes real ordinary delivery and legacy analytics; all tenants due=${allTenantsDue}`,async t=>{
 const dir=await mkdtemp(join(tmpdir(),'p4-metric-phase-')),url=`file:${join(dir,'fixture.db')}`,seed=createOwnedDb({url});
 await seed.migrate({targetVersion:32});
 const dataset=makeDataset({now,days:45,withNaps:false});
 for(const [i,id] of ['alice','bob','lan'].entries()){
  await seed.createUser({id,displayName:id,status:'ACTIVE',timezone:'Asia/Taipei'});
  await seed.linkTelegram({userId:id,chatId:String(1001+i)});
  await seed.saveTokens(id,{accessToken:'synthetic',refreshToken:'synthetic',expiresAt:new Date(Date.now()+3600000),whoopUserId:String(12345+i)});
  await seed.saveCapabilities(id,[{key:'sleep',status:'SUPPORTED'}],{expectedLifecycleGeneration:1});
  for(const resource of WHOOP_SYNC.RESOURCES){
   const stale=(allTenantsDue||id==='alice')&&resource==='workout';
   await seed.saveSyncState(id,resource,{backfillComplete:true,lastSuccessAt:new Date(now.getTime()-(stale?61*60000:0)).toISOString()},{now});
   const owner=`fixture-${id}-${resource}`;
   assert.equal(await seed.claimReconciliation({userId:id,resource,owner,leaseMs:300000,now,lifecycleGeneration:1}),true);
   assert.equal(await seed.settleReconciliation({userId:id,resource,owner,result:RECONCILE_RESULT.SUCCESS,windowTo:now,now,lifecycleGeneration:1}),true);
  }
  if(allTenantsDue||id==='alice'){
   const own=rows=>rows.map(row=>({...row,user_id:12345+i}));
   await seed.upsertSleeps(id,own(dataset.sleeps),{timezone:'Asia/Taipei',now});
   await seed.upsertRecoveries(id,own(dataset.recoveries),{now});
   await seed.upsertCycles(id,own(dataset.cycles),{now});
   await seed.upsertBodyMeasurement(id,{height_meter:1.7,weight_kilogram:70},{now});
  }
 }
 await seed.setLocale('alice','en'); // Disposable fixture only; production uses the Telegram flow.
 await seed.close();const transport=hranaTransport(url);let calls=0,sends=0,workoutFetches=0;
 const latency=Number(process.env.PHASE4_FIXTURE_LATENCY_MS??10);
 assert.ok(Number.isSafeInteger(latency)&&latency>=0&&latency<=500);
 const db=createDb({url:'https://isolated.invalid',phase4Keys:fixtureKeys,fetch:async request=>{
  calls++;if(latency)await new Promise(resolve=>setTimeout(resolve,latency));return transport.fetch(request);
 }});
 t.after(async()=>{db.close();transport.close();await rm(dir,{recursive:true,force:true});});
 const environment={PHASE4_BETA_SHADOW_RUNTIME:'off',PHASE4_PUBLIC_BETA_MODE:'off'};
 const request={releaseSha:runningReleaseSha(),requestId:randomUUID(),phase:'SYNC',triggerSource:'cloudflare',executionMode:'OFF',
  configProof:configurationProof(fixtureKeys,publicBetaConfiguration(environment),environment)};
 const payloads=[];
 const deps={makeWhoop:()=>({getAccessToken:async()=>'synthetic',workouts:async()=>{workoutFetches++;return [];}}),
  makeTelegram:({chatId})=>({send:async text=>{payloads.push({chatId,text});return {messageId:++sends};},sendTyping:async()=>true,notifyError:async()=>false}),
  makeSource:()=>staticDataSource(dataset),makeCoach:()=>fakeCoach(),
  weekly:async()=>null,proactive:async()=>null,guardian:async()=>null,drainWebhook:async()=>({}),
 };
 const env={timezone:'Asia/Taipei',dryRun:true,maxUserConcurrency:3,telegramBotToken:'synthetic',telegramChatId:'synthetic',
  whoopClientId:'synthetic',whoopClientSecret:'synthetic',openrouterApiKey:'synthetic',openrouterModel:'synthetic',repoLastCommitAt:now.toISOString()};
 const started=performance.now(),result=await runExecutionPhase({request,db,keys:fixtureKeys,environment,env,deps,now});
 assert.equal(result.status,200,JSON.stringify(result));assert.equal(result.body.syncComplete,true);
 assert.equal(result.body.result.settlementState,'FINALIZED_SUCCESS');assert.equal(result.body.drainAuthorized,false);
 assert.equal(workoutFetches,allTenantsDue?3:1);
 const ordinary=payloads.filter(p=>p.chatId==='1001');assert.equal(ordinary.length,1);
 assert.match(ordinary[0].text,/alice/);assert.doesNotMatch(ordinary[0].text,/Beta|Body Energy|Kelvin/);
 assert.equal((await db.raw.execute("SELECT count(*) n FROM report_runs WHERE user_id='alice' AND report_type='daily' AND status='SENT'")).rows[0].n,1);
 assert.ok((await db.raw.execute("SELECT count(*) n FROM healthspan_metrics WHERE user_id='alice'")).rows[0].n>0);
 const beforeReplay=calls;assert.deepEqual(await runExecutionPhase({request,db,keys:fixtureKeys,environment,env,deps,now}),result);
 assert.equal(payloads.filter(p=>p.chatId==='1001').length,1,'phase replay cannot duplicate the ordinary report');
 console.log(JSON.stringify({measurement:'ordinary_and_legacy_analytics_http_phase',allTenantsDue,latencyPerRequestMs:latency,elapsedMs:performance.now()-started,workRequests:beforeReplay,replayRequests:calls-beforeReplay}));
});
