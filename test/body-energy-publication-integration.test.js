import {withPhaseTelemetry} from '../src/executionTelemetry.js';
import test from 'node:test';import assert from 'node:assert/strict';
import Database from 'libsql';
import {createDb} from '../src/db.js';
import {fixtureKeys} from './localDb.js';
import {createPhase4Foundation} from '../src/phase4Foundation.js';
import {bodyInput,seedBodyInput} from './bodyEnergyFixture.js';
import {createPhase4Stage6,authorizeStage6ShadowWorker} from '../src/phase4Reanalysis.js';
import {finalizedFixtureDrain} from './finalizedStage6Fixture.js';
import {authorizeBodyEnergyPublication,authorizeBodyEnergyFixturePublication,assertBodyEnergyPublication} from '../src/bodyEnergyQualificationAuthority.js';
import {createBodyEnergyIntegration} from '../src/bodyEnergyIntegration.js';
import {createBodyEnergyAlertDelivery,createBodyEnergyFixtureTransport} from '../src/bodyEnergyAlertDelivery.js';
import {renderBodyEnergy,isBodyEnergyQuery} from '../src/bodyEnergyPresentation.js';
import {BODY_ENERGY_RELEASE_CRITERIA as CRITERIA} from '../src/bodyEnergyReleaseCriteria.js';
import {BODY_ENERGY_NOTIFICATION_POLICY as POLICY} from '../src/bodyEnergyNotificationPolicy.js';
import {authorizeBodyEnergyFixtureDrain} from '../src/bodyEnergyDrainAuthority.js';
import {runDaily} from '../src/daily.js';
import {fakeCoach} from './fakes.js';
import {buildPhase4Core} from '../src/phase4Core.js';
import {composePhase4Stores} from '../src/phase4Repositories.js';
import {bodyEnergyMetricAnalysisTime,verifyBodyEnergyProducer} from '../src/bodyEnergyDerivedTime.js';
import {canonicalMetricSourceValue} from '../src/phase4IntelligenceStore.js';
import {bodyHealthDate} from '../src/bodyEnergyInputs.js';
const AT=Date.now()-1000,DATE=bodyHealthDate(AT,'Asia/Taipei');
async function setup(t,{drain=true,wakeMinutes=0,captureAt=AT,ongoingWorkout=false,measure=false}={}){
  let time=AT,revision=0,closed=false;const anchor=new Database('file::memory:?cache=shared'),db=createDb({url:'file::memory:?cache=shared',phase4Keys:fixtureKeys});
  const close=async()=>{if(closed)return;closed=true;global.gc?.();await new Promise(resolve=>setImmediate(resolve));db.close();anchor.close();};
  t.after(close);
  await db.migrate();for(const id of ['a','b'])await db.createUser({id,displayName:'Synthetic',timezone:'Asia/Taipei',status:'ACTIVE'},{now:new Date(AT)});
  const stores=await createPhase4Foundation({db,keys:fixtureKeys,admission:await db.admitRuntime()});
  for(const id of ['a','b'])await stores.initializeTenant(id,'SHADOW');const f={db,stores,keys:fixtureKeys};await f.db.setLocale('a','zh-TW');await f.db.setLocale('b','vi');
  const input=bodyInput({asOf:captureAt-wakeMinutes*60000});input.asOfEpochMs=captureAt;
  input.sources.recovery[0].cycle_id=input.sources.cycle[0].id;
  input.sources.cycle[0].start_at=input.sources.sleep[0].start_at;
  input.sources.cycle[0].score_state='SCORED';
  for(const rows of Object.values(input.sources))for(const row of rows)row.synced_at=new Date(captureAt).toISOString();
  for(const row of input.sync){row.last_success_at=new Date(captureAt).toISOString();row.updated_at=row.last_success_at;}
  if(ongoingWorkout)input.sources.workout.push({user_id:'a',id:'workout-progress',start_at:input.sources.sleep[0].end_at,end_at:null,strain:0,updated_at:new Date(captureAt).toISOString(),synced_at:new Date(captureAt).toISOString()});for(const sleep of input.sources.sleep){sleep.health_date=bodyHealthDate(Date.parse(sleep.end_at),'Asia/Taipei');
    input.sources.recovery.find(row=>row.sleep_id===sleep.id).health_date=sleep.health_date;}
  await f.db.transaction(()=>seedBodyInput(f.db,input));
  await f.db.ensureOnboarding('a',{state:'READY',now:new Date(AT)});
  await f.db.linkTelegram({userId:'a',chatId:'100001',now:new Date(AT)});
  const worker=await createPhase4Stage6({db:f.db,keys:f.keys,executionMode:'SHADOW',workerCapability:authorizeStage6ShadowWorker({executionMode:'SHADOW'}),now:()=>new Date(Math.max(time,Date.now()))});
  await f.stores.queue.sourceChanged(await f.stores.captureControl('a'));
  const drainAll=async()=>{
    for(let n=0;n<12&&(await worker.diagnostics()).pendingJobs;n++){
      const result=await finalizedFixtureDrain(f.db,worker,{budget:{maxItemsPerTenant:32,maxItems:64,maxWallMs:90000,leaseMs:120000}});
      assert.equal(result.failedJobs,0,JSON.stringify(result));
    }
    assert.equal((await worker.diagnostics()).pendingJobs,0);
    return {body:{result:{outcome:'COMPLETE'}}};
  };
  if(drain&&measure)await withPhaseTelemetry({phase:'STAGE6_DRAIN',source:'manual',releaseSha:'b37fd100754a8d76ea009f97cd392b38ae786abd',emit:(event,fields)=>{if(event==='phase4_trace_summary'||event==='phase4_operation_totals')process.stdout.write('BODY_ENERGY_NATIVE_TELEMETRY '+JSON.stringify({event,...fields})+'\n');}},drainAll);
  else if(drain)await drainAll();
  const grant=await authorizeBodyEnergyFixturePublication({db:f.db,userIds:['a'],notificationUserIds:['a']});
  return {...f,worker,grant,close,drainAll,input,now:()=>new Date(Math.max(time,Date.now())),setNow:value=>{time=value;},advanceProfile:async()=>{const user=await db.getUser('a');await db.updateUser('a',{displayName:'Synthetic ABA'});await db.updateUser('a',{displayName:user.displayName});}};
}
const service=f=>createBodyEnergyIntegration({db:f.db,stores:f.stores,keys:f.keys,publicationCapability:f.grant,now:f.now});
test('qualified fixture consumes actual finalized v32 Body result, localized owner and scoped durable provenance',async t=>{
  const f=await setup(t,{measure:true}),ui=service(f);
  const view=await f.stores.withContext('a',{executionMode:'SHADOW',providerRequired:true},c=>f.stores.bodyEnergy.readForPublication(c,{healthDate:DATE,asOfEpochMs:f.now().getTime()}));
  assert.equal(view.status,'AVAILABLE');assert.equal(view.value,70);assert.equal(view.algorithm,CRITERIA.algorithm);
  assert.equal(view.constantsHash,CRITERIA.constantsHash);assert.ok(view.publicationProof);assert.ok(view.wakeAtUtc);assert.ok(view.provenance.sources.length>30);
  assert.equal(Object.hasOwn(view,'manifest'),false);assert.equal(Object.hasOwn(view,'recovery'),false);
  for(const locale of ['zh-TW','vi','en']){
    await f.db.setLocale('a',locale);const result=await ui.query({text:'/energy',userId:'a',requestedAt:f.now()});
    assert.match(result.message,/Synthetic.*70\/100/);assert.match(result.message,/Kelvin Health OS/);assert.ok(result.message.includes(CRITERIA.constantsHash));assert.ok(result.message.length<4096);
    const page=await ui.query({text:'/energy sources 2',userId:'a',requestedAt:f.now()});assert.match(page.message,/sources 2/);assert.ok(page.message.length<4096);
    assert.equal(await result.verifyCurrent(),true);
  }
  const other=await ui.query({text:'năng lượng cơ thể',userId:'b',requestedAt:f.now()});
  assert.doesNotMatch(other.message,/70\/100|Synthetic/);assert.match(other.message,/chờ xác minh/);
});
test('qualification flags/JSON cannot grant publication, and absent finalized generation or stale sources withhold score',async t=>{
  const f=await setup(t,{drain:false});
  assert.equal(authorizeBodyEnergyPublication({db:f.db,userIds:['a'],qualificationId:'on'}),null);
  await assert.rejects(assertBodyEnergyPublication({qualified:true},f.db,'a'),/NOT_QUALIFIED/);
  const result=await service(f).query({text:'身體能量',userId:'a',requestedAt:f.now()});assert.doesNotMatch(result.message,/\d+\/100/);assert.match(result.message,/處理/);
  assert.equal(isBodyEnergyQuery('/energy alerts on'),false);assert.equal(isBodyEnergyQuery('explain all my history'),false);
  await f.close();const ready=await setup(t,{captureAt:Date.now()-91*60000});const stale=await service(ready).query({text:'/energy',userId:'a',requestedAt:ready.now()});
  assert.doesNotMatch(stale.message,/70\/100/);assert.match(stale.message,/新鮮/);
});
test('prepared query re-acquires current authority and fences profile ABA, locale, generation and inactive actor',async t=>{
  const f=await setup(t),ui=service(f),result=await ui.query({text:'/energy',userId:'a',requestedAt:f.now()});
  await f.advanceProfile();await assert.rejects(result.verifyCurrent(),/RECIPIENT_FENCED/);
  const next=await ui.query({text:'/energy',userId:'a',requestedAt:f.now()});await f.db.setLocale('a','vi');
  await assert.rejects(next.verifyCurrent(),/RECIPIENT_FENCED/);
  const after=await ui.query({text:'/energy',userId:'a',requestedAt:f.now()});await f.stores.queue.sourceChanged(await f.stores.captureControl('a'));
  await assert.rejects(after.verifyCurrent(),/CURRENTNESS_FENCED/);
  const pending=await ui.query({text:'/energy',userId:'a',requestedAt:f.now()});
  await f.db.transitionUserLifecycle({userId:'a',targetStatus:'DISABLED'});
  await assert.rejects(pending.verifyCurrent(),/FENCED/);
});
test('explicit alert control defaults off, is actor/chat bound, persistent and duplicate-safe without affecting Morning Brief',async t=>{
  const f=await setup(t,{drain:false}),ui=service(f),user=await f.db.getUser('a');
  assert.equal((await ui.notificationControl.read('a')).alertsEnabled,false);
  await assert.rejects(ui.notificationControl.handle({text:'/energy alerts on',user,chatId:'100002'}),/ACTOR_FENCED/);
  const onReply=await ui.notificationControl.handle({text:'/energy alerts on',user,chatId:'100001'});
  assert.equal(await ui.verifyReplyGuard(onReply.replyGuard,'a'),true);
  const once=await ui.notificationControl.read('a');assert.equal(once.alertsEnabled,true);assert.equal(once.revision,1);
  await ui.notificationControl.handle({text:'/energy alerts on',user,chatId:'100001'});assert.deepEqual(await ui.notificationControl.read('a'),once);
  const restarted=service(f);assert.deepEqual(await restarted.notificationControl.read('a'),once);
  assert.equal((await restarted.notificationControl.read('b')).alertsEnabled,false);
  await ui.notificationControl.handle({text:'/energy alerts off',user,chatId:'100001'});assert.equal((await ui.notificationControl.read('a')).revision,2);
  await assert.rejects(ui.verifyReplyGuard(onReply.replyGuard,'a'),/CONTROL_REPLY_FENCED/);
  const onAgain=await ui.notificationControl.handle({text:'/energy alerts on',user,chatId:'100001'});
  await assert.rejects(ui.verifyReplyGuard(onReply.replyGuard,'a'),/CONTROL_REPLY_FENCED/);
  assert.equal(await ui.verifyReplyGuard(onAgain.replyGuard,'a'),true);
  assert.equal(await f.db.isProactiveEnabled('a'),true);
  await f.db.transitionUserLifecycle({userId:'a',targetStatus:'DISABLED'});await f.db.transitionUserLifecycle({userId:'a',targetStatus:'ACTIVE'});
  assert.equal((await ui.notificationControl.read('a')).alertsEnabled,false);
});
test('typed drop reader never turns no new result or time decay into an alert',async t=>{
  const f=await setup(t),request={healthDate:DATE,asOfEpochMs:f.now().getTime()};
  const view=await f.stores.withContext('a',{executionMode:'SHADOW'},c=>f.stores.bodyEnergy.readForPublication(c,request));
  const candidate=await f.stores.withContext('a',{executionMode:'SHADOW'},c=>f.stores.bodyEnergy.readDropCandidate(c,{...request,previousResultId:view.resultId}));
  assert.equal(candidate.eligible,false);assert.equal(candidate.reason,'NO_NEW_RESULT');
  const wrong=await f.stores.withContext('b',{executionMode:'SHADOW'},c=>f.stores.bodyEnergy.readDropCandidate(c,{...request,previousResultId:view.resultId}));
  assert.equal(wrong.eligible,false);assert.notEqual(wrong.view?.status,'AVAILABLE');
});
const viewFor=(f,resultId='synthetic-current')=>({status:'AVAILABLE',userId:'a',resultId,healthDate:DATE,
  asOfUtc:f.now().toISOString(),asOfEpochMs:f.now().getTime(),timezone:'Asia/Taipei',value:45,quality:'AVAILABLE',confidence:1,
  algorithm:CRITERIA.algorithm,constantsHash:CRITERIA.constantsHash,publicationProof:'synthetic-current-proof',
  drivers:{initialCharge:70,timeDepletion:1,loadDepletion:24,napRecharge:0}});
