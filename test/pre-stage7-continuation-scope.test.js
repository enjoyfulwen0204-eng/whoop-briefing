import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createDb,fixtureKeys} from './localDb.js';
import {runExecutionPhase,discoverExecutionContinuation} from '../src/phase4Execution.js';
import {discoverPhaseContinuation} from '../src/phase4Continuation.js';
import {configurationProof,canonicalPhaseRequest,claimPhaseRequest,commitPhaseWork,readExecution,EXECUTION_WORK_MAX_AGE_MS} from '../src/phase4ExecutionStore.js';
import {createExecutionBudget} from '../src/executionBudget.js';import {runningReleaseSha} from '../src/phase4Release.js';
import {OWNER_PILOT_APPROVAL_SHA256} from '../src/betaPilotAllowance.js';
import {publicBetaConfiguration} from '../src/publicBetaConfig.js';
const environment=(start=Date.now()-1000)=>({PHASE4_BETA_SHADOW_RUNTIME:'on',PHASE4_PUBLIC_BETA_MODE:'off',BRIEFING_CONTINUATION_SCOPE:'stage6-shadow',
 PHASE4_BETA_PILOT_ID:'a'.repeat(64),PHASE4_BETA_PILOT_USER_ID:'pilot-user',PHASE4_BETA_PILOT_START_AT:new Date(start).toISOString(),
 PHASE4_BETA_PILOT_CONSENT_SHA256:'b'.repeat(64),PHASE4_BETA_PILOT_ALLOWANCE_ID:OWNER_PILOT_APPROVAL_SHA256,PHASE4_BETA_PILOT_STOP:'off'});
const query=env=>({releaseSha:runningReleaseSha(),executionMode:'SHADOW',triggerSource:'cloudflare',scope:'stage6-shadow',configProof:configurationProof(fixtureKeys,publicBetaConfiguration(env),env)});
const request=(env,extra={})=>{const {scope,...q}=query(env);return {...q,phase:'SYNC',requestId:randomUUID(),...extra};};
const success=()=>({syncComplete:true,syncOutcome:'NO_NEW_DATA_SUCCESS'});
async function fixture(t){const dir=await mkdtemp(join(tmpdir(),'continuation-scope-')),db=createDb({url:'file:'+join(dir,'fixture.db')});t.after(async()=>{db.close();await rm(dir,{recursive:true,force:true});});await db.migrate();await db.admitRuntime();
 for(const id of ['pilot-user','foreign-user']){await db.createUser({id,status:'ACTIVE',displayName:'Before'});await db.ensureOnboarding(id);await db.raw.execute({sql:"UPDATE user_onboarding SET state='READY' WHERE user_id=?",args:[id]});}return db;}
