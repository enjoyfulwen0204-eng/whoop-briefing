import {cloneResult} from './processingReadSnapshot.js';
const ownership=`SELECT state,lease_owner,lease_expires_at,requested_generation,
 claimed_generation,scope_revision,claimed_scope_revision,claimed_purge_generation,claimed_lifecycle_generation,
 claimed_auth_generation FROM phase4_jobs WHERE user_id=? AND execution_mode=? AND job_kind=?`;
const tenant='SELECT 1 FROM resource_locks WHERE name=? AND owner=? AND expires_at=? AND expires_at>?';
const contextLease='SELECT owner FROM resource_locks WHERE name=? AND expires_at>?';
const normalized=s=>s.replace(/\s+/g,' ').trim();
// Raw non-health DATA only. Every original clock/ownership/authority predicate
// still runs. Keep the entire original query and every clock argument in key.
export function inflightControlReadKey(statement,context){
 if(context?.executionMode!=='LIVE'||context.providerRequired!==true||typeof context.userId!=='string'
   ||!statement||typeof statement!=='object'||Array.isArray(statement))return null;
 const {sql,args}=statement;if(typeof sql!=='string'||!Array.isArray(args)
   ||args.some(value=>typeof value!=='string'||value.length>4096))return null;
 const shape=normalized(sql);
 const own=shape===normalized(ownership)&&args.length===3&&args[0]===context.userId&&args[1]==='LIVE';
 const lock=shape===tenant&&args.length===4&&args[0]===`phase4-stage6-pass:${JSON.stringify([context.userId,'LIVE'])}`;
 // Name shape is an eligibility filter, never HMAC/tenant authority. The
 // genuine context brand/WeakMap and every original expiry/owner predicate
 // remain in phase4Cache; the pool also keys the exact context object.
 const lease=shape===contextLease&&args.length===2&&/^p4ctx:[a-f0-9]{64}:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(args[0]);
 if(!own&&!lock&&!lease)return null;
 const key=JSON.stringify([sql,args]);return Buffer.byteLength(key)<=8192?key:null;
}
// Pending promises only: no completed observation or successful guard is kept.
// One pool belongs to one original acknowledged write root. Callers opt in
// only under its original execution, budget and branded readonly check.
export function createInflightControlReads(){
 let contexts=new Map(),entries=0,closed=false;
 return {
  close(){closed=true;contexts.clear();entries=0;},
  run(context,marker,key,epoch,read){
   if(closed||!key||!marker)return read();
   const identity=JSON.stringify([epoch,key]),markers=contexts.get(context),rows=markers?.get(marker),prior=rows?.get(identity);
   const copy=(result,joined)=>{try{return cloneResult(result);}catch(error){if(joined)throw error;return result;}};
   if(prior)return prior.promise.then(result=>copy(result,true));
   if(entries>=128)return read();
   // Submit synchronously in the original position, before another caller
   // can submit a mutation. No new queue, timer, retry or transaction exists.
   const value=read(),byMarker=markers??new Map(),pending=rows??new Map(),entry={};
   const remove=()=>{if(pending.get(identity)!==entry)return;pending.delete(identity);
    if(contexts.get(context)===byMarker&&byMarker.get(marker)===pending){entries--;if(!pending.size)byMarker.delete(marker);if(!byMarker.size)contexts.delete(context);}};
   entry.promise=Promise.resolve(value).then(result=>{remove();return result;},error=>{remove();throw error;});
   pending.set(identity,entry);byMarker.set(marker,pending);contexts.set(context,byMarker);entries++;
   return entry.promise.then(result=>copy(result,false));
  },
 };
}