async function eligibleDeliveryFixture(t,outcome='DELIVERED'){
  const f=await setup(t,{drain:false}),transport=createBodyEnergyFixtureTransport({outcome}),user=await f.db.getUser('a');
  const stores={...f.stores,bodyEnergy:{...f.stores.bodyEnergy,readDropCandidate:async()=>({view:viewFor(f),eligible:true,
    reason:'QUALIFIED_FRESH_LOAD_DROP',episodeId:'synthetic-episode',semanticEventId:'synthetic-semantic'})}};
  const sender=createBodyEnergyAlertDelivery({db:f.db,stores,keys:f.keys,publicationCapability:f.grant,fixtureTransport:transport,now:f.now});
  await sender.controls.handle({text:'/energy alerts on',user,chatId:'100001'});return {...f,sender,transport,drainAuthority:await authorizeBodyEnergyFixtureDrain({db:f.db,userId:'a'})};
}
test('isolated deterministic alert delivery durably acknowledges and deduplicates same episode without external transport',async t=>{
  const f=await eligibleDeliveryFixture(t);
  const first=await f.sender.deliver({userId:'a',drainAuthority:f.drainAuthority});assert.equal(first.status,'delivered');assert.equal(first.messageId,1);
  const claim=await f.db.getClaim('a',POLICY.reportType,'synthetic-episode');assert.equal(claim.deliveryState,'DELIVERED');assert.equal(claim.telegramMessageId,1);
  const repeat=await f.sender.deliver({userId:'a',drainAuthority:f.drainAuthority});assert.equal(repeat.status,'episode_or_policy_suppressed');assert.equal(f.transport.messages.length,1);
  const row=(await f.db.raw.execute("SELECT sent_at,outcome,message_text,reason_json FROM proactive_events WHERE user_id='a'")).rows[0];
  assert.ok(row.sent_at);assert.equal(row.outcome,'DELIVERED');assert.equal(row.message_text,null);
  assert.doesNotMatch(row.reason_json,/45|70|hrv|resting_heart_rate/);
  assert.equal((await f.sender.deliver({userId:'b'})).status,'publication_not_qualified');
});
test('ambiguous and invalid acknowledgments remain terminal and never fabricate delivery or retry',async t=>{
  for(const outcome of ['AMBIGUOUS','INVALID_ACK']){
    const f=await eligibleDeliveryFixture(t,outcome),first=await f.sender.deliver({userId:'a',drainAuthority:f.drainAuthority});
    assert.equal(first.status,'ambiguous');assert.equal(first.messageId,null);
    const claim=await f.db.getClaim('a',POLICY.reportType,'synthetic-episode');assert.equal(claim.deliveryState,'AMBIGUOUS');
    assert.equal(claim.telegramSentAt,null);await f.sender.deliver({userId:'a',drainAuthority:f.drainAuthority});assert.equal(f.transport.messages.length,1);await f.close();
  }
});
test('alert admission respects pause/global/user controls and fixture cannot reach arbitrary provider transport',async t=>{
  const f=await eligibleDeliveryFixture(t);await f.db.setProactiveEnabled('a',false);
  assert.equal((await f.sender.deliver({userId:'a',drainAuthority:f.drainAuthority})).status,'notifications_disabled');assert.equal(f.transport.messages.length,0);
  await f.db.setProactiveEnabled('a',true);await f.db.raw.execute("INSERT INTO user_notification_preferences(user_id,notifications_paused,created_at,updated_at) VALUES('a',1,'2026-09-25T00:00:00.000Z','2026-09-25T00:00:00.000Z') ON CONFLICT(user_id) DO UPDATE SET notifications_paused=1");
  assert.equal((await f.sender.deliver({userId:'a',drainAuthority:f.drainAuthority})).status,'notifications_disabled');
  const unsafe=createBodyEnergyAlertDelivery({db:f.db,stores:f.stores,keys:f.keys,publicationCapability:f.grant,fixtureTransport:{send:async()=>{throw Error('MUST_NOT_RUN');}},now:f.now});
  await assert.rejects(unsafe.deliver({userId:'a',drainAuthority:f.drainAuthority}),/FIXTURE_TRANSPORT_REQUIRED/);
  assert.equal((await f.sender.deliver({userId:'a',drainAuthority:{trigger:'FINALIZED_STAGE6_DRAIN'}})).status,'trigger_not_admitted');
});
test('rendering refuses malformed numeric/algorithm views and keeps unavailable states localized without scores',()=>{
  const fake={now:()=>new Date(AT)};
  for(const locale of ['zh-TW','vi','en']){
    const text=renderBodyEnergy(viewFor(fake),{locale,displayName:'User\nInjected'});assert.ok(text.includes('UserInjected'));
    assert.throws(()=>renderBodyEnergy({...viewFor(fake),drivers:{initialCharge:70,timeDepletion:NaN,loadDepletion:0,napRecharge:0}},{locale}),/VIEW_INVALID/);
    assert.throws(()=>renderBodyEnergy({...viewFor(fake),algorithm:'unregistered'},{locale}),/VIEW_INVALID/);
    assert.doesNotMatch(renderBodyEnergy({status:'LIMITED'},{locale}),/45\/100|70\/100/);
  }
});

