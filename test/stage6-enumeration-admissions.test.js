import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,fixtureKeys} from './v32ReviewFixture.js';
import {pilotPrefixFrom} from '../src/betaPilotBoundedReads.js';
import {MONITORED_BODY_WORK_PROFILE} from '../src/betaPilotPermit.js';
import {createReanalysisInputs} from '../src/phase4ReanalysisInputs.js';
import {betaPilotConfiguration,createBetaPilotPermit,withBetaPilotAttempt} from '../src/betaPilotPermit.js';
import {OWNER_PILOT_APPROVAL_SHA256,reviewedPilotAllowance} from '../src/betaPilotAllowance.js';

const context=Object.freeze({userId:'a',executionMode:'SHADOW',authGeneration:1,lifecycleGeneration:1});
const sqlOf=x=>typeof x==='string'?x:x?.sql??'';
const probe=x=>sqlOf(x).includes('candidate_count');
const journal=x=>/FROM (journal_events|journal_coverage_windows|experiment_field_groups) INDEXED/.test(sqlOf(x));
const sleep=x=>sqlOf(x).includes('FROM whoop_sleeps INDEXED');
const enumeration=x=>sqlOf(x).startsWith('SELECT source_type,source_id,json_array');
async function setup(t){
 const {db,transport}=await fixture(t);
 await db.createUser({id:'a',displayName:'Synthetic',status:'ACTIVE',timezone:'Asia/Taipei'});
 await db.createUser({id:'b',displayName:'Peer synthetic',status:'ACTIVE',timezone:'Asia/Taipei'});
 await db.ensureOnboarding('a',{state:'READY'});await db.admitRuntime();
 const config=betaPilotConfiguration({PHASE4_BETA_PILOT_ID:'a'.repeat(64),PHASE4_BETA_PILOT_USER_ID:'a',
  PHASE4_BETA_PILOT_START_AT:new Date(Date.now()-1000).toISOString(),PHASE4_BETA_PILOT_CONSENT_SHA256:'b'.repeat(64),
  PHASE4_BETA_PILOT_ALLOWANCE_ID:OWNER_PILOT_APPROVAL_SHA256});
 const grant=await createBetaPilotPermit({db,keys:fixtureKeys,config,reservation:reviewedPilotAllowance(config.allowanceId)}).reserve();
 const inputs=createReanalysisInputs({client:db.raw},{});
 const run=work=>withBetaPilotAttempt(grant,'a',()=>db.withRuntimeFence(c=>grant.assert(c),()=>db.transaction(work)));
 return {db,transport,inputs,grant,run};
}
test('all ten actual bounded probes overlap before owner-only health enumeration',async t=>{
 const {db,inputs,run}=await setup(t),execute=db.raw.execute.bind(db.raw);let seen=0,journals=0,sleepPending=false,overlapped=false,settled=0;
 db.raw.execute=async statement=>{
  if(probe(statement)){seen++;if(sleep(statement))sleepPending=true;if(journal(statement)){journals++;if(sleepPending)overlapped=true;}}
  if(enumeration(statement)){assert.equal(seen,10);assert.equal(settled,10);}
  const value=await execute(statement);
  if(probe(statement)){if(sleep(statement)){sleepPending=true;await new Promise(r=>setTimeout(r,40));sleepPending=false;}settled++;}
  return value;
 };
 try{
  const rows=await run(()=>inputs.enumerate(context,null,1));
  assert.equal(overlapped,true);assert.equal(journals,3);assert.equal(seen,10);assert.equal(settled,10);
  assert.deepEqual(rows.map(x=>[x.source_type,x.source_id]),[['USER','a']]);
 }finally{db.raw.execute=execute;}
});
for(const whoopFailed of [true,false])test(`probe failures settle and preserve ${whoopFailed?'WHOOP':'Journal'} priority without health enumeration`,async t=>{
 const {db,inputs,run}=await setup(t),execute=db.raw.execute.bind(db.raw);let seen=0,settled=0,health=0;
 db.raw.execute=async statement=>{
  if(enumeration(statement))health++;
  if(!probe(statement))return execute(statement);
  seen++;const value=await execute(statement);
  if(sleep(statement)){await new Promise(r=>setTimeout(r,40));settled++;if(whoopFailed)throw Error('FIRST_WHOOP_FAILURE');}
  else{settled++;if(journal(statement))throw Error('SECOND_JOURNAL_FAILURE');}
  return value;
 };
 try{
  await assert.rejects(()=>run(async()=>{
   await db.raw.execute("INSERT INTO telegram_state VALUES('probe_rollback','synthetic','2026-10-12')");
   return inputs.enumerate(context,null,1);
  }),whoopFailed?/FIRST_WHOOP_FAILURE/:/SECOND_JOURNAL_FAILURE/);
  assert.equal(seen,10);assert.equal(settled,10);assert.equal(health,0);
  assert.equal((await execute("SELECT count(*) n FROM telegram_state WHERE key='probe_rollback'")).rows[0].n,0);
 }finally{db.raw.execute=execute;}
});
test('fresh runtime revocation while a prefix probe settles prevents the payload query and rolls back',async t=>{
 const {db,inputs,grant}=await setup(t),execute=db.raw.execute.bind(db.raw);let revoked=false,health=0;
 db.raw.execute=async statement=>{
  const value=await execute(statement);if(enumeration(statement))health++;if(probe(statement)&&journal(statement))revoked=true;return value;
 };
 const guard=()=>{if(revoked)throw Error('CURRENT_RUNTIME_REVOKED');};
 try{
  await assert.rejects(()=>withBetaPilotAttempt(grant,'a',()=>db.withRuntimeFence(guard,()=>db.withRuntimeFence(c=>grant.assert(c),()=>db.transaction(()=>inputs.enumerate(context,null,1))))),/CURRENT_RUNTIME_REVOKED/);
  assert.equal(health,0);revoked=false;await db.transaction(()=>execute('SELECT 1'));
 }finally{revoked=false;db.raw.execute=execute;}
});

