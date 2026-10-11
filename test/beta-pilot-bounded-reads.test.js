import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createDb,fixtureKeys} from './localDb.js';
import {createBetaPilotPermit,betaPilotConfiguration,withBetaPilotAttempt,reviewedPilotReservation} from '../src/betaPilotPermit.js';
import {readPilotPrefixRows} from '../src/betaPilotBoundedReads.js';
const userId='pilot-user',context={userId,executionMode:'SHADOW'},source='a'.repeat(64);
const reservation={id:'c'.repeat(64),evidenceSha256:'d'.repeat(64),
 perAttempt:{rowsRead:1,rowsWritten:1,storageBytes:1,bytesSynced:0,microUsd:1},
 maximum:{rowsRead:48,rowsWritten:48,storageBytes:48,bytesSynced:0,microUsd:48}};
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'pilot-prefix-')),db=createDb({url:`file:${join(dir,'db')}`});
 t.after(async()=>{db.close();await rm(dir,{recursive:true,force:true});});
 await db.migrate();await db.admitRuntime();await db.createUser({id:userId,displayName:'Synthetic',timezone:'Asia/Taipei',status:'ACTIVE'});
 await db.ensureOnboarding(userId);await db.raw.execute({sql:"UPDATE user_onboarding SET state='READY' WHERE user_id=?",args:[userId]});
 const config=betaPilotConfiguration({PHASE4_BETA_PILOT_ID:'a'.repeat(64),PHASE4_BETA_PILOT_USER_ID:userId,
  PHASE4_BETA_PILOT_START_AT:new Date(Date.now()-1000).toISOString(),PHASE4_BETA_PILOT_CONSENT_SHA256:'b'.repeat(64),PHASE4_BETA_PILOT_COST_BOUND_ID:reservation.id});
 const grant=await createBetaPilotPermit({db,keys:fixtureKeys,config,reservation}).reserve();
 const statements=[],client=db.raw,execute=client.execute.bind(client);
 client.execute=async statement=>{
  if(statement?.sql?.startsWith('SELECT')&&statement.sql.includes('INDEXED BY sqlite_autoindex_'))statements.push(statement);
  return execute(statement);
 };
 const run=work=>withBetaPilotAttempt(grant,userId,()=>db.transaction(work));
 return {db,client,statements,run,grant};
}
async function insertFamily(db,sequence,json='{}'){
 await db.raw.execute({sql:'INSERT INTO phase4_family_directory_entries VALUES (?,?,?,?,?,?,?,?,?,?)',args:[
  userId,'SHADOW',source,sequence,sequence.toString(16).padStart(64,'0'),'f'.repeat(64),json,'KNOWN','stage6-family-directory-v1','e'.repeat(64)]});
}
const ordinary={sql:'SELECT 1 ordinary',args:[]};
const family=(client,c=context)=>readPilotPrefixRows(client,c,'family',[userId,'SHADOW',source],ordinary);

test('each v32 forced prefix has a bounded inner probe, exact ordered payload and no temporary sort',async t=>{
 const {db,client,statements,run}=await fixture(t);await insertFamily(db,1);await insertFamily(db,2,'{"synthetic":"引號\\\""}');
 await run(async()=>{
  assert.equal((await family(client)).length,2);
  for(const [id,args] of [['routeEntries',[userId,'SHADOW','EPISODE',source]],['routes',[userId,'SHADOW']],['receiptProjection',[userId,'SHADOW']]])
   assert.deepEqual(await readPilotPrefixRows(client,context,id,args,ordinary),[]);
  for(const query of statements){
   const plan=(await db.raw.execute({...query,sql:`EXPLAIN QUERY PLAN ${query.sql}`})).rows.map(row=>row.detail).join('\n');
   assert.match(plan,/USING PRIMARY KEY/);assert.doesNotMatch(plan,/TEMP B-TREE|SCAN phase4_/);
   assert.match(query.sql,/INDEXED BY sqlite_autoindex_/);assert.equal(query.args.at(-1),1001);
  }
 });assert.equal(reviewedPilotReservation(),null);
});
test('growth between reads invalidates fresh prefix admission instead of truncating source history',async t=>{
 const {db,client,statements,run}=await fixture(t);await insertFamily(db,1);
 await run(async()=>{
  assert.equal((await family(client)).length,1);
  // Growth occurs inside the same fixture write transaction; each next call
  // independently rechecks it. No cached count/24h snapshot is authoritative.
  for(let n=2;n<=1001;n++)await insertFamily(db,n);
  const before=statements.length;await assert.rejects(()=>family(client),/PREFIX_BOUNDS_UNAVAILABLE/);
  assert.equal(statements.length-before,1);assert.match(statements.at(-1).sql,/candidate_count/);
 });
});
test('oversized UTF-8 payload is denied before payload selection and denied probes consume the envelope',async t=>{
 const {db,client,statements,run}=await fixture(t);
 // Many small synthetic values exceed the same production envelope without
 // relying on a giant native-driver parameter allocation.
 for(let n=1;n<=100;n++)await insertFamily(db,n,JSON.stringify({synthetic:'越'.repeat(1000)}));
 await run(async()=>{
  for(let n=0;n<32;n++)await assert.rejects(()=>family(client),/PREFIX_BOUNDS_UNAVAILABLE/);
  assert.equal(statements.length,32);assert.ok(statements.every(q=>q.sql.includes('candidate_count')));
  await assert.rejects(()=>family(client),/BETA_PILOT_DENIED/);assert.equal(statements.length,32);
 });
 const row=(await db.raw.execute("SELECT last_detail FROM system_heartbeats WHERE component='phase4_beta_pilot_permit_v1'")).rows[0];
 assert.equal(JSON.parse(row.last_detail).attempts,1);assert.equal(reviewedPilotReservation(),null);
});
test('pilot reads require the canonical cohort and an existing processing transaction before submitting SQL',async t=>{
 const {client,statements,grant,db}=await fixture(t);
 await withBetaPilotAttempt(grant,userId,async()=>{
  await assert.rejects(()=>family(client),/BETA_PILOT_DENIED/);assert.equal(statements.length,0);
  await db.transaction(async()=>{
   await assert.rejects(()=>family(client,{...context,userId:'other-user'}),/BETA_PILOT_DENIED/);
   await assert.rejects(()=>family({execute:client.execute}),/BETA_PILOT_DENIED/);
  });
  assert.equal(statements.length,0);
 });
});
test('SQLite TEXT affinity cannot admit a JSON BLOB to the scalar serialization bound',async t=>{
 const {db,client,statements,run}=await fixture(t);
 await insertFamily(db,1,new TextEncoder().encode('{"synthetic":"x"}'));
 assert.equal((await db.raw.execute('SELECT typeof(descriptor_json) type FROM phase4_family_directory_entries')).rows[0].type,'blob');
 await run(async()=>{await assert.rejects(()=>family(client),/PREFIX_BOUNDS_UNAVAILABLE/);
  assert.equal(statements.length,1);assert.match(statements[0].sql,/invalid_types/);
 });
});
test('no pilot scope preserves exact ordinary SQL including full result cardinality',async()=>{
 const rows=Array.from({length:1002},(_,id)=>({id}));let received;
 const client={execute:async statement=>{received=statement;return {rows};}};
 assert.equal(await family(client),rows);assert.equal(received,ordinary);
});
