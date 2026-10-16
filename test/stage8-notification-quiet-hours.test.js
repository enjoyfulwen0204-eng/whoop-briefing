import test from 'node:test';
import assert from 'node:assert/strict';
import {stage8Fixture} from './stage8Fixture.js';
import {syntheticPhase4Fixture} from './phase4Fixture.js';
import {bodyInput,seedBodyInput} from './bodyEnergyFixture.js';
import {grantSourceConsent} from './stage8SourceConsentFixture.js';
import {createStage7Companion} from '../src/stage7Companion.js';
import {createOwnerMonitoring} from '../src/stage8OwnerMonitoring.js';
import {createStage8OwnerDispatcher} from '../src/stage8OwnerDispatcher.js';
import {createStage8LiveProducer} from '../src/stage8LiveProducer.js';
import {createSyntheticStage8SubjectAlertProvider} from '../src/stage8SubjectAlerts.js';
import {readStage8RecipientQuietHours,stage8RecipientIsQuiet,sendStage8RecipientNotification} from '../src/stage8NotificationQuietHours.js';
import {SEND_OUTCOME} from '../src/sendOutcome.js';
import {localHour} from '../src/time.js';

async function setQuiet(f,userId,start,end){
 const companion=createStage7Companion(f),user=await f.db.getUser(userId),chatId=await f.db.getActiveChatIdForUser(userId,{expectedLifecycleGeneration:user.lifecycleGeneration});
 return f.db.transaction(async()=>{const actor=await companion.interactions.authenticate({user,chatId}),p=await companion.preferences(actor);return companion.changePreferences(actor,p,{quiet_start:start,quiet_end:end});});
}
async function ownerFixture(t){
 const f=await stage8Fixture(t,{owner:true}),monitoring=await createOwnerMonitoring({...f,ownerId:'a',enabled:()=>true,sourceConsent:f.app.sourceConsent,now:f.now});
 await grantSourceConsent(f);const actor=await monitoring.authenticate(f.input),request={subjectId:'b',notificationClass:'DAILY_SUMMARY'};
 await monitoring.configure(actor,{...request,enabled:true,expectedRevision:0,operationKey:'quiet-explicit-owner-follow'});
 assert.equal((await monitoring.prepareDaily(actor,'b')).status,'CURRENT_PLAN');
 const allowed=await monitoring.authorize(actor,request),proposal=await monitoring.propose(actor,allowed.ticket);
 assert.equal(proposal.status,'PROPOSED');return {...f,monitoring,actor,request,proposal};
}
const outbox=async f=>(await f.db.raw.execute('SELECT state,attempt_count FROM owner_monitoring_outbox')).rows[0];
const attempts=async f=>(await f.db.raw.execute('SELECT state FROM owner_monitoring_attempts')).rows;
const quietFailure=error=>error?.message==='STAGE8_NOTIFICATION_QUIET_HOURS'&&error.sendOutcome===SEND_OUTCOME.DEFINITE_FAILURE;

test('canonical quiet hours use recipient timezone, wrap midnight, exclude the end, and absent preferences stay absent',async t=>{
 const f=await stage8Fixture(t),p=await readStage8RecipientQuietHours(f.db,'a');
 assert.deepEqual(p,{timezone:'Asia/Taipei',start:'22:00',end:'08:00'});
 for(const [at,quiet] of [['2026-09-19T13:59:59Z',false],['2026-09-19T14:00:00Z',true],['2026-09-19T23:59:59Z',true],['2026-09-20T00:00:00Z',false]])assert.equal(stage8RecipientIsQuiet(p,new Date(at)),quiet);
 assert.equal(stage8RecipientIsQuiet({...p,timezone:'America/Los_Angeles'},new Date('2026-09-19T14:00:00Z')),true,'07:00 recipient local time');
 assert.equal(stage8RecipientIsQuiet({...p,start:'09:00',end:'10:00'},f.now()),true);
 assert.equal(stage8RecipientIsQuiet({...p,start:'09:00',end:'09:00'},f.now()),false);
 assert.equal(Number((await f.db.raw.execute('SELECT count(*) n FROM journal_tracking_preferences')).rows[0].n),0,'reader never creates opt-in/preferences');
});

test('final notification boundary reads changed canonical preferences after validation and refuses before provider IO',async t=>{
 const f=await stage8Fixture(t);let calls=0;
 await setQuiet(f,'a','10:00','11:00');
 const transaction=f.db.transaction;let armed=true;
 t.mock.method(f.db,'transaction',async(...args)=>{if(armed){armed=false;await setQuiet(f,'a','09:00','10:00');}return transaction(...args);});
 await assert.rejects(sendStage8RecipientNotification({db:f.db,userId:'a',now:f.now,verify:async()=>{},send:()=>{calls++;}}),quietFailure);
 assert.equal(calls,0);
 const p=(await f.db.raw.execute("SELECT daily_enabled,weekly_enabled,coach_enabled FROM journal_tracking_preferences WHERE user_id='a'")).rows[0];
 assert.deepEqual({...p},{daily_enabled:0,weekly_enabled:0,coach_enabled:0});
});

