import {request,claim,authority,fixtureKeys} from './v32ReviewFixture.js';
import {commitPhaseWork,finalizePhaseWork} from '../src/phase4ExecutionStore.js';
import {withDurableExecution} from '../src/phase4ExecutionContext.js';
// A positive publication fixture must establish the same durable producing
// authority as production. This helper never fabricates historical success.
export async function finalizedFixtureDrain(db,worker,options){
 const sync=request(),sc=await claim(db,sync);
 await commitPhaseWork(db,sync,sc,{outcome:'NO_NEW_DATA_SUCCESS'},authority);
 const completed=await finalizePhaseWork(db,sync,sc,fixtureKeys,authority);
 const r=request({phase:'STAGE6_DRAIN',syncRequestId:sync.requestId,handoff:completed.handoff}),c=await claim(db,r);
 const drained=await withDurableExecution({claim:c,keys:fixtureKeys,pending:new Set(),authority},()=>worker.drain(options));
 await commitPhaseWork(db,r,c,{outcome:drained.outcome,itemsProcessed:drained.processedItems,jobsCompleted:drained.completedJobs,
  jobsFailed:drained.failedJobs,remainingJobs:drained.remainingJobs,completion:drained.completion},authority);
 await finalizePhaseWork(db,r,c,fixtureKeys,authority);return drained;
}
