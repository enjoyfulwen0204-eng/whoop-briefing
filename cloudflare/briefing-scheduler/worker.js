const PATH='/internal/briefing/run';
export const MAX_ATTEMPTS=2;
export const TIMEOUT_MS=180_000;
export const DRAIN_TIMEOUT_MS=100_000;
export const MAX_RESPONSE_BYTES=16*1024;
export const MAX_CONFIGURED_WINDOW_MS=MAX_ATTEMPTS*(TIMEOUT_MS+DRAIN_TIMEOUT_MS)+1000;
export const REDIRECT_MODE='manual';
export const ALLOWED_REDIRECT_MODES=Object.freeze(['follow','manual']);
export const isRedirect=status=>status>=300&&status<400;
export const retryableStatus=status=>[429,502,503,504].includes(status);
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const hex=bytes=>[...new Uint8Array(bytes)].map(b=>b.toString(16).padStart(2,'0')).join('');
const sha256=async text=>hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)));
export async function canonicalMessage({timestamp,requestId,method,path,body}) {return [timestamp,requestId,method.toUpperCase(),path,await sha256(body)].join('\n');}
export async function signRequest(args,secret) {
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 return `v1=${hex(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(await canonicalMessage(args))))}`;
}
function error(category,nonRetryable=false) {const e=new Error(category);e.category=category;e.nonRetryable=nonRetryable;return e;}
async function raceAbort(work,signal) {
 if(signal.aborted){void Promise.resolve(work).catch(()=>{});throw error('timeout');}let onAbort;
 const aborted=new Promise((_,reject)=>{onAbort=()=>reject(error('timeout'));signal.addEventListener('abort',onAbort,{once:true});});
 try{const result=await Promise.race([work,aborted]);if(signal.aborted)throw error('timeout');return result;}
 finally{signal.removeEventListener('abort',onAbort);}
}
export async function readResponseBody(response,{controller,maxBytes=MAX_RESPONSE_BYTES,deadlineAt=Infinity,now=Date.now}={}) {
 if(!response.body?.getReader)throw error('invalid_response',true);
 const reader=response.body.getReader(),chunks=[];let size=0,done=false;
 const assertTime=()=>{if(now()>=deadlineAt||controller.signal.aborted)throw error('timeout');};
 try{
  while(true){assertTime();const part=await raceAbort(reader.read(),controller.signal);assertTime();if(part.done){done=true;break;}
   size+=part.value.byteLength;if(size>maxBytes){controller.abort();throw error('body_too_large',true);}chunks.push(part.value);}
  const bytes=new Uint8Array(size);let offset=0;for(const part of chunks){bytes.set(part,offset);offset+=part.byteLength;}
  assertTime();return new TextDecoder().decode(bytes);
 }finally{
  if(!done){controller.abort();try{void reader.cancel().catch(()=>{});}catch{}}
  try{reader.releaseLock();}catch{}
 }
}
export async function invoke(env,{fetchImpl=fetch,now=()=>Date.now(),sleep=delay,timeoutMs=TIMEOUT_MS,
 drainTimeoutMs=DRAIN_TIMEOUT_MS,setTimer=setTimeout,clearTimer=clearTimeout,signal,signImpl=signRequest,deadlineAt=Infinity}={}) {
 const endpoint=new URL(env.BRIEFING_ENDPOINT_URL);
 if(endpoint.protocol!=='https:'||endpoint.pathname!==PATH||endpoint.search||endpoint.hash||/replace|placeholder/i.test(endpoint.hostname))throw error('configuration',true);
 if(!env.BRIEFING_TRIGGER_SECRET||new TextEncoder().encode(env.BRIEFING_TRIGGER_SECRET).length<32
   ||!['OFF','SHADOW'].includes(env.BRIEFING_EXECUTION_MODE)||!/^[a-f0-9]{40}$/.test(env.BRIEFING_RELEASE_SHA??'')||!/^[a-f0-9]{64}$/.test(env.BRIEFING_CONFIG_PROOF))throw error('configuration',true);
 deadlineAt=Math.min(deadlineAt,now()+MAX_CONFIGURED_WINDOW_MS);
 const assertCaller=()=>{if(signal?.aborted)throw error('cancelled',true);if(now()>=deadlineAt)throw error('timeout',true);};
 assertCaller();
 const root=crypto.randomUUID();
 async function phase(phaseName,handoff) {
  const requestId=`${root}_${phaseName.toLowerCase()}`;
  const body=JSON.stringify({requestId,releaseSha:env.BRIEFING_RELEASE_SHA,phase:phaseName,executionMode:env.BRIEFING_EXECUTION_MODE,triggerSource:'cloudflare',configProof:env.BRIEFING_CONFIG_PROOF,
   ...(handoff?{syncRequestId:handoff.requestId,handoff:handoff.token}:{})});
  let last;
  for(let attempt=1;attempt<=MAX_ATTEMPTS;attempt++) {
   assertCaller();
   const timestamp=String(now());
   const controller=new AbortController(),onAbort=()=>controller.abort();signal?.addEventListener('abort',onAbort,{once:true});
   if(signal?.aborted)controller.abort();
   const attemptDeadline=Math.min(deadlineAt,now()+(phaseName==='SYNC'?timeoutMs:drainTimeoutMs));
   const assertAttempt=()=>{assertCaller();if(controller.signal.aborted||now()>=attemptDeadline)throw error('timeout');};
   const timer=setTimer(()=>controller.abort(),attemptDeadline-now());
   let response;
   try{
    assertCaller();
    const signature=await raceAbort(signImpl({timestamp,requestId,method:'POST',path:PATH,body},env.BRIEFING_TRIGGER_SECRET),controller.signal);
    assertAttempt();
    const pendingResponse=Promise.resolve(fetchImpl(endpoint.toString(),{method:'POST',body,signal:controller.signal,redirect:REDIRECT_MODE,
     headers:{'content-type':'application/json','x-briefing-timestamp':timestamp,'x-briefing-request-id':requestId,'x-briefing-signature':signature}}))
      .then(value=>{if(controller.signal.aborted){try{void value.body?.cancel().catch(()=>{});}catch{}}return value;});
    response=await raceAbort(pendingResponse,controller.signal);
    assertAttempt();
    const text=await readResponseBody(response,{controller,deadlineAt:attemptDeadline,now});assertAttempt();let payload;try{payload=JSON.parse(text);}catch{payload=null;}
    if(isRedirect(response.status))throw error('redirect',true);
    if([401,403].includes(response.status))throw error('authentication',true);
    if(response.status===200&&!payload)throw error('invalid_response',true);
    if(response.status===200&&payload?.ok===true&&payload.phase===phaseName&&payload.source==='cloudflare'
      &&(phaseName!=='SYNC'||payload.syncComplete===true)) {
      console.log(JSON.stringify({event:'briefing_phase_ok',phase:phaseName,attempt,status:response.status}));
      return {requestId,payload,status:response.status,attempt};
    }
    if(response.status===207||payload?.syncComplete===false)throw error('sync_incomplete',true);
    last=error(isRedirect(response.status)?'redirect':response.status===401||response.status===403?'authentication':`http_${Math.floor(response.status/100)}xx`,
      !retryableStatus(response.status)&&!(response.status===409&&payload?.error==='REQUEST_PENDING'));
    throw last;
   }catch(e){if(now()>=deadlineAt)throw error('timeout',true);if(signal?.aborted)throw error('cancelled',true);last=e;if(e?.name==='TypeError'&&/redirect/i.test(e.message))last=error('redirect',true);if(!last.category)last=error(controller.signal.aborted?'timeout':'transport');if(last.nonRetryable||attempt===MAX_ATTEMPTS)throw last;}
   finally{controller.abort();try{void response?.body?.cancel().catch(()=>{});}catch{}clearTimer(timer);signal?.removeEventListener('abort',onAbort);}
   await sleep(attempt*500);
  }
  throw last;
 }
 const sync=await phase('SYNC');
 if(sync.payload.drainAuthorized!==true)return {ok:true,status:sync.status,attempt:sync.attempt,phase:'SYNC',drain:'DISABLED'};
 if(env.BRIEFING_EXECUTION_MODE!=='SHADOW'||!/^[a-f0-9]{64}$/.test(sync.payload.handoff))throw error('invalid_handoff',true);
 const drain=await phase('STAGE6_DRAIN',{requestId:sync.requestId,token:sync.payload.handoff});
 return {ok:true,status:drain.status,attempt:drain.attempt,phase:'STAGE6_DRAIN',outcome:drain.payload.result?.outcome};
}
export default {
 scheduled(_event,env,ctx){ctx.waitUntil(invoke(env).catch(e=>{console.error(JSON.stringify({event:'briefing_trigger_failed',category:e.category??'unknown',retryable:!e.nonRetryable}));throw e;}));},
 async fetch(){return new Response(JSON.stringify({ok:true,service:'briefing-scheduler'}),{status:200,headers:{'content-type':'application/json','cache-control':'no-store'}});},
};