const whoopDataset=input=>({
  sleeps:input.sources.sleep.map(row=>({id:row.id,start:row.start_at,end:row.end_at,created_at:row.start_at,updated_at:row.updated_at,
    nap:Boolean(row.nap),score_state:row.score_state,score:{sleep_performance_percentage:row.sleep_performance_percentage,respiratory_rate:15,
      stage_summary:{total_light_sleep_time_milli:3e6,total_slow_wave_sleep_time_milli:2e6,total_rem_sleep_time_milli:2e6,total_awake_time_milli:1e6,total_in_bed_time_milli:8e6},
      sleep_needed:{baseline_milli:8e6}}})),
  recoveries:input.sources.recovery.map(row=>({sleep_id:row.sleep_id,cycle_id:row.cycle_id??'synthetic-cycle-'+row.sleep_id,created_at:row.updated_at,updated_at:row.updated_at,
    score_state:row.score_state,score:{recovery_score:60,hrv_rmssd_milli:row.hrv_rmssd_milli,resting_heart_rate:row.resting_heart_rate,user_calibrating:Boolean(row.user_calibrating)}})),
  cycles:input.sources.cycle.map(row=>({id:row.id,start:row.start_at,end:row.end_at,created_at:row.start_at,updated_at:row.updated_at,
    score_state:'SCORED',score:{strain:row.strain}})),
});
test('actual tooSoon poll then finalized DRAIN then unchanged canonical refetch publishes Body in normal Morning Brief',async t=>{
  const f=await setup(t,{drain:false,wakeMinutes:31}),ui=service(f),dataset=whoopDataset(f.input),messages=[];
  const refetch=async()=>{
    const options={timezone:'Asia/Taipei',expectedLifecycleGeneration:1};
    await f.db.upsertSleeps('a',dataset.sleeps,options);await f.db.upsertRecoveries('a',dataset.recoveries,options);
    await f.db.upsertCycles('a',dataset.cycles,options);return dataset;
  };
  const source={poll:refetch,history:refetch},args={db:f.db,userId:'a',source,coach:fakeCoach(),
    telegram:{send:async(text,{authorize}={})=>{if(authorize&&await authorize()===false)return {messageId:null,suppressed:'ACCOUNT_INACTIVE'};messages.push(text);return {messageId:messages.length};}},timezone:'Asia/Taipei',locale:'zh-TW',
    expectedLifecycleGeneration:1,bodyEnergy:ui};
  const before=await runDaily({...args,now:new Date(Date.parse(f.input.sources.sleep[0].end_at)+5*60000)});assert.equal(before.status,'not_ready');assert.equal(messages.length,0);
  await f.drainAll();
  const original=await f.stores.withContext('a',{executionMode:'SHADOW'},c=>f.stores.bodyEnergy.readLatestCurrent(c,{healthDate:DATE,asOfEpochMs:f.now().getTime()}));
  const manifest=original.row.input_manifest_json,hash=original.row.input_manifest_hash,generation=original.row.input_generation;
  const after=await runDaily({...args,now:f.now()});assert.equal(after.status,'sent');assert.equal(messages.length,1);
  assert.match(messages[0],/Body Energy.*69\/100/);assert.match(messages[0],/工程估計/);
  const current=await f.stores.withContext('a',{executionMode:'SHADOW'},c=>f.stores.bodyEnergy.readLatestCurrent(c,{healthDate:DATE,asOfEpochMs:f.now().getTime()}));
  assert.equal(current.row.input_generation,generation);assert.equal(current.row.input_manifest_json,manifest);assert.equal(current.row.input_manifest_hash,hash);
  const claim=await f.db.getClaim('a','daily',DATE);assert.equal(claim.deliveryState,'DELIVERED');assert.equal(claim.telegramMessageId,1);
  assert.equal((await runDaily({...args,now:f.now()})).status,'already_sent');assert.equal(messages.length,1);
});
test('Body invalidation after composition safely removes optional section and delivers ordinary Morning once under same claim',async t=>{
  const f=await setup(t,{wakeMinutes:31}),ui=service(f),dataset=whoopDataset(f.input),messages=[];
  const renew=f.db.renewClaim;let invalidated=false;
  f.db.renewClaim=async args=>{const result=await renew(args);if(!invalidated){invalidated=true;
    await f.stores.queue.sourceChanged(await f.stores.captureControl('a'));}return result;};
  const result=await runDaily({db:f.db,userId:'a',source:{poll:async()=>dataset,history:async()=>dataset},coach:fakeCoach(),bodyEnergy:ui,
    telegram:{send:async(text,{authorize}={})=>{if(authorize&&await authorize()===false)return {messageId:null,suppressed:'ACCOUNT_INACTIVE'};messages.push(text);return {messageId:1};}},timezone:'Asia/Taipei',locale:'zh-TW',now:f.now(),expectedLifecycleGeneration:1});
  assert.equal(result.status,'sent');assert.equal(messages.length,1);assert.doesNotMatch(messages[0],/Body Energy|70\/100/);
  assert.equal((await f.db.getClaim('a','daily',DATE)).deliveryState,'DELIVERED');
  assert.equal((await f.db.raw.execute("SELECT count(*) n FROM report_claims WHERE user_id='a' AND report_type='daily'")).rows[0].n,1);
});
test('derived analysis authorizes original persistence time while raw WHOOP future ingestion, forged cutoff/currentness remain rejected',async t=>{
  const f=await setup(t);
  const core=await buildPhase4Core({processing:{client:f.db.raw,transaction:f.db.transaction,active:f.db.processingTransactionActive,
    afterCommit:f.db.afterProcessingCommit,afterCompletion:f.db.afterProcessingCompletion},keys:f.keys,admission:await f.db.admitRuntime(),
    authorizeMode:mode=>{assert.equal(mode,'SHADOW');}}),stores=composePhase4Stores(core);
  await stores.withContext('a',{executionMode:'SHADOW'},async c=>{
    const result=await stores.bodyEnergy.readLatestCurrent(c,{healthDate:DATE,asOfEpochMs:f.now().getTime()});
    const artifact=await stores.readArtifact(c,'body_energy_results',{result_id:result.row.result_id});
    const analysis=await bodyEnergyMetricAnalysisTime(core,c,artifact,result.row.as_of_utc);
    assert.equal(analysis,result.row.created_at);assert.ok(Date.parse(analysis)>result.row.as_of_epoch_ms);
    assert.equal(result.manifest.as_of_utc,result.row.as_of_utc);
    await assert.rejects(bodyEnergyMetricAnalysisTime(core,c,artifact,new Date(Date.now()+86400000).toISOString()),/CUTOFF_MISMATCH/);
    await assert.rejects(bodyEnergyMetricAnalysisTime(core,c,{...artifact,ref:{...artifact.ref}},result.row.as_of_utc),/INVALID_SOURCE_REFERENCE/);
    await assert.rejects(verifyBodyEnergyProducer(core,c,{...artifact.row,created_at:new Date(Date.now()+86400000).toISOString()}),/DERIVED_TIME_INVALID/);
    await assert.rejects(verifyBodyEnergyProducer(core,c,{...artifact.row,user_id:'b'}),/CURRENTNESS_FENCED/);
    const future=new Date(Date.parse(analysis)+1).toISOString();
    assert.throws(()=>canonicalMetricSourceValue('rhr',{type:'recovery',id:'synthetic',row:{score_state:'SCORED',user_calibrating:0,
      resting_heart_rate:60,updated_at:future,synced_at:future,health_date:DATE}},c,analysis),/METRIC_SOURCE_INVALID/);
    const observed=canonicalMetricSourceValue('body_energy',{type:'body_energy_results',id:result.row.result_id,row:result.row},c,analysis);
    assert.equal(observed.observedAt,result.row.as_of_utc);assert.equal(observed.ingestedAt,result.row.created_at);
  });
});
test('atomic legacy/Body rolling cap and Body topic cooldown apply across overlap, generations and policy retries',async t=>{
  const f=await setup(t,{drain:false}),now=f.now(),claim=(id,key,policy='legacy')=>f.db.claimProactiveEvent(id,{healthDate:DATE,idempotencyKey:key,
    signals:[{code:policy===POLICY.version?POLICY.signalCode:'HRV_LOW',metric:policy===POLICY.version?'body_energy':'hrv'}],decision:'NOTIFY',
    reason:{code:'SYNTHETIC'},policyVersion:policy,messageText:null},{now,expectedLifecycleGeneration:1});
  const [body1,body2]=await Promise.all([claim('a','body-episode-1',POLICY.version),claim('a','body-episode-2',POLICY.version)]);
  assert.equal([body1,body2].filter(r=>r.claimed).length,1);
  const legacy=await Promise.all(Array.from({length:5},(_,n)=>claim('a','legacy-'+n)));
  assert.equal(legacy.filter(r=>r.claimed).length,1);
  assert.equal((await f.db.raw.execute("SELECT count(*) n FROM proactive_events WHERE user_id='a' AND decision='NOTIFY'")).rows[0].n,2);
  await f.stores.queue.sourceChanged(await f.stores.captureControl('a'));
  assert.equal((await claim('a','body-episode-1',POLICY.version)).claimed,false);
  assert.equal((await claim('b','body-episode-1',POLICY.version)).claimed,true);
  const nonMessage=await f.db.claimProactiveEvent('a',{healthDate:DATE,idempotencyKey:'log-only',decision:'LOG_ONLY',policyVersion:'legacy'},
    {now,expectedLifecycleGeneration:1});assert.equal(nonMessage.claimed,true);
});


