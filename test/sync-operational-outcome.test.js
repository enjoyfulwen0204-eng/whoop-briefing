import test from 'node:test';import assert from 'node:assert/strict';
import {createSync} from '../src/sync.js';import {LIFECYCLE_UNFENCED} from '../src/accountLifecycle.js';
import {operationalLogFields} from '../src/logger.js';
const resources=['sleep','recovery','cycle','workout','body_measurement'];
async function observe(status){
 const lines=[],write=process.stdout.write;
 const db={getSyncState:async()=>({backfillComplete:true}),saveSyncState:async()=>{},transaction:async fn=>fn(),
  upsertSleeps:async()=>0,upsertRecoveries:async()=>0,upsertCycles:async()=>0,upsertWorkouts:async()=>0,upsertBodyMeasurement:async()=>0};
 const whoop={sleeps:async()=>[],recoveries:async()=>[],cycles:async()=>[],workouts:async()=>[],bodyMeasurement:async()=>{
  if(status==='timeout'||status==='cancelled')throw Object.assign(Error('synthetic-only'),{code:status==='timeout'?'SYNC_TIMEOUT':'SYNC_CANCELLED'});
  return status==='success'?{synthetic:1}:null;
 }};
 process.stdout.write=(chunk,...args)=>{lines.push(String(chunk));const callback=args.find(v=>typeof v==='function');callback?.();return true;};
 let result;try{result=await createSync({db,whoop,userId:'synthetic',timezone:'Asia/Taipei',expectedLifecycleGeneration:LIFECYCLE_UNFENCED}).syncAll({force:true,resources});}
 finally{process.stdout.write=write;}
 return {result,line:lines.flatMap(s=>s.trim().split('\n')).filter(s=>s.startsWith('{')).map(s=>JSON.parse(s)).find(s=>s.event==='sync_all_done')};
}
for(const [status,outcome,complete] of [['timeout','TIMEOUT',false],['cancelled','CANCELLED',false],['success','COMPLETE_SUCCESS',true],['noop','NO_NEW_DATA_SUCCESS',true]])
 test(`real operational emission preserves ${status} typed outcome without health or identity fields`,async()=>{
  const {result,line}=await observe(status);assert.equal(result.outcome,outcome);assert.equal(result.complete,complete);
  assert.equal(line.outcome,result.outcome);assert.equal(line.complete,result.complete);
  assert.equal(line.ok,status==='timeout'||status==='cancelled'?4:5);assert.equal(line.failed,0);
  assert.equal(line.timed_out,status==='timeout'?1:0);assert.equal(line.cancelled,status==='cancelled'?1:0);
  assert.equal(line.throttled,0);assert.equal(line.scope_missing,0);assert.equal('user_id' in line,false);
 });
test('positive allowlist retains only numeric safe counters and boolean complete',()=>{
 assert.deepEqual(operationalLogFields({timed_out:1,cancelled:2,throttled:3,scope_missing:4,complete:false,outcome:'TIMEOUT',
  user_id:'synthetic',health_date:'synthetic',display_name:'synthetic'}),{timed_out:1,cancelled:2,throttled:3,scope_missing:4,complete:false,outcome:'TIMEOUT'});
 assert.deepEqual(operationalLogFields({timed_out:'secret',cancelled:NaN,throttled:Infinity,complete:'true'}),{});
});
