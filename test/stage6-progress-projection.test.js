import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,fixtureKeys,request,claim,authority} from './v32ReviewFixture.js';
import {recordDrainProgress} from '../src/phase4ExecutionStore.js';
import {withDurableExecution,workStepKey} from '../src/phase4ExecutionContext.js';
import {workStepOptions} from '../src/phase4WorkStep.js';

async function setup(t){
 const {db,transport}=await fixture(t);await db.admitRuntime();
 const parent=request();await claim(db,parent);
 const r=request({phase:'STAGE6_DRAIN',syncRequestId:parent.requestId,handoff:'a'.repeat(64)}),owner=await claim(db,r);
 const context={claim:owner,keys:fixtureKeys,pending:new Set(),authority};
 const at=Date.now(),events=['discovery_start','discovery_complete','drain_start'].map(event=>({event,observedAt:at,
  phase:'STAGE6_DRAIN',source:r.triggerSource,releaseSha:r.releaseSha,identity:owner.identity,outcome:'PENDING',jobsConsidered:1}));
 const counts=async()=>({projections:Number((await db.raw.execute("SELECT count(*) n FROM system_heartbeats WHERE component LIKE 'phase4_stage6_drain:%:discovery_%' OR component='phase4_stage6_drain:manual:drain_start'")).rows[0].n),
 receipts:Number((await db.raw.execute({sql:'SELECT count(*) n FROM phase4_execution_work_receipts WHERE execution_id=?',args:[r.requestId]})).rows[0].n)});
 return {db,transport,r,context,events,counts,run:()=>withDurableExecution(context,()=>recordDrainProgress(db,events))};
}
test('three genuine observed projections commit atomically under one exact immutable receipt and never finalize work',async t=>{
 const {db,r,context,events,counts,run}=await setup(t);events[0].healthValue='synthetic-omitted';events[1].userId='synthetic-omitted';
 await run();assert.deepEqual(await counts(),{projections:3,receipts:1});
 const rows=(await db.raw.execute("SELECT component,last_detail,last_ok_at FROM system_heartbeats WHERE component LIKE 'phase4_stage6_drain:%'")).rows;
 assert.equal(rows.length,3);for(const row of rows){assert.ok(!row.last_detail.includes('synthetic-omitted'));assert.equal(Date.parse(row.last_ok_at),events[0].observedAt);assert.equal(JSON.parse(row.last_detail).outcome,'PENDING');}
 const step=withDurableExecution(context,()=>workStepOptions('phase.observation.batch-v1',events.map(e=>`phase4_stage6_drain:manual:${e.event}`),{discardResult:true}).workStep);
 const receipt=(await db.raw.execute({sql:'SELECT * FROM phase4_execution_work_receipts WHERE execution_id=?',args:[r.requestId]})).rows[0];
 assert.equal(receipt.step_key,workStepKey(context,['named',step]));assert.equal(receipt.receipt_key,receipt.step_key);
 assert.equal((await db.raw.execute({sql:'SELECT state FROM phase4_executions WHERE execution_id=?',args:[r.requestId]})).rows[0].state,'ESTABLISHED');
 await run();assert.deepEqual(await counts(),{projections:3,receipts:1},'same identity replays its immutable projection receipt');
});
for(const attack of ['order','release','identity','time','extra'])test(`invalid ${attack} projection is rejected before SQL effects`,async t=>{
 const {events,counts,run}=await setup(t);
 if(attack==='order')events.reverse();if(attack==='release')events[1].releaseSha='f'.repeat(40);
 if(attack==='identity')events[1].identity='f'.repeat(64);if(attack==='time')events[1].observedAt=Date.now()+100000;
 if(attack==='extra')events.push({...events[2]});
 await assert.rejects(run,/EXECUTION_EVENT_SEQUENCE_INVALID/);assert.deepEqual(await counts(),{projections:0,receipts:0});
});
test('a replaced execution owner cannot persist projections or a receipt',async t=>{
 const {db,r,counts,run}=await setup(t);
 await db.raw.execute({sql:'UPDATE phase4_executions SET lease_until=?,deadline_at=? WHERE execution_id=?',args:[Date.now()-1,Date.now()-1,r.requestId]});
 await db.raw.execute({sql:'UPDATE phase4_executions SET owner=?,generation=generation+1,lease_until=?,deadline_at=? WHERE execution_id=?',args:['synthetic-successor',Date.now()+30000,Date.now()+30000,r.requestId]});
 await assert.rejects(run,/REQUEST_OWNER_FENCED/);assert.deepEqual(await counts(),{projections:0,receipts:0});
});
test('lost COMMIT ACK preserves the atomic unknown outcome and prohibits a second submission',async t=>{
 const {db,transport,context,counts,run}=await setup(t);
 transport.arm({matchSql:/INSERT INTO system_heartbeats/,loseAcknowledgement:true});
 await assert.rejects(run,/COMMIT_INDETERMINATE/);assert.equal(context.indeterminate,true);
 assert.deepEqual(await counts(),{projections:3,receipts:1});const submitted=transport.counts.sqlStatements;
 await assert.rejects(run,/COMMIT_INDETERMINATE/);assert.equal(transport.counts.sqlStatements,submitted);
});
test('revocation after projection writes rolls back all rows and their receipt before COMMIT',async t=>{
 const {db,context,counts,run}=await setup(t),batch=db.raw.batch.bind(db.raw);let revoked=false;
 context.authority={assert(){if(revoked)throw Error('SYNTHETIC_AUTHORITY_REVOKED');}};
 db.raw.batch=async statements=>{const v=await batch(statements);if(statements.some(s=>s.sql.includes('INSERT INTO system_heartbeats')))revoked=true;return v;};
 try{await assert.rejects(run,/SYNTHETIC_AUTHORITY_REVOKED/);revoked=false;assert.deepEqual(await counts(),{projections:0,receipts:0});}
 finally{revoked=false;db.raw.batch=batch;}
});
