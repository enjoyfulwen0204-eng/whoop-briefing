import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {notifyAssociation,ASSOCIATION_POLICY} from '../src/associationNotifications.js';
import {companionUserOrder} from '../src/companionService.js';
import {companionSchedulerSlots} from '../src/companionTimingPolicy.js';
import {runCompanionStep} from '../src/companionStep.js';
import {fixtureKeys} from './localDb.js';
import {withExecutionBudget,createExecutionBudget} from '../src/executionBudget.js';
const now=new Date('2026-11-01T06:00:00Z');
function fixture(){
 const state=new Map(),writes=[],calls={inspect:0,send:0,timing:0};
 const control={paused:false,previous:false,view:{topics:[]},claim:true,send:{messageId:7}};
 const db={
  getState:async key=>state.get(key)??null,
  setState:async(key,value)=>{if(control.writeError)throw control.writeError;state.set(key,value);writes.push({key,value});},
  raw:{execute:async({sql})=>{
   if(sql.includes('notifications_paused')){calls.timing++;return {rows:[{notifications_paused:control.paused||control.pauseAtClaim&&calls.timing>1?1:0,quiet_start:'22:00',quiet_end:'08:00'}]};}
   if(sql.includes('SELECT 1'))return {rows:control.previous?[{}]:[]};
   if(sql.includes('reason_json'))return {rows:[]};
   throw Error('UNEXPECTED_QUERY');
  }},
  assertAccountActive:async()=>{},transaction:async fn=>fn(),
  claimProactiveEvent:async()=>({claimed:control.claim,id:'synthetic-event'}),markProactiveEventSent:async()=>{}
 };
 const reader={inspect:async()=>{calls.inspect++;if(control.error)throw control.error;return control.view;},assertFresh:async()=>{if(control.freshError)throw control.freshError;}};
 const args={db,keys:fixtureKeys,reader,user:{id:'synthetic-user-private',timezone:'Asia/Taipei',lifecycleGeneration:1},locale:'en',now,telegram:{send:async()=>{calls.send++;return control.send;}}};
 const qualified=()=>{control.view={today:'2026-11-01',topics:[{topic:'alcohol',status:'ASSOCIATION',exposed:6,unexposed:14,metrics:[{metric:'hrv',direction:'low',difference:-12}]}]};};
 return {state,writes,calls,control,args,qualified,run:extra=>notifyAssociation({...args,...extra})};
}
test('daily completion is per local day/user/policy; second tick skips inspect and next day checks',async()=>{
 const f=fixture();assert.equal((await f.run()).status,'NO_NEW_ASSOCIATION');assert.equal((await f.run()).status,'ALREADY_CHECKED_TODAY');assert.equal(f.calls.inspect,1);
 assert.equal((await f.run({now:new Date('2026-11-02T06:00:00Z')})).status,'NO_NEW_ASSOCIATION');assert.equal(f.calls.inspect,2);
 assert.equal((await f.run({user:{...f.args.user,id:'other-synthetic-user'}})).status,'NO_NEW_ASSOCIATION');assert.equal(f.calls.inspect,3);
 assert.deepEqual(JSON.parse(f.writes[0].value),{date:'2026-11-01',version:ASSOCIATION_POLICY});
 assert.equal(f.writes[0].key,'association-check-v1:'+fixtureKeys.lookup(['association-check-v1',f.args.user.id,'2026-11-01',ASSOCIATION_POLICY]));
 assert.doesNotMatch(JSON.stringify(f.writes),/synthetic-user-private|difference|exposed|hrv|recovery/i);
});
for(const status of ['ALREADY_RESERVED','ALREADY_RESERVED_OR_LIMITED','DELIVERED'])test(`${status} writes date/version only, subsequent tick does not recompute`,async()=>{
 const f=fixture();f.qualified();if(status==='ALREADY_RESERVED')f.control.previous=true;if(status==='ALREADY_RESERVED_OR_LIMITED')f.control.claim=false;
 assert.equal((await f.run()).status,status);assert.equal((await f.run()).status,'ALREADY_CHECKED_TODAY');assert.equal(f.calls.inspect,status==='ALREADY_RESERVED'?0:1);assert.equal(f.writes.length,1);
 assert.deepEqual(JSON.parse(f.writes[0].value),{date:'2026-11-01',version:ASSOCIATION_POLICY});
 assert.equal(f.calls.send,status==='DELIVERED'?1:0);
});
test('budget/null, quiet and paused are retryable without a completion marker',async()=>{
 const f=fixture(),b=createExecutionBudget({budgetMs:1000});try{assert.equal((await withExecutionBudget(b,()=>f.run())).status,'DEFERRED_BUDGET');}finally{b.close();}
 assert.equal(f.calls.inspect,0);assert.equal(f.writes.length,0);
 assert.equal((await f.run({now:new Date('2026-11-01T15:00:00Z')})).status,'QUIET_OR_PAUSED');
 f.control.paused=true;assert.equal((await f.run()).status,'QUIET_OR_PAUSED');f.control.paused=false;
 f.control.view=null;assert.equal((await f.run()).status,'DEFERRED_BUDGET');assert.equal(f.writes.length,0);
 f.control.view={topics:[]};assert.equal((await f.run()).status,'NO_NEW_ASSOCIATION');assert.equal(f.calls.inspect,2);
});
test('calculation, freshness and KV errors propagate without a completion marker and can retry',async()=>{
 for(const field of ['error','freshError','writeError']){
  const f=fixture();if(field==='freshError')f.qualified();const error=Error('SYNTHETIC_FAILURE');f.control[field]=error;
  await assert.rejects(f.run(),e=>e===error);assert.equal(f.state.size,0);delete f.control[field];
  assert.ok(['DELIVERED','NO_NEW_ASSOCIATION'].includes((await f.run()).status));assert.equal(f.calls.inspect,2);
 }
});
test('quiet change during claim is not memoized; unknown/suppressed delivery is not marked complete',async()=>{
 const f=fixture();f.qualified();f.control.pauseAtClaim=true;
 assert.equal((await f.run()).status,'ALREADY_RESERVED_OR_LIMITED');assert.equal(f.writes.length,0);assert.equal(f.calls.send,0);
 f.control.pauseAtClaim=false;assert.equal((await f.run()).status,'DELIVERED');assert.equal(f.calls.inspect,2);
 for(const result of [{},{suppressed:true},{dryRun:true}]){const x=fixture();x.qualified();x.control.send=result;assert.ok(['UNKNOWN','SUPPRESSED'].includes((await x.run()).status));assert.equal(x.state.size,0);}
});
test('malformed marker fails closed before calculation or sending',async()=>{
 const f=fixture(),key='association-check-v1:'+fixtureKeys.lookup(['association-check-v1',f.args.user.id,'2026-11-01',ASSOCIATION_POLICY]);f.state.set(key,'{}');
 await assert.rejects(f.run(),/ASSOCIATION_CHECK_MARKER_INVALID/);assert.equal(f.calls.inspect,0);assert.equal(f.calls.send,0);assert.equal(f.writes.length,0);
});
test('rotation follows actual morning and hourly cron, includes every user, wraps days without fixed last user',()=>{
 const ids=['a','b','c'],original=[...ids],start=Date.parse('2026-11-01T00:00:00Z'),slots=companionSchedulerSlots(start,start+86400000);
 assert.equal(slots.length,45);let last;
 for(const at of slots){const order=companionUserOrder(ids,new Date(at));assert.deepEqual([...order].sort(),ids);assert.deepEqual(order,companionUserOrder(ids,new Date(at)));if(last)assert.equal(order[0],ids[(ids.indexOf(last)+1)%3]);last=order[0];}
 assert.deepEqual(ids,original);assert.deepEqual(companionUserOrder([],now),[]);assert.deepEqual(companionUserOrder(['a'],now),['a']);
 const source=readFileSync(new URL('../src/companionService.js',import.meta.url),'utf8');assert.match(source,/for\(const id of companionUserOrder\(runtime\?cohort.userIds:\[\],now\(\)\)\)/);
 const cron=readFileSync(new URL('../cloudflare/briefing-scheduler/wrangler.toml',import.meta.url),'utf8');assert.match(cron,/"\*\/10 0-3 \* \* \*", "10 4-23 \* \* \*"/);
});
test('all eight step timings are sanitized; result identity and recoverable/nonrecoverable behavior unchanged',async t=>{
 const logs=[];t.mock.method(console,'log',line=>logs.push(JSON.parse(line)));const args={db:{processingTransactionActive:()=>false},keys:fixtureKeys,userId:'synthetic-private-id'};
 for(const step of ['daily','coach','weekly','low','insight','family_daily','family_alert','family_weekly']){
  const result={status:'DELIVERED',health:'PRIVATE_HEALTH_SENTINEL'};assert.equal(await runCompanionStep({...args,step,run:async()=>result}),result);
 }
 assert.equal(logs.length,8);for(const log of logs){assert.deepEqual(Object.keys(log).sort(),['duration_ms','event','status','step','user']);assert.equal(log.event,'companion_step_timing');assert.ok(Number.isSafeInteger(log.duration_ms)&&log.duration_ms>=0);assert.equal(log.user,fixtureKeys.lookup(['companion-diagnostic-user-v1',args.userId]));}
 assert.deepEqual(await runCompanionStep({...args,step:'coach',run:async()=>{throw Object.assign(Error('PRIVATE_HEALTH_SENTINEL'),{code:'PHASE4_SOURCE_NOT_FOUND'});}}),{status:'SKIPPED'});assert.equal(logs.at(-1).status,'SKIPPED');
 const err=Error('PRIVATE_HEALTH_SENTINEL');await assert.rejects(runCompanionStep({...args,step:'insight',run:async()=>{throw err;}}),e=>e===err);assert.equal(logs.at(-1).status,'EXCEPTION');
 const privateResult={status:'private payload'};assert.equal(await runCompanionStep({...args,step:'daily',run:async()=>privateResult}),privateResult);assert.equal(logs.at(-1).status,'UNKNOWN');assert.doesNotMatch(JSON.stringify(logs),/PRIVATE_HEALTH_SENTINEL|synthetic-private-id|private payload/);
});