test('clock crossing quiet-start after the final database snapshot still refuses; quiet-end permits the same boundary',async t=>{
 const f=await stage8Fixture(t);let at=Date.parse('2026-09-19T13:59:59.999Z'),calls=0;
 const now=()=>new Date(at),transaction=f.db.transaction;
 t.mock.method(f.db,'transaction',async(...args)=>{const result=await transaction(...args);at=Date.parse('2026-09-19T14:00:00Z');return result;});
 await assert.rejects(sendStage8RecipientNotification({db:f.db,userId:'a',now,verify:async()=>{},send:()=>{calls++;}}),quietFailure);assert.equal(calls,0);
 t.mock.restoreAll();at=Date.parse('2026-09-20T00:00:00Z');
 assert.equal(await sendStage8RecipientNotification({db:f.db,userId:'a',now,verify:async()=>{},send:()=>{calls++;return 'synthetic-ack';}}),'synthetic-ack');assert.equal(calls,1);
});

test('Owner quiet defers existing pending work without attempts; interactive reads remain available, unpause sends once to the owner',async t=>{
 const f=await ownerFixture(t);let calls=0;
 t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response(JSON.stringify({ok:true,result:{message_id:909,date:Math.floor(f.now().getTime()/1000),chat:{id:123,type:'private'}}}),{status:200});});
 const dispatcher=createStage8OwnerDispatcher({...f,env:f.env,enabled:()=>true,now:f.now});
 await setQuiet(f,'a','09:00','10:00');
 for(let n=0;n<2;n++)assert.equal((await dispatcher.dispatch(f.input,f.request)).status,'QUIET_HOURS');
 assert.deepEqual({...await outbox(f)},{state:'PROPOSED',attempt_count:0});assert.deepEqual(await attempts(f),[]);assert.equal(calls,0);
 assert.equal((await f.monitoring.authorize(await f.monitoring.authenticate(f.input),f.request)).status,'APPROVED','quiet hours do not block interactive owner reads');
 const self=await f.app.handle({...f.input,text:'How is my Recovery?'});assert.ok(self?.stage8ReplyGuard,'interactive self query remains available');
 const control=await f.stores.captureControl('a'),p=await f.stores.preferences.read(control);await f.stores.preferences.update(control,p.preference_version,{notifications_paused:1});
 await assert.rejects(dispatcher.dispatch(f.input,f.request),/OWNER_NOTIFICATIONS_PAUSED/);assert.equal(calls,0);
 const paused=await f.stores.preferences.read(control);await f.stores.preferences.update(control,paused.preference_version,{notifications_paused:0});
 await setQuiet(f,'a','10:00','11:00');await setQuiet(f,'b','09:00','10:00');
 assert.equal((await dispatcher.dispatch(f.input,f.request)).providerOutcome,'DELIVERED','source quiet period is not the recipient quiet period');
 assert.equal(calls,1);assert.equal((await dispatcher.dispatch(f.input,f.request)).status,'DELIVERED');assert.equal(calls,1);
 assert.deepEqual({...await outbox(f)},{state:'DELIVERED',attempt_count:1});
});

for(const mutation of ['preference','clock'])test(`Owner final runtime-fence ${mutation} change has a definite non-send outcome`,async t=>{
 const f=await ownerFixture(t);let calls=0,validations=0,armed=false;
 await setQuiet(f,'a','09:11','10:00');
 t.mock.method(globalThis,'fetch',async()=>{calls++;throw Error('SYNTHETIC_PROVIDER_FORBIDDEN');});
 const monitoring={...f.monitoring,validate:async(...args)=>{const result=await f.monitoring.validate(...args);if(++validations===3)armed=true;return result;}};
 const original=f.db.assertRuntimeFences;t.mock.method(f.db,'assertRuntimeFences',async()=>{if(armed){armed=false;if(mutation==='preference')await setQuiet(f,'a','09:00','10:00');else f.setTime('2026-09-19T01:11:00Z');}return original?.();});
 const dispatcher=createStage8OwnerDispatcher({...f,monitoring,env:f.env,enabled:()=>true,now:f.now}),result=await dispatcher.dispatch(f.input,f.request);
 assert.equal(calls,0);assert.equal(result.providerOutcome,'FAILED_DEFINITE');assert.deepEqual((await attempts(f)).map(row=>row.state),['FAILED_DEFINITE']);
 assert.equal((await dispatcher.dispatch(f.input,f.request)).status,'QUIET_HOURS');assert.equal((await outbox(f)).attempt_count,1,'quiet ticks consume no further retries');
});

