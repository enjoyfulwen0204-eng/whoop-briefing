import {currentExecutionBudget} from './executionBudget.js';
import {currentDurableExecution} from './phase4ExecutionContext.js';
/** Parent intersection plus provider resource bound. Caller owns cleanup. */
export function transportAuthority({timeoutMs,signal,executionBudget}={}) {
 const budgets=[...new Set([currentExecutionBudget(),executionBudget].filter(Boolean))];
 const controller=new AbortController();
 const deadline=Math.min(Date.now()+timeoutMs,...budgets.map(b=>b.deadlineAt));
 const signals=[controller.signal,signal,...budgets.map(b=>b.signal)].filter(Boolean);
 const combined=AbortSignal.any(signals);
 const assert=()=>{for(const b of budgets)b.assert();currentDurableExecution()?.authority.assert();signal?.throwIfAborted();combined.throwIfAborted();if(Date.now()>=deadline)throw Object.assign(Error('TRANSPORT_TIMEOUT'),{name:'TimeoutError'});};
 const timer=setTimeout(()=>controller.abort(Object.assign(Error('TRANSPORT_TIMEOUT'),{name:'TimeoutError'})),Math.max(0,deadline-Date.now()));
 return {signal:combined,assert,close:()=>clearTimeout(timer)};
}
