import test from 'node:test';import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createDb} from '../src/db.js';
import {schemaTransitionRuntimeProfileFor} from '../src/schemaTransitionProfile.js';
import {fixture,fixtureKeys} from './v32ReviewFixture.js';
import {createExecutionBudget,withExecutionBudget} from '../src/executionBudget.js';
const hash=s=>createHash('sha256').update(s).digest('hex');
for(const stop of ['cancel','deadline'])test('v33 '+stop+' before cleanup dispatch closes the original stream and preserves committed data',async t=>{
 const initial=await fixture(t,33),transport=initial.transport;initial.db.close();
 const db=createDb({url:'https://isolated.invalid',fetch:transport.fetch,phase4Keys:fixtureKeys,runtimeProfile:schemaTransitionRuntimeProfileFor({environment:{PHASE4_EXECUTION_PROFILE:'STAGE8_SCHEMA_TRANSITION'},keys:fixtureKeys})});t.after(()=>db.close());await db.admitRuntime();
 await db.raw.execute("INSERT INTO telegram_state VALUES('SYNTHETIC-COMMITTED','kept','2026-10-24')");
 let now=Date.now();const budget=createExecutionBudget({budgetMs:60000,nowMs:()=>now});let callbackFinished=false;
 try{await assert.rejects(withExecutionBudget(budget,()=>db.transaction(async()=>{
  try{
   await db.raw.execute("INSERT INTO telegram_state VALUES('SYNTHETIC-ABORTED','must-roll-back','2026-10-24')");
   if(stop==='cancel')budget.cancel();else now=budget.deadlineAt;
   await db.raw.execute('SELECT 333');
  }finally{callbackFinished=true;}
 })),e=>e.code===(stop==='cancel'?'SYNC_CANCELLED':'SYNC_TIMEOUT'));}finally{budget.close();}
 assert.equal(callbackFinished,true);
 await db.transaction(()=>db.raw.execute("INSERT INTO telegram_state VALUES('SYNTHETIC-NEXT','fresh','2026-10-24')"));
 const rows=(await db.raw.execute("SELECT key FROM telegram_state WHERE key IN ('SYNTHETIC-COMMITTED','SYNTHETIC-ABORTED','SYNTHETIC-NEXT') ORDER BY key")).rows;
 assert.deepEqual(rows.map(r=>r.key),['SYNTHETIC-COMMITTED','SYNTHETIC-NEXT']);
 const afterAbortSQL333Count=transport.counts.byTemplate[hash('SELECT 333')]?.count??0;
 assert.equal(afterAbortSQL333Count,0);

});
