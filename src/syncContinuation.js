import {currentDurableExecution} from './phase4ExecutionContext.js';
import {currentExecutionBudget} from './executionBudget.js';

// This reserve does not extend a deadline. A leg yields only at an existing
// completed logical-unit boundary; the normal hard budget still bounds units.
export const SYNC_YIELD_RESERVE_MS=30_000;
export function syncShouldYield({reserveMs}={}){
 const execution=currentDurableExecution();if(!execution?.syncContinuation)return false;
 const budget=currentExecutionBudget();budget?.assert();
 const reserve=reserveMs===undefined?execution.syncYieldReserveMs:Math.min(execution.syncYieldReserveMs,reserveMs);
 if(!Number.isSafeInteger(reserve)||reserve<1)throw Error('SYNC_YIELD_RESERVE_INVALID');
 if(execution.syncYieldRequested||budget.remainingMs()<reserve){execution.syncYieldRequested=true;return true;}
 return false;
}
