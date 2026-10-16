/** Source-only encrypted ingress. Runtime remains disabled without an exact
 * separately authorized compiled pin, matching configuration and queue binding.
 * Only a public encryption key reaches this producer. Original WHOOP HMAC
 * authentication and canonical ledger consumption remain local.
 */
export const BUFFER_PATH='/whoop/encrypted-buffer/v1';
export const BUFFER_PROBE_PATH='/whoop/encrypted-buffer/probe/v1';
export const MAX_WHOOP_BYTES=16*1024;
export const WHOOP_FRESH_MS=5*60_000;
export const MAX_QUEUE_ENQUEUE_SKEW_MS=60_000;
export const BUFFER_ACTIVE_MS=2*60*60_000;
export const MAX_BUFFER_HOLD_MS=24*60*60_000;
const CONTRACT='stage8-whoop-encrypted-buffer-v1',encoder=new TextEncoder();
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v,keys)=>object(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const fail=code=>{throw Object.assign(Error(code),{code});};
const integer=v=>Number.isSafeInteger(v)&&v>0;
const hex=bytes=>Array.from(new Uint8Array(bytes),v=>v.toString(16).padStart(2,'0')).join('');
const base64=bytes=>{let raw='';for(const b of new Uint8Array(bytes))raw+=String.fromCharCode(b);return btoa(raw);};
function bytes64(value,max=65536){if(typeof value!=='string'||value.length>Math.ceil(max/3)*4||value.length%4!==0||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))fail('BUFFER_BASE64_INVALID');const bytes=Uint8Array.from(atob(value),c=>c.charCodeAt(0));if(bytes.length>max||base64(bytes)!==value)fail('BUFFER_BASE64_INVALID');return bytes;}
const aad=pin=>encoder.encode(CONTRACT+'\n'+pin.approvalId+'\n'+pin.publicKeyFingerprint+'\n'+pin.queueId);
function pinOf(value){
 if(!exact(value,['contract','approvalId','accountId','workerName','queueId','origin','publicKeyFingerprint','publicKeySpkiBase64','acceptFromMs','acceptUntilMs','maxHoldMs'])
  ||value.contract!=='stage8-whoop-buffer-owner-approval-v1'||typeof value.approvalId!=='string'||!/^owner-[A-Za-z0-9_.-]{1,90}$/.test(value.approvalId)
  ||value.accountId!=='17558c0263c5c4076055ee0f860907dc'||value.workerName!=='whoop-briefing-scheduler'
  ||typeof value.queueId!=='string'||!/^[a-f0-9]{32}$/.test(value.queueId)||!(/^[a-f0-9]{64}$/).test(value.publicKeyFingerprint??'')
  ||!integer(value.acceptFromMs)||!integer(value.acceptUntilMs)||value.acceptUntilMs-value.acceptFromMs!==BUFFER_ACTIVE_MS
  ||!integer(value.maxHoldMs)||value.maxHoldMs>MAX_BUFFER_HOLD_MS)fail('BUFFER_SEPARATE_PINNED_OWNER_APPROVAL_REQUIRED');
 let url;try{url=new URL(value.origin);}catch{fail('BUFFER_PINNED_WORKER_ORIGIN_REQUIRED');}
 if(url.protocol!=='https:'||url.origin!==value.origin||!url.hostname.endsWith('.workers.dev')||url.username||url.password)fail('BUFFER_PINNED_WORKER_ORIGIN_REQUIRED');
 bytes64(value.publicKeySpkiBase64,1024);return structuredClone(value);
}
export const validateApprovedWhoopBufferPin=value=>pinOf(value);
function publicHeaders(headers,receivedAt){
 const timestamp=headers.get('x-whoop-signature-timestamp'),signature=headers.get('x-whoop-signature');
 if(typeof timestamp!=='string'||!/^\d{13}$/.test(timestamp)||!Number.isSafeInteger(Number(timestamp))||Math.abs(receivedAt-Number(timestamp))>WHOOP_FRESH_MS)fail('BUFFER_WHOOP_TIMESTAMP_NOT_FRESH');
 if(typeof signature!=='string'||!(/^[A-Za-z0-9+/]{43}=$/).test(signature)||bytes64(signature,32).length!==32)fail('BUFFER_WHOOP_SIGNATURE_SHAPE_INVALID');
 return {timestamp,signature};
}
function approvedMetadataOnly(raw){
 let text,value;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(raw);value=JSON.parse(text);}catch{return false;}
 if(!exact(value,['user_id','id','type','trace_id']))return false;
 // Reject duplicate/escaped keys; otherwise JSON.parse could hide an earlier
 // out-of-scope value while the ORIGINAL bytes still entered encrypted storage.
 const keys=[...text.matchAll(/"((?:[^"\\]|\\.)*)"\s*:/g)].map(m=>m[1]);
 if(keys.length!==4||new Set(keys).size!==4||keys.some(k=>!['user_id','id','type','trace_id'].includes(k)))return false;
 const user=typeof value.user_id==='number'?Number.isSafeInteger(value.user_id)&&value.user_id>0:typeof value.user_id==='string'&&/^[1-9]\d{0,19}$/.test(value.user_id);
 const uuid=v=>typeof v==='string'&&/^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/.test(v);
 return Boolean(user&&uuid(value.id)&&uuid(value.trace_id)&&['sleep.updated','sleep.deleted','recovery.updated','recovery.deleted','workout.updated','workout.deleted'].includes(value.type));
}
async function deadline(work,ms){let timer;try{return await Promise.race([Promise.resolve(work),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('BUFFER_OPERATION_DEADLINE')),ms);})]);}finally{clearTimeout(timer);}}
async function boundedBody(request,limit,timeoutMs){
 const reader=request.body?.getReader();if(!reader)return new Uint8Array();let size=0;const chunks=[];
 try{return await deadline((async()=>{for(;;){const p=await reader.read();if(p.done)break;size+=p.value.length;if(size>limit)fail('BUFFER_BODY_TOO_LARGE');chunks.push(p.value);}const bytes=new Uint8Array(size);let at=0;for(const c of chunks){bytes.set(c,at);at+=c.length;}return bytes;})(),timeoutMs);}
 finally{try{void reader.cancel().catch(()=>{});}catch{}try{reader.releaseLock();}catch{}}
}
async function publicKey(pin,cryptoImpl){
 const spki=bytes64(pin.publicKeySpkiBase64,1024);if(hex(await cryptoImpl.subtle.digest('SHA-256',spki))!==pin.publicKeyFingerprint)fail('BUFFER_PUBLIC_KEY_FINGERPRINT_MISMATCH');
 const key=await cryptoImpl.subtle.importKey('spki',spki,{name:'RSA-OAEP',hash:'SHA-256'},false,['encrypt']);
 if(key.algorithm.modulusLength<3072)fail('BUFFER_RSA3072_REQUIRED');return key;
}
async function encrypt(payload,pin,key,cryptoImpl){
 const raw=cryptoImpl.getRandomValues(new Uint8Array(32)),iv=cryptoImpl.getRandomValues(new Uint8Array(12));let plain;
 try{
  const aes=await cryptoImpl.subtle.importKey('raw',raw,{name:'AES-GCM'},false,['encrypt']);plain=encoder.encode(JSON.stringify(payload));
  const [wrapped,ciphertext]=await Promise.all([cryptoImpl.subtle.encrypt({name:'RSA-OAEP',label:aad(pin)},key,raw),cryptoImpl.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad(pin),tagLength:128},aes,plain)]);
  return {contract:CONTRACT,approvalId:pin.approvalId,keyFingerprint:pin.publicKeyFingerprint,wrappedKey:base64(wrapped),iv:base64(iv),ciphertext:base64(ciphertext)};
 }finally{raw.fill(0);plain?.fill(0);}
}
const response=status=>new Response(JSON.stringify({ok:status===200}),{status,headers:{'content-type':'application/json','cache-control':'no-store'}});
const probeMessage=async({pin,timestamp,requestId,rawBody,cryptoImpl})=>encoder.encode(['WHOOP_BUFFER_OPERATOR_PROBE_V1',pin.approvalId,pin.queueId,pin.origin,timestamp,requestId,'POST',BUFFER_PROBE_PATH,hex(await cryptoImpl.subtle.digest('SHA-256',rawBody))].join('\n'));
/** Concrete, domain-separated use of the EXISTING Worker trigger secret.
 * Scheduler v1 signatures cannot verify under this message domain/path.
 * No new secret and no WHOOP/Turso credential is copied to the Worker.
 */
