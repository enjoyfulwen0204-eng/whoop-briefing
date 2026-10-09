import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {deliveryFixture,fixtureKeys} from './deliveryDefaultFixture.js';import {claimPhaseRequest,canonicalPhaseRequest,configurationProof} from '../src/phase4ExecutionStore.js';import {runningReleaseSha} from '../src/phase4Release.js';
import {runExecutionPhase} from '../src/phase4Execution.js';import {runDaily} from '../src/daily.js';import {staticDataSource} from '../src/dataSource.js';import {makeDataset} from './fixtures.js';import {fakeCoach} from './fakes.js';
const environment={PHASE4_BETA_SHADOW_RUNTIME:'off',PHASE4_PUBLIC_BETA_MODE:'off'},timezone='Asia/Kabul';
for(const kind of ['late-continuation','expired-continuation','explicit-fixture','late-during-coach','expired-during-coach'])test(`Morning Brief live-clock policy: ${kind}`,async t=>{
 const {db}=await deliveryFixture(t),uid='alice';await db.createUser({id:uid,displayName:'Alice',status:'ACTIVE',timezone});await db.setLocale(uid,'en');await db.getCapabilities(uid);
 const RealDate=Date,originalAt=Date.parse(new Date(Date.now()+86400000).toISOString().slice(0,10)+'T19:29:00Z');let wallAt=originalAt;
 class ClockDate extends RealDate{constructor(...a){super(...(a.length?a:[wallAt]));}static now(){return wallAt;}}
 // Advance the isolated JS clock ahead of SQLite wall time; owner deadlines
 // remain valid while the policy clock crosses midnight/cutoffs. No DB clock override.
 globalThis.Date=ClockDate;
 try{
  const r={requestId:'p4c1_'+randomUUID(),releaseSha:runningReleaseSha(),phase:'SYNC',triggerSource:'cloudflare',executionMode:'OFF',configProof:configurationProof(fixtureKeys,{runtime:'off',mode:'off'},environment)};
  await claimPhaseRequest(db,r,canonicalPhaseRequest(r));await db.raw.execute({sql:'UPDATE phase4_executions SET lease_until=0,deadline_at=0 WHERE execution_id=?',args:[r.requestId]});
  const during=kind.includes('during'),expired=kind.includes('expired'),explicit=kind==='explicit-fixture';
  const wakeMinutesAgo=expired?(during?2879.99:2875):(during?1439.99:1435),dataset=makeDataset({now:new Date(originalAt),days:3,wakeMinutesAgo,withNaps:false});
  if(!during)wallAt+=10*60000;
  let dailyResult,sends=0,authorization;const authorize=db.authorizeReportDelivery;
  db.authorizeReportDelivery=async args=>{const row=(await db.raw.execute({sql:'SELECT expires_at FROM report_claims WHERE user_id=? AND report_type=? AND local_date=?',args:[uid,args.reportType,args.localDateKey]})).rows[0];authorization={now:args.now.getTime(),live:Date.now(),expires:Date.parse(row.expires_at)};return authorize(args);};
  const coach=fakeCoach(),plan=coach.narrativePlan;coach.narrativePlan=async(...a)=>{if(during)wallAt+=2000;return plan(...a);};
  await runExecutionPhase({request:r,body:canonicalPhaseRequest(r),db,keys:fixtureKeys,environment,env:{dryRun:true},...(explicit?{now:new Date(originalAt)}:{}),deps:{runBriefing:async({now})=>{
   assert.equal(now.getTime(),originalAt,'WHOOP window remains the original phase window');
   dailyResult=await runDaily({db,userId:uid,source:staticDataSource(dataset),coach,telegram:{send:async()=>{sends++;return {messageId:1};},notifyError:async()=>true},timezone,locale:'en',now,expectedLifecycleGeneration:1});
   return {syncComplete:true,syncOutcome:'NO_NEW_DATA_SUCCESS',users:1,failed:0};
  }}});
  assert.equal(sends,expired?0:1);assert.equal(dailyResult.status,expired?'missed':'sent');
  if(!expired){assert.equal(dailyResult.late,!explicit);assert.equal(authorization.now,authorization.live);assert.ok(authorization.expires>authorization.live,'a resumed phase must not backdate a new delivery lease');}
  else {assert.equal(authorization,undefined);assert.equal((await db.raw.execute('SELECT count(*) n FROM report_claims')).rows[0].n,0);}
 }finally{globalThis.Date=RealDate;}
});
