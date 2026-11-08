// Per-request diagnostics only. No durable state, delivery decisions or retries.
const knownSteps=new Set(['status','daily','weekly','insight','coach','brief_update','no_sleep','low','prediction','timed_energy','family_daily','family_alert','family_weekly']);
const failureStates=new Set(['FAILED_DEFINITE','RETRY_EXHAUSTED','DELIVERY_STARTED','AMBIGUOUS','UNKNOWN']);
export function createCompanionProgress(plans){
 const users=new Map(plans.map(([user,steps])=>[user,{started:false,complete:false,steps:new Map(steps.map(s=>[s,'PENDING']))}]));
 const extraDeferred={};let frozen;
 const entry=user=>users.get(user);
 const api={
  start(user){if(!frozen&&entry(user))entry(user).started=true;},
  finish(user){if(!frozen&&entry(user)){entry(user).complete=true;entry(user).started=true;}},
  observe({user,step,status}){if(frozen||!knownSteps.has(step)||!/^([A-Z][A-Z0-9_]{0,63})$/.test(status))return;const e=entry(user);if(!e)return;if(status!=='DEFERRED_BUDGET')e.started=true;e.steps.set(step,status);},
  // Older injected adapters can return results instead of emitting progress.
  finishSteps(user,steps){if(frozen)return;for(const step of steps)if(entry(user)?.steps.get(step)==='PENDING')entry(user).steps.set(step,'NOT_APPLICABLE');},
  addDeferred(counts){if(frozen)return;const seen=api.snapshot().deferredSteps;for(const [s,n] of Object.entries(counts??{}))if(knownSteps.has(s)&&Number.isSafeInteger(n)&&n>0)extraDeferred[s]=Math.max(extraDeferred[s]??0,n-(seen[s]??0));},
  snapshot(exhausted=false){
   if(frozen)return frozen;
   const deferredSteps={...extraDeferred},interruptedSteps={},outcomes={};let checked=0,completedUsers=0,failedUsers=0;
   for(const e of users.values()){
    if(e.started)checked++;if(e.complete)completedUsers++;if([...e.steps.values()].some(s=>failureStates.has(s)))failedUsers++;
    for(const [step,status] of e.steps){
     if(status==='DEFERRED_BUDGET'||exhausted&&status==='PENDING'&&!e.complete)deferredSteps[step]=(deferredSteps[step]??0)+1;
     if(exhausted&&status==='STARTED')interruptedSteps[step]=(interruptedSteps[step]??0)+1;
     if(!['PENDING','STARTED','NOT_APPLICABLE'].includes(status))outcomes[status]=(outcomes[status]??0)+1;
    }
   }
   return {checked,completedUsers,failedUsers,unprocessedUsers:users.size-checked,incompleteUsers:checked-completedUsers,outcomes,deferredSteps,interruptedSteps,deferred:Object.keys(deferredSteps).length>0,budgetExhausted:exhausted};
  },
  freeze(exhausted=false){frozen=api.snapshot(exhausted);return frozen;},
 };
 return api;
}