export async function signWhoopBufferProbe({approvedPin,timestamp,requestId,rawBody,secret,cryptoImpl=globalThis.crypto}){
 const pin=pinOf(approvedPin);if(typeof secret!=='string'||encoder.encode(secret).length<32||!/^\d{13}$/.test(timestamp)||!(/^[a-f0-9]{64}$/).test(requestId??''))fail('BUFFER_PROBE_AUTH_REQUIRED');
 const key=await cryptoImpl.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 return 'v1='+hex(await cryptoImpl.subtle.sign('HMAC',key,await probeMessage({pin,timestamp,requestId,rawBody,cryptoImpl})));
}
export function createWhoopBufferProbeAuthenticator({approvedPin,secret,cryptoImpl=globalThis.crypto}={}){
 const pin=approvedPin?structuredClone(approvedPin):null;
 return async({request,rawBody,receivedAt,path})=>{
  try{
   const bound=pinOf(pin),url=new URL(request.url),timestamp=request.headers.get('x-whoop-buffer-probe-timestamp'),requestId=request.headers.get('x-whoop-buffer-probe-id'),signature=request.headers.get('x-whoop-buffer-probe-signature');
   if(typeof secret!=='string'||encoder.encode(secret).length<32||path!==BUFFER_PROBE_PATH||url.origin!==bound.origin||url.pathname!==path||url.search||request.method!=='POST'||!/^\d{13}$/.test(timestamp??'')||Math.abs(receivedAt-Number(timestamp))>WHOOP_FRESH_MS||!(/^[a-f0-9]{64}$/).test(requestId??'')||!(/^v1=[a-f0-9]{64}$/).test(signature??''))return false;
   const key=await cryptoImpl.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['verify']),sig=Uint8Array.from(signature.slice(3).match(/../g),v=>parseInt(v,16));
   return await cryptoImpl.subtle.verify('HMAC',key,sig,await probeMessage({pin:bound,timestamp,requestId,rawBody,cryptoImpl}));
  }catch{return false;}
 };
}
/** approvedPin must be separately reviewed source compiled AFTER the exact new
 * queue/security/data-scope approval. Do not construct it from env or JSON.
 * configuration is only an equality-checked runtime copy, never approval.
 * assertOperatorProbe must verify a fresh, path-bound operator authentication
 * before any probe is encrypted. Default is disabled. No WHOOP secret needed.
 */
