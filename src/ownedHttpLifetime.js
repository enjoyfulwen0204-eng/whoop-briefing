// Local HTTP request/body lifetime only. An idle receiver does not prove a
// provider-side transaction/stream closed, or authorize health-hold disposal.
export function createOwnedHttpLifetime(fetchImpl){
 if(typeof fetchImpl!=='function')throw Error('OWNED_HTTP_FETCH_REQUIRED');
 const active=new Set(),waiters=new Set();
 let requests=0,failures=0,cancellations=0,epoch=0;
 const snapshot=()=>Object.freeze({epoch,requests,pendingFetches:[...active].filter(entry=>!entry.headers).length,
  pendingBodies:[...active].filter(entry=>entry.headers).length,failures,cancellations,
  requestBodiesJoined:active.size===0,providerCompletion:'UNKNOWN',healthDisposalAuthorized:false});
 const changed=()=>{for(const wake of [...waiters])wake();};
 const fetch=async(...args)=>{
  // Register before calling the provider, including its synchronous throw and
  // initial requests which have no Hrana baton. Cancellation never removes it.
  const entry={headers:false,failed:false,done:false,cancelling:false};active.add(entry);requests++;epoch++;changed();
  const failed=()=>{if(!entry.failed){entry.failed=true;failures++;}};
  const finish=()=>{if(entry.done)return;entry.done=true;active.delete(entry);epoch++;changed();};
  let response,reader;
  try{
   response=await fetchImpl(...args);
   if(!(response instanceof Response))throw Error('OWNED_HTTP_RESPONSE_REQUIRED');
   entry.headers=true;
   if(!response.ok)failed();
   if(response.body===null){finish();return response;}
   reader=response.body.getReader();
   const release=()=>{try{reader.releaseLock();}catch{failed();}};
   const body=new ReadableStream({
    async pull(controller){
     try{const part=await reader.read();
      if(entry.cancelling)return;
      if(part.done){release();finish();controller.close();}
      else controller.enqueue(part.value);
     }catch(error){if(entry.cancelling)return;failed();release();finish();controller.error(error);}
    },
    async cancel(reason){
     entry.cancelling=true;cancellations++;failed();
     // Keep the entry live until the ORIGINAL body's cancel promise settles.
     // Even a successful cancel does not prove the provider accepted a close.
     try{await reader.cancel(reason);}finally{release();finish();}
    },
   });
   const wrapped=new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
   // Preserve direct metadata for the installed Hrana JSON consumer. This is
   // not a transparent general fetch adapter: constructed Response headers
   // are mutable, and native clones have constructed-response URL/type data.
   for(const key of ['url','redirected','type'])Object.defineProperty(wrapped,key,{value:response[key],enumerable:true});
   return wrapped;
  }catch(error){failed();
   if(reader){try{await reader.cancel(error);}catch{/* Original error wins; failure remains latched. */}
    try{reader.releaseLock();}catch{/* No disposal authority is inferred. */}}
   finish();throw error;
  }
 };
 async function join({timeoutMs=5000,signal}={}){
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>15000)throw Error('OWNED_HTTP_JOIN_BOUND_REQUIRED');
  let timer,quiet,onAbort,wake;
  try{
   const joined=await new Promise((resolve,reject)=>{
    // A completed body may immediately schedule an owned late-response close.
    // Observe all entries added during this wait, rather than Promise.all over
    // its initial set. A quiet turn still does not prove future/provider finality.
    wake=()=>{clearTimeout(quiet);if(active.size===0){const observed=epoch;
     quiet=setTimeout(()=>{if(active.size===0&&epoch===observed)resolve(true);},0);
    }};waiters.add(wake);
    timer=setTimeout(()=>resolve(false),timeoutMs);
    if(signal){onAbort=()=>reject(signal.reason??Error('OWNED_HTTP_JOIN_CANCELLED'));
     signal.addEventListener('abort',onAbort,{once:true});if(signal.aborted)onAbort();}
    wake();
   });
   // This is a point-in-time observation, never a reusable finality grant.
   return Object.freeze({...snapshot(),joinCompleted:joined&&active.size===0});
  }finally{clearTimeout(timer);clearTimeout(quiet);waiters.delete(wake);if(onAbort)signal.removeEventListener('abort',onAbort);}
 }
 return Object.freeze({fetch,snapshot,join});
}
