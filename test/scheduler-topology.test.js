import test from 'node:test';
import assert from 'node:assert/strict';
import {schedulerTopology,schedulerProviderState,stage6SchedulerDecision} from '../src/schedulerPolicy.js';
import {readSchedulerHealth,checkPeerScheduler} from '../src/schedulerWatchdog.js';
import {evaluate,gatherFacts} from '../src/guardian.js';
import {configurationProof} from '../src/phase4ExecutionStore.js';
import {fixtureKeys} from './localDb.js';
const environment={BRIEFING_SCHEDULER_TOPOLOGY:'cloudflare_morning_only'};
const at=time=>new Date(`2026-10-16T${time}+08:00`);
function fixture(last='11:51:00'){
 const alerts=[],clears=[],sends=[],db={getHeartbeat:async(_scope,component)=>({lastOkAt:component==='briefing_github'?'2026-10-06T23:03:27.002Z':at(last).toISOString()}),
  hasErrorNotify:async()=>true,clearErrorNotify:async(...args)=>clears.push(args),listActiveUsers:async()=>[]};
 return {db,alerts,clears,sends,systemTelegram:{notifyError:async(...args)=>{alerts.push(args);return true;},send:async(...args)=>sends.push(args)}};
}
test('declared disabled GitHub is quiet during the verified morning-only scheduled pause; no false recovery or history deletion',async()=>{
 const f=fixture(),now=at('17:30:00'),health=await readSchedulerHealth({...f,now,environment});
 assert.equal(health.github.state,'disabled');assert.equal(health.github.expected,false);
 assert.equal(health.cloudflare.state,'scheduled_pause');assert.equal(health.overall,'not_scheduled');
 for(const source of ['cloudflare','manual','event']){
  const result=await checkPeerScheduler({...f,source,now,environment});assert.equal(result.alerted,false);assert.equal(result.recovered,false);
 }
 assert.deepEqual(f.alerts,[]);assert.deepEqual(f.sends,[]);assert.deepEqual(f.clears,[]);
 const facts=await gatherFacts({db:f.db,now,environment});assert.ok(now-at('11:51:00')>3*3600000);
 assert.equal(evaluate(facts).filter(v=>v.signal==='cron_heartbeat_stale').length,0);
});
test('missed Cloudflare morning stays an outage through quiet time and only the real primary is alertable',async()=>{
 const f=fixture('08:10:00'),now=at('17:30:00');
 const result=await checkPeerScheduler({...f,source:'cloudflare',now,environment});
 assert.equal(result.cloudflare.state,'stale');assert.equal(result.overall,'outage');assert.equal(result.alerted,true);
 assert.equal(f.alerts[0][0],'scheduler_primary_stale');assert.equal(f.alerts[0][2].cooldownHours,24);
 assert.equal(f.clears.length,0);assert.equal(f.sends.length,0);
 assert.equal(evaluate(await gatherFacts({db:f.db,now,environment})).filter(v=>v.signal==='cron_heartbeat_stale').length,1);
});
test('morning grace and thirty-minute threshold remain, companion-only heartbeat cannot substitute for SYNC',async()=>{
 assert.equal(schedulerProviderState(null,'cloudflare',at('08:20:59'),{topology:'cloudflare_morning_only'}).state,'startup_grace');
 assert.equal(schedulerProviderState(null,'cloudflare',at('08:21:00'),{topology:'cloudflare_morning_only'}).state,'stale');
 for(const [minutes,state]of [[30,'healthy'],[30.001,'stale']])assert.equal(schedulerProviderState({lastOkAt:new Date(at('09:00:00')-minutes*60000).toISOString()},'cloudflare',at('09:00:00'),{topology:'cloudflare_morning_only'}).state,state);
 const db={getHeartbeat:async(_s,c)=>c==='companion_v1'?{lastOkAt:at('17:29:00').toISOString()}:null};
 assert.equal((await readSchedulerHealth({db,now:at('17:30:00'),environment})).overall,'outage');
 for(const last of ['2026-10-15T03:51:00Z','2026-10-16T09:31:00Z','invalid'])assert.equal(schedulerProviderState({lastOkAt:last},'cloudflare',at('17:30:00'),{topology:'cloudflare_morning_only'}).state,'stale');
});
test('quiet period before next morning retains the previous window requirement; no schedule or Stage6 authority changes',()=>{
 const now=at('07:59:59');
 assert.equal(schedulerProviderState({lastOkAt:'2026-10-15T03:51:00Z'},'cloudflare',now,{topology:'cloudflare_morning_only'}).state,'scheduled_pause');
 assert.equal(schedulerProviderState({lastOkAt:'2026-10-14T03:51:00Z'},'cloudflare',now,{topology:'cloudflare_morning_only'}).state,'stale');
 assert.equal(stage6SchedulerDecision({source:'cloudflare',now:at('17:30:00')}).drain,false);
 assert.equal(schedulerTopology({}),'dual');assert.throws(()=>schedulerTopology({BRIEFING_SCHEDULER_TOPOLOGY:'ignore'}),/TOPOLOGY_INVALID/);
 assert.equal(schedulerProviderState(null,'github',at('17:30:00')).state,'stale');
 const args=[fixtureKeys,{runtime:'off',mode:'off'}],sha='a'.repeat(40);
 assert.notEqual(configurationProof(...args,{},sha),configurationProof(...args,environment,sha));
 assert.throws(()=>configurationProof(...args,{BRIEFING_SCHEDULER_TOPOLOGY:'ignore'},sha),/TOPOLOGY_INVALID/);
});
test('declared topology read failure stays unknown rather than reviving legacy quiet-period cron alerts',async()=>{
 const f=fixture(),read=f.db.getHeartbeat;
 f.db.getHeartbeat=async(scope,component)=>{if(component==='briefing_cloudflare')throw Error('SYNTHETIC_METADATA_UNAVAILABLE');return read(scope,component);};
 const facts=await gatherFacts({db:f.db,now:at('17:30:00'),environment});
 assert.equal(facts.schedulerHealth.overall,'unknown');assert.ok(facts.cronHeartbeat.lastOkAt);
 assert.equal(evaluate(facts).filter(v=>v.signal==='cron_heartbeat_stale').length,0);
 const legacy=await gatherFacts({db:f.db,now:at('17:30:00'),environment:{}});
 assert.equal(evaluate(legacy).filter(v=>v.signal==='cron_heartbeat_stale').length,1);
});
test('shared topology does not shorten Guardian three-hour cooldown threshold to the primary thirty-minute threshold',()=>{
 const now=at('09:00:00');
 assert.equal(evaluate({now,cronHeartbeat:{lastOkAt:at('08:20:00').toISOString()},schedulerHealth:{overall:'outage'}}).length,0);
});