export function createEncryptedWhoopBuffer({approvedPin=null,configuration={enabled:'off'},queue=null,cryptoImpl=globalThis.crypto,now=Date.now,assertOperatorProbe=null,operationTimeoutMs=10_000}={}){
 approvedPin=approvedPin?structuredClone(approvedPin):null;configuration=structuredClone(configuration);
 return async request=>{
  const url=new URL(request.url);if(![BUFFER_PATH,BUFFER_PROBE_PATH].includes(url.pathname))return null;
  let body;
  try{
   if(!approvedPin||configuration.enabled!=='on'||!exact(configuration,['enabled','binding'])||JSON.stringify(configuration.binding)!==JSON.stringify(approvedPin)||typeof queue?.send!=='function'||!Number.isSafeInteger(operationTimeoutMs)||operationTimeoutMs<1||operationTimeoutMs>15_000)return response(503);
   const pin=pinOf(approvedPin),receivedAt=now();if(!integer(receivedAt)||receivedAt<pin.acceptFromMs||receivedAt>=pin.acceptUntilMs)return response(503);
   if(url.origin!==pin.origin||url.search||url.hash)return response(400);if(request.method!=='POST')return response(405);
   const key=await deadline(publicKey(pin,cryptoImpl),operationTimeoutMs);let payload;
   if(url.pathname===BUFFER_PROBE_PATH){
    if(typeof assertOperatorProbe!=='function')return response(404);
    body=await boundedBody(request,256,operationTimeoutMs);if(await assertOperatorProbe({request,rawBody:body,receivedAt,path:BUFFER_PROBE_PATH})!==true)return response(401);
    let control;try{control=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body));}catch{return response(400);}
    if(!exact(control,['contract','nonce'])||control.contract!=='WHOOP_BUFFER_OPERATOR_PROBE_V1'||typeof control.nonce!=='string'||!/^[a-f0-9]{64}$/.test(control.nonce))return response(400);
    payload={kind:'OPERATOR_PROBE',approvalId:pin.approvalId,receivedAt,nonce:control.nonce};
   }else{
    let headers;try{headers=publicHeaders(request.headers,receivedAt);}catch{return response(401);}
    body=await boundedBody(request,MAX_WHOOP_BYTES,operationTimeoutMs);if(!body.length||!approvedMetadataOnly(body))return response(400);
    payload={kind:'WHOOP_EVENT',approvalId:pin.approvalId,receivedAt,timestamp:headers.timestamp,signature:headers.signature,rawBodyBase64:base64(body)};
   }
   // No ctx.waitUntil/fire-and-forget success: durable Queue.send must resolve.
   // A timeout/uncertain enqueue returns503; later duplicate ingestion is safe.
   const encrypted=await deadline(encrypt(payload,pin,key,cryptoImpl),operationTimeoutMs);
   const beforeSend=now();
   if(!integer(beforeSend)||beforeSend<receivedAt||beforeSend+operationTimeoutMs>=pin.acceptUntilMs||beforeSend-receivedAt+operationTimeoutMs>MAX_QUEUE_ENQUEUE_SKEW_MS)return response(503);
   // Reserve the full allowed enqueue skew before acknowledging an event.
   // Otherwise a near-expiry WHOOP signature could receive200 here but fail
   // the consumer's authoritative enqueue-time freshness check.
   if(payload.kind==='WHOOP_EVENT'&&Math.abs(beforeSend-Number(payload.timestamp))>WHOOP_FRESH_MS-MAX_QUEUE_ENQUEUE_SKEW_MS)return response(503);
   await deadline(queue.send(encrypted,{contentType:'json'}),operationTimeoutMs);
   const afterSend=now();
   if(!integer(afterSend)||afterSend<beforeSend||afterSend>=pin.acceptUntilMs||afterSend-receivedAt>MAX_QUEUE_ENQUEUE_SKEW_MS||payload.kind==='WHOOP_EVENT'&&Math.abs(afterSend-Number(payload.timestamp))>WHOOP_FRESH_MS)return response(503);
   return response(200);
  }catch{return response(503);}finally{body?.fill(0);}
 };
}
