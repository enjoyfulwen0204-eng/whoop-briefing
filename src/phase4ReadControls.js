import {assertExecutionWorkOwner} from './phase4ExecutionContext.js';

// Both observations are non-health metadata, inside the same original owned
// transaction. Preserve the caller's original rejection priority and return
// only the original owner row; this creates no accepted-guard/result cache.
export async function observeContextAndWorkOwner(core,context,{ownerFirst=false}={}){
 const owner=()=>assertExecutionWorkOwner(core.client),state=()=>core.assertContext(context);
 const values=await Promise.allSettled((ownerFirst?[owner,state]:[state,owner]).map(call=>Promise.resolve().then(call)));
 for(const value of values)if(value.status==='rejected')throw value.reason;
 return values[ownerFirst?0:1].value;
}

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
