import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createDb,fixtureKeys} from './localDb.js';
import {createBetaPilotPermit,betaPilotConfiguration,withBetaPilotAttempt,reservePilotMutation,reviewedPilotReservation} from '../src/betaPilotPermit.js';
import {pilotPrefixFrom} from '../src/betaPilotBoundedReads.js';
import {PILOT_V32_PREFIX_SHAPES} from '../src/betaPilotV32ReadShapes.js';
import {createReanalysisInputs} from '../src/phase4ReanalysisInputs.js';
import {createBodyEnergyStore} from '../src/bodyEnergyStore.js';
import {createReceiptRouting} from '../src/phase4ReceiptRouting.js';
import {createPhase4EntityStore} from '../src/phase4EntityStore.js';
import {createTargetAuthorityClosure} from '../src/phase4AuthorityClosure.js';
import {buildPhase4Core} from '../src/phase4Core.js';
import {addPrivacyLink} from '../src/phase4V22Backfill.js';
const userId='pilot-user',context={userId,executionMode:'SHADOW',timezone:'Asia/Taipei',inputGeneration:0,lifecycleGeneration:1,authGeneration:0,sourceGeneration:0};
const units={id:'c'.repeat(64),evidenceSha256:'d'.repeat(64),perAttempt:{rowsRead:1,rowsWritten:1,storageBytes:1,bytesSynced:0,microUsd:1},maximum:{rowsRead:48,rowsWritten:48,storageBytes:48,bytesSynced:0,microUsd:48}};
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'pilot-work-')),db=createDb({url:'file:'+join(dir,'fixture.db')});
 t.after(async()=>{db.close();await rm(dir,{recursive:true,force:true});});
 await db.migrate();await db.admitRuntime();await db.createUser({id:userId,displayName:'Synthetic',timezone:'Asia/Taipei',status:'ACTIVE'});
 await db.ensureOnboarding(userId);await db.raw.execute({sql:"UPDATE user_onboarding SET state='READY' WHERE user_id=?",args:[userId]});
 const config=betaPilotConfiguration({PHASE4_BETA_PILOT_ID:'a'.repeat(64),PHASE4_BETA_PILOT_USER_ID:userId,
  PHASE4_BETA_PILOT_START_AT:new Date(Date.now()-1000).toISOString(),PHASE4_BETA_PILOT_CONSENT_SHA256:'b'.repeat(64),PHASE4_BETA_PILOT_COST_BOUND_ID:units.id});
 const grant=await createBetaPilotPermit({db,keys:fixtureKeys,config,reservation:units}).reserve(),queries=[],execute=db.raw.execute.bind(db.raw);
 db.raw.execute=async statement=>{if(typeof statement?.sql==='string')queries.push(statement);return execute(statement);};
 return {db,grant,queries,run:work=>withBetaPilotAttempt(grant,userId,()=>db.transaction(work))};
}
test('all registered v32 raw prefixes match actual fields/types/index prefixes and stop without a temporary sort',async t=>{
 const {db,queries,run}=await fixture(t);
 await run(async()=>{
  for(const [table,spec] of Object.entries(PILOT_V32_PREFIX_SHAPES)){
   const info=(await db.raw.execute(`PRAGMA table_info(${table})`)).rows;
   assert.deepEqual(info.map(r=>r.name),spec.fields);assert.equal(Object.isFrozen(spec),true);
   const index=(await db.raw.execute(`PRAGMA index_info(${spec.index})`)).rows.map(r=>r.name);
   assert.deepEqual(index.slice(0,spec.prefix.length),spec.prefix);
   const args=spec.prefix.map(f=>f==='user_id'?userId:f.endsWith('execution_mode')?'SHADOW':f==='subject_kind'?'EPISODE':'a'.repeat(64));
   const from=await pilotPrefixFrom(db.raw,context,table,args);
   assert.match(from,/INDEXED BY/);
   const query=queries.filter(q=>q.sql.includes('candidate_count')).at(-1),plan=(await db.raw.execute({...query,sql:'EXPLAIN QUERY PLAN '+query.sql})).rows.map(r=>r.detail).join('\n');
   assert.doesNotMatch(plan,/TEMP B-TREE/);assert.equal(query.args.at(-1),1001);
  }
 });assert.equal(reviewedPilotReservation(),null);
});
test('returned LIMIT1 cannot submit source UNION after raw ineligible WHOOP prefix overflow; ordinary source SQL is unchanged',async t=>{
 const {db,queries,run}=await fixture(t),inputs=createReanalysisInputs({client:db.raw},{});
 await db.raw.batch(Array.from({length:1001},(_,n)=>({sql:'INSERT INTO whoop_cycles(user_id,id,synced_at) VALUES(?,?,?)',args:[userId,String(n),'2026-10-11T00:00:00.000Z']})));
 await run(async()=>{await assert.rejects(()=>inputs.enumerate(context,null,1),/PREFIX_BOUNDS_UNAVAILABLE/);
  assert.equal(queries.filter(q=>q.sql.includes('UNION ALL')).length,0);
 });
 queries.length=0;assert.equal((await inputs.enumerate(context,null,1))[0].source_type,'USER');
 assert.equal(queries.some(q=>q.sql.includes('candidate_count')||q.sql.includes('INDEXED BY')),false);
});
test('Body Energy preserves all eight original reads and admits their complete raw prefixes before payload',async t=>{
 const {db,queries,run}=await fixture(t);let captured=false;
 const core={client:db.raw,keys:fixtureKeys,now:()=>new Date('2026-10-11T00:00:00.000Z'),run:async(_,fn)=>fn(),root:async()=>({ref:{synthetic:true}}),
  contextRegistry:{set(){captured=true;}},newId:()=> 'synthetic-capture'};
 const store=createBodyEnergyStore(core,{},{});
 await run(async()=>{await store.prepare(context,{asOfEpochMs:Date.parse('2026-10-11T00:00:00.000Z')});
  const payload=queries.filter(q=>q.sql.startsWith('SELECT user_id,'));assert.equal(payload.length,8);
  assert.ok(payload.every(q=>q.sql.includes('INDEXED BY')));assert.equal(captured,true);
 });
});
test('routing tip rejects a synthetic overflow observation before issuing its aggregate COUNT',async t=>{
 const {db,queries,run}=await fixture(t),execute=db.raw.execute.bind(db.raw);
 db.raw.execute=async statement=>{
  if(statement?.sql?.includes('candidate_count')&&statement.sql.includes('phase4_receipt_route_entries')){
   queries.push(statement);return {rows:[{candidate_count:1001,serialized_bytes:0,invalid_types:0}]};
  }return execute(statement);
 };
 await run(async()=>{await assert.rejects(()=>createReceiptRouting(db.raw,fixtureKeys).tip(context,'EPISODE','synthetic'),/PREFIX_BOUNDS_UNAVAILABLE/);
  assert.equal(queries.some(q=>q.sql.startsWith('SELECT COUNT(*) count FROM')),false);
 });
});
test('receipt tenant trigger scope observes own-write growth; unsupported scopes and types deny before data SQL',async t=>{
 const {db,queries,run}=await fixture(t),execute=db.raw.execute.bind(db.raw);let observed=0;
 db.raw.execute=async statement=>{
  if(statement?.sql?.includes('candidate_count')&&statement.sql.includes('phase4_operation_receipts')){
   queries.push(statement);return {rows:[{candidate_count:observed,serialized_bytes:0,invalid_types:0}]};
  }return execute(statement);
 };
 await run(async()=>{
  await pilotPrefixFrom(db.raw,context,'phase4_operation_receipts',[userId,'SHADOW'],'',true);
  observed=1001;await assert.rejects(()=>pilotPrefixFrom(db.raw,context,'phase4_operation_receipts',[userId,'SHADOW'],'',true),/PREFIX_BOUNDS_UNAVAILABLE/);
  const before=queries.length;await assert.rejects(()=>pilotPrefixFrom(db.raw,context,'unregistered',[userId]),/PREFIX_BOUNDS_UNAVAILABLE/);assert.equal(queries.length,before);
 });
});
test('artifact graph rejects a real raw link-prefix overflow before submitting the filtered link payload query',async t=>{
 const {db,queries,run}=await fixture(t),artifactId='a'.repeat(64),admission=await db.admitRuntime();
 const core=await buildPhase4Core({keys:fixtureKeys,admission,authorizeMode:()=>{},processing:{client:db.raw,transaction:db.transaction,
  active:db.processingTransactionActive,afterCommit:db.afterProcessingCommit,afterCompletion:db.afterProcessingCompletion}});
 await db.raw.batch(Array.from({length:1001},(_,n)=>({sql:'INSERT INTO phase4_source_links VALUES(?,?,?,?,?,?,?,?,?,?,?)',
  args:[userId,'SHADOW','body_energy_results',artifactId,'SHARED','USER','synthetic-'+n,'DEPENDS_ON','2026-10-11T00:00:00.000Z',null,null]})));
 await run(async()=>{await assert.rejects(()=>core.validateStoredGraph(context,'body_energy_results',artifactId),/PREFIX_BOUNDS_UNAVAILABLE/);
  assert.equal(queries.some(q=>q.sql.startsWith('SELECT source_execution_mode,source_type,source_id,relationship')),false);
 });
});
test('scoped authority rejects raw tenant overflow before opening full authority JSON payloads',async t=>{
 const {db,queries,run}=await fixture(t),execute=db.raw.execute.bind(db.raw);
 db.raw.execute=async statement=>{
  if(statement?.sql?.includes('candidate_count')&&statement.sql.includes('phase4_evidence_result_authorities')){
   queries.push(statement);return {rows:[{candidate_count:1001,serialized_bytes:0,invalid_types:0}]};
  }return execute(statement);
 };
 const closure=createTargetAuthorityClosure({client:db.raw,keys:fixtureKeys,schemaVersion:32},()=>{throw Error('SHOULD_NOT_AUTHENTICATE');});
 await run(async()=>{await assert.rejects(()=>closure.inventory(context,{kind:'INSIGHT',insightKey:'synthetic'}),/PREFIX_BOUNDS_UNAVAILABLE/);
  assert.equal(queries.some(q=>q.sql.startsWith('SELECT * FROM phase4_evidence_result_authorities')),false);
 });
});
test('completeEvidence actual UTF8 submissions share the cumulative envelope before UPDATE',async t=>{
 const {db,run}=await fixture(t),execute=db.raw.execute.bind(db.raw);let updates=0;
 db.raw.execute=async statement=>{if(statement?.sql?.startsWith('UPDATE evidence_runs SET')){updates++;return {rowsAffected:1};}return execute(statement);};
 const core={client:db.raw,run:async(_,fn)=>fn(),timestamp:()=> '2026-10-11T00:00:00.000Z',artifact:async()=>({row:{state:'STARTED'}})},store=createPhase4EntityStore(core);
 await run(async()=>{
  for(let n=0;n<2;n++)await store.completeEvidence(context,'synthetic-run',{input_manifest_json:{synthetic:'x'.repeat(120000)}});
  await assert.rejects(()=>store.completeEvidence(context,'synthetic-run',{input_manifest_json:{synthetic:'x'.repeat(120000)}}),/BETA_PILOT_DENIED/);
  assert.equal(updates,2);
 });
 assert.equal(reservePilotMutation({executionMode:'LIVE'},null,[Buffer.alloc(1)]),false,'ordinary no-pilot path retains its existing semantics');
});
test('named mutation reservations consume attempted source-link operations despite definite rollback or duplicate outcomes',async t=>{
 const {db,grant}=await fixture(t);
 await withBetaPilotAttempt(grant,userId,async()=>{
  const link=n=>addPrivacyLink(db.raw,{userId,mode:'SHADOW',table:'body_energy_results',artifactId:String(n),
   sourceMode:'SHARED',sourceType:'USER',sourceId:userId,at:'2026-10-11T00:00:00.000Z'});
  await assert.rejects(()=>db.transaction(async()=>{for(let n=0;n<128;n++)await link(n);throw Error('definite-rollback');}),/definite-rollback/);
  assert.equal((await db.raw.execute('SELECT COUNT(*) n FROM phase4_source_links')).rows[0].n,0);
  await db.transaction(async()=>{await assert.rejects(()=>link(129),/BETA_PILOT_DENIED/);});
 });assert.equal(reviewedPilotReservation(),null);
});
