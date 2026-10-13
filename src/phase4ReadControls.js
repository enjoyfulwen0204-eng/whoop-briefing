import {assertExecutionWorkOwner} from './phase4ExecutionContext.js';

// Transport only: both original fresh control observations run in their
// original owned transaction. Nothing is cached and no proof is issued.
// Settle both before returning; context failure retains first priority.
export async function assertFreshContextAndWorkOwner(core,context){
 const values=await Promise.allSettled([
  Promise.resolve().then(()=>core.run(context,async()=>{})),
  Promise.resolve().then(()=>assertExecutionWorkOwner(core.client)),
 ]);
 for(const value of values)if(value.status==='rejected')throw value.reason;
}
