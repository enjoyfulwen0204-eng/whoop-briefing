import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createOwnedFileDb,composeDb} from '../src/db.js';
import {createClient} from '@libsql/client';
import {createPhase4Keys} from '../src/phase4Keys.js';
import {runningReleaseSha} from '../src/phase4Release.js';
import {executionProfile} from '../src/phase4Rollback.js';
import {configurationProof} from '../src/phase4ExecutionStore.js';
import {publicBetaConfiguration} from '../src/publicBetaConfig.js';
import {stage8Configuration} from '../src/stage8Runtime.js';
import {bodyEnergyConfiguration} from '../src/bodyEnergyRuntime.js';
import {replaceObservedRuntimeLifetime,renewRuntimeAfterContention} from '../src/runtimeAdmission.js';
import {SCHEMA_TRANSITION_PROFILE,createSchemaTransitionRuntimeProfile,
 schemaTransitionRuntimeProfileFor,requireSchemaTransitionRuntimeProfile} from '../src/schemaTransitionProfile.js';

const keys=createPhase4Keys({lookupKey:Buffer.alloc(32,71),auditKey:Buffer.alloc(32,83)});
const releaseSha=runningReleaseSha({});
const environment=()=>({PHASE4_EXECUTION_PROFILE:SCHEMA_TRANSITION_PROFILE,PHASE4_RELEASE_SHA:releaseSha,
 PHASE4_BETA_SHADOW_RUNTIME:'off',PHASE4_PUBLIC_BETA_MODE:'off',PHASE4_PUBLIC_BETA_USER_IDS:'',
 PHASE4_STAGE8_RUNTIME:'off',PHASE4_STAGE8_OWNER_MONITORING:'off',STAGE8_MORNING_BRIEF:'off',
 STAGE8_LIVE_ANALYSIS:'off',STAGE8_POST_SYNC:'off',STAGE8_SUBJECT_ALERTS:'off',PHASE4_DELIVERY_CUTOVER:'off',
 BODY_ENERGY_PUBLICATION:'off',BODY_ENERGY_ALERTS:'off',STAGE7_COMPANION:'on',STAGE7_AUTOMATIC:'on'});
async function fixture(t,version=33){
 const directory=await mkdtemp(join(tmpdir(),'schema-transition-profile-')),url=pathToFileURL(join(directory,'synthetic.db')).href;
 const seed=createOwnedFileDb({url,phase4Keys:keys});await seed.migrate({targetVersion:version});seed.close();
 const opened=[];t.after(async()=>{for(const db of opened)db.close();await rm(directory,{recursive:true,force:true});});
 return {url,open(runtimeProfile){const db=createOwnedFileDb({url,phase4Keys:keys,runtimeProfile});opened.push(db);return db;}};
}

for(const version of [33,35])test(`explicit trusted transition profile admits complete actual SQLite${version} read-only`,async t=>{
 const f=await fixture(t,version),env=environment(),runtimeProfile=createSchemaTransitionRuntimeProfile({environment:env,keys}),db=f.open(runtimeProfile);
 const execute=db.raw.execute,queries=[];db.raw.execute=async statement=>{queries.push(typeof statement==='string'?statement:statement.sql);return execute(statement);};
 const capability=await db.admitRuntime();assert.equal(db.requireRuntimeAdmission(capability),version);
 assert.equal(await db.admitRuntime(),capability);assert.equal(queries.length,5);
 assert.ok(queries.every(sql=>/^SELECT\b|^PRAGMA foreign_keys\b/.test(sql)));
 assert.equal(env.STAGE7_AUTOMATIC,'on');assert.equal(env.STAGE7_COMPANION,'on');
 assert.equal(executionProfile(env),SCHEMA_TRANSITION_PROFILE);
 const proof=configurationProof(keys,publicBetaConfiguration(env),env,releaseSha);
 assert.match(proof,/^[a-f0-9]{64}$/);assert.equal(proof,configurationProof(keys,publicBetaConfiguration(env),env,releaseSha));
 if(version===35){const normal=f.open();assert.equal(normal.requireRuntimeAdmission(await normal.admitRuntime()),35);}
});

test('normal runtime and request-shaped admission options cannot admit33; copies and cross-connection policy reuse refuse',async t=>{
 const f=await fixture(t),normal=f.open();
 await assert.rejects(normal.admitRuntime(),/CONTROLLED_MIGRATION_REQUIRED/);
 await assert.rejects(normal.admitRuntime({runtimeProfile:{allow33:true},minimumVersion:33}),/CONTROLLED_MIGRATION_REQUIRED/);
 assert.equal(schemaTransitionRuntimeProfileFor({environment:{PHASE4_EXECUTION_PROFILE:'PHASE4'},keys}),undefined);
 assert.throws(()=>f.open({}),/TRUSTED_PROFILE_REQUIRED/);
 const profile=createSchemaTransitionRuntimeProfile({environment:environment(),keys}),db=f.open(profile);
 assert.equal(db.requireRuntimeAdmission(await db.admitRuntime()),33);
 for(const copy of [{...profile},JSON.parse(JSON.stringify(profile))])assert.throws(()=>f.open(copy),/TRUSTED_PROFILE_REQUIRED/);
 assert.throws(()=>f.open(profile),/CONNECTION_PROFILE_CHANGED/);
 const wrong=createPhase4Keys({lookupKey:Buffer.alloc(32,91),auditKey:Buffer.alloc(32,92)});
 assert.throws(()=>requireSchemaTransitionRuntimeProfile(profile,wrong),/TRUSTED_PROFILE_REQUIRED/);
 assert.equal(db.requireRuntimeAdmission(await db.admitRuntime()),33,'failed rebind does not replace the original client policy');
});

