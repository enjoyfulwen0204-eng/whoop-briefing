import test from 'node:test';import assert from 'node:assert/strict';
import {deliveryFixture,fixtureKeys} from './deliveryDefaultFixture.js';
import {executionProfile} from '../src/phase4Rollback.js';
import {runMorningReadiness} from '../src/morningReadiness.js';
import {configurationProof} from '../src/phase4ExecutionStore.js';
import {runningReleaseSha} from '../src/phase4Release.js';
import {verifyPhase4Schema} from '../src/phase4Migrations.js';
import {createStage7Runtime} from '../src/stage7Runtime.js';
const environment={PHASE4_EXECUTION_PROFILE:'COMPANION_V33_RECOVERY',PHASE4_BETA_SHADOW_RUNTIME:'off',PHASE4_PUBLIC_BETA_MODE:'off',STAGE7_COMPANION:'off',BODY_ENERGY_PUBLICATION:'off',BODY_ENERGY_ALERTS:'off'};
test('same-schema v33 recovery admits full objects and ordinary readiness without changing user state or activating companion',async t=>{
 const {db}=await deliveryFixture(t,{version:33});assert.equal(executionProfile(environment),'COMPANION_V33_RECOVERY');await db.admitRuntime();
 await db.createUser({id:'retained',displayName:'Fixture retained',timezone:'Asia/Taipei',status:'ACTIVE'});
 await db.raw.execute("INSERT INTO journal_tracking_preferences(user_id,lifecycle_generation,created_at,updated_at) VALUES('retained',1,'2026-01-01','2026-01-01')");
 const before=(await db.raw.execute('SELECT * FROM journal_tracking_preferences')).rows;
 const releaseSha=runningReleaseSha(),request={kind:'MORNING_READINESS_V1',requestId:'isolated-v33-recovery-001',releaseSha,executionMode:'OFF',triggerSource:'cloudflare',configProof:configurationProof(fixtureKeys,{runtime:'off',mode:'off'},environment)};
 const result=await runMorningReadiness({request,db,keys:fixtureKeys,env:{maxUserConcurrency:1},environment,deps:{runUser:()=>{throw Error('NOT_READY_USER');}}});
 assert.equal(result.status,200);assert.equal(result.body.result.users,0);assert.equal(await createStage7Runtime({db,environment}),null);
 await verifyPhase4Schema(db.raw,33);assert.deepEqual((await db.raw.execute('SELECT * FROM journal_tracking_preferences')).rows,before);
 assert.deepEqual((await db.raw.execute('PRAGMA foreign_key_check')).rows,[]);assert.equal((await db.raw.execute('PRAGMA integrity_check')).rows[0].integrity_check,'ok');
 assert.throws(()=>executionProfile({...environment,STAGE7_COMPANION:'on'}),/FEATURES_OFF/);
});
test('v33 binary refuses exact-v32 fixture until explicit migration; no minimum-version relaxation',async t=>{
 const {db}=await deliveryFixture(t,{version:32});await assert.rejects(db.admitRuntime(),/CONTROLLED_MIGRATION_REQUIRED/);
});
