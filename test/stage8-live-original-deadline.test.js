import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as sleep} from 'node:timers/promises';
import {syntheticPhase4Fixture} from './phase4Fixture.js';
import {bodyInput,seedBodyInput} from './bodyEnergyFixture.js';
import {createStage8LiveProducer} from '../src/stage8LiveProducer.js';
import {verifyLiveExecutionResult} from '../src/stage8LiveExecution.js';
import {canonicalJson} from '../src/phase4EntityStore.js';

async function snapshot(db){
 const tables=(await db.raw.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")).rows;
 const state={};for(const {name} of tables){assert.match(name,/^[a-z0-9_]+$/);if(name==='resource_locks')continue;
  state[name]=(await db.raw.execute('SELECT * FROM '+name)).rows.map(canonicalJson).sort();}
 return state;
}
// Real factory work and real clocks. Only a definite interruption BEFORE an
// original SQL dispatch is injected. No row, receipt, clock or deadline is edited.
test('expired original ESTABLISHED and WORK_COMMITTED identities preserve all durable state; a new identity recomputes', {timeout:120000},async t=>{
 const cases=[];
 for(const state of ['ESTABLISHED','WORK_COMMITTED']){
  const f=await syntheticPhase4Fixture(t,{targetVersion:35,ownedConnection:true,now:()=>new Date()});
  await f.db.transaction(()=>seedBodyInput(f.db,bodyInput({asOf:Date.now()-1000,days:0})));
  await f.db.ensureOnboarding('a',{state:'READY'});
  const producer=await createStage8LiveProducer({...f,admission:await f.db.admitRuntime(),userIds:['a'],enabled:()=>true,eligible:id=>id==='a'});
  const execute=f.db.raw.execute,request={userId:'a',requestId:'original-interrupted-'+state};let fired=false;
  f.db.raw.execute=async statement=>{
   const sql=typeof statement==='string'?statement:statement.sql;
   const target=state==='ESTABLISHED'?"UPDATE stage8_live_executions SET state='WORK_COMMITTED'":'UPDATE stage8_live_executions SET state=?';
   if(!fired&&sql.startsWith(target)){fired=true;throw Error('DEFINITE_INTERRUPTION_BEFORE_'+state+'_NEXT_SQL');}
   return execute(statement);
  };
  try{await assert.rejects(producer.run(request),/DEFINITE_INTERRUPTION_BEFORE/);}finally{f.db.raw.execute=execute;}
  assert.equal(fired,true);const row=(await execute('SELECT * FROM stage8_live_executions')).rows[0];
  assert.equal(row.state,state);assert.equal(row.generation,1);assert.equal(row.deadline_at-row.created_at,45000);assert.equal(row.lease_until-row.created_at,60000);
  assert.ok((await execute('SELECT count(*) n FROM stage8_live_execution_work_receipts')).rows[0].n>0,'genuine committed work must precede interruption');
  assert.ok((await execute('SELECT count(*) n FROM stage8_live_execution_producers')).rows[0].n>0);
  if(state==='WORK_COMMITTED')assert.ok(verifyLiveExecutionResult(f.keys,row).outcome);
  const before=await snapshot(f.db),writes=[];
  const retry=async expected=>{
   f.db.raw.execute=async statement=>{const sql=typeof statement==='string'?statement:statement.sql;if(/^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql)&&!/^\s*(?:INSERT INTO|DELETE FROM) resource_locks\b/i.test(sql))writes.push(sql);return execute(statement);};
   try{await assert.rejects(producer.run(request),error=>error.code===expected);}finally{f.db.raw.execute=execute;}
   assert.deepEqual(await snapshot(f.db),before,'old RID retry must preserve EVERY durable table, including jobs, generations and outputs');
  };
  await retry('STAGE8_LIVE_REQUEST_PENDING');cases.push({f,producer,request,row,before,writes,retry});
 }
 const until=Math.max(...cases.map(c=>c.row.lease_until))+30;
 t.diagnostic('Waiting for the actual original 60-second leases; no authority is renewed or backdated.');
 await sleep(Math.max(0,until-Date.now()));
 for(const c of cases){
  await c.retry('STAGE8_LIVE_REQUEST_EXPIRED');assert.deepEqual(c.writes,[],'existing identity must skip bootstrap, rollout, reanalysis and settlement DML');
  const beforeSource=(await c.f.db.raw.execute("SELECT source_generation FROM phase4_user_state WHERE user_id='a'")).rows[0].source_generation;
  let last;for(let leg=0;leg<16;leg++){last=await c.producer.run({userId:'a',requestId:'legitimate-future-'+c.row.state+'-'+leg});if(last.publication.status==='CURRENT')break;}
  assert.equal(last.publication.status,'CURRENT');
  assert.deepEqual((await c.f.db.raw.execute({sql:'SELECT * FROM stage8_live_executions WHERE execution_id=?',args:[c.row.execution_id]})).rows[0],c.row);
  const after=await snapshot(c.f.db);
  for(const table of ['stage8_live_execution_work_receipts','stage8_live_operation_receipts','stage8_live_execution_producers'])for(const original of c.before[table])assert.ok(after[table].includes(original),'original full row retained: '+table);
  assert.equal((await c.f.db.raw.execute("SELECT source_generation FROM phase4_user_state WHERE user_id='a'")).rows[0].source_generation,beforeSource);
  assert.equal((await c.f.db.raw.execute('SELECT count(*) n FROM outbound_messages')).rows[0].n,0);
 }
 t.diagnostic(JSON.stringify({contract:'original-live-deadline-preserved-v1',states:cases.map(c=>c.row.state),realClockExpiration:true,oldRowsReceiptsJobsGenerationsOutputsPreserved:true,newIdentityGenuineCompletion:true,productionEvidence:false}));
});
