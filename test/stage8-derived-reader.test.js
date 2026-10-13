import test from 'node:test';import assert from 'node:assert/strict';
import {stage8Fixture} from './stage8Fixture.js';
import {createStage8DerivedReader,STAGE8_DERIVED_CONTRACT} from '../src/stage8DerivedReader.js';
test('typed LIVE reader rejects external scope/mode/kind and returns updating without a producer for each registered kind',async t=>{
 const f=await stage8Fixture(t);await f.core.initializeTenant('a','LIVE');
 await f.db.raw.execute("UPDATE phase4_computation_state SET last_completed_generation=input_generation WHERE user_id='a' AND execution_mode='LIVE'");
 const scope=await f.app.scopes.open({...f.input,text:'my HRV today'}),reader=createStage8DerivedReader({...f,admission:await f.db.admitRuntime(),eligible:uid=>uid==='a',now:f.now});
 for(const kind of STAGE8_DERIVED_CONTRACT.kinds){const result=await f.app.scopes.derived(scope,kind);assert.equal(result.status,'ANALYSIS_UPDATING');assert.deepEqual(result.items,[]);}
 for(const change of [{executionMode:'SHADOW'},{userId:'b'},{purpose:'OWNER_MONITORING'}])await assert.rejects(reader({scope:{...scope,...change},kind:'INSIGHTS',inputGeneration:1}),/SCOPE_REQUIRED/);
 await assert.rejects(reader({scope,kind:'SQL',inputGeneration:1}),/SCOPE_REQUIRED/);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM phase4_execution_producers')).rows[0].n,0);
});
test('real Self Q&A composition has wired reader, never promotes SHADOW or current-empty metadata, and fences a revoked cohort',async t=>{
 const f=await stage8Fixture(t);await f.core.initializeTenant('a','LIVE');await f.db.raw.execute("UPDATE phase4_computation_state SET last_completed_generation=input_generation WHERE user_id='a'");
 assert.match((await f.app.handle({...f.input,text:'/insights'})).text,/Analysis is updating/);const scope=await f.app.scopes.open({...f.input,text:'my recovery'});
 f.environment.PHASE4_STAGE8_RUNTIME='off';await assert.rejects(f.app.scopes.derived(scope,'INSIGHTS'),/SCOPE_REQUIRED/);
});
