import test from 'node:test';
import assert from 'node:assert/strict';
import {stage8Fixture} from './stage8Fixture.js';
import {authorizeStage6ShadowWorker,createPhase4Stage6} from '../src/phase4Reanalysis.js';
import {createStage8DerivedReader} from '../src/stage8DerivedReader.js';

test('frozen v34 execution allocation cannot be minted as LIVE by request/configuration flags',async t=>{
 const f=await stage8Fixture(t),at=Date.now(),request={requestId:'synthetic-live-contract-probe',phase:'SYNC',releaseSha:'a'.repeat(40),executionMode:'LIVE',triggerSource:'manual',configProof:'b'.repeat(64)};
 await assert.rejects(f.db.raw.execute({sql:`INSERT INTO phase4_executions(execution_id,identity_digest,scope_key,canonical_request_json,phase,release_sha,execution_mode,trigger_source,config_proof,owner,generation,lease_until,deadline_at,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,1,?,?,'ESTABLISHED',?,?)`,args:[request.requestId,'c'.repeat(64),'d'.repeat(64),JSON.stringify(request),request.phase,request.releaseSha,request.executionMode,request.triggerSource,request.configProof,'synthetic',at+45000,at+30000,at,at]}),/CHECK constraint failed.*execution_mode/s);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM phase4_executions')).rows[0].n,0);
});

test('SHADOW worker authority cannot authorize LIVE calculation',async()=>{
 assert.throws(()=>authorizeStage6ShadowWorker({executionMode:'LIVE'}),/PHASE4_STAGE6_SHADOW_REQUIRED/);
 const workerCapability=authorizeStage6ShadowWorker({executionMode:'SHADOW'});
 await assert.rejects(createPhase4Stage6({executionMode:'LIVE',workerCapability}),/PHASE4_STAGE6_SHADOW_REQUIRED/);
});

test('fake LIVE completion and current-empty metadata cannot replace finalized producer proof',async t=>{
 const f=await stage8Fixture(t);await f.core.initializeTenant('a','LIVE');
 await f.db.raw.execute("UPDATE phase4_computation_state SET last_completed_generation=input_generation WHERE user_id='a' AND execution_mode='LIVE'");
 const admission=await f.db.admitRuntime(),reader=createStage8DerivedReader({...f,admission,eligible:id=>id==='a'}),scope={permitted:true,purpose:'SELF_QA',executionMode:'LIVE',userId:'a',asOfUtc:f.now().toISOString()};
 const before=await f.db.getUser('b');
 for(const kind of ['BODY_ENERGY','INSIGHTS','EPISODES','EVIDENCE'])assert.deepEqual(await reader({scope,kind,inputGeneration:1}),{status:'ANALYSIS_UPDATING',kind,asOfUtc:scope.asOfUtc,items:[]});
 assert.deepEqual(await f.db.getUser('b'),before);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM phase4_execution_producers')).rows[0].n,0);
});
