import test from 'node:test';
import assert from 'node:assert/strict';
import {recoveryFixture,fixtureKeys,profileEnvironment} from './round4Fixture.js';
import {SCHEMA} from '../src/schema.js';
import {createPhase4Keys} from '../src/phase4Keys.js';
import {createOwnedFileDb} from '../src/db.js';
import {createSchemaTransitionRuntimeProfile} from '../src/schemaTransitionProfile.js';

test('v33 actual trusted admission rejects retired indexes and admits after local-only retirement',async t=>{
 const {db}=await recoveryFixture(t);
 assert.equal(db.requireRuntimeAdmission(await db.admitRuntime({fresh:true})),33);
 for(const name of ['idx_insight_subject','idx_insight_active']){
  const ddl=SCHEMA.find(sql=>sql.includes('INDEX IF NOT EXISTS '+name+' '));assert.ok(ddl);
  await db.raw.execute(ddl);
  await assert.rejects(db.admitRuntime({fresh:true}),/UNEXPECTED_SCHEMA_OBJECT|retired_index_present/);
  await db.raw.execute('DROP INDEX '+name);
  assert.equal(db.requireRuntimeAdmission(await db.admitRuntime({fresh:true})),33);
 }
});
test('v33 preserves original key continuity, marker and checkpoint requirements',async t=>{
 const {db}=await recoveryFixture(t);
 for(const [step,wrong,correct,pattern] of [
  ['lookup_key_check','SYNTHETIC_WRONG',fixtureKeys.lookupCheckpoint(),/LOOKUP_KEY_MISMATCH/],
  ['audit_key_check','SYNTHETIC_WRONG',fixtureKeys.auditCheckpoint(),/AUDIT_KEY_MISMATCH/]]){
  await db.raw.execute({sql:'UPDATE phase4_migration_checkpoints SET last_cursor=? WHERE target_version=22 AND step_key=?',args:[wrong,step]});
  await assert.rejects(db.admitRuntime({fresh:true}),pattern);
  await db.raw.execute({sql:'UPDATE phase4_migration_checkpoints SET last_cursor=? WHERE target_version=22 AND step_key=?',args:[correct,step]});
 }
 await db.raw.execute("UPDATE phase4_migration_checkpoints SET postcondition_state='PENDING' WHERE target_version=32 AND step_key='execution_authority'");
 await assert.rejects(db.admitRuntime({fresh:true}),/CHECKPOINT_INCOMPLETE/);
 await db.raw.execute("UPDATE phase4_migration_checkpoints SET postcondition_state='COMPLETE' WHERE target_version=32 AND step_key='execution_authority'");
 await db.raw.execute("UPDATE schema_version SET note='SYNTHETIC_WRONG' WHERE version=33");
 await assert.rejects(db.admitRuntime({fresh:true}),/VERSION_AUTHORITY_INCOMPLETE/);
});
test('wrong version, forged profile, wrong key identity, release and Advanced ON fail closed',async t=>{
 const {db,dir}=await recoveryFixture(t);
 await db.raw.execute('UPDATE schema_version SET version=34 WHERE version=33');
 await assert.rejects(db.admitRuntime({fresh:true}),/RECOVERY_V33_REQUIRED/);
 assert.throws(()=>createOwnedFileDb({url:'file:'+dir+'/rejected-profile.db',phase4Keys:fixtureKeys,runtimeProfile:{}}),/TRUSTED_PROFILE_REQUIRED/);
 const wrong=createPhase4Keys({lookupKey:Buffer.alloc(32,3),auditKey:Buffer.alloc(32,4)});
 const p=createSchemaTransitionRuntimeProfile({environment:profileEnvironment(),keys:fixtureKeys});
 assert.throws(()=>createOwnedFileDb({url:'file:'+dir+'/rejected-keys.db',phase4Keys:wrong,runtimeProfile:p}),/TRUSTED_PROFILE_REQUIRED/);
 assert.throws(()=>createSchemaTransitionRuntimeProfile({environment:{...profileEnvironment(),PHASE4_RELEASE_SHA:'a'.repeat(40)},keys:fixtureKeys}),/CHECKOUT_MISMATCH/);
 assert.throws(()=>createSchemaTransitionRuntimeProfile({environment:{...profileEnvironment(),STAGE8_LIVE_ANALYSIS:'on'},keys:fixtureKeys}),/NEW_FEATURES_OFF_REQUIRED/);
});
