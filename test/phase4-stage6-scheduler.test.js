import test from 'node:test';
import assert from 'node:assert/strict';
import { schedulerWindow,schedulerProviderState,stage6SchedulerDecision,FUTURE_CLOUDFLARE_CRON } from '../src/schedulerPolicy.js';
import { runPhase4Stage6 } from '../src/shadowDrainScheduler.js';
import { checkPeerScheduler,readSchedulerHealth,SCHEDULER_ALERT_TYPE } from '../src/schedulerWatchdog.js';
import { HEARTBEAT_COMPONENT as C } from '../src/guardianPolicy.js';
import { runBriefing } from '../src/index.js';
const at=time=>new Date(`2026-09-25T${time}+08:00`);

test('Stage 6 Taipei boundaries and startup grace use the same scheduling and monitoring policy',()=>{
  for(const [time,expected,grace] of [['07:59:59',false,false],['08:00:00',true,true],['08:20:59',true,true],
    ['08:21:00',true,false],['11:59:59',true,false],['12:00:00',false,false]]) {
    const now=at(time),window=schedulerWindow(now);
    assert.equal(window.cloudflareExpected,expected,time);assert.equal(window.startupGrace,grace,time);
    assert.equal(stage6SchedulerDecision({source:'cloudflare',now}).drain,expected);
    assert.equal(stage6SchedulerDecision({source:'github',now}).drain,!expected||!grace);
    assert.equal(schedulerProviderState(null,'cloudflare',now).state,!expected?'not_expected':grace?'startup_grace':'stale');
  }
  assert.equal(FUTURE_CLOUDFLARE_CRON,'*/10 0-3 * * *');
});

test('Stage 6 CF >30m and outside-window GitHub >3h staleness; sync-only CF heartbeat does not suppress GH Stage 6',async()=>{
  const now=at('09:00:00');
  for(const [minutes,state] of [[30,'healthy'],[30.001,'stale']])
    assert.equal(schedulerProviderState({lastOkAt:new Date(now.getTime()-minutes*60000).toISOString()},'cloudflare',now).state,state);
  const outside=at('12:00:00');
  for(const [hours,state] of [[3,'healthy'],[3.001,'stale']])
    assert.equal(schedulerProviderState({lastOkAt:new Date(outside.getTime()-hours*3600000).toISOString()},'github',outside).state,state);
  let calls=0;const worker={drain:async request=>{calls++;return {outcome:'DRAINED',...request};}},db={getHeartbeat:async()=>({lastOkAt:now.toISOString()})};
  assert.equal((await runPhase4Stage6({db,worker,triggerSource:'github',now})).role,'fallback');
  db.getHeartbeat=async()=>null;
  assert.equal((await runPhase4Stage6({db,worker,triggerSource:'github',now})).role,'fallback');
  assert.equal((await runPhase4Stage6({db,worker,triggerSource:'github',now:outside})).role,'background');
  for(const triggerSource of ['manual','event'])assert.equal((await runPhase4Stage6({db,worker,triggerSource,now,userId:'a'})).userId,'a');
  assert.equal(calls,5);assert.equal((await runPhase4Stage6({db,now})).outcome,'DISABLED');
});

