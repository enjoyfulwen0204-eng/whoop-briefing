import {createUserErasure} from './userErasure.js';
import {createOperationalRetention} from './operationalRetention.js';
import {localDate} from './time.js';

/** No message transport. Pending erasures retry at each natural night slot;
 * whole operational retirement runs once per Taipei day, within the caller's
 * existing deadline. An incomplete pass is not memoized as complete. */
export async function runErasureMaintenance({db,keys,environment,budget,now=()=>new Date(),emit=console.log}){
 const started=Date.now(),day=localDate(now(),'Asia/Taipei'),marker='e1b:retention:'+day;
 if(budget.remainingMs()<15000){
  const retries={completed:0,pending:0,deferred:1,overdue:0},retention={status:'DEFERRED_BUDGET',deferred:1};
  emit(JSON.stringify({event:'erasure_maintenance',completed:0,pending:0,overdue:0,deferred:2,duration_ms:Date.now()-started}));
  return {retries,retention};
 }
 const engine=createUserErasure({db,keys,environment,now});
 const retries=await engine.retryPending({budget});
 let retention={status:'ALREADY_COMPLETED'};
 const completed=JSON.stringify({date:day,version:'e1b-retention-v1'});
 if(await db.getState(marker)!==completed){
  retention=await createOperationalRetention({db,keys,now,emit}).run({budget});
  if(!retention.deferred){budget.assert();await db.setState(marker,completed,{now:now()});}
 }
 emit(JSON.stringify({event:'erasure_maintenance',completed:retries.completed,pending:retries.pending,overdue:retries.overdue,deferred:retries.deferred+(retention.deferred??0),duration_ms:Date.now()-started}));
 return {retries,retention};
}
