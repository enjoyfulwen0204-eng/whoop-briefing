/** Local business ownership only. Drain never proves remote SQL cancellation. */
import {createTransitionTaskScope} from './transitionTaskScope.js';

const fail=code=>{throw Object.assign(Error(code),{code});};

export function createBusinessWebhookLifecycle({closeDatabase,stopBackground=async()=>{}}={}) {
  if(typeof closeDatabase!=='function'||typeof stopBackground!=='function') {
    fail('BUSINESS_LIFECYCLE_CALLBACKS_REQUIRED');
  }
  const tasks=createTransitionTaskScope();
  let stopped=null,disposing=null,disposed=false,databaseClosed=false;
  let handlerBound=false,backgroundStopped=false;
  const stop=()=>stopped??=Promise.resolve().then(stopBackground).then(()=>{backgroundStopped=true;});

  function closeAdmission(windowId) {
    const current=tasks.closeAdmission(windowId);
    void stop().catch(()=>{});
    return current;
  }

  async function waitForDrained({signal}={}) {
    if(!signal||typeof signal.throwIfAborted!=='function') {
      fail('TRANSITION_CLOSED_ADMISSION_AND_SIGNAL_REQUIRED');
    }
    signal.throwIfAborted();
    if(tasks.status().admission!=='CLOSED')fail('TRANSITION_CLOSED_ADMISSION_AND_SIGNAL_REQUIRED');
    // Abort bounds this local join. It cannot cancel the owned background call.
    await new Promise((resolve,reject)=>{
      const cleanup=()=>signal.removeEventListener('abort',aborted);
      const aborted=()=>{cleanup();reject(signal.reason);};
      signal.addEventListener('abort',aborted,{once:true});
      stop().then(()=>{cleanup();resolve();},error=>{cleanup();reject(error);});
      if(signal.aborted)aborted();
    });
    signal.throwIfAborted();
    return tasks.waitForDrained({signal});
  }

  function dispose({signal}={}) {
    if(disposed)return Promise.resolve(status());
    if(disposing)return disposing;
    disposing=(async()=>{
      await waitForDrained({signal});
      if(!databaseClosed){await closeDatabase();databaseClosed=true;}
      tasks.dispose();disposed=true;
      return status();
    })().catch(error=>{
      // A deadline or failed close never reopens admission. Retain ownership so
      // a later local cleanup attempt can join the same work and finish closing.
      disposing=null;
      throw error;
    });
    return disposing;
  }

  function status() {
    const current=tasks.status();
    return Object.freeze({...current,databaseClosed,disposed,backgroundStopped,
      localWorkDrained:backgroundStopped&&current.activeTasks===0});
  }

  function trackedHandler(handler,onClosed) {
    if(handlerBound||typeof handler!=='function'||typeof onClosed!=='function') {
      fail('BUSINESS_CANONICAL_HANDLER_REQUIRED');
    }
    handlerBound=true;
    return async(req,res)=>{
      let work;
      try{work=tasks.run(()=>handler(req,res));}
      catch(error){
        if(error?.code==='TRANSITION_BUSINESS_ADMISSION_CLOSED')return onClosed(req,res);
        throw error;
      }
      return await work;
    };
  }

  return Object.freeze({trackedHandler,fork:operation=>tasks.fork(operation),
    closeAdmission,waitForDrained,dispose,status});
}
