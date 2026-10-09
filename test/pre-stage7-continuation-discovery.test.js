import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {deliveryFixture,fixtureKeys,openHttpFixture} from './deliveryDefaultFixture.js';
import {discoverPhaseContinuation} from '../src/phase4Continuation.js';
import {canonicalPhaseRequest,configurationProof,claimPhaseRequest,readExecution} from '../src/phase4ExecutionStore.js';
import {runningReleaseSha} from '../src/phase4Release.js';import {runExecutionPhase} from '../src/phase4Execution.js';
import {createBriefingEndpoint} from '../src/briefingEndpoint.js';import {signTriggerRequest} from '../src/briefingTriggerAuth.js';
import {readOnlyStatement} from '../src/processingTransaction.js';
const environment={PHASE4_BETA_SHADOW_RUNTIME:'on',PHASE4_PUBLIC_BETA_MODE:'off'};
const query=()=>({releaseSha:runningReleaseSha(),triggerSource:'cloudflare',executionMode:'SHADOW',configProof:configurationProof(fixtureKeys,{runtime:'on',mode:'off'},environment)});
const request=q=>({...q,requestId:randomUUID(),phase:'SYNC'});
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
test('discovery cannot replace older noncanonical transport bytes with a new receipt identity',async t=>{
 const {db}=await deliveryFixture(t),q=query(),r=request(q);
 await claimPhaseRequest(db,r,JSON.stringify(r));const before=await readExecution(db,r.requestId);
 await assert.rejects(()=>discover(db,q),/CONTINUATION_TRANSPORT_IDENTITY_UNAVAILABLE/);
 assert.deepEqual(await readExecution(db,r.requestId),before);
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
 const child={...q,requestId:randomUUID(),phase:'STAGE6_DRAIN',syncRequestId:r.requestId,handoff:replay.body.handoff};
 const drained=await run(child,canonicalPhaseRequest(child),{runtime:{phase4Stage6:{drain:async()=>({outcome:'NO_WORK',jobsConsidered:0,itemsAttempted:0,processedItems:0,completedJobs:0,remainingJobs:0,completion:'COMPLETE'})}}});
 assert.equal(drained.status,200);assert.equal((await discover(db,q)).body.state,'NONE');
});
test('two HTTP dispatchers elect one unfinished identity; expiry alone cannot start a conflicting request',async t=>{
 const {db,url}=await deliveryFixture(t),other=openHttpFixture(url);t.after(()=>other.close());
 const q=query(),a=request(q),b=request(q);
 const attempts=await Promise.allSettled([claimPhaseRequest(db,a,canonicalPhaseRequest(a)),claimPhaseRequest(other.db,b,canonicalPhaseRequest(b))]);
 assert.equal(attempts.filter(r=>r.status==='fulfilled').length,1);assert.equal(attempts.find(r=>r.status==='rejected').reason.code,'REQUEST_SCOPE_PENDING');
 const winner=attempts[0].status==='fulfilled'?a:b,loser=winner===a?b:a;
 assert.equal((await discover(db,q)).body.requestBody,canonicalPhaseRequest(winner));
 await db.raw.execute({sql:'UPDATE phase4_executions SET deadline_at=?,lease_until=? WHERE execution_id=?',args:[Date.now()-1,Date.now()-1,winner.requestId]});
 await assert.rejects(()=>claimPhaseRequest(db,loser,canonicalPhaseRequest(loser)),/REQUEST_SCOPE_PENDING/);
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
