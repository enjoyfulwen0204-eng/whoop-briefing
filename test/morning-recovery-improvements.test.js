import {followFixture} from './morningFollowupsFixture.js';
import test from 'node:test';import assert from 'node:assert/strict';
import {reportIdentity,sendScheduledReport} from '../src/scheduledReport.js';
import {runDaily} from '../src/daily.js';
import {makeDataset} from './fixtures.js';import {fakeDb,fakeTelegram,fakeCoach} from './fakes.js';
import {LIFECYCLE_UNFENCED} from '../src/accountLifecycle.js';
import {createMorningFollowups,morningChanged,noSleepReminderDue,noSleepText,morningUpdateText} from '../src/morningFollowups.js';
import {createMorningSnapshotStore} from '../src/morningReportSnapshot.js';
import {fixtureKeys} from './localDb.js';
import {recoveryFixture} from './round4Fixture.js';
import {withExecutionBudget} from '../src/executionBudget.js';
import {createOnDemandBodyEnergy} from '../src/onDemandBodyEnergy.js';
const TZ='Asia/Taipei';
function morning({minutes=30,short=false,days=30,at='2026-11-03T00:00:00Z'}={}){
 const data=makeDataset({now:new Date(at),wakeMinutesAgo:minutes,days,withNaps:false,overrides:short?{0:{light:60*60000,sws:30*60000,rem:30*60000}}:{}});
 const db=fakeDb(),telegram=fakeTelegram(),args={db,telegram,userId:'synthetic',timezone:TZ,now:data.now,expectedLifecycleGeneration:LIFECYCLE_UNFENCED,
  coach:fakeCoach(),source:{poll:async()=>data,history:async()=>data}};
 return {data,db,telegram,args};
}
test('ordinary 30 minute wake and cold-start remain eligible; short sleep waits without a claim or send',async()=>{
 for(const options of [{},{short:true,days:1}]){const f=morning(options);assert.equal((await runDaily(f.args)).status,'sent');assert.equal(f.telegram.sent.length,1);}
 const f=morning({short:true});assert.equal((await runDaily(f.args)).reason,'SHORT_SLEEP_WAIT');assert.equal(f.telegram.sent.length,0);assert.equal(f.db.claims.size,0);
});
test('short sleep keeps waiting before local 10:00 even beyond 120 minutes',async()=>{
 for(const options of [{minutes:120},{at:'2026-11-02T23:10:00Z',minutes:160},{at:'2026-11-03T01:59:00Z',minutes:329}]){
  const f=morning({...options,short:true});
  assert.equal((await runDaily(f.args)).reason,'SHORT_SLEEP_WAIT');
  assert.equal(f.telegram.sent.length,0);assert.equal(f.db.claims.size,0);
 }
});
test('short sleep follows ordinary readiness at and after local 10:00',async()=>{
 for(const at of ['2026-11-03T02:00:00Z','2026-11-03T02:01:00Z']){
  const f=morning({at,minutes:30,short:true});assert.equal((await runDaily(f.args)).status,'sent');assert.equal(f.telegram.sent.length,1);
 }
});
test('corrected normal-length sleep sends on the next tick before local 10:00',async()=>{
 const f=morning({short:true,minutes:210});assert.equal((await runDaily(f.args)).reason,'SHORT_SLEEP_WAIT');
 assert.equal(f.db.claims.size,0);assert.equal(f.telegram.sent.length,0);
 const fixed=morning({at:'2026-11-03T00:10:00Z'}).data;
 f.args.now=fixed.now;f.args.source.poll=async()=>fixed;f.args.source.history=async()=>fixed;
 assert.equal((await runDaily(f.args)).status,'sent');assert.equal(f.telegram.sent.length,1);
});
test('update uses original signed snapshot; thresholds inclusive, one send per day, no health quota',async()=>{
 assert.equal(morningChanged({recovery:35,minutes:236},{recovery:44,minutes:265}),false);
 assert.equal(morningChanged({recovery:35,minutes:236},{recovery:45,minutes:236}),true);
 assert.equal(morningChanged({recovery:35,minutes:236},{recovery:35,minutes:266}),true);
 const f=followFixture();await f.capture();assert.equal((await createMorningFollowups(f.input).briefUpdate()).status,'DELIVERED');
 assert.equal((await createMorningFollowups(f.input).briefUpdate()).status,'ALREADY_DELIVERED');assert.equal(f.sent.length,1);assert.match(f.sent[0],/35% → 75%/);
 assert.ok(f.db.claims.has('synthetic|brief_update|2026-11-03'));assert.equal(f.db.runs.length,0);
});
test('quiet update defers, before 18 sends, after 18 does not; absent snapshots never reconstruct original values',async()=>{
 const f=followFixture();await f.capture();f.setQuiet(true);assert.equal((await createMorningFollowups(f.input).briefUpdate()).status,'NOT_READY');assert.equal(f.sent.length,0);
 f.setQuiet(false);assert.equal((await createMorningFollowups(f.input).briefUpdate()).status,'DELIVERED');
 const late=followFixture({at:'2026-11-03T10:00:00Z'});await late.capture();assert.equal((await createMorningFollowups(late.input).briefUpdate()).status,'NOT_DUE');
 assert.equal((await createMorningFollowups(followFixture().input).briefUpdate()).status,'NO_SNAPSHOT');
});
test('ambiguous update is never replayed; snapshot tampering and generation change fail closed',async()=>{
 const f=followFixture();await f.capture();f.input.telegram.send=async()=>{throw Error('SYNTHETIC_LOST_ACK');};
 assert.equal((await createMorningFollowups(f.input).briefUpdate()).status,'AMBIGUOUS');
 assert.equal((await createMorningFollowups(f.input).briefUpdate()).status,'ALREADY_RESERVED');
 const g=followFixture();await g.capture();const [key,raw]=[...g.state][0];g.state.set(key,raw.replace('35','99'));
 await assert.rejects(createMorningFollowups(g.input).briefUpdate(),/MORNING_SNAPSHOT_INVALID/);
 const h=followFixture();await h.capture();h.originalClaim.lifecycleGeneration=2;assert.equal((await createMorningFollowups(h.input).briefUpdate()).status,'NO_SNAPSHOT');
});
test('no-sleep after noon only; naps wording; 3-day gaps; pause/quiet; one report daily',async()=>{
 assert.deepEqual([1,2,3,4,5,6,7,8,9].filter(noSleepReminderDue),[1,2,3,6,9]);
 const f=followFixture({gap:1,nap:true,at:'2026-11-03T03:59:00Z'});assert.equal((await createMorningFollowups(f.input).noSleep()).status,'NOT_DUE');f.setTime('2026-11-03T04:00:00Z');
 f.setPaused(1);assert.equal((await createMorningFollowups(f.input).noSleep()).status,'NOT_READY');f.setPaused(0);
 assert.equal((await createMorningFollowups(f.input).noSleep()).status,'DELIVERED');assert.match(f.sent[0],/只記錄到小睡/);
 assert.equal((await createMorningFollowups(f.input).noSleep()).status,'ALREADY_DELIVERED');
 const g=followFixture({gap:4});assert.equal((await createMorningFollowups(g.input).noSleep()).status,'GAP_COOLDOWN');
 assert.equal((await createMorningFollowups(followFixture().input).noSleep()).status,'HAS_SLEEP_OR_REPORT');
 for(const locale of ['zh-TW','vi','en']){assert.match(noSleepText({days:1,nap:false,locale}),/😴/);assert.match(noSleepText({days:6,nap:false,locale}),/6/);assert.match(morningUpdateText({recovery:35,minutes:236},{recovery:68,minutes:432},locale),/35% → 68%/);}
});
test('followups with insufficient budget perform no reads or delivery',async()=>{
 const f=followFixture();f.db.getSleeps=()=>assert.fail('no read');f.db.getClaim=()=>assert.fail('no claim read');
 await withExecutionBudget({remainingMs:()=>2000},async()=>{const r=createMorningFollowups(f.input);assert.equal((await r.briefUpdate()).status,'DEFERRED_BUDGET');assert.equal((await r.noSleep()).status,'DEFERRED_BUDGET');});
});
test('signed snapshot and report identity work on the actual v33 local storage contract',async t=>{
 const f=await recoveryFixture(t),day='2026-09-19';
 await f.db.createUser({id:'a',displayName:'Synthetic',timezone:TZ,status:'ACTIVE'});
 await f.db.raw.execute("INSERT INTO user_whoop_tokens(user_id,access_token,refresh_token,access_token_expires_at,auth_generation,updated_at) VALUES('a','synthetic','synthetic','2026-11-03',1,'2026-09-19')");
 await f.db.raw.execute("INSERT INTO phase4_user_state(user_id,created_at,updated_at) VALUES('a','2026-09-19','2026-09-19') ON CONFLICT DO NOTHING");
 const claim=await f.db.claimReport({userId:'a',reportType:'daily',localDateKey:day,ttlMs:60000,expectedLifecycleGeneration:1,now:new Date('2026-09-19T00:00:00Z')});
 const store=createMorningSnapshotStore({db:f.db,keys:fixtureKeys});
 await store.capture({userId:'a',healthDate:day,claim,briefing:{sleepId:'synthetic',metrics:[{key:'recovery_score',value:35},{key:'sleep_total',value:14400000}]}});
 const current=await f.db.getClaim('a','daily',day);assert.equal(await store.read({userId:'a',healthDate:day,claim:current}),null);
 assert.equal(current.lifecycleGeneration,1);
 await f.db.linkTelegram({userId:'a',chatId:'123'});await f.db.ensureOnboarding('a',{state:'READY'});
 for(const resource of ['sleep','recovery'])await f.db.raw.execute({sql:'INSERT INTO whoop_resource_access(user_id,resource,status,auth_generation,lifecycle_generation,checked_at) VALUES(?,?,?,?,?,?)',args:['a',resource,'ACCESSIBLE',1,1,'2026-09-19']});
 const user={id:'a',status:'ACTIVE',lifecycleGeneration:1,timezone:TZ,reportChatId:'123'},identity=await reportIdentity(f.db,user);
 assert.equal(identity.access_count,2);const at=new Date('2026-09-19T04:00:00Z');let sent=0;
 const input={db:f.db,user,kind:'no_sleep',day,text:'Synthetic only',identity,now:()=>at,telegram:{send:async(text,{authorize})=>{await authorize();sent++;return {sent:true,messageId:123};}}};
 const first=await sendScheduledReport(input),second=await sendScheduledReport(input);
 assert.equal(first.status,'DELIVERED');assert.equal(second.status,'ALREADY_DELIVERED');assert.equal(sent,1);
 assert.equal((await f.db.getClaim('a','daily',day)).deliveryState,'CLAIMED');
});

