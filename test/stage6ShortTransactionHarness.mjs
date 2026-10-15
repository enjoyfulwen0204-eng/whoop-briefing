import assert from 'node:assert/strict';
import {residualFixture,fixtureKeys} from './stage6JournalBoundaryFixture.js';
import {request,claim} from './v32ReviewFixture.js';
import {commitPhaseWork,finalizePhaseWork} from '../src/phase4ExecutionStore.js';
import {withDurableExecution} from '../src/phase4ExecutionContext.js';
import {createExecutionBudget,withExecutionBudget} from '../src/executionBudget.js';
import {isolatedPublicationClient,prepareIsolatedUnit,publishIsolatedUnit} from './stage6ShortTransactionPrototype.mjs';
import {verifyShortProof} from './stage6ShortProof.mjs';
import {createPhase4Stage6,authorizeStage6ShadowWorker} from '../src/phase4Reanalysis.js';
export async function syncFor(f){const req=request(),owner=await claim(f.db,req),a={assert(){}};await commitPhaseWork(f.db,req,owner,{outcome:'NO_NEW_DATA_SUCCESS'},a);return {req,result:await finalizePhaseWork(f.db,req,owner,fixtureKeys,a)};}
export async function leg(f,sync,{client,prepare=true,maxItems=1,profile=false}={}){
 const phaseCounts=structuredClone(f.transport.counts),phases=[],phaseStarted=performance.now(),req=request({phase:'STAGE6_DRAIN',syncRequestId:sync.req.requestId,handoff:sync.result.handoff}),owner=await claim(f.db,req,{leaseMs:60000,deadlineAt:Date.now()+45000}),budget=createExecutionBudget({budgetMs:30000}),authority={assert:()=>budget.assert()},started=performance.now();let result,measurement;
 const delta=(before,at,label)=>({label,http:f.transport.counts.httpRequests-before.httpRequests,sql:f.transport.counts.sqlStatements-before.sqlStatements,elapsedMs:performance.now()-at,remainingWorkerMs:budget.remainingMs()});
 if(profile)phases.push(delta(phaseCounts,phaseStarted,'claim/admission'));
 let saved;
 if(profile&&client){saved={execute:client.execute,batch:client.batch};for(const method of ['execute','batch'])client[method]=async(...args)=>{const stmts=method==='batch'?args[0]:[args[0]],sql=stmts.map(x=>typeof x==='string'?x:x.sql).join(' '),label=sql.includes('SHORT_TRANSACTION_HEADROOM_REJECTED')?'atomic publication':sql.includes('PREPARATION_FRESH_PAGE_BOUNDS')?'bounded DATA snapshot':sql.includes('__bounded_bytes')?'key/byte metadata':sql.includes('sqlite_master')?'schema catalog':sql.includes('PRAGMA table_info')?'column/index metadata':sql.includes('PREPARATION_CONTEXT_REJECTED')?'context lease registration':sql.startsWith('DELETE FROM resource_locks')?'RAM disposal/context release':'control/owner observation',before=structuredClone(f.transport.counts),at=performance.now();try{return await saved[method].apply(client,args);}finally{phases.push(delta(before,at,label));}};}

 try{
  await withDurableExecution({claim:owner,keys:fixtureKeys,pending:new Set(),authority},()=>withExecutionBudget(budget,()=>budget.run(async()=>{
   if(prepare){const plan=await prepareIsolatedUnit({client,userId:'a',maxItems});measurement=await publishIsolatedUnit(client,plan);result=measurement.result;}
   else{const worker=await createPhase4Stage6({db:f.db,keys:fixtureKeys,admission:await f.db.admitRuntime(),executionMode:'SHADOW',workerCapability:authorizeStage6ShadowWorker({executionMode:'SHADOW'})});result=await worker.drain({triggerSource:'manual',userId:'a',budget:{maxItems,maxItemsPerTenant:maxItems}});}
  })));
 }finally{if(saved){client.execute=saved.execute;client.batch=saved.batch;}budget.close();}
 const workMs=performance.now()-started,workCounts=structuredClone(f.transport.counts),settlementStarted=performance.now(),settlement=createExecutionBudget({budgetMs:15000}),a={assert:()=>settlement.assert()};
 try{await withExecutionBudget(settlement,()=>settlement.run(async()=>{await commitPhaseWork(f.db,req,owner,{outcome:result.outcome,itemsProcessed:result.processedItems,jobsCompleted:result.completedJobs,jobsFailed:result.failedJobs,unitsCommitted:result.unitsCommitted},a);await finalizePhaseWork(f.db,req,owner,fixtureKeys,a);}));}finally{settlement.close();}
 if(profile){phases.push({label:'original signed settlement',http:f.transport.counts.httpRequests-workCounts.httpRequests,sql:f.transport.counts.sqlStatements-workCounts.sqlStatements,elapsedMs:performance.now()-settlementStarted});const remoteMs=phases.filter(p=>!['claim/admission','original signed settlement'].includes(p.label)).reduce((v,p)=>v+p.elapsedMs,0);phases.push({label:'RAM import/original algorithm/HMAC',http:0,sql:0,elapsedMs:workMs-remoteMs});}
 const wholeMs=performance.now()-phaseStarted;assert.ok(wholeMs<45000);return {executionId:req.requestId,wholeMs,workMs,...(profile?{phases,wholeHttp:f.transport.counts.httpRequests-phaseCounts.httpRequests,wholeSql:f.transport.counts.sqlStatements-phaseCounts.sqlStatements}:{}),...measurement,result,jobs:await f.jobs(),counts:await f.counts()};
}
