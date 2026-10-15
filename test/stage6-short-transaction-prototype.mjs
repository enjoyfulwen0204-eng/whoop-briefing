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
import {createFamilyDirectory} from '../src/phase4FamilyDirectory.js';
import {INTELLIGENCE_VERSIONS,phase4Metric} from '../src/phase4IntelligenceRegistry.js';
test('bounded original algorithm prepares and atomically publishes a genuine source unit',{skip:process.env.SHORT_SIX==='1'},async t=>{
 const f=await residualFixture(t),sync=await syncFor(f);
 for(let n=0;n<60;n++){const r=await leg(f,sync,{prepare:false});assert.equal(r.result.failedJobs,0);if((await f.jobs()).every(j=>j.full_scan_cursor===JSON.stringify(['USER','a']))&&Number((await f.db.raw.execute("SELECT count(*) n FROM phase4_evidence_result_authorities WHERE result_scope='METRIC'")).rows[0].n)>1)break;}
 await f.toHttp();const client=isolatedPublicationClient(f.syntheticFetch);t.after(()=>client.close());f.setLatency(Number(process.env.SHORT_LATENCY_MS??115));f.transport.setTransactionMaxMs(5000);
 let familyProof;
 for(let unit=1;unit<=3;unit++){
 const priorJobs=await f.jobs();
 const before=structuredClone(f.transport.counts),r=await leg(f,sync,{client,profile:true});console.log('SHORT_TRANSACTION '+JSON.stringify({unit,...r,http:f.transport.counts.httpRequests-before.httpRequests,sql:f.transport.counts.sqlStatements-before.sqlStatements}));
 assert.ok(r.result.unitsCommitted||r.result.processedItems||r.result.completedJobs);assert.ok(r.transactionMs<4000);assert.ok(r.workMs<30000);
 if(unit===1){assert.equal(r.counts.domain,2);f.setLatency(0);console.log('SHORT_SIGNED_PROOF '+JSON.stringify(await verifyShortProof(f,{domainOnly:true})));f.setLatency(115);}else if(unit===2){
  assert.equal(r.result.processedItems,0);assert.equal(r.result.unitsCommitted,1);assert.deepEqual(r.jobs.map(j=>j.full_scan_cursor),priorJobs.map(j=>j.full_scan_cursor));
  f.setLatency(0);const domain=(await f.db.raw.execute("SELECT * FROM phase4_operation_receipts WHERE user_id='a' AND operation_kind='analyzeMetric'")).rows.find(row=>JSON.parse(row.request_json).request.metricKey==='cycle_strain'),req=JSON.parse(domain.request_json).request,family=fixtureKeys.lookup(['episode-family-v1','a',phase4Metric(req.metricKey).domain,req.metricKey,INTELLIGENCE_VERSIONS.algorithm,req.metricKey,req.windowFamily]);
  const e=(await f.db.raw.execute("SELECT * FROM phase4_executions WHERE phase='STAGE6_DRAIN' ORDER BY execution_seq DESC LIMIT 1")).rows[0],work=(await f.db.raw.execute({sql:'SELECT * FROM phase4_execution_work_receipts WHERE execution_id=?',args:[e.execution_id]})).rows;
  const acks=r.jobs.map(j=>fixtureKeys.lookup(['execution-work-step-v2',e.identity_digest,e.scope_key,['named',fixtureKeys.lookup(['phase4-logical-work-v1','stage6.family',['a','SHADOW',j.job_kind,j.requested_generation,j.scope_revision,[req.metricKey,req.asOfUtc,family]]])]])).filter(key=>work.some(row=>row.receipt_key===key));assert.equal(acks.length,1);
  const state=(await f.db.raw.execute("SELECT u.timezone,u.lifecycle_generation,coalesce(t.auth_generation,0) auth_generation,p.source_generation,p.purge_generation,c.input_generation,c.algorithm_set_version FROM users u LEFT JOIN user_whoop_tokens t ON t.user_id=u.id JOIN phase4_user_state p ON p.user_id=u.id JOIN phase4_computation_state c ON c.user_id=u.id AND c.execution_mode='SHADOW' WHERE u.id='a'")).rows[0],context={userId:'a',executionMode:'SHADOW',timezone:state.timezone,lifecycleGeneration:state.lifecycle_generation,authGeneration:state.auth_generation,sourceGeneration:state.source_generation,purgeGeneration:state.purge_generation,inputGeneration:state.input_generation,algorithmSetVersion:state.algorithm_set_version};
  const entry=(await f.db.raw.execute({sql:"SELECT * FROM phase4_family_directory_entries WHERE user_id='a' AND family_key=?",args:[family]})).rows[0];assert.ok(entry);const directory=createFamilyDirectory(f.db.raw,fixtureKeys);assert.equal((await directory.work(context,entry)).due,false);
  const episode=(await f.db.raw.execute({sql:"SELECT episode_id,revision FROM observation_episodes WHERE user_id='a' AND episode_family_key=?",args:[family]})).rows;assert.ok(episode.length);familyProof={acks,episode};await f.fresh();assert.equal((await createFamilyDirectory(f.db.raw,fixtureKeys).work(context,entry)).due,false);f.setLatency(115);
 }else{assert.equal(r.result.processedItems,1);assert.ok(r.jobs.some(j=>j.full_scan_cursor===JSON.stringify(['cycle','cycle-current'])));f.setLatency(0);assert.deepEqual((await f.db.raw.execute({sql:"SELECT episode_id,revision FROM observation_episodes WHERE user_id='a' AND episode_id=?",args:[familyProof.episode[0].episode_id]})).rows,familyProof.episode);console.log('SHORT_FAMILY_BOUNDARY_PROOF '+JSON.stringify({cursorPendingUntilAssociation:true,exactFamilyAck:familyProof.acks,restarted:true,noDuplicateEpisode:true,...await verifyShortProof(f,{domainOnly:true})}));}

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