test('privacy purge invalidates original snapshot; access and changed Telegram binding fence before send',async()=>{
 const f=followFixture();await f.capture();f.purge();assert.equal((await createMorningFollowups(f.input).briefUpdate()).status,'NO_SNAPSHOT');
 const g=followFixture();await g.capture();g.revokeAccess();assert.equal((await createMorningFollowups(g.input).briefUpdate()).status,'NOT_READY');assert.equal(g.sent.length,0);
 const h=followFixture();await h.capture();const originalClaim=h.db.claimReport.bind(h.db);
 h.db.claimReport=async args=>{const claim=await originalClaim(args);h.relink();return claim;};
 assert.equal((await createMorningFollowups(h.input).briefUpdate()).status,'FENCED');assert.equal(h.sent.length,0);
});
test('a preference race fences this optional report without failing the user or altering the daily claim',async()=>{
 const f=followFixture(),identity=await reportIdentity(f.db,f.input.user);f.setPaused(1);
 assert.equal((await sendScheduledReport({...f.input,kind:'no_sleep',day:f.day,identity,text:'Synthetic only'})).status,'FENCED');
 assert.equal(f.sent.length,0);assert.equal(f.originalClaim.deliveryState,'CLAIMED');assert.equal(f.db.claims.size,1);
});
test('morning Body Energy diagnostics contain only keyed identity, quality and reason codes',async()=>{
 let quality='DEGRADED';const logs=[],old=console.log,context={timezone:TZ,lifecycleGeneration:1,authGeneration:1,purgeGeneration:0,sourceGeneration:1,inputGeneration:1};
 const db={...fakeDb(),raw:{},getState:async()=>null,setState:async()=>assert.fail('no write'),transaction:async f=>f(),resolveUserByChatId:async()=>null,assertAccountActive:async()=>true,getUser:async()=>({status:'ACTIVE'}),getLocale:async()=> 'zh-TW',getOnboarding:async()=>({state:'READY'})};
 const stores={withContext:async(id,opts,f)=>f(context),assertCurrent:async()=>{},bodyEnergy:{calculateReadOnly:async()=>({healthDate:'2026-11-03',timezone:TZ,calculation:{quality_state:quality,value:47,drivers:{initial_charge:86},reasons:['MAIN_SLEEP_MISSING','private-value-123']}})}};
 const body=createOnDemandBodyEnergy({db,stores,keys:fixtureKeys,environment:{BODY_ENERGY_ON_DEMAND:'on'}});
 try{console.log=s=>logs.push(JSON.parse(s));await body.currentSection({userId:'synthetic-private-id',morning:true});
  await body.currentSection({userId:'synthetic-private-id',morning:false});quality='AVAILABLE';await body.currentSection({userId:'synthetic-private-id',morning:true});
 }finally{console.log=old;}
 assert.equal(logs.length,1);assert.deepEqual(Object.keys(logs[0]).sort(),['event','quality_state','reasons','user']);
 assert.match(logs[0].user,/^[a-f0-9]{64}$/);assert.deepEqual(logs[0].reasons,['MAIN_SLEEP_MISSING']);
 assert.ok(!JSON.stringify(logs).includes('synthetic-private-id'));assert.ok(!('value' in logs[0]));
});