test('Stage 6 watchdog is quiet outside CF window; event/manual never alert or recover; recorded outage recovers once',async()=>{
  let now=at('09:00:00'),lastAlert=null,alerts=0,recoveries=0;const flags=new Set(),beats=new Map([[C.GITHUB,{lastOkAt:now.toISOString()}]]);
  const db={getHeartbeat:async(_scope,component)=>beats.get(component),hasErrorNotify:async(_scope,key)=>flags.has(key),
    clearErrorNotify:async(_scope,key)=>flags.delete(key)};
  const telegram={notifyError:async(key,_message,{cooldownHours})=>{
    assert.equal(cooldownHours,24);if(lastAlert!==null&&now-lastAlert<24*3600000)return false;
    flags.add(key);lastAlert=now;alerts++;return true;
  },send:async()=>{recoveries++;}};
  assert.equal((await checkPeerScheduler({db,source:'github',systemTelegram:telegram,now})).alerted,true);
  assert.equal((await checkPeerScheduler({db,source:'github',systemTelegram:telegram,now})).alerted,false);
  beats.set(C.CLOUDFLARE,{lastOkAt:now.toISOString()});
  for(const source of ['manual','event']) {
    const result=await checkPeerScheduler({db,source,systemTelegram:telegram,now});assert.equal(result.recovered,false);
    assert.ok(flags.has(SCHEDULER_ALERT_TYPE));
  }
  assert.equal((await checkPeerScheduler({db,source:'cloudflare',systemTelegram:telegram,now})).recovered,true);
  assert.equal((await checkPeerScheduler({db,source:'cloudflare',systemTelegram:telegram,now})).recovered,false);
  now=at('20:00:00');beats.set(C.GITHUB,{lastOkAt:now.toISOString()});
  const quiet=await checkPeerScheduler({db,source:'github',systemTelegram:telegram,now});
  assert.equal(quiet.cloudflare.state,'not_expected');assert.equal(quiet.overall,'healthy');assert.equal(alerts,1);assert.equal(recoveries,1);
  beats.set(C.GITHUB,{lastOkAt:at('16:59:59').toISOString()});assert.equal((await readSchedulerHealth({db,now})).overall,'outage');
});

function runner(outcome='DRAINED') {
  const beats=[],calls=[];
  const db={migrate:async()=>{},close(){},listActiveUsers:async()=>[],getHeartbeat:async()=>null,
    recordHeartbeat:async(scope,component)=>beats.push({scope,component}),listPendingOnboarding:async()=>[]};
  const env={timezone:'Asia/Taipei',dryRun:true,maxUserConcurrency:1,telegramBotToken:'SYNTHETIC',telegramChatId:'SYNTHETIC'};
  const worker={drain:async options=>{calls.push(options);return {outcome,claimedJobs:1,failedJobs:outcome==='FAILED'?1:0};}};
  return {db,env,worker,beats,calls};
}
for(const triggerSource of ['manual','event','github','cloudflare'])test(`Stage 6 runner: ${triggerSource} SYNC leaves Stage 6 unentered and attributes liveness exactly`,async()=>{
  const f=runner();const result=await runBriefing({now:at('09:00:00'),triggerSource,deps:{db:f.db,env:f.env,phase4Stage6:f.worker}});
  assert.equal(f.calls.length,0);assert.equal(result.phase4Stage6.outcome,'NOT_ENTERED');assert.equal(result.outcome,'nothing_due');
  assert.deepEqual(f.beats.map(beat=>beat.component),['github','cloudflare'].includes(triggerSource)?[triggerSource==='github'?C.GITHUB:C.CLOUDFLARE,C.CRON]:[]);
});

test('injected Stage 6 failure is never entered or mislabeled by SYNC',async()=>{
  const f=runner('FAILED');const result=await runBriefing({now:at('09:00:00'),triggerSource:'github',deps:{db:f.db,env:f.env,phase4Stage6:f.worker}});
  assert.equal(result.runState,'alive');assert.equal(result.outcome,'nothing_due');assert.equal(result.errors.length,0);
  assert.equal(f.calls.length,0);assert.equal(f.beats.length,2);
});

test('SYNC never enters beta reads, ordinary sync remains reachable', async () => {
  const f=runner();const order=[];
  f.db.listActiveUsers=async()=>[{id:'a',timezone:'Asia/Taipei'}];
  f.worker.drain=async()=>{order.push('drain');return {outcome:'DRAINED',failedJobs:0};};
  const result=await runBriefing({now:at('09:00:00'),triggerSource:'manual',deps:{
    db:f.db,env:f.env,phase4Stage6:f.worker,betaPresentation:{},
    betaNow:()=>{order.push('as_of');return at('09:00:00');},
    runUser:async()=>{order.push('sync');return {daily:null,weekly:null,skipped:null,errors:[],sync:{outcome:'NO_NEW_DATA_SUCCESS'}};},
    deliverBetaSummary:async()=>{order.push('typed_read');order.push('send');return {status:'delivered'};},
  }});
  assert.deepEqual(order,['sync']);
  assert.equal(result.betaSummaries,undefined);assert.equal(result.syncComplete,true);
});
