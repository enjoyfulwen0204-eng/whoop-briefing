import test from 'node:test';import assert from 'node:assert/strict';
import {syntheticPhase4Fixture} from './phase4Fixture.js';
import {requireRuntimeAdmission,renewRuntimeAfterContention} from '../src/runtimeAdmission.js';
import {authorizeStage8LiveProducer,liveProducerConfiguration,isLiveExecution,registerLiveExecution,liveScopeDigest} from '../src/stage8LiveProducerAuthority.js';
import {LIVE_TABLES} from '../src/stage8LiveAllocation.js';

test('LIVE allocation is opt-in and preserves every frozen v34 definition',async t=>{
 const f=await syntheticPhase4Fixture(t,{targetVersion:34}),before=(await f.db.raw.execute("SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name")).rows;
 const old=await f.db.admitRuntime();assert.equal(requireRuntimeAdmission(f.db.raw,old,f.keys,f.db.transaction),34);
 await f.db.migrate({targetVersion:35});const admission=await f.db.freshRuntimeAdmission();
 assert.equal(requireRuntimeAdmission(f.db.raw,admission,f.keys,f.db.transaction),35);
 for(const row of before){const after=(await f.db.raw.execute({sql:'SELECT sql FROM sqlite_master WHERE name=?',args:[row.name]})).rows[0];assert.equal(after.sql,row.sql,row.name);}
 for(const table of Object.values(LIVE_TABLES))assert.equal((await f.db.raw.execute(`SELECT count(*) n FROM ${table}`)).rows[0].n,0);
 assert.match((await f.db.raw.execute("SELECT sql FROM sqlite_master WHERE name='phase4_execution_producers'")).rows[0].sql,/execution_mode='SHADOW'/);
 assert.match((await f.db.raw.execute("SELECT sql FROM sqlite_master WHERE name='stage8_live_execution_producers'")).rows[0].sql,/execution_mode='LIVE'/);
 assert.equal((await f.db.raw.execute('PRAGMA foreign_key_check')).rows.length,0);
});

test('producing capability rejects v34, JSON, read identity, peer user and policy revocation',async t=>{
 const f=await syntheticPhase4Fixture(t,{targetVersion:34});let enabled=true;const options={...f,admission:await f.db.admitRuntime(),releaseSha:'a'.repeat(40),configProof:'b'.repeat(64),enabled:()=>enabled,eligible:id=>id==='a'};
 await assert.rejects(authorizeStage8LiveProducer(options),/PRODUCING_AUTHORITY/);
 await f.db.migrate({targetVersion:35});options.admission=await f.db.freshRuntimeAdmission();
 const context={userId:'a',executionMode:'LIVE',inputGeneration:1,sourceGeneration:0,lifecycleGeneration:1,authGeneration:0,purgeGeneration:0,algorithmSetVersion:'synthetic',timezone:'UTC'},grant=await authorizeStage8LiveProducer(options),request=Object.freeze({tenantScope:liveScopeDigest(f.keys,context),requestId:'synthetic-execution',executionMode:'LIVE',phase:'STAGE6_DRAIN',contract:'stage8-live-producer-v1',releaseSha:options.releaseSha,configProof:options.configProof}),execution={claim:Object.freeze({request,executionId:request.requestId,generation:1,owner:'synthetic'}),authority:{assert(){}}};
 assert.equal(Object.isFrozen(liveProducerConfiguration(grant,f.db.raw,f.keys,'a')),true);
 assert.throws(()=>registerLiveExecution(grant,{},f.db.raw,f.keys,'a'),/PRODUCING_AUTHORITY/);
 assert.throws(()=>liveProducerConfiguration({},f.db.raw,f.keys,'a'),/PRODUCING_AUTHORITY/);
 assert.throws(()=>liveProducerConfiguration(grant,{},f.keys,'a'),/PRODUCING_AUTHORITY/);
 assert.throws(()=>registerLiveExecution(grant,execution,f.db.raw,f.keys,'b'),/PRODUCING_AUTHORITY/);
 registerLiveExecution(grant,execution,f.db.raw,f.keys,'a',context);assert.equal(isLiveExecution(execution,f.db.raw,f.keys,'a'),true);
 assert.equal(isLiveExecution({...execution},f.db.raw,f.keys,'a'),false);assert.equal(isLiveExecution(execution,f.db.raw,f.keys,'b'),false);
 await renewRuntimeAfterContention(f.db.raw,f.keys,f.db.transaction);assert.equal(isLiveExecution(execution,f.db.raw,f.keys,'a'),true);
 enabled=false;assert.equal(isLiveExecution(execution,f.db.raw,f.keys,'a'),false);
});

test('v35 admission rejects missing and altered allocation objects, and resumes an interrupted additive migration',async t=>{
 const f=await syntheticPhase4Fixture(t,{targetVersion:34});
 const {buildV35}=await import('../src/phase4V35Schema.js');
 // A crash after the first CREATE does not grant runtime35 or alter v34.
 await f.db.raw.execute(buildV35().ddl[0]);
 assert.equal(requireRuntimeAdmission(f.db.raw,await f.db.freshRuntimeAdmission(),f.keys,f.db.transaction),34);
 await f.db.migrate({targetVersion:35});await f.db.freshRuntimeAdmission();
 await f.db.migrate({targetVersion:35});
 const trigger='stage8_live_p4_execution_receipt_owner',ddl=(await f.db.raw.execute({sql:'SELECT sql FROM sqlite_master WHERE name=?',args:[trigger]})).rows[0].sql;
 await f.db.transaction(async()=>{
  await f.db.raw.execute(`DROP TRIGGER ${trigger}`);await assert.rejects(f.db.freshRuntimeAdmission(),/postcondition/);
  await f.db.raw.execute(ddl.replace('BEFORE INSERT','BEFORE UPDATE'));await assert.rejects(f.db.freshRuntimeAdmission(),/postcondition/);
  await f.db.raw.execute(`DROP TRIGGER ${trigger}`);await f.db.raw.execute(ddl);await f.db.freshRuntimeAdmission();
 });
});