const run=(db,env,r,deps={})=>runExecutionPhase({db,environment:env,keys:fixtureKeys,request:r,body:canonicalPhaseRequest(r),now:new Date('2026-10-11T00:30:00Z'),env:{dryRun:true},deps});
const discover=(db,env)=>discoverExecutionContinuation({db,environment:env,keys:fixtureKeys,query:query(env)});
async function parentChild(db,env){const parent=request(env),sync=await run(db,env,parent,{runBriefing:success});assert.equal(sync.body.drainAuthorized,true);return {parent,child:request(env,{phase:'STAGE6_DRAIN',requestId:`p4c1_${randomUUID()}`,syncRequestId:parent.requestId,handoff:sync.body.handoff})};}
const complete={outcome:'NO_WORK',jobsConsidered:0,itemsAttempted:0,processedItems:0,completedJobs:0,remainingJobs:0,completion:'COMPLETE'};
test('scope changes authenticated proof while absent/off preserves legacy OFF and ordinary profile',()=>{
 const legacy={PHASE4_BETA_SHADOW_RUNTIME:'off',PHASE4_PUBLIC_BETA_MODE:'off'},proof=configurationProof(fixtureKeys,publicBetaConfiguration(legacy),legacy);
 assert.equal(configurationProof(fixtureKeys,publicBetaConfiguration(legacy),{...legacy,BRIEFING_CONTINUATION_SCOPE:'off'}),proof);
 assert.throws(()=>configurationProof(fixtureKeys,publicBetaConfiguration(legacy),{...legacy,BRIEFING_CONTINUATION_SCOPE:'stage6-shadow'}),/CONTINUATION_SCOPE_REJECTED/);
 const env=environment(),{BRIEFING_CONTINUATION_SCOPE,...ordinary}=env;assert.notEqual(query(env).configProof,configurationProof(fixtureKeys,publicBetaConfiguration(ordinary),ordinary));
});
test('Render missing or malformed scope rejects before database admission; query scope is authenticated',async()=>{
 const env=environment();let admissions=0;const db={raw:{protocol:'http'},admitRuntime:()=>{admissions++;throw Error('DB_FORBIDDEN');}};
 for(const scope of [undefined,'off','incorrect'])await assert.rejects(()=>discoverExecutionContinuation({db,keys:fixtureKeys,environment:{...env,BRIEFING_CONTINUATION_SCOPE:scope},query:query(env)}),/CONTINUATION_SCOPE_REJECTED/);
 await assert.rejects(()=>discoverExecutionContinuation({db,keys:fixtureKeys,environment:env,query:{...query(env),scope:'incorrect'}}),/CONTINUATION_QUERY_INVALID/);assert.equal(admissions,0);
});
test('Render never discovers unfinished ordinary SYNC, acknowledged work or partially failed SYNC; new versioned SYNC is rejected',async t=>{
 const db=await fixture(t),env=environment(),ordinary=request(env),body=canonicalPhaseRequest(ordinary),claim=await claimPhaseRequest(db,ordinary,body);
 assert.equal((await discover(db,env)).body.state,'NONE');const budget=createExecutionBudget({budgetMs:5000});try{await commitPhaseWork(db,ordinary,claim,{outcome:'PARTIAL'},budget);}finally{budget.close();}
 assert.equal((await discover(db,env)).body.state,'NONE');let work=0;
 await assert.rejects(()=>run(db,env,request(env,{requestId:`p4c1_${randomUUID()}`}),{runBriefing:async()=>{work++;return success();}}),/CONTINUATION_SCOPE_REJECTED/);assert.equal(work,0);
 const partial=await run(db,env,request(env),{runBriefing:async()=>({syncComplete:false,syncOutcome:'PARTIAL'})});assert.equal(partial.body.drainAuthorized,false);
 const q=query(env),raw=await discoverPhaseContinuation({db,keys:fixtureKeys,query:q,releaseSha:q.releaseSha,mode:'SHADOW',configProof:q.configProof,scope:q.scope});assert.equal(raw.body.state,'NONE');
});
test('exact successful unversioned parent replays immutably and scoped DRAIN resumes same age and consenting user only',async t=>{
 const db=await fixture(t),env=environment(),{parent,child}=await parentChild(db,env);assert.equal((await discover(db,env)).body.requestBody,canonicalPhaseRequest(parent));
 await run(db,env,parent,{runBriefing:()=>{throw Error('PARENT_BUSINESS_REPLAY_FORBIDDEN');}});
 const calls=[],runtime={phase4Stage6:{drain:async input=>{calls.push(input.userId);throw Object.assign(Error('synthetic-timeout'),{code:'SYNC_TIMEOUT'});}}};
 const first=await run(db,env,child,{runtime});assert.equal(first.body.result.resumable,true);const initial=await readExecution(db,child.requestId);
 assert.equal((await discover(db,env)).body.requestBody,canonicalPhaseRequest(child));
 const final=await run(db,env,child,{runBriefing:()=>{throw Error('MORNING_FORBIDDEN');},runtime:{phase4Stage6:{drain:async input=>{calls.push(input.userId);return complete;}}}});
 assert.equal(final.status,200);const settled=await readExecution(db,child.requestId);assert.equal(settled.created_at,initial.created_at);assert.equal(settled.generation,2);assert.ok(settled.deadline_at<=settled.created_at+EXECUTION_WORK_MAX_AGE_MS);
 assert.deepEqual(calls,['pilot-user','pilot-user']);assert.equal((await db.getUser('foreign-user')).displayName,'Before');assert.equal((await discover(db,env)).body.state,'NONE');
});
test('900 seconds is immutable database context age: stale child cannot execute; old acknowledged commit reconciles metadata only',async t=>{
 const db=await fixture(t),env=environment(),{child}=await parentChild(db,env);
 const agedClaim=async r=>{const original=Date.now,at=original();try{Date.now=()=>at-900100;return await claimPhaseRequest(db,r,canonicalPhaseRequest(r),{deadlineAt:at+120000});}finally{Date.now=original;}};
 await agedClaim(child);await db.raw.execute({sql:'UPDATE phase4_executions SET deadline_at=?,lease_until=? WHERE execution_id=?',args:[Date.now()-1,Date.now()-1,child.requestId]});
 let work=0;await assert.rejects(()=>run(db,env,child,{runtime:{phase4Stage6:{drain:async()=>{work++;return complete;}}}}),/EXECUTION_STALE_REQUEST/);assert.equal(work,0);
 const newer=await parentChild(db,env),committed=await agedClaim(newer.child),budget=createExecutionBudget({budgetMs:5000});
 try{await commitPhaseWork(db,newer.child,committed,complete,budget);}finally{budget.close();}
 const result=await run(db,env,newer.child,{runBriefing:()=>{throw Error('NO_SYNC');},runtime:{phase4Stage6:{drain:async()=>{work++;throw Error('NO_BUSINESS');}}}});assert.equal(result.status,200);assert.equal(work,0);assert.equal((await readExecution(db,newer.child.requestId)).state,'FINALIZED_SUCCESS');
});
test('pilot stop or expiry bypasses optional discovery while ordinary Morning Brief remains operational',async t=>{
 const db=await fixture(t),env=environment();await parentChild(db,env);
 for(const change of [{PHASE4_BETA_PILOT_STOP:'on'},{PHASE4_BETA_PILOT_START_AT:new Date(Date.now()-86400100).toISOString()}]){
  const inactive={...env,...change};assert.equal((await discover(db,inactive)).body.state,'NONE');let briefs=0;
  const result=await run(db,inactive,request(inactive),{runBriefing:async()=>{briefs++;return success();}});assert.equal(briefs,1);assert.equal(result.body.syncComplete,true);assert.equal(result.body.drainAuthorized,false);
 }
});
