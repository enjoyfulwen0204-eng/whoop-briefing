import test from 'node:test';import assert from 'node:assert/strict';
import {residualFixture,fixtureKeys} from './stage6JournalBoundaryFixture.js';
import {request,claim} from './v32ReviewFixture.js';
import {commitPhaseWork,finalizePhaseWork} from '../src/phase4ExecutionStore.js';
import {withDurableExecution} from '../src/phase4ExecutionContext.js';
import {createExecutionBudget,withExecutionBudget} from '../src/executionBudget.js';
import {isolatedPublicationClient,prepareIsolatedUnit,publishIsolatedUnit} from './stage6ShortTransactionPrototype.mjs';
import {verifyShortProof} from './stage6ShortProof.mjs';
import {createPhase4Stage6,authorizeStage6ShadowWorker} from '../src/phase4Reanalysis.js';
import {syncFor,leg} from './stage6ShortTransactionHarness.mjs';
import {ramScopeCounters} from './stage6RamScopeLifetime.mjs';
test('bounded original algorithm prepares and atomically publishes a genuine source unit',{skip:process.env.SHORT_SIX==='1'},async t=>{
 const f=await residualFixture(t),sync=await syncFor(f);
 for(let n=0;n<60;n++){const r=await leg(f,sync,{prepare:false});assert.equal(r.result.failedJobs,0);if((await f.jobs()).every(j=>j.full_scan_cursor===JSON.stringify(['USER','a']))&&Number((await f.db.raw.execute("SELECT count(*) n FROM phase4_evidence_result_authorities WHERE result_scope='METRIC'")).rows[0].n)>1)break;}
 await f.toHttp();const client=isolatedPublicationClient(f.syntheticFetch);t.after(()=>client.close());f.setLatency(Number(process.env.SHORT_LATENCY_MS??115));f.transport.setTransactionMaxMs(5000);
 for(let unit=1;unit<=2;unit++){
 const before=structuredClone(f.transport.counts),r=await leg(f,sync,{client,profile:true});console.log('SHORT_TRANSACTION '+JSON.stringify({unit,...r,http:f.transport.counts.httpRequests-before.httpRequests,sql:f.transport.counts.sqlStatements-before.sqlStatements}));
 assert.ok(r.result.unitsCommitted||r.result.processedItems||r.result.completedJobs);assert.ok(r.transactionMs<4000);assert.ok(r.workMs<30000);
 if(unit===1){assert.equal(r.counts.domain,2);f.setLatency(0);console.log('SHORT_SIGNED_PROOF '+JSON.stringify(await verifyShortProof(f,{domainOnly:true})));f.setLatency(115);}else{assert.equal(r.result.processedItems,1);assert.ok(r.jobs.some(j=>j.full_scan_cursor===JSON.stringify(['cycle','cycle-current'])));}
 }

});

test('six successor synthetic jobs converge under bounded 115ms preparation/publication',{skip:process.env.SHORT_SIX!=='1'},async t=>{
 const evidence=[];
 for(let fixture=1;fixture<=3;fixture++){
  const f=await residualFixture(t),sync=await syncFor(f);await f.toHttp();const client=isolatedPublicationClient(f.syntheticFetch);t.after(()=>client.close());f.setLatency(115);f.transport.setTransactionMaxMs(5000);
  const legs=[];
  for(let n=1;n<=180;n++){
   const before=structuredClone(f.transport.counts),r=await leg(f,sync,{client,maxItems:6});assert.equal(r.result.failedJobs,0);assert.ok(r.result.processedItems||r.result.unitsCommitted||r.result.completedJobs);assert.ok(r.transactionMs<4000&&r.workMs<30000&&r.wholeMs<45000);
   const scopes=ramScopeCounters();assert.equal(scopes.liveOwners,0);assert.equal(scopes.liveScopes,0);assert.equal(scopes.retainedEnabled,0);
   const item={fixture,leg:n,wholeMs:r.wholeMs,workMs:r.workMs,transactionMs:r.transactionMs,http:f.transport.counts.httpRequests-before.httpRequests,sql:f.transport.counts.sqlStatements-before.sqlStatements,items:r.result.processedItems,units:r.result.unitsCommitted,completed:r.result.completedJobs,scopes,memory:process.memoryUsage()};legs.push(item);console.log('SHORT_SIX_LEG '+JSON.stringify(item));
   if(r.jobs.every(j=>j.completed_generation===j.requested_generation))break;
  }
  f.setLatency(0);await f.fresh();const jobs=await f.jobs();assert.ok(jobs.every(j=>j.completed_generation===j.requested_generation&&j.full_scan_cursor===null&&j.lease_owner===null));
  const receipts=(await f.db.raw.execute("SELECT count(*) n FROM phase4_operation_receipts WHERE user_id='a'")).rows[0].n;
  const proof=await verifyShortProof(f,{domainOnly:true});const completedFixture={fixture,proof,jobs,legs:legs.length,maxWholeMs:Math.max(...legs.map(x=>x.wholeMs)),maxWorkMs:Math.max(...legs.map(x=>x.workMs)),maxTransactionMs:Math.max(...legs.map(x=>x.transactionMs)),http:legs.reduce((s,x)=>s+x.http,0),sql:legs.reduce((s,x)=>s+x.sql,0),receipts,counts:await f.counts()};evidence.push(completedFixture);console.log('SHORT_SIX_FIXTURE_COMPLETION '+JSON.stringify(completedFixture));
 }
 console.log('SHORT_SIX_COMPLETION '+JSON.stringify({synthetic:true,production:false,evidence}));
});