test('future ingestion bookkeeping cannot prolong publication or pass current reader clock',async t=>{
  const f=await setup(t),before=await service(f).query({text:'/energy',userId:'a',requestedAt:f.now()});
  await f.db.raw.execute({sql:"UPDATE whoop_sleeps SET synced_at=? WHERE user_id='a' AND id='sleep-00'",args:[new Date(Date.now()+60000).toISOString()]});
  await assert.rejects(before.verifyCurrent(),/VERSION_MISMATCH/);
  await assert.rejects(f.stores.withContext('a',{executionMode:'SHADOW'},c=>f.stores.bodyEnergy.readForPublication(c,{healthDate:DATE,asOfEpochMs:Date.now()+60000})),/FUTURE_REQUEST/);
});
test('transport-final Body invalidation proves zero-send before ordinary fallback under the same claim',async t=>{
  const f=await setup(t,{wakeMinutes:31}),ui=service(f),dataset=whoopDataset(f.input),messages=[];let attempts=0;
  const result=await runDaily({db:f.db,userId:'a',source:{poll:async()=>dataset,history:async()=>dataset},coach:fakeCoach(),bodyEnergy:ui,
    telegram:{send:async(text,{authorize}={})=>{attempts++;if(attempts===1)await f.stores.queue.sourceChanged(await f.stores.captureControl('a'));
      if(authorize&&await authorize()===false)return {messageId:null,suppressed:'ACCOUNT_INACTIVE'};messages.push(text);return {messageId:1};}},
    timezone:'Asia/Taipei',locale:'zh-TW',now:f.now(),expectedLifecycleGeneration:1});
  assert.equal(result.status,'sent');assert.equal(attempts,2);assert.equal(messages.length,1);assert.doesNotMatch(messages[0],/Body Energy|\d+\/100/);
  const claim=await f.db.getClaim('a','daily',DATE);assert.equal(claim.deliveryState,'DELIVERED');assert.equal(claim.telegramMessageId,1);
});

