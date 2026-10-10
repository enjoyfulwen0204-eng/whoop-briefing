import {createExecutionBudget,SETTLEMENT_MARGIN_MS,boundedBody,abortable} from './executionBudget.js';
// Closing an existing Hrana baton releases transport resources; it grants no
// SQL/COMMIT/business authority. Keep it bounded even after parent cancellation.
export async function hranaPayload(request){
 if(!(request instanceof Request)||request.method!=='POST'||!new URL(request.url).pathname.endsWith('/v2/pipeline')
  ||!request.headers.get('content-type')?.startsWith('application/json'))return null;
 try{return await request.clone().json();}catch{return null;}
}
const baton=value=>typeof value==='string'&&value.length>0&&value.length<=4096;
export function closeOnlyPayload(payload){return payload&&baton(payload.baton)&&Array.isArray(payload.requests)&&payload.requests.length>0
 &&payload.requests.every(r=>r&&Object.keys(r).length===1&&r.type==='close')&&Object.keys(payload).every(k=>['baton','requests'].includes(k));}
export async function closeHranaStream(fetchImpl,request,id,pending){
 if(!baton(id))return;
 const cleanup=createExecutionBudget({budgetMs:SETTLEMENT_MARGIN_MS});
 try{return await cleanup.run(async()=>{
  // Do not close underneath an already submitted command. Waiting grants no
  // SQL authority; unresolved transport is left to provider expiry.
  if(pending)await abortable(Promise.resolve(pending).catch(()=>{}),cleanup.signal);
  const response=await fetchImpl(new Request(request.url,{method:'POST',headers:request.headers,
   body:JSON.stringify({baton:id,requests:[{type:'close'}]}),signal:cleanup.signal}));
  const body=await boundedBody(response,{signal:cleanup.signal,maxBytes:1024*1024});
  return new Response(body,{status:response.status,headers:response.headers});
 });}finally{cleanup.close();}
}
export async function closeLateHranaResponse(fetchImpl,request,response){
 const cleanup=createExecutionBudget({budgetMs:SETTLEMENT_MARGIN_MS});
 try{const copy=response.clone();
  const body=await cleanup.run(()=>boundedBody(copy,{signal:cleanup.signal,maxBytes:4*1024*1024}));
  const result=JSON.parse(body);if(baton(result?.baton))await closeHranaStream(fetchImpl,request,result.baton);
 }catch{/* Unknown acknowledgement stays uncertain; provider stream expiry is still required. */}
 finally{cleanup.close();}
}
