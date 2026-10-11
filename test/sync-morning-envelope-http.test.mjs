import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
const APP=fileURLToPath(new URL('../',import.meta.url));
const APP_SHA=execFileSync('git',['rev-parse','HEAD'],{cwd:APP,encoding:'utf8'}).trim();
const {createOwnedDb}=await import(pathToFileURL(APP+'/test/stage5OwnedDb.js'));
const {hranaTransport}=await import(pathToFileURL(APP+'/test/hranaTransport.js'));
import {pathToFileURL,fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
const sourceRoot=pathToFileURL(APP+'/');
const {runDaily}=await import(new URL('src/daily.js',sourceRoot));
const {fakeCoach}=await import(new URL('test/fakes.js',sourceRoot));
const MODEL_DELAY_MS=3000,PHYSICAL_HTTP_LATENCY_MS=Number(process.env.SYNC_FIXTURE_LATENCY_MS??110);
assert.ok(Number.isSafeInteger(PHYSICAL_HTTP_LATENCY_MS)&&PHYSICAL_HTTP_LATENCY_MS>=0&&PHYSICAL_HTTP_LATENCY_MS<=150);
let realProviderRequests=0;globalThis.fetch=async()=>{realProviderRequests++;throw Error('REAL_PROVIDER_FORBIDDEN_IN_SYNTHETIC_LOCAL_FIXTURE');};
console.log('SYNTHETIC_LOCAL_ONLY '+JSON.stringify({appCommit:APP_SHA,modelDelayMs:MODEL_DELAY_MS,physicalHttpLatencyMs:PHYSICAL_HTTP_LATENCY_MS,modelDelayQualification:'declared synthetic model-double delay; no production latency assertion',realProvidersAllowed:false}));
const {log}=await import(new URL('src/logger.js',sourceRoot));
const {runForUser}=await import(new URL('src/index.js',sourceRoot));
const {createDb}=await import(new URL('src/db.js',sourceRoot));
const {fixtureKeys}=await import(new URL('test/localDb.js',sourceRoot));
const {runExecutionPhase}=await import(new URL('src/phase4Execution.js',sourceRoot));
const {configurationProof}=await import(new URL('src/phase4ExecutionStore.js',sourceRoot));
const {canonicalPhaseRequest,readExecution}=await import(new URL('src/phase4ExecutionStore.js',sourceRoot));
const {createBriefingEndpoint}=await import(new URL('src/briefingEndpoint.js',sourceRoot));
const {signTriggerRequest}=await import(new URL('src/briefingTriggerAuth.js',sourceRoot));
const {publicBetaConfiguration}=await import(new URL('src/publicBetaConfig.js',sourceRoot));
const {runningReleaseSha}=await import(new URL('src/phase4Release.js',sourceRoot));
const {WHOOP_SYNC}=await import(new URL('src/config.js',sourceRoot));
const {createReconciler}=await import(new URL('src/reconcile.js',sourceRoot));

const now=new Date('2026-10-11T00:00:00Z'),day=86400000;
function records(){
 const sleeps=[],recoveries=[],cycles=[],workouts=[];
 for(let i=0;i<7;i++){
  const end=new Date(now.getTime()-i*day-3600000).toISOString(),start=new Date(Date.parse(end)-7*3600000).toISOString();
  sleeps.push({id:`sleep-${i}`,user_id:1,start,end,timezone_offset:'+08:00',nap:false,score_state:'SCORED',created_at:end,updated_at:end,
   score:{stage_summary:{total_light_sleep_time_milli:4*3600000,total_slow_wave_sleep_time_milli:3600000,total_rem_sleep_time_milli:2*3600000},sleep_needed:{baseline_milli:8*3600000},sleep_performance_percentage:90}});
  recoveries.push({sleep_id:`sleep-${i}`,cycle_id:1000+i,user_id:1,score_state:'SCORED',created_at:end,updated_at:end,score:{recovery_score:65,resting_heart_rate:51,hrv_rmssd_milli:55}});
  cycles.push({id:1000+i,user_id:1,start:new Date(Date.parse(end)-day).toISOString(),end,score_state:'SCORED',created_at:end,updated_at:end,score:{strain:12}});
  if(i===1||i===4)workouts.push({id:`workout-${i}`,user_id:1,start,end,score_state:'SCORED',created_at:end,updated_at:end,score:{strain:9}});
 }
 return {sleeps,recoveries,cycles,workouts,body:{height_meter:1.75,weight_kilogram:70,max_heart_rate:190}};
}
const copyCounts=c=>structuredClone(c);
test('SYNTHETIC LOCAL: three READY morning-due reports + full SYNC under 110ms physical HTTP and 3s model-double delay',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'sync-roundtrips-')),url=`file:${join(dir,'db.sqlite')}`,seed=createOwnedDb({url}),data=records();
 await seed.migrate({targetVersion:32});
 const unchanged=false;
 for(const [index,id] of ['alice','bob','lan'].entries()){
  await seed.createUser({id,displayName:'Synthetic',status:'ACTIVE',timezone:'Asia/Taipei'});
  await seed.linkTelegram({userId:id,chatId:String(1001+index)});await seed.setLocale(id,['en','zh-TW','vi'][index]);
  await seed.ensureOnboarding(id,{state:'READY'});
  await seed.saveTokens(id,{accessToken:'synthetic',refreshToken:'synthetic',expiresAt:new Date(Date.now()+3600000),whoopUserId:String(2001+index)});
  await seed.saveCapabilities(id,[{key:'sleep',status:'SUPPORTED'}],{expectedLifecycleGeneration:1});
  await seed.upsertSleeps(id,unchanged?data.sleeps:data.sleeps.slice(2),{timezone:'Asia/Taipei',now});
  await seed.upsertRecoveries(id,unchanged?data.recoveries:data.recoveries.slice(2),{now});await seed.upsertCycles(id,unchanged?data.cycles:data.cycles.slice(2),{now});
  if(unchanged){await seed.upsertWorkouts(id,data.workouts,{timezone:'Asia/Taipei',now});await seed.upsertBodyMeasurement(id,data.body,{now});}
  for(const resource of WHOOP_SYNC.RESOURCES)await seed.saveSyncState(id,resource,{backfillComplete:true,lastSuccessAt:new Date(now.getTime()-3*3600000).toISOString()},{now});
  assert.equal(await seed.isSent(id,'daily','2026-10-11'),false,'all three current morning reports are due');
 }
 await seed.close();
 const operations=new AsyncLocalStorage(),high=new Set(['PHASE_ADMISSION','PHASE_CLAIM','PHASE_WORK','PHASE_SETTLEMENT','WEBHOOK_DRAIN','ONBOARDING','USER_RUN','USER_MAINTENANCE','WHOOP_AUTH','DAILY_REPORT','WEEKLY_REPORT','WHOOP_SYNC','FAST_RECONCILIATION','PROACTIVE','ANALYSIS_INPUTS','PREDICTION','HEALTHSPAN','SYSTEM_MAINTENANCE']);
 const originalInfo=log.info;log.info=(event,fields)=>{if(event==='phase4_operation_start'&&high.has(fields.operation)&&operations.getStore())operations.getStore().operation=fields.operation;originalInfo(event,fields);};
 t.after(()=>{log.info=originalInfo;});
 const transport=hranaTransport(url,{operation:()=>operations.getStore()?.operation??'UNSCOPED'}),latency=PHYSICAL_HTTP_LATENCY_MS;
 assert.ok(Number.isSafeInteger(latency)&&latency>=0&&latency<=150);
 const db=createDb({url:'https://isolated.invalid',phase4Keys:fixtureKeys,fetch:async request=>{
  if(latency)await new Promise(resolve=>setTimeout(resolve,latency));return transport.fetch(request);
 }});t.after(async()=>{db.close();transport.close();await rm(dir,{recursive:true,force:true});});
 const continuing=true;
 const environment={PHASE4_RELEASE_SHA:APP_SHA,PHASE4_EXECUTION_PROFILE:'PHASE4',NODE_VERSION:'22.23.2',PHASE4_BETA_SHADOW_RUNTIME:'on',PHASE4_PUBLIC_BETA_MODE:'off',PHASE4_PUBLIC_BETA_USER_IDS:'',PHASE4_BETA_PILOT_STOP:'on',BRIEFING_CONTINUATION_SCOPE:'sync-and-stage6-shadow'},releaseSha=runningReleaseSha(environment);
 const request={releaseSha,requestId:(continuing?'p4s1_':'')+randomUUID(),phase:'SYNC',triggerSource:'cloudflare',executionMode:'SHADOW',configProof:configurationProof(fixtureKeys,publicBetaConfiguration(environment),environment)};
 let providerCalls=0,sends=0,modelCalls=0;const dailyResults=[],sendCounts=new Map(),modelCounts=new Map();let fixtureLeg=0;
 const fetchData=name=>async()=>{assert.equal(db.processingTransactionActive(),false,'provider must stay outside a write transaction');providerCalls++;return structuredClone(data[name]);};
 const deps={runUser:o=>operations.run({operation:'USER_RUN'},()=>runForUser(o)),makeWhoop:()=>({getAccessToken:async()=>'synthetic',sleeps:fetchData('sleeps'),recoveries:fetchData('recoveries'),cycles:fetchData('cycles'),workouts:fetchData('workouts'),bodyMeasurement:fetchData('body'),
  apiGet:async path=>{assert.equal(db.processingTransactionActive(),false,'all FAST/tombstone provider calls stay outside transactions');providerCalls++;
   const name={'/activity/sleep':'sleeps','/recovery':'recoveries','/cycle':'cycles','/activity/workout':'workouts'}[path];assert.ok(name,'fixture only permits declared collection providers');return {records:structuredClone(data[name]),next_token:null};}}),
  makeReconciler:options=>({reconcileAll:async args=>{const results=await createReconciler(options).reconcileAll(args);console.log('SYNC_FAST_RESULTS '+JSON.stringify(results.map(({resource,scope,result,errorClass})=>({resource,scope,result,errorClass}))));return results;}}),
  daily:async ctx=>{const result=await runDaily(ctx);dailyResults.push({fixtureLeg,status:result.status,coachUsed:result.coachUsed??false,recorded:result.recorded??false});return result;},
  makeCoach:({userId})=>{const coach=fakeCoach(),plan=coach.narrativePlan;coach.narrativePlan=async(...args)=>{
   assert.equal(db.processingTransactionActive(),false,'synthetic model delay remains outside DB write transaction');
   modelCalls++;modelCounts.set(userId,(modelCounts.get(userId)??0)+1);await new Promise(resolve=>setTimeout(resolve,MODEL_DELAY_MS));return plan(...args);
  };return coach;},
  makeTelegram:({chatId})=>({send:async text=>{
   const uid={1001:'alice',1002:'bob',1003:'lan'}[chatId];assert.ok(uid,'only synthetic fixture chat bindings allowed');
   assert.ok(typeof text==='string'&&text.length>0);assert.equal(db.processingTransactionActive(),false,'synthetic ACK remains outside DB write transaction');
   const row=(await db.raw.execute({sql:"SELECT delivery_state,delivery_attempts,lifecycle_generation FROM report_claims WHERE user_id=? AND report_type='daily' AND local_date='2026-10-11'",args:[uid]})).rows[0];
   assert.equal(row?.delivery_state,'DELIVERY_STARTED','real durable authorization precedes synthetic send');assert.equal(row.delivery_attempts,1);assert.equal(row.lifecycle_generation,1);
   sends++;sendCounts.set(uid,(sendCounts.get(uid)??0)+1);assert.equal(sendCounts.get(uid),1,'never resend acknowledged synthetic report across same identity legs');
   return {messageId:9000+sends};
  },notifyError:async()=>false}),guardian:async()=>null};
 const env={timezone:'Asia/Taipei',dryRun:false,maxUserConcurrency:3,telegramBotToken:'synthetic',telegramChatId:'synthetic',whoopClientId:'synthetic',whoopClientSecret:'synthetic',openrouterApiKey:'synthetic',openrouterModel:'synthetic',repoLastCommitAt:now.toISOString()};
 const secret='synthetic-roundtrip-continuation-secret-32bytes',body=continuing?canonicalPhaseRequest(request):JSON.stringify(request);
 const endpoint=createBriefingEndpoint({secret,environment,runPhase:()=>operations.run({operation:'PHASE'},()=>runExecutionPhase({request,body,db,keys:fixtureKeys,environment,env,deps,now}))});
 const send=()=>{const timestamp=String(Date.now()),path='/internal/briefing/run';return endpoint({method:'POST',url:path,headers:{'content-type':'application/json','x-briefing-request-id':request.requestId,'x-briefing-timestamp':timestamp,'x-briefing-signature':signTriggerRequest({timestamp,requestId:request.requestId,method:'POST',path,body},secret)}},body);};
 const started=performance.now(),legs=[];let result;
 for(let leg=0;leg<(continuing?3:1);leg++){
  fixtureLeg=leg+1;const before=transport.counts.httpRequests,at=performance.now(),sendsBefore=sends,modelsBefore=modelCalls;result=await send();
  const measuredLeg={leg:leg+1,status:result.status,outcome:result.body.result?.outcome,httpRequests:transport.counts.httpRequests-before,elapsedMs:Math.round(performance.now()-at),syntheticAcks:sends-sendsBefore,syntheticModelCalls:modelCalls-modelsBefore,workBudgetMs:120000,wholeServerBudgetMs:165000};legs.push(measuredLeg);
  console.log('SYNTHETIC_MORNING_HTTP_LEG '+JSON.stringify(measuredLeg));
  if(result.status===200)break;
  assert.equal(continuing,true);assert.equal(result.status,202,JSON.stringify(result));assert.equal(result.body.result.outcome,'PARTIAL');assert.equal(result.body.syncComplete,false);assert.equal(result.body.drainAuthorized,false);assert.equal(result.body.handoff,undefined);
  const row=await readExecution(db,request.requestId);assert.equal(row.state,'ESTABLISHED');assert.equal(row.result_json,null);assert.equal(row.result_digest,null);assert.ok(row.lease_until<Date.now());assert.ok(row.deadline_at<Date.now());
 }
 const measured=copyCounts(transport.counts),elapsedMs=Math.round(performance.now()-started);
 console.log('SYNTHETIC_MORNING_COMPLETION_CHECKPOINT '+JSON.stringify({syntheticLocalOnly:true,users:3,legs,
  elapsedMs,wholeCallerMarginMs:561000-elapsedMs,syntheticWhoopCalls:providerCalls,syntheticAcks:sends,
  syntheticModelCalls:modelCalls,dailyResults,realProviderRequests,finalStatus:result.status,
  finalOutcome:result.body.result?.outcome,finalYieldReason:result.body.result?.yieldReason,
  finalSettlementState:result.body.result?.settlementState,...measured}));
 assert.equal(result.status,200,JSON.stringify(result));assert.equal(result.body.syncComplete,true);assert.equal(result.body.result.users,3);
 assert.equal(result.body.result.settlementState,'FINALIZED_SUCCESS');assert.equal(result.body.drainAuthorized,false);assert.equal(sends,3);assert.equal(modelCalls,3);assert.equal(realProviderRequests,0);
 assert.equal(dailyResults.filter(x=>x.status==='sent'&&x.coachUsed&&x.recorded).length,3,'actual daily/model/record paths execute for all3 users');
 const claims=(await db.raw.execute("SELECT delivery_state,delivery_attempts,telegram_message_id IS NOT NULL acknowledged FROM report_claims WHERE report_type='daily' AND local_date='2026-10-11' ORDER BY user_id")).rows;
 assert.equal(claims.length,3);for(const c of claims){assert.equal(c.delivery_state,'DELIVERED');assert.equal(c.delivery_attempts,1);assert.equal(c.acknowledged,1);}
 assert.equal((await db.raw.execute("SELECT COUNT(*) n FROM report_runs WHERE report_type='daily' AND local_date='2026-10-11' AND status='SENT'")).rows[0].n,3);
 for(const uid of ['alice','bob','lan']){assert.equal(sendCounts.get(uid),1);assert.equal(modelCounts.get(uid),1);}
 for(const id of ['alice','bob','lan']){
  assert.equal((await db.raw.execute({sql:'SELECT COUNT(*) n FROM whoop_sleeps WHERE user_id=?',args:[id]})).rows[0].n,7);
  assert.equal((await db.raw.execute({sql:'SELECT COUNT(*) n FROM whoop_recoveries WHERE user_id=?',args:[id]})).rows[0].n,7);
  assert.ok((await db.raw.execute({sql:'SELECT COUNT(*) n FROM healthspan_metrics WHERE user_id=?',args:[id]})).rows[0].n>0,'every required scheduled analysis phase finishes before completion');
  const state=(await db.raw.execute({sql:'SELECT COUNT(*) n FROM whoop_reconciliation_state WHERE user_id=? AND last_success_at IS NOT NULL AND consecutive_failures=0 AND continuation_from IS NULL AND continuation_to IS NULL',args:[id]})).rows[0].n;
  assert.equal(state,WHOOP_SYNC.RESOURCES.length,'all due FAST resources really succeeded');
 }
 assert.equal((await db.raw.execute('SELECT COUNT(*) n FROM (SELECT execution_id,step_key FROM phase4_execution_work_receipts GROUP BY execution_id,step_key HAVING COUNT(*)>1)')).rows[0].n,0);
 const beforeReplay=transport.counts.httpRequests;assert.deepEqual(await runExecutionPhase({request,body,db,keys:fixtureKeys,environment,env,deps,now}),result);
 assert.equal(sends,3);assert.equal(modelCalls,3);assert.equal(realProviderRequests,0);
 console.log('SYNTHETIC_MORNING_HTTP_MEASUREMENT '+JSON.stringify({syntheticLocalOnly:true,appCommit:releaseSha,users:3,unchanged,continuing,legs,syntheticWhoopCalls:providerCalls,syntheticAcks:sends,syntheticModelCalls:modelCalls,modelDelayMs:MODEL_DELAY_MS,latencyPerRequestMs:latency,elapsedMs,wholeCallerMarginMs:561000-elapsedMs,originalEpochMs:900000,maxLegs:3,dailyResults,syntheticDeliveredClaims:claims.length,duplicateAcknowledgedResends:0,realProviderRequests,...measured,replayHttpRequests:transport.counts.httpRequests-beforeReplay}));
});
