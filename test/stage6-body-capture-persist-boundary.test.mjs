import test from 'node:test';
import assert from 'node:assert/strict';
import {syntheticPhase4Fixture} from './phase4Fixture.js';
import {bodyInput,seedBodyInput} from './bodyEnergyFixture.js';
import {createStage8LiveProducer} from '../src/stage8LiveProducer.js';
import {currentExecutionReceiptTransactionMarker} from '../src/phase4ExecutionContext.js';

for(const fault of ['SOURCE_CORRECTED','OWNER_REVOKED','SOURCE_GENERATION_CHANGED','AUTH_GENERATION_CHANGED','ACCESS_REVOKED','TOMBSTONE_APPEARED'])test('private Body capture ticket retains fresh persist boundary: '+fault,async t=>{
 const f=await syntheticPhase4Fixture(t,{targetVersion:35,ownedConnection:true,now:()=>new Date()});
 await f.db.transaction(()=>seedBodyInput(f.db,bodyInput({asOf:Date.now()-1000,days:0})));
 await f.db.ensureOnboarding('a',{state:'READY'});await f.db.linkTelegram({userId:'a',chatId:'10001'});
 const p=await createStage8LiveProducer({...f,admission:await f.db.admitRuntime(),userIds:['a'],enabled:()=>true,eligible:id=>id==='a'});
 const original=f.db.raw.execute,batch=f.db.raw.batch;let inventories=0,captureMarker=null,persistMarker=null,armed=false,injected=false,priorReceipts=[],readBatches=0;
 const project=async(stmt,result)=>{
  const sql=typeof stmt==='string'?stmt:stmt.sql;
  if(/^SELECT user_id,/.test(sql)&&/FROM (whoop_sleeps|whoop_recoveries|whoop_cycles|whoop_workouts|whoop_resource_access|whoop_sync_state|whoop_resource_tombstones|whoop_capabilities) WHERE/.test(sql)){
   inventories++;captureMarker=currentExecutionReceiptTransactionMarker();
  }
  if(/^SELECT 1 FROM body_energy_results WHERE user_id=\? AND execution_mode=\? AND input_generation=\?/.test(sql)){
   assert.ok(inventories>=8,'all original source/control capture inventories must precede the write attempt');
   armed=true;persistMarker=currentExecutionReceiptTransactionMarker();
   priorReceipts=(await original('SELECT * FROM stage8_live_execution_work_receipts')).rows;
  }
  if(armed&&fault==='SOURCE_CORRECTED'&&/SELECT \* FROM whoop_cycles WHERE/.test(sql)&&result.rows.some(r=>r.id==='cycle-current')){
   injected=true;return {...result,rows:result.rows.map(r=>r.id==='cycle-current'?{...r,strain:r.strain+1}:r)};
  }
  if(armed&&fault==='OWNER_REVOKED'&&(/^SELECT \* FROM stage8_live_executions WHERE execution_id=\? AND owner=\? AND generation=\?/.test(sql)
    ||/FROM stage8_live_executions e LEFT JOIN stage8_live_execution_work_receipts/.test(sql))){injected=true;return {...result,rows:[]};}
  if(armed&&['SOURCE_GENERATION_CHANGED','AUTH_GENERATION_CHANGED'].includes(fault)&&/^SELECT u.id,u.status,u.timezone,u.lifecycle_generation,/.test(sql)){
   injected=true;const field=fault==='SOURCE_GENERATION_CHANGED'?'source_generation':'auth_generation';
   return {...result,rows:result.rows.map(r=>({...r,[field]:r[field]+1}))};
  }
  if(armed&&fault==='ACCESS_REVOKED'&&/^SELECT status FROM whoop_resource_access/.test(sql)){
   injected=true;return {...result,rows:result.rows.map(r=>({...r,status:'DENIED'}))};
  }
  if(armed&&fault==='TOMBSTONE_APPEARED'&&/^SELECT 1 FROM whoop_resource_tombstones/.test(sql)){
   injected=true;return {...result,rows:[{'1':1}]};
  }
  return result;
 };
 f.db.raw.execute=async stmt=>project(stmt,await original(stmt));
 f.db.raw.batch=async(statements,...rest)=>{
  const list=[...statements],results=await batch(list,...rest);
  if(list.length===3&&list[0]?.sql==='SELECT owner FROM resource_locks WHERE name=? AND expires_at>?'
    ||list.length===4&&/^SELECT \* FROM whoop_/.test(list[0]?.sql??''))readBatches++;
  return Promise.all(results.map((result,index)=>project(list[index],result)));
 };
 let value,error;try{value=await p.run({userId:'a',requestId:'body-capture-fresh-boundary-'+fault});}catch(e){error=e;}finally{f.db.raw.execute=original;f.db.raw.batch=batch;}
 assert.ok(readBatches>0,'fault projections must traverse actual new read-batch transport');
 assert.equal(armed,true);assert.equal(injected,true);assert.ok(captureMarker);assert.ok(persistMarker);
 assert.notEqual(captureMarker,persistMarker,'capture and persist must be original distinct owned transactions');
 if(error)assert.match(String(error.code??error.message),/PHASE4_PARENT_STALE|REQUEST_OWNER_FENCED|STAGE8_LIVE|PHASE4_INPUT_FENCED|PHASE4_AUTH_FENCED|PHASE4_CONTEXT_RELEASED|PHASE4_RESOURCE_FENCED|PHASE4_SOURCE_DELETED/);
 else{assert.ok(value.result.jobsFailed>0);assert.notEqual(value.publication.status,'CURRENT');}
 assert.equal((await original('SELECT count(*) n FROM body_energy_results')).rows[0].n,0);
 assert.equal((await original("SELECT count(*) n FROM stage8_live_operation_receipts WHERE operation_kind='BODY_ENERGY_COMPUTE'")).rows[0].n,0);
 assert.equal((await original('SELECT count(*) n FROM stage8_live_publications')).rows[0].n,0);
 assert.equal((await original('SELECT count(*) n FROM outbound_messages')).rows[0].n,0);
 assert.ok((await original("SELECT full_scan_cursor,completed_generation FROM phase4_jobs WHERE user_id='a' AND execution_mode='LIVE'")).rows.every(r=>r.full_scan_cursor===null&&r.completed_generation===0));
 const after=new Set((await original('SELECT * FROM stage8_live_execution_work_receipts')).rows.map(r=>JSON.stringify(r)));
 for(const r of priorReceipts)assert.ok(after.has(JSON.stringify(r)),'prior durable receipt remains byte-identical');
});
