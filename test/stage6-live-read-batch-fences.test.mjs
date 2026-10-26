import test from 'node:test';
import assert from 'node:assert/strict';
import {syntheticPhase4Fixture} from './phase4Fixture.js';
import {bodyInput,seedBodyInput} from './bodyEnergyFixture.js';
import {createStage8LiveProducer} from '../src/stage8LiveProducer.js';

for(const fault of ['SQL_ERROR','LEASE_PLUS_SQL_ERROR','OWNER_AFTER_RAW_BATCH','RUNTIME_AFTER_RAW_BATCH','CONTEXT_LEASE_REVOKED','CAPABILITY_UNAVAILABLE'])
test('original LIVE source unit rejects fresh read-batch fault before any effect: '+fault,async t=>{
 const f=await syntheticPhase4Fixture(t,{targetVersion:35,ownedConnection:true,now:()=>new Date()});
 await f.db.transaction(()=>seedBodyInput(f.db,bodyInput({asOf:Date.now()-1000,days:0})));
 await f.db.ensureOnboarding('a',{state:'READY'});await f.db.linkTelegram({userId:'a',chatId:'10001'});
 let runtimeEnabled=true;
 const producer=await createStage8LiveProducer({...f,admission:await f.db.admitRuntime(),userIds:['a'],enabled:()=>runtimeEnabled,eligible:id=>id==='a'});
 const execute=f.db.raw.execute,batch=f.db.raw.batch;
 let armed=false,targeted=false,afterRaw=false,revoked=false,sqlFailures=0,prior=[];
 f.db.raw.execute=async stmt=>{
  const sql=typeof stmt==='string'?stmt:stmt.sql,result=await execute(stmt);
  if(/^SELECT 1 FROM body_energy_results WHERE user_id=\? AND execution_mode=\? AND input_generation=\?/.test(sql)){
   armed=true;prior=(await execute('SELECT * FROM stage8_live_execution_work_receipts')).rows;
  }
  if(afterRaw&&fault==='OWNER_AFTER_RAW_BATCH'&&(/^SELECT \* FROM stage8_live_executions WHERE execution_id=\? AND owner=\? AND generation=\?/.test(sql)
    ||/FROM stage8_live_executions e LEFT JOIN stage8_live_execution_work_receipts/.test(sql))){revoked=true;return {...result,rows:[]};}
  return result;
 };
 f.db.raw.batch=async(statements,...rest)=>{
  const list=[...statements],control=list.length===3&&list[0]?.sql==='SELECT owner FROM resource_locks WHERE name=? AND expires_at>?',
   raw=list.length===4&&/^SELECT \* FROM whoop_/.test(list[0]?.sql??'');
  if(!armed||targeted||!(fault.includes('SQL_ERROR')||fault==='CONTEXT_LEASE_REVOKED'?control:raw))return batch(list,...rest);
  targeted=true;
  if(fault.includes('SQL_ERROR')){
   // The installed driver executes this actual read batch, then throws for
   // its failing last statement. Earlier successful rowsets are not returned.
   const submitted=list.slice();
   if(fault==='LEASE_PLUS_SQL_ERROR')submitted[0]={sql:"SELECT 'wrong-owner' owner"};
   submitted[2]={sql:'SELECT synthetic_missing_column FROM users'};
   try{return await batch(submitted,...rest);}catch(error){sqlFailures++;assert.match(error.message,/synthetic_missing_column/);throw error;}
  }
  const results=await batch(list,...rest);
  if(fault==='CONTEXT_LEASE_REVOKED'){revoked=true;return results.map((r,i)=>i? r:{...r,rows:[{owner:'wrong-owner'}]});}
  if(fault==='CAPABILITY_UNAVAILABLE'){revoked=true;return results.map((r,i)=>i===2?{...r,rows:[{'1':1}]}:r);}
  afterRaw=true;
  if(fault==='RUNTIME_AFTER_RAW_BATCH'){runtimeEnabled=false;revoked=true;}
  return results;
 };
 let value,error;
 try{value=await producer.run({userId:'a',requestId:'read-batch-real-fault-'+fault});}
 catch(e){error=e;}finally{f.db.raw.execute=execute;f.db.raw.batch=batch;}
 assert.equal(armed,true);assert.equal(targeted,true,'must reach the real fixed read bundle');
 if(fault.includes('SQL_ERROR'))assert.equal(sqlFailures,1,'no fallback or resubmission after actual SQL batch failure');
 else assert.equal(revoked,true,'must reach the fresh post-batch comparison/fence');
 if(!error){assert.ok(value.result.jobsFailed>0);assert.notEqual(value.publication.status,'CURRENT');}
 for(const table of ['body_energy_results','stage8_live_operation_receipts','stage8_live_publications','outbound_messages'])
  assert.equal((await execute('SELECT count(*) n FROM '+table)).rows[0].n,0,table);
 assert.ok((await execute("SELECT full_scan_cursor,completed_generation FROM phase4_jobs WHERE user_id='a' AND execution_mode='LIVE'")).rows.every(r=>r.full_scan_cursor===null&&r.completed_generation===0));
 const after=new Set((await execute('SELECT * FROM stage8_live_execution_work_receipts')).rows.map(r=>JSON.stringify(r)));
 for(const r of prior)assert.ok(after.has(JSON.stringify(r)),'original durable receipt remains byte-identical');
});