test('near the original finite read-set limit, eager probes deny without refund or payload',async t=>{
 const {db,inputs,run}=await setup(t),execute=db.raw.execute.bind(db.raw);let health=0,probes=0;
 await assert.rejects(()=>run(async()=>{
  for(let i=0;i<MONITORED_BODY_WORK_PROFILE.prefixReadSets-1;i++)await pilotPrefixFrom(db.raw,context,'whoop_cycles',['a']);
  db.raw.execute=async statement=>{const v=await execute(statement);if(probe(statement))probes++;if(enumeration(statement))health++;return v;};
  return inputs.enumerate(context,null,1);
 }),/BETA_PILOT_DENIED/);
 db.raw.execute=execute;assert.equal(probes,1);assert.equal(health,0);
 const signed=JSON.parse((await execute("SELECT last_detail FROM system_heartbeats WHERE scope='global' AND component='phase4_beta_pilot_permit_v1'")).rows[0].last_detail);
 assert.equal(signed.attempts,1);
});
test('earlier pure WHOOP rejection wins later Journal SQL failure and caught error poisons its parent',async t=>{
 const {db,inputs,run}=await setup(t),execute=db.raw.execute.bind(db.raw);let health=0,write=false,settled=0;
 db.raw.execute=async statement=>{
  if(!probe(statement)){const v=await execute(statement);if(enumeration(statement))health++;return v;}
  if(journal(statement)){try{return await execute('SELECT * FROM synthetic_absent_journal_probe');}finally{settled++;}}
  const v=await execute(statement);settled++;if(sleep(statement))v.rows[0].candidate_count=1001;return v;
 };
 try{
  await assert.rejects(()=>run(async()=>{
   try{await db.transaction(()=>inputs.enumerate(context,null,1),{readOnly:true});}
   catch(e){assert.equal(e.code,'BETA_PILOT_PREFIX_BOUNDS_UNAVAILABLE');}
   await db.raw.execute("INSERT INTO telegram_state VALUES('caught_probe_failure','synthetic','2026-10-12')");write=true;
  }),/BETA_PILOT_PREFIX_BOUNDS_UNAVAILABLE/);
  assert.equal(settled,10);assert.equal(health,0);assert.equal(write,false);
  assert.equal((await execute("SELECT count(*) n FROM telegram_state WHERE key='caught_probe_failure'")).rows[0].n,0);
 }finally{db.raw.execute=execute;}
});