test('actual CYCLE score with receipt-backed newly-created completed workout admits relative-only drop and durable localized delivery',async t=>{
  const f=await setup(t),request=()=>({healthDate:DATE,asOfEpochMs:Date.now()}),
    old=await f.stores.withContext('a',{executionMode:'SHADOW'},c=>f.stores.bodyEnergy.readForPublication(c,request())),
    transport=createBodyEnergyFixtureTransport(),sender=createBodyEnergyAlertDelivery({db:f.db,stores:f.stores,keys:f.keys,publicationCapability:f.grant,fixtureTransport:transport,now:f.now}),
    user=await f.db.getUser('a'),drainAuthority=await authorizeBodyEnergyFixtureDrain({db:f.db,userId:'a'});
  await sender.controls.handle({text:'/energy alerts on',user,chatId:'100001'});
  assert.equal((await sender.deliver({userId:'a',drainAuthority})).status,'no_eligible_drop');
  const at=Date.now(),iso=ms=>new Date(ms).toISOString();assert.ok(at-1000>old.asOfEpochMs);
  const cycle=whoopDataset(f.input).cycles[0];cycle.updated_at=iso(at);cycle.score.strain=8;
  await f.db.upsertCycles('a',[cycle],{timezone:'Asia/Taipei',now:new Date(at)});
  await f.db.upsertWorkouts('a',[{id:'synthetic-new-completed',start:iso(at-2000),end:iso(at-1000),created_at:iso(at-500),updated_at:iso(at),score_state:'SCORED',score:{strain:8}}],{timezone:'Asia/Taipei',now:new Date(at)});
  await f.drainAll();
  const candidate=await f.stores.withContext('a',{executionMode:'SHADOW'},c=>f.stores.bodyEnergy.readDropCandidate(c,{...request(),previousResultId:old.resultId}));
  assert.equal(candidate.eligible,true);assert.equal(candidate.view.provenance.included.loadKind,'CYCLE');
  assert.equal(candidate.view.provenance.included.loadIds.length,1);
  const unexpectedDrop=old.value-candidate.view.value-Math.max(0,candidate.view.drivers.timeDepletion-old.drivers.timeDepletion);
  assert.ok(unexpectedDrop<12);assert.ok(unexpectedDrop/old.value>=.15);
  const sent=await sender.deliver({userId:'a',drainAuthority});assert.equal(sent.status,'delivered');assert.equal(transport.messages.length,1);
  assert.match(transport.messages[0],/Synthetic/);assert.match(transport.messages[0],/健康參考/);
  assert.equal((await f.db.getClaim('a',POLICY.reportType,candidate.episodeId)).deliveryState,'DELIVERED');
  assert.equal((await sender.deliver({userId:'a',drainAuthority})).status,'no_eligible_drop');assert.equal(transport.messages.length,1);
});
test('actual finalized open-cycle correction without a new completed workout cannot become a sudden-drop alert',async t=>{
  const f=await setup(t),old=await f.stores.withContext('a',{executionMode:'SHADOW'},c=>f.stores.bodyEnergy.readForPublication(c,{healthDate:DATE,asOfEpochMs:Date.now()}));
  const cycle=whoopDataset(f.input).cycles[0];cycle.updated_at=new Date().toISOString();cycle.score.strain=18;
  await f.db.upsertCycles('a',[cycle],{timezone:'Asia/Taipei'});await f.drainAll();
  const candidate=await f.stores.withContext('a',{executionMode:'SHADOW'},c=>f.stores.bodyEnergy.readDropCandidate(c,{healthDate:DATE,asOfEpochMs:Date.now(),previousResultId:old.resultId}));
  assert.equal(candidate.view.status,'AVAILABLE');assert.ok(candidate.view.value<old.value-12);assert.equal(candidate.eligible,false);assert.equal(candidate.reason,'NO_RECEIPT_BACKED_LOAD_EVENT');
});


test('late consent revocation suppresses a prepared eligible alert before any isolated transport',async t=>{
  const f=await eligibleDeliveryFixture(t),claim=f.db.claimReport,user=await f.db.getUser('a');
  f.db.claimReport=async request=>{const value=await claim(request);await f.sender.controls.handle({text:'/energy alerts off',user,chatId:'100001'});return value;};
  const result=await f.sender.deliver({userId:'a',drainAuthority:f.drainAuthority});assert.equal(result.status,'fenced');assert.equal(f.transport.messages.length,0);
  const row=(await f.db.raw.execute("SELECT sent_at,outcome FROM proactive_events WHERE user_id='a'")).rows[0];assert.equal(row.sent_at,null);assert.notEqual(row.outcome,'DELIVERED');
});
