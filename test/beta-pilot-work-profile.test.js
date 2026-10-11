import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createDb,fixtureKeys} from './localDb.js';
import {betaPilotConfiguration,createBetaPilotPermit,withBetaPilotAttempt,reservePilotMutation,
 currentPilotWorkProfile,MONITORED_BODY_WORK_PROFILE} from '../src/betaPilotPermit.js';
import {OWNER_PILOT_APPROVAL_SHA256,reviewedPilotAllowance} from '../src/betaPilotAllowance.js';
import {pilotPrefixFrom} from '../src/betaPilotBoundedReads.js';
const userId='synthetic-profile';
const context=Object.freeze({userId,executionMode:'SHADOW'});
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'pilot-profile-')),db=createDb({url:`file:${join(dir,'db.sqlite')}`});
 t.after(async()=>{db.close();await rm(dir,{recursive:true,force:true});});await db.migrate();await db.admitRuntime();
 await db.createUser({id:userId,displayName:'Synthetic',status:'ACTIVE',timezone:'Asia/Taipei'});await db.ensureOnboarding(userId,{state:'READY'});
 const config=betaPilotConfiguration({PHASE4_BETA_PILOT_ID:'a'.repeat(64),PHASE4_BETA_PILOT_USER_ID:userId,
  PHASE4_BETA_PILOT_START_AT:new Date(Date.now()-1000).toISOString(),PHASE4_BETA_PILOT_CONSENT_SHA256:'b'.repeat(64),
  PHASE4_BETA_PILOT_ALLOWANCE_ID:OWNER_PILOT_APPROVAL_SHA256});
 const grant=await createBetaPilotPermit({db,keys:fixtureKeys,config,reservation:reviewedPilotAllowance(config.allowanceId)}).reserve();
 return {db,grant,config};
}

test('the finite monitored work profile follows only the branded database/user grant and cannot replace its singleton authority',async t=>{
 const {db,grant,config}=await fixture(t);
 assert.equal(Object.isFrozen(MONITORED_BODY_WORK_PROFILE),true);
 assert.throws(()=>currentPilotWorkProfile(userId,db.raw),/BETA_PILOT_DENIED/);
 await assert.rejects(()=>withBetaPilotAttempt({...grant,workProfile:MONITORED_BODY_WORK_PROFILE},userId,async()=>{}),/BETA_PILOT_DENIED/);
 await withBetaPilotAttempt(grant,userId,async()=>{
  assert.equal(currentPilotWorkProfile(userId,db.raw),MONITORED_BODY_WORK_PROFILE);
  assert.throws(()=>currentPilotWorkProfile('other',db.raw),/BETA_PILOT_DENIED/);
  assert.throws(()=>currentPilotWorkProfile(userId,{}),/BETA_PILOT_DENIED/);
 });
 const row=(await db.raw.execute("SELECT last_detail FROM system_heartbeats WHERE scope='global' AND component='phase4_beta_pilot_permit_v1'")).rows[0];
 const record=JSON.parse(row.last_detail);assert.equal(record.attempts,1);assert.equal(record.startAt,config.startAt);assert.equal(record.endAt,config.endAt);
 assert.equal(record.closed,false);assert.equal(Object.hasOwn(record,'workProfile'),false);
});

test('monitored mutation and byte reservations remain finite and consumed after definite rollback',async t=>{
 const {db,grant}=await fixture(t);
 await withBetaPilotAttempt(grant,userId,async()=>{
  await assert.rejects(()=>db.transaction(async()=>{
   for(let n=0;n<MONITORED_BODY_WORK_PROFILE.mutations;n++)assert.equal(reservePilotMutation(context,db.raw,[]),true);
   throw Error('SYNTHETIC_ROLLBACK');
  }),/SYNTHETIC_ROLLBACK/);
  await db.transaction(async()=>assert.throws(()=>reservePilotMutation(context,db.raw,[]),/BETA_PILOT_DENIED/));
 });
 const another=await fixture(t);
 await withBetaPilotAttempt(another.grant,userId,()=>another.db.transaction(async()=>{
  assert.equal(reservePilotMutation(context,another.db.raw,['x'.repeat(MONITORED_BODY_WORK_PROFILE.mutationBytes-64)]),true);
  assert.throws(()=>reservePilotMutation(context,another.db.raw,[]),/BETA_PILOT_DENIED/);
 }));
});

test('monitored prefix slots retain each probe and deny the next slot, oversized source, receipt overflow and invalid types',async t=>{
 const {db,grant}=await fixture(t),execute=db.raw.execute.bind(db.raw);let observedBytes=0,invalidTypes=0;
 db.raw.execute=async statement=>statement?.sql?.includes('candidate_count')?
  {rows:[{candidate_count:1,serialized_bytes:observedBytes,invalid_types:invalidTypes}]}:execute(statement);
 await withBetaPilotAttempt(grant,userId,()=>db.transaction(async()=>{
  observedBytes=1024*1024+1;
  await assert.rejects(()=>pilotPrefixFrom(db.raw,context,'whoop_cycles',[userId]),/PREFIX_BOUNDS_UNAVAILABLE/);
  observedBytes=1103902;
  assert.match(await pilotPrefixFrom(db.raw,context,'phase4_operation_receipts',[userId,'SHADOW'],'',true),/INDEXED BY/);
  observedBytes=MONITORED_BODY_WORK_PROFILE.receiptPrefixBytes+1;
  await assert.rejects(()=>pilotPrefixFrom(db.raw,context,'phase4_operation_receipts',[userId,'SHADOW'],'',true),/PREFIX_BOUNDS_UNAVAILABLE/);
  observedBytes=0;invalidTypes=1;
  await assert.rejects(()=>pilotPrefixFrom(db.raw,context,'whoop_cycles',[userId]),/PREFIX_BOUNDS_UNAVAILABLE/);
  invalidTypes=0;
  for(let n=4;n<MONITORED_BODY_WORK_PROFILE.prefixReadSets;n++)await pilotPrefixFrom(db.raw,context,'whoop_cycles',[userId]);
  await assert.rejects(()=>pilotPrefixFrom(db.raw,context,'whoop_cycles',[userId]),/BETA_PILOT_DENIED/);
 }));
});
