import test from 'node:test';import assert from 'node:assert/strict';
import {setup,request as metricRequest,T} from './stage5HistoryFixture.js';import {call} from './stage5ClosureFixture.js';
import {request,claim,authority,fixtureKeys} from './v32ReviewFixture.js';
import {commitPhaseWork,finalizePhaseWork,readExecution} from '../src/phase4ExecutionStore.js';
import {withDurableExecution,bindProducingExecution} from '../src/phase4ExecutionContext.js';
import {createPublicBetaPresentation,publicBetaPolicy,authorizePublicBetaRuntime} from '../src/publicBeta.js';
import {bodyInput,seedBodyInput} from './bodyEnergyFixture.js';
async function drainClaim(db){const sync=request(),sc=await claim(db,sync);await commitPhaseWork(db,sync,sc,{outcome:'NO_NEW_DATA_SUCCESS'},authority);
 const completed=await finalizePhaseWork(db,sync,sc,fixtureKeys,authority),r=request({phase:'STAGE6_DRAIN',syncRequestId:sync.requestId,handoff:completed.handoff});return {r,c:await claim(db,r)};}
async function bind(f,execution,userId='a'){
 return withDurableExecution({claim:execution.c,keys:fixtureKeys,pending:new Set(),authority},()=>f.stores.withContext(userId,{executionMode:'SHADOW'},ctx=>f.db.transaction(async()=>{
  await bindProducingExecution(f.db.raw,ctx);await f.db.raw.execute({sql:"UPDATE phase4_computation_state SET last_completed_generation=input_generation WHERE user_id=? AND execution_mode='SHADOW'",args:[userId]});
 })));
}
const typed=f=>f.stores.withContext('a',{executionMode:'SHADOW'},ctx=>f.stores.betaSummary.readCurrent(ctx,{asOfUtc:new Date(T).toISOString()}));
test('producer unfinalized + unrelated NO_WORK stays withheld; reconciliation unlocks zh-TW/en/vi only for its user',async t=>{
 const f=await setup(t,{targetVersion:30});await f.db.migrate({targetVersion:32});const e=await drainClaim(f.db);
 await withDurableExecution({claim:e.c,keys:fixtureKeys,pending:new Set(),authority},()=>call(f,'intelligence','analyzeMetric',{...metricRequest(f.initialRefs[0],f.initialRefs.slice(1),new Date(T).toISOString()),windowFamily:'FINALIZED_PRODUCER'}));
 await bind(f,e);await commitPhaseWork(f.db,e.r,e.c,{outcome:'COMPLETE'},authority);assert.equal((await typed(f)).episodes.length,0);
 const noop=await drainClaim(f.db);await commitPhaseWork(f.db,noop.r,noop.c,{outcome:'NO_WORK'},authority);await finalizePhaseWork(f.db,noop.r,noop.c,fixtureKeys,authority);
 assert.equal((await typed(f)).episodes.length,0,'unrelated finalized NO_WORK cannot launder the producer');
 await finalizePhaseWork(f.db,e.r,e.c,fixtureKeys,authority);assert.ok((await typed(f)).episodes.length>0);
 const presentation=createPublicBetaPresentation({db:f.db,stores:f.stores,policy:publicBetaPolicy({mode:'all'}),runtimeCapability:authorizePublicBetaRuntime({executionMode:'SHADOW'})});
 await f.db.raw.execute("UPDATE users SET display_name='Ada' WHERE id='a'");
 for(const locale of ['zh-TW','en','vi']){await f.db.setLocale('a',locale);const text=await presentation.summary({userId:'a',now:new Date(T)});assert.ok(text);assert.match(text,/Ada/);assert.doesNotMatch(text,/Kelvin|Body Energy|身體能量/);
  await f.db.setLocale('b',locale);assert.equal(await presentation.summary({userId:'b',now:new Date(T)}),null);}
 const row=(await f.db.raw.execute("SELECT * FROM phase4_execution_producers WHERE user_id='a'")).rows[0];
 await assert.rejects(()=>f.db.raw.execute({sql:'UPDATE phase4_execution_producers SET producing_execution_id=? WHERE user_id=?',args:[noop.r.syncRequestId,'a']}));
 await f.db.raw.execute({sql:`INSERT INTO phase4_execution_producers(user_id,execution_mode,input_generation,producing_execution_id,producing_generation,execution_seq,tenant_proof)
  VALUES('b','SHADOW',?,?,?,?,?)`,args:[row.input_generation,row.producing_execution_id,row.producing_generation,row.execution_seq,row.tenant_proof]}).then(()=>assert.fail('terminal producer insertion must reject'),()=>{});
});
test('newer pending producer remains withheld even when older success finalizes later; failed contributor stays withheld',async t=>{
 const f=await setup(t,{targetVersion:30});await f.db.migrate({targetVersion:32});const older=await drainClaim(f.db);
 await withDurableExecution({claim:older.c,keys:fixtureKeys,pending:new Set(),authority},()=>call(f,'intelligence','analyzeMetric',{...metricRequest(f.initialRefs[0],f.initialRefs.slice(1),new Date(T).toISOString()),windowFamily:'PENDING_NEWER_PRODUCER'}));
 await bind(f,older);await commitPhaseWork(f.db,older.r,older.c,{outcome:'COMPLETE'},authority);
 const newer=await drainClaim(f.db);await bind(f,newer);await finalizePhaseWork(f.db,older.r,older.c,fixtureKeys,authority);
 assert.ok((await readExecution(f.db,newer.r.requestId)).execution_seq>(await readExecution(f.db,older.r.requestId)).execution_seq);
 assert.equal((await typed(f)).episodes.length,0);
 await commitPhaseWork(f.db,newer.r,newer.c,{outcome:'FAILED'},authority);await finalizePhaseWork(f.db,newer.r,newer.c,fixtureKeys,authority);
 assert.equal((await typed(f)).episodes.length,0,'a finalized failure does not authorize presentation');
});
test('a cross-user producer proof with otherwise valid finalized execution and own healthy artifacts is withheld',async t=>{
 const f=await setup(t,{targetVersion:30}),input=bodyInput({asOf:T,days:30});
 const rebind=value=>{if(Array.isArray(value))return value.map(rebind);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,['userId','user_id'].includes(k)?'b':rebind(v)]));return value;};
 const bInput=rebind(input);for(let i=0;i<bInput.sources.recovery.length;i++)bInput.sources.recovery[i].recovery_score=i?[40,45,50,55,60][(i-1)%5]:15;
 await f.db.transaction(()=>seedBodyInput(f.db,bInput));await f.db.migrate({targetVersion:32});const e=await drainClaim(f.db);
 await withDurableExecution({claim:e.c,keys:fixtureKeys,pending:new Set(),authority},async()=>{
  await call(f,'intelligence','analyzeMetric',{...metricRequest(f.initialRefs[0],f.initialRefs.slice(1),new Date(T).toISOString()),windowFamily:'CROSS_USER_PRODUCER_A'});
  await f.stores.withContext('b',{executionMode:'SHADOW'},async ctx=>{const refs=[];for(const source of bInput.sources.recovery)refs.push((await f.stores.root(ctx,'recovery',source.sleep_id)).ref);
   const result=await f.stores.intelligence.analyzeMetric(ctx,{...metricRequest(refs[0],refs.slice(1),new Date(T).toISOString()),windowFamily:'CROSS_USER_PRODUCER_B'});assert.ok(result.episode);
  });
 });
 await bind(f,e);const a=(await f.db.raw.execute("SELECT * FROM phase4_execution_producers WHERE user_id='a'")).rows[0];
 const bGeneration=(await f.db.raw.execute("SELECT input_generation FROM phase4_computation_state WHERE user_id='b' AND execution_mode='SHADOW'")).rows[0].input_generation;
 await f.db.raw.execute({sql:`INSERT INTO phase4_execution_producers(user_id,execution_mode,input_generation,producing_execution_id,producing_generation,execution_seq,tenant_proof)
  VALUES('b','SHADOW',?,?,?,?,?)`,args:[bGeneration,a.producing_execution_id,a.producing_generation,a.execution_seq,a.tenant_proof]});
 await f.db.raw.execute("UPDATE phase4_computation_state SET last_completed_generation=input_generation WHERE user_id='b' AND execution_mode='SHADOW'");
 await commitPhaseWork(f.db,e.r,e.c,{outcome:'COMPLETE'},authority);await finalizePhaseWork(f.db,e.r,e.c,fixtureKeys,authority);
 assert.ok((await typed(f)).episodes.length>0);
 const b=await f.stores.withContext('b',{executionMode:'SHADOW'},ctx=>f.stores.betaSummary.readCurrent(ctx,{asOfUtc:new Date(T).toISOString()}));assert.equal(b.episodes.length,0);
 assert.ok((await f.db.raw.execute("SELECT count(*) AS n FROM observation_episodes WHERE user_id='b'")).rows[0].n>0,'withholding must be authority-driven, not absence of own data');
});