test('renewal keeps the same trusted policy, revokes old capabilities and rechecks current OFF configuration',async t=>{
 const f=await fixture(t),env=environment(),db=f.open(createSchemaTransitionRuntimeProfile({environment:env,keys})),first=await db.admitRuntime();
 replaceObservedRuntimeLifetime(db.raw);assert.throws(()=>db.requireRuntimeAdmission(first),/ADMISSION_REQUIRED/);
 const next=await renewRuntimeAfterContention(db.raw,keys,db.transaction);
 assert.notEqual(next,first);assert.equal(db.requireRuntimeAdmission(next),33);
 env.STAGE8_MORNING_BRIEF='on';
 assert.throws(()=>db.requireRuntimeAdmission(next),/NEW_FEATURES_OFF_REQUIRED/);
 await assert.rejects(renewRuntimeAfterContention(db.raw,keys,db.transaction),/NEW_FEATURES_OFF_REQUIRED/);
 await assert.rejects(db.admitRuntime({fresh:true}),/NEW_FEATURES_OFF_REQUIRED/);
});

test('exact catalog metadata variant remains metadata during caller-owned SQLite re-admission', {timeout:10000},async t=>{
 const f=await fixture(t),base=createClient({url:f.url}),db=composeDb(base,{phase4Keys:keys,
  runtimeProfile:createSchemaTransitionRuntimeProfile({environment:environment(),keys})});t.after(()=>db.close());
 assert.equal(db.requireRuntimeAdmission(await db.admitRuntime()),33);
 assert.equal((await db.raw.execute('SELECT 1 value')).rows[0].value,1);
 assert.equal(db.requireRuntimeAdmission(await db.admitRuntime()),33);
});

test('complete33 metadata, key checkpoints and committed version remain mandatory',async t=>{
 const f=await fixture(t),db=f.open(createSchemaTransitionRuntimeProfile({environment:environment(),keys}));
 await db.raw.execute('CREATE TABLE synthetic_future_object(id INTEGER)');
 await assert.rejects(db.admitRuntime(),/UNEXPECTED_SCHEMA_OBJECT/);await db.raw.execute('DROP TABLE synthetic_future_object');
 await db.raw.execute('CREATE VIEW synthetic_future_view AS SELECT 1 value');
 await assert.rejects(db.admitRuntime(),/UNEXPECTED_SCHEMA_OBJECT/);await db.raw.execute('DROP VIEW synthetic_future_view');
 await db.raw.execute("UPDATE phase4_migration_checkpoints SET last_cursor='SYNTHETIC_CORRUPT' WHERE target_version=22 AND step_key='lookup_key_check'");
 await assert.rejects(db.admitRuntime(),/LOOKUP_KEY_MISMATCH/);
 await db.raw.execute({sql:"UPDATE phase4_migration_checkpoints SET last_cursor=? WHERE target_version=22 AND step_key='lookup_key_check'",args:[keys.lookupCheckpoint()]});
 await db.raw.execute('DROP INDEX uniq_whoop_webhook_event');
 await assert.rejects(db.admitRuntime(),/schema_postcondition_failed/);
});

test('transition rejects committed34 and allows fresh cold35 reconstruction without enabling new features',async t=>{
 const f=await fixture(t,34),db=f.open(createSchemaTransitionRuntimeProfile({environment:environment(),keys}));
 await assert.rejects(db.admitRuntime(),/COMMITTED_VERSION_REQUIRED/);
 db.close();const normal=f.open();await normal.migrate({targetVersion:35});normal.close();
 const env=environment(),next=f.open(createSchemaTransitionRuntimeProfile({environment:env,keys}));
 assert.equal(next.requireRuntimeAdmission(await next.admitRuntime()),35);
 for(const field of ['PHASE4_STAGE8_RUNTIME','STAGE8_LIVE_ANALYSIS','STAGE8_MORNING_BRIEF','PHASE4_DELIVERY_CUTOVER','BODY_ENERGY_PUBLICATION','BODY_ENERGY_ALERTS','PHASE4_BETA_SHADOW_RUNTIME']){
  const bad={...env,[field]:'on'};
  assert.throws(()=>createSchemaTransitionRuntimeProfile({environment:bad,keys}),/NEW_FEATURES_OFF_REQUIRED/);
  assert.throws(()=>executionProfile(bad),/NEW_FEATURES_OFF_REQUIRED/);
  assert.throws(()=>stage8Configuration(bad),/NEW_FEATURES_OFF_REQUIRED/);
  assert.throws(()=>bodyEnergyConfiguration(bad),/NEW_FEATURES_OFF_REQUIRED/);
  assert.throws(()=>configurationProof(keys,publicBetaConfiguration(env),bad,releaseSha),/NEW_FEATURES_OFF_REQUIRED/);
 }
});

test('transition identity requires the actual checkout and its policy proof is independent of schema',()=>{
 const env=environment();
 assert.throws(()=>createSchemaTransitionRuntimeProfile({environment:{...env,PHASE4_RELEASE_SHA:'a'.repeat(40)},keys}),/CHECKOUT_MISMATCH/);
 const transition=configurationProof(keys,publicBetaConfiguration(env),env,releaseSha);
 const ordinary=configurationProof(keys,publicBetaConfiguration(env),{...env,PHASE4_EXECUTION_PROFILE:'PHASE4'},releaseSha);
 assert.notEqual(transition,ordinary);
 assert.equal(transition,configurationProof(keys,publicBetaConfiguration(env),{...env},releaseSha));
});
