import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {deliveryFixture,fixtureKeys,openHttpFixture} from './deliveryDefaultFixture.js';
import {discoverExecutionContinuation as discoverPhaseContinuation} from '../src/phase4Execution.js';
import {canonicalPhaseRequest,configurationProof,claimPhaseRequest,readExecution,commitPhaseWork} from '../src/phase4ExecutionStore.js';
import {runningReleaseSha} from '../src/phase4Release.js';import {runExecutionPhase} from '../src/phase4Execution.js';
import {createBriefingEndpoint} from '../src/briefingEndpoint.js';import {signTriggerRequest} from '../src/briefingTriggerAuth.js';
import {readOnlyStatement} from '../src/processingTransaction.js';
import {withDurableExecution} from '../src/phase4ExecutionContext.js';import {createExecutionBudget} from '../src/executionBudget.js';
const environment={PHASE4_BETA_SHADOW_RUNTIME:'on',PHASE4_PUBLIC_BETA_MODE:'off'};
const query=()=>({releaseSha:runningReleaseSha(),triggerSource:'cloudflare',executionMode:'SHADOW',configProof:configurationProof(fixtureKeys,{runtime:'on',mode:'off'},environment)});
const request=q=>({...q,requestId:`p4c1_${randomUUID()}`,phase:'SYNC'});
const discover=(db,q=query())=>discoverPhaseContinuation({query:q,db,keys:fixtureKeys,environment});
test('a fresh process/connection recovers exact canonical identity through read-only HTTP discovery',async t=>{
 const {db,url}=await deliveryFixture(t),q=query(),r=request(q),body=canonicalPhaseRequest(r);
 assert.equal((await discover(db,q)).body.state,'NONE');
 await claimPhaseRequest(db,r,body,{deadlineAt:Date.now()+120000});const before=await readExecution(db,r.requestId);
 db.close();const reopened=openHttpFixture(url);t.after(()=>reopened.close());
 const result=await discover(reopened.db,q);assert.equal(result.status,200);assert.equal(result.body.state,'IN_PROGRESS');
 assert.equal(result.body.requestBody,body);assert.equal(result.body.workReceipts,0);
 assert.deepEqual(await readExecution(reopened.db,r.requestId),before);
 assert.deepEqual(Object.keys(result.body).sort(),['ok','requestBody','state','workReceipts']);
 assert.doesNotMatch(JSON.stringify(result.body),/owner|generation|tenant|health|token|display_name/i);
});
test('release/config/source substitutions fail before selecting another identity',async t=>{
 const {db}=await deliveryFixture(t),q=query(),r=request(q);await claimPhaseRequest(db,r,canonicalPhaseRequest(r));
 await assert.rejects(()=>discover(db,{...q,releaseSha:'b'.repeat(40)}),/RELEASE_CHECKOUT_MISMATCH/);
 await assert.rejects(()=>discover(db,{...q,configProof:'b'.repeat(64)}),/EXECUTION_CONFIG_CHANGED/);
 await assert.rejects(()=>discover(db,{...q,triggerSource:'github'}),/CONTINUATION_QUERY_INVALID/);
 await assert.rejects(()=>discover(db,{...q,userId:'bob'}),/CONTINUATION_QUERY_INVALID/);
});
test('discovery leaves legacy noncanonical bytes untouched and scope election still fences their live authority',async t=>{
 const {db}=await deliveryFixture(t),q=query(),r=request(q);
 const legacy={...r,requestId:randomUUID()};
 await claimPhaseRequest(db,legacy,JSON.stringify(legacy));const before=await readExecution(db,legacy.requestId);
 assert.equal((await discover(db,q)).body.state,'NONE');
 await assert.rejects(()=>claimPhaseRequest(db,r,canonicalPhaseRequest(r),{serializeScope:true}),/REQUEST_SCOPE_PENDING/);
 assert.deepEqual(await readExecution(db,legacy.requestId),before);
});
test('stale incomplete identities do not authorize work on a new calendar date',async t=>{
 const {db}=await deliveryFixture(t),q=query(),r=request(q),body=canonicalPhaseRequest(r);
 const original=Date.now;
 try{Date.now=()=>original()-900001;await claimPhaseRequest(db,r,body);}finally{Date.now=original;}
 const before=await readExecution(db,r.requestId);assert.equal((await discover(db,q)).body.state,'NONE');assert.deepEqual(await readExecution(db,r.requestId),before);
});
test('death between finalized SYNC and DRAIN recovers the parent; settled DRAIN ends discovery',async t=>{
 const {db}=await deliveryFixture(t),q=query(),r=request(q),body=canonicalPhaseRequest(r);
 const run=(request,body,deps)=>runExecutionPhase({request,body,db,keys:fixtureKeys,environment,env:{dryRun:true},deps});
 const first=await run(r,body,{runBriefing:async()=>({syncComplete:true,syncOutcome:'NO_NEW_DATA_SUCCESS'})});assert.equal(first.status,200);
 assert.equal((await discover(db,q)).body.state,'FINALIZED_SUCCESS');assert.equal((await discover(db,q)).body.requestBody,body);
 const replay=await run(r,body,{runBriefing:async()=>{throw Error('FINALIZED_SYNC_REPLAYED');}});assert.deepEqual(replay,first);
 const child={...q,requestId:`p4c1_${randomUUID()}`,phase:'STAGE6_DRAIN',syncRequestId:r.requestId,handoff:replay.body.handoff};
 const drained=await run(child,canonicalPhaseRequest(child),{runtime:{phase4Stage6:{drain:async()=>({outcome:'NO_WORK',jobsConsidered:0,itemsAttempted:0,processedItems:0,completedJobs:0,remainingJobs:0,completion:'COMPLETE'})}}});
 assert.equal(drained.status,200);assert.equal((await discover(db,q)).body.state,'NONE');
});
test('two HTTP dispatchers elect one unfinished identity; expiry alone cannot start a conflicting request',async t=>{
 const {db,url}=await deliveryFixture(t),other=openHttpFixture(url);t.after(()=>other.close());
 const q=query(),a=request(q),b=request(q);
 const attempts=await Promise.allSettled([claimPhaseRequest(db,a,canonicalPhaseRequest(a),{serializeScope:true}),claimPhaseRequest(other.db,b,canonicalPhaseRequest(b),{serializeScope:true})]);
 assert.equal(attempts.filter(r=>r.status==='fulfilled').length,1);assert.equal(attempts.find(r=>r.status==='rejected').reason.code,'REQUEST_SCOPE_PENDING');
 const winner=attempts[0].status==='fulfilled'?a:b,loser=winner===a?b:a;
 assert.equal((await discover(db,q)).body.requestBody,canonicalPhaseRequest(winner));
 await db.raw.execute({sql:'UPDATE phase4_executions SET deadline_at=?,lease_until=? WHERE execution_id=?',args:[Date.now()-1,Date.now()-1,winner.requestId]});
 await assert.rejects(()=>claimPhaseRequest(db,loser,canonicalPhaseRequest(loser),{serializeScope:true}),/REQUEST_SCOPE_PENDING/);
 const resumed=await claimPhaseRequest(db,winner,canonicalPhaseRequest(winner));assert.equal(resumed.generation,2);
 assert.equal((await db.raw.execute('SELECT count(*) n FROM phase4_executions')).rows[0].n,1);
});
test('discovery endpoint authenticates its own path, validates narrow inputs and issues read-only SQL',async t=>{
 const {db}=await deliveryFixture(t),secret='synthetic-discovery-auth-only-32byte-secret',path='/internal/briefing/continuation';
 let calls=0,queries=0;const execute=db.raw.execute;
 db.raw.execute=statement=>{queries++;assert.equal(readOnlyStatement(statement),true);return execute(statement);};
 const endpoint=createBriefingEndpoint({secret,environment,runPhase:async()=>{throw Error('MUTATIONS_FORBIDDEN');},discoverContinuation:options=>{calls++;return discoverPhaseContinuation({...options,db,keys:fixtureKeys,environment});}});
 const send=(query,signedPath=path)=>{const body=JSON.stringify(query),requestId=randomUUID(),timestamp=String(Date.now());
  return endpoint({method:'POST',url:path,headers:{'content-type':'application/json','x-briefing-request-id':requestId,'x-briefing-timestamp':timestamp,
   'x-briefing-signature':signTriggerRequest({timestamp,requestId,method:'POST',path:signedPath,body},secret)}},body);};
 assert.equal((await send(query(),'/internal/briefing/run')).status,401);assert.equal(calls,0);assert.equal(queries,0);
 assert.equal((await send({...query(),userId:'alice'})).status,400);assert.equal(calls,0);assert.equal(queries,0);
 const accepted=await send(query());assert.equal(accepted.status,200);assert.equal(accepted.body.state,'NONE');assert.equal(calls,1);assert.ok(queries>0);
});
test('receipt-backed DRAIN is discovered directly and reconciles expired-parent PARTIAL without any new business work',async t=>{
 const {db}=await deliveryFixture(t),q=query(),parent=request(q);
 const sync=await runExecutionPhase({request:parent,body:canonicalPhaseRequest(parent),db,keys:fixtureKeys,environment,env:{dryRun:true},deps:{runBriefing:async()=>({syncComplete:true,syncOutcome:'NO_NEW_DATA_SUCCESS'})}});
 const child={...q,phase:'STAGE6_DRAIN',requestId:`p4c1_${randomUUID()}`,syncRequestId:parent.requestId,handoff:sync.body.handoff},body=canonicalPhaseRequest(child);
 const claim=await claimPhaseRequest(db,child,body),authority=createExecutionBudget({budgetMs:5000});
 try{await withDurableExecution({claim,keys:fixtureKeys,pending:new Set(),authority},()=>db.transaction(async()=>{
  await db.raw.execute("INSERT INTO telegram_state(key,value,updated_at) VALUES('drain_progress','1','2026-10-09')");return 1;
 },{workStep:'drain-durable-progress'}));}finally{authority.close();}
 await db.raw.execute({sql:'UPDATE phase4_executions SET lease_until=?,deadline_at=? WHERE execution_id=?',args:[Date.now()-1,Date.now()-1,child.requestId]});
 const found=await discover(db,q);assert.equal(found.body.requestBody,body);assert.equal(found.body.workReceipts,1);
 const original=Date.now;let work=0;
 try{Date.now=()=>original()+20*60000;
  const result=await runExecutionPhase({request:child,body,db,keys:fixtureKeys,environment,env:{dryRun:true},deps:{runBriefing:async()=>{work++;throw Error('MORNING_BRIEF_FORBIDDEN');},runtime:{phase4Stage6:{drain:async()=>{work++;throw Error('NEW_DRAIN_WORK_FORBIDDEN');}}}}});
  assert.equal(result.status,200);assert.equal(result.body.result.outcome,'PARTIAL');assert.equal(result.body.result.stopReason,'RECONCILIATION_ONLY');
 }finally{Date.now=original;}
 assert.equal(work,0);assert.equal((await db.raw.execute("SELECT value FROM telegram_state WHERE key='drain_progress'")).rows[0].value,'1');
 assert.equal((await discover(db,q)).body.state,'NONE');
});
test('versioned coordination uses only v32 fields and rejects substituted transport bytes',async t=>{
 const {db}=await deliveryFixture(t),r=request(query());
 await assert.rejects(()=>claimPhaseRequest(db,{...r,continuationVersion:1},canonicalPhaseRequest({...r,continuationVersion:1})),/EXECUTION_REQUEST_INVALID/);
 await assert.rejects(()=>claimPhaseRequest(db,{...r,legacyBodyDigest:'a'.repeat(64)},canonicalPhaseRequest({...r,legacyBodyDigest:'a'.repeat(64)})),/EXECUTION_REQUEST_INVALID/);
 await assert.rejects(()=>claimPhaseRequest(db,r,JSON.stringify(r)),/EXECUTION_BODY_MISMATCH/);
 assert.equal((await db.raw.execute('SELECT count(*) n FROM phase4_executions')).rows[0].n,0);
 const claim=await claimPhaseRequest(db,r,canonicalPhaseRequest(r));assert.equal(claim.generation,1);
 assert.equal((await db.raw.execute('SELECT MAX(version) v FROM schema_version')).rows[0].v,32);
});