for(const quiet of [true,false])test(`real subject analysis finalizes a nonempty episode with recipient quiet=${quiet} and truthful delivery`,async t=>{
 t.mock.method(globalThis,'fetch',async()=>{throw Error('NETWORK_FORBIDDEN');});
 const f=await syntheticPhase4Fixture(t,{targetVersion:35,now:()=>new Date()}),input=bodyInput({asOf:Date.now()-1000,days:10});
 // One main sleep and ten earlier Recovery samples are enough for the frozen
 // severe-single threshold; this is a focused notification test, not a dense
 // capacity campaign. No derived rows, job receipts or publications are seeded.
 input.sources.sleep=input.sources.sleep.slice(0,1);
 for(let i=0;i<input.sources.recovery.length;i++)input.sources.recovery[i].recovery_score=i===0?10:60+i%5;
 await f.db.transaction(()=>seedBodyInput(f.db,input));await f.db.ensureOnboarding('a',{state:'READY'});await f.db.linkTelegram({userId:'a',chatId:'10001'});
 await f.db.raw.execute("INSERT INTO tenant_delivery_modes(user_id,execution_mode,message_family,mode,lifecycle_generation,auth_generation,changed_at,reason_code,cutover_boundary,timezone) VALUES('a','LIVE','EPISODE_NOTIFICATION','PHASE4',1,1,'2026-10-01','CUTOVER_COMMITTED','2026-10-01','Asia/Taipei')");
 const control=await f.stores.captureControl('a'),p=await f.stores.preferences.read(control);await f.stores.preferences.update(control,p.preference_version,{notifications_paused:0});
 const admission=await f.db.admitRuntime(),provider=createSyntheticStage8SubjectAlertProvider({db:f.db,now:f.core.now}),producer=await createStage8LiveProducer({...f,admission,userIds:['a'],enabled:()=>true,eligible:id=>id==='a',subjectAlertProvider:provider});
 const hour=localHour(new Date(),'Asia/Taipei'),hm=h=>String(h%24).padStart(2,'0')+':00';
 await setQuiet(f,'a',quiet?hm(hour):'00:00',quiet?hm(hour+2):'00:00');let result,legs=0;
 for(;legs<24;legs++){
  result=await producer.run({userId:'a',requestId:`quiet-${quiet}-important-${legs}`});if(result.publication.status==='CURRENT')break;
 }
 assert.equal(result.publication.status,'CURRENT');assert.equal(provider.calls.length,quiet?0:1);
 assert.ok(Number((await f.db.raw.execute("SELECT count(*) n FROM observation_episodes WHERE user_id='a' AND execution_mode='LIVE'")).rows[0].n)>0);
 assert.equal(Number((await f.db.raw.execute("SELECT count(*) n FROM outbound_delivery_attempts WHERE user_id='a' AND execution_mode='LIVE'")).rows[0].n),quiet?0:1);
 assert.equal(Number((await f.db.raw.execute("SELECT count(*) n FROM outbound_messages WHERE user_id='a' AND message_class='EPISODE_NOTIFICATION'")).rows[0].n),quiet?0:1);
 if(!quiet){
  assert.equal((await f.db.raw.execute("SELECT state FROM outbound_messages WHERE user_id='a' AND message_class='EPISODE_NOTIFICATION'")).rows[0].state,'DELIVERED');
  assert.equal((await f.db.raw.execute("SELECT state FROM outbound_delivery_attempts WHERE user_id='a' AND execution_mode='LIVE'")).rows[0].state,'DELIVERED');
 }
 const alerts=(await f.db.raw.execute("SELECT result_json FROM stage8_live_executions WHERE json_extract(result_json,'$.outcome')='NO_ELIGIBLE_WORK'")).rows;
 assert.equal(alerts.length>0,quiet);t.diagnostic(`Own synthetic source analysis: ${legs+1} bounded producer legs, quiet=${quiet}, synthetic alert calls=${provider.calls.length}; no Production evidence.`);
});

test('Owner quiet still recovers a pre-existing started attempt as ambiguous without provider IO',async t=>{
 const f=await ownerFixture(t);let calls=0;
 await f.monitoring.start(f.actor,{subjectId:'b',messageId:f.proposal.messageId,expectedRevision:0});await setQuiet(f,'a','09:00','10:00');
 t.mock.method(globalThis,'fetch',async()=>{calls++;throw Error('SYNTHETIC_PROVIDER_FORBIDDEN');});
 const dispatcher=createStage8OwnerDispatcher({...f,env:f.env,enabled:()=>true,now:f.now}),result=await dispatcher.dispatch(f.input,f.request);
 assert.equal(result.status,'AMBIGUOUS');assert.equal(result.recovered,true);assert.equal(calls,0);assert.deepEqual((await attempts(f)).map(row=>row.state),['AMBIGUOUS']);
});
