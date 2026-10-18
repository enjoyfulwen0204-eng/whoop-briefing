/** SOURCE ONLY: business request/background lifetime tracking for the future
 * in-process schema supervisor. No DB/provider/mode authority is granted here.
 * Draining local promises does NOT prove remote SQL cancellation or finality. */
import {AsyncLocalStorage} from 'node:async_hooks';
const fail=code=>{throw Object.assign(Error(code),{code});};
export function createTransitionTaskScope(){
 const context=new AsyncLocalStorage(),active=new Set(),waiters=new Set();
 let admission='OPEN',closed=false,originalWindowId=null;
 const notify=()=>{if(!active.size)for(const resolve of [...waiters])resolve();};
 function start(operation,kind){
  if(typeof operation!=='function'||closed)fail('TRANSITION_TASK_SCOPE_CLOSED');
  const entry={kind,done:false};active.add(entry);
  // Install the entry before invoking the operation, including synchronous throws.
  const promise=Promise.resolve().then(()=>context.run(entry,operation));
  const settled=promise.finally(()=>{entry.done=true;active.delete(entry);notify();});
  // A detached owner's onError remains responsible for recording the failure.
  // This observer only prevents an abandoned tracking promise becoming unhandled.
  settled.catch(()=>{});return settled;
 }
 function run(operation){
  if(admission!=='OPEN'||closed)fail('TRANSITION_BUSINESS_ADMISSION_CLOSED');
  return start(operation,'REQUEST');
 }
 function fork(operation){
  const parent=context.getStore();
  if(!parent||parent.done||!active.has(parent)||closed)fail('TRANSITION_ACTIVE_PARENT_REQUIRED');
  return start(operation,'BACKGROUND');
 }
 function closeAdmission(windowId){
  if(typeof windowId!=='string'||!/^[A-Za-z0-9_-]{16,128}$/.test(windowId))fail('TRANSITION_ORIGINAL_WINDOW_REQUIRED');
  if(originalWindowId!==null&&originalWindowId!==windowId)fail('TRANSITION_ORIGINAL_WINDOW_CHANGED');
  originalWindowId=windowId;admission='CLOSED';return status();
 }
 function status(){return Object.freeze({admission,closed,originalWindowId,activeTasks:active.size,
  requests:[...active].filter(e=>e.kind==='REQUEST').length,background:[...active].filter(e=>e.kind==='BACKGROUND').length,
  provesRemoteSqlCancellation:false,productionAuthority:'NONE'});}
 async function waitForDrained({signal}={}){
  if(admission!=='CLOSED'||!signal||typeof signal.throwIfAborted!=='function')fail('TRANSITION_CLOSED_ADMISSION_AND_SIGNAL_REQUIRED');
  signal.throwIfAborted();
  if(active.size)await new Promise((resolve,reject)=>{
   const done=()=>{cleanup();resolve();},abort=()=>{cleanup();reject(signal.reason);};
   const cleanup=()=>{waiters.delete(done);signal.removeEventListener('abort',abort);};
   waiters.add(done);signal.addEventListener('abort',abort,{once:true});
   if(signal.aborted)abort();else if(!active.size)done();
  });
  signal.throwIfAborted();if(active.size)fail('TRANSITION_BUSINESS_NOT_DRAINED');return status();
 }
 function dispose(){
  if(admission!=='CLOSED'||active.size)fail('TRANSITION_CANNOT_DISPOSE_ACTIVE_SCOPE');
  closed=true;context.disable();return status();
 }
 // Intentionally no reopen method. A fresh runtime/scope must be constructed
 // after independently authenticated33 revocation or exact35 reconciliation.
 return Object.freeze({run,fork,closeAdmission,status,waitForDrained,dispose});
}
