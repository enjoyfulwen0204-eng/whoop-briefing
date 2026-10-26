// Physical request counts only, not native timing/EOF/Production evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,fixtureKeys} from './v32ReviewFixture.js';
import {bodyInput,seedBodyInput} from './bodyEnergyFixture.js';
import {createPhase4Foundation} from '../src/phase4Foundation.js';
import {createStage8LiveProducer} from '../src/stage8LiveProducer.js';
test('three original LIVE legs report Body, completed-run and item physical HTTP costs',async t=>{
 const {db,transport}=await fixture(t,35,{traceTransactions:true});
 await db.createUser({id:'a',displayName:'Synthetic',timezone:'Asia/Taipei',status:'ACTIVE'});
 const stores=await createPhase4Foundation({db,keys:fixtureKeys});await stores.initializeTenant('a','SHADOW');
 await db.transaction(()=>seedBodyInput(db,bodyInput({asOf:Date.now()-1000,days:0})));
 await db.ensureOnboarding('a',{state:'READY'});await db.linkTelegram({userId:'a',chatId:'10001'});await db.setLocale('a','en');
 const producer=await createStage8LiveProducer({db,keys:fixtureKeys,admission:await db.admitRuntime(),userIds:['a'],enabled:()=>true,eligible:id=>id==='a'});
 const before=transport.transactions.length;
 for(let leg=0;leg<3;leg++){
  const value=await producer.run({userId:'a',requestId:'original-unit-physical-cost-'+leg});assert.equal(value.result.jobsFailed,0);
 }
 const bodies=transport.transactions.slice(before).filter(x=>x.statements.some(s=>s.verb==='INSERT'&&s.table==='body_energy_results'));
 assert.equal(bodies.length,1);const tx=bodies[0];assert.equal(tx.outcome,'COMMITTED');
 for(const table of ['stage8_live_operation_receipts','stage8_live_execution_work_receipts'])assert.ok(tx.statements.some(s=>s.verb==='INSERT'&&s.table===table));
 assert.ok(tx.statements.some(s=>s.verb==='SELECT'&&s.table==='whoop_cycles'));
 assert.ok(tx.statements.some(s=>s.verb==='SELECT'&&s.table==='whoop_resource_access'));
 assert.equal((await db.raw.execute('SELECT count(*) n FROM outbound_messages')).rows[0].n,0);
 const executions=(await db.raw.execute('SELECT generation,deadline_at,created_at,lease_until FROM stage8_live_executions')).rows;
 assert.ok(executions.length);for(const row of executions){assert.equal(row.generation,1);assert.equal(row.deadline_at-row.created_at,45000);assert.equal(row.lease_until-row.created_at,60000);}
 console.log('ORIGINAL_BODY_PHYSICAL_COST '+JSON.stringify({HTTP:tx.httpOperations,SQL:tx.sqlOperations,
  principalReads:tx.statements.filter(s=>s.verb==='SELECT'&&s.table==='users').length,
  modeledServerWallMs:tx.finishedAt-tx.beginSubmittedAt,addedLatencyMs:0,
  productionEvidence:false,nativeEvidence:false,EOF:false,qualification:false}));
 for(const [kind,verb,table] of [['RUN_COMPLETE','UPDATE','evidence_runs'],['ITEM','INSERT','evidence_items']]){
  const unit=transport.transactions.slice(before).find(x=>x.statements.some(s=>s.verb===verb&&s.table===table));
  assert.ok(unit,'must actually reach original '+kind);assert.equal(unit.outcome,'COMMITTED');
  const statements={};for(const s of unit.statements){const key=s.verb+':'+s.table;statements[key]=(statements[key]??0)+1;}
  console.log('ORIGINAL_METRIC_PHYSICAL_COST '+JSON.stringify({kind,HTTP:unit.httpOperations,SQL:unit.sqlOperations,statements,
   addedLatencyMs:0,productionEvidence:false,nativeEvidence:false,EOF:false,qualification:false}));
 }
});
