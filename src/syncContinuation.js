import {currentDurableExecution} from './phase4ExecutionContext.js';
import {currentExecutionBudget} from './executionBudget.js';

// This reserve does not extend a deadline. A leg yields only at an existing
// completed logical-unit boundary; the normal hard budget still bounds units.
export const SYNC_YIELD_RESERVE_MS=30_000;
export function syncShouldYield({reserveMs}={}){
 const execution=currentDurableExecution();if(!execution?.syncContinuation)return false;
 execution.authority.assert();
 const budget=currentExecutionBudget();budget?.assert();
 const reserve=reserveMs===undefined?execution.syncYieldReserveMs:Math.min(execution.syncYieldReserveMs,reserveMs);
 if(!Number.isSafeInteger(reserve)||reserve<1)throw Error('SYNC_YIELD_RESERVE_INVALID');
 // This marker records that some completed-unit boundary left work pending.
 // A peer's 30s yield cannot replace an admitted tail's explicit 15s boundary.
 // Keep the reached boundary sticky for equal/larger admissions, and tighten
 // it when a smaller boundary is actually reached. No marker or deadline is
 // cleared; per-user deferred results keep whole-phase completion false.
 const reached=execution.syncYieldReserveReachedMs??execution.syncYieldReserveMs;
 if(execution.syncYieldRequested&&reserve>=reached)return true;
 if(budget.remainingMs()<reserve){execution.syncYieldRequested=true;
  execution.syncYieldReserveReachedMs=Math.min(reached,reserve);return true;}
 return false;
}