test('legacy committed or receipt-backed DRAIN cannot starve a versioned pending identity',async t=>{
 const {db}=await deliveryFixture(t),q=query(),legacy={...q,phase:'SYNC',requestId:randomUUID()},body=JSON.stringify(legacy);
 const old=await claimPhaseRequest(db,legacy,body),authority=createExecutionBudget({budgetMs:5000});t.after(()=>authority.close());
 await commitPhaseWork(db,legacy,old,{outcome:'NO_NEW_DATA_SUCCESS'},authority);
 const next=request(q);await claimPhaseRequest(db,next,canonicalPhaseRequest(next),{serializeScope:true});
 assert.equal((await discover(db,q)).body.requestBody,canonicalPhaseRequest(next));
 assert.equal((await readExecution(db,legacy.requestId)).identity_digest,old.identity);
 const parent={...q,phase:'SYNC',requestId:randomUUID()};
 const sync=await runExecutionPhase({request:parent,body:JSON.stringify(parent),db,keys:fixtureKeys,environment,env:{dryRun:true},deps:{runBriefing:async()=>({syncComplete:true,syncOutcome:'NO_NEW_DATA_SUCCESS'})}});
 const child={...q,phase:'STAGE6_DRAIN',requestId:randomUUID(),syncRequestId:parent.requestId,handoff:sync.body.handoff},childBody=JSON.stringify(child);
 const claim=await claimPhaseRequest(db,child,childBody);
 await withDurableExecution({claim,keys:fixtureKeys,pending:new Set(),authority},()=>db.transaction(async()=>{
  await db.raw.execute("INSERT INTO telegram_state(key,value,updated_at) VALUES('legacy_drain_progress','1','2026-10-09')");return 1;
 },{workStep:'legacy-drain-durable-progress'}));
 const before=await readExecution(db,child.requestId);
 assert.equal((await discover(db,q)).body.requestBody,canonicalPhaseRequest(next));
 assert.deepEqual(await readExecution(db,child.requestId),before);
});
