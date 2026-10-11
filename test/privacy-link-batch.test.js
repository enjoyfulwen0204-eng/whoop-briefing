import test from 'node:test';import assert from 'node:assert/strict';
import {fixture,fixtureKeys} from './v32ReviewFixture.js';
import {addPrivacyLink,addPrivacyLinks} from '../src/phase4V22Backfill.js';
import {createBetaPilotPermit,betaPilotConfiguration,withBetaPilotAttempt,reservePilotMutation,MONITORED_BODY_WORK_PROFILE} from '../src/betaPilotPermit.js';
import {OWNER_PILOT_APPROVAL_SHA256,reviewedPilotAllowance} from '../src/betaPilotAllowance.js';
const link=(artifact,n)=>({userId:'a',mode:'SHADOW',table:'body_energy_results',artifactId:artifact,
 sourceMode:'SHARED',sourceType:'USER',sourceId:'synthetic-'+n,at:'2026-10-11T00:00:00.000Z'});
async function setup(t){const {db,transport}=await fixture(t);await db.createUser({id:'a',displayName:'Synthetic',status:'ACTIVE',timezone:'Asia/Taipei'});
 await db.ensureOnboarding('a',{state:'READY'});await db.admitRuntime();return {db,transport};}

test('ordered source-link batches execute the same complete rows in the same existing physical transaction with fewer Hrana requests',async t=>{
 const {db,transport}=await setup(t),requests={};
 for(const batch of [false,true]){const artifact=batch?'batch':'serial',links=Array.from({length:37},(_,n)=>link(artifact,n)),before=transport.counts.httpRequests;
  await db.transaction(async()=>{if(batch)await addPrivacyLinks(db.raw,links);else for(const row of links)await addPrivacyLink(db.raw,row);});
  requests[artifact]=transport.counts.httpRequests-before;
 }
 const rows=(await db.raw.execute('SELECT artifact_id,source_id,relationship,linked_at FROM phase4_source_links ORDER BY source_id,artifact_id')).rows;
 assert.equal(rows.length,74);for(let n=0;n<rows.length;n+=2)assert.deepEqual({...rows[n],artifact_id:null},{...rows[n+1],artifact_id:null});
 assert.equal(requests.serial-requests.batch,36);console.log('PRIVACY_LINK_ORDERED_BATCH_HTTP '+JSON.stringify(requests));
});

test('a failed ordered source-link statement rolls back the whole producing transaction without losing earlier validation or leaving a partial graph',async t=>{
 const {db}=await setup(t),links=Array.from({length:20},(_,n)=>link('rollback',n));links[17]={...links[17],sourceId:null};
 await assert.rejects(()=>db.transaction(()=>addPrivacyLinks(db.raw,links)),/NOT NULL/);
 assert.equal((await db.raw.execute("SELECT count(*) n FROM phase4_source_links WHERE artifact_id='rollback'")).rows[0].n,0);
});

test('batch preparation preserves every attempted logical mutation reservation, denies the next scalar before submission and never refunds a rollback',async t=>{
 const {db}=await setup(t),config=betaPilotConfiguration({PHASE4_BETA_PILOT_ID:'a'.repeat(64),PHASE4_BETA_PILOT_USER_ID:'a',
  PHASE4_BETA_PILOT_START_AT:new Date(Date.now()-1000).toISOString(),PHASE4_BETA_PILOT_CONSENT_SHA256:'b'.repeat(64),
  PHASE4_BETA_PILOT_ALLOWANCE_ID:OWNER_PILOT_APPROVAL_SHA256});
 const grant=await createBetaPilotPermit({db,keys:fixtureKeys,config,reservation:reviewedPilotAllowance(config.allowanceId)}).reserve();
 await withBetaPilotAttempt(grant,'a',async()=>{
  await assert.rejects(()=>db.transaction(async()=>{
   for(let n=0;n<MONITORED_BODY_WORK_PROFILE.mutations-9;n++)reservePilotMutation({userId:'a',executionMode:'SHADOW'},db.raw,[]);
   await addPrivacyLinks(db.raw,Array.from({length:16},(_,n)=>link('denied',n)));
  }),/BETA_PILOT_DENIED/);
  assert.equal((await db.raw.execute("SELECT count(*) n FROM phase4_source_links WHERE artifact_id='denied'")).rows[0].n,0);
  await db.transaction(async()=>assert.throws(()=>reservePilotMutation({userId:'a',executionMode:'SHADOW'},db.raw,[]),/BETA_PILOT_DENIED/));
 });
});
