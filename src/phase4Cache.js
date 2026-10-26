import {processingContextLeaseDataEligible} from './processingTransaction.js';
import {CONTEXT_LEASE_DATA_SQL} from './processingInflightControlReads.js';
import {executeCoordination} from './phase4Coordination.js';
import { fail } from './phase4Core.js';
import {requireUserId} from './userContext.js';

export function phase4UserStateStatement(userId){
 const uid=requireUserId(userId,'phase4');
 return {sql:`SELECT u.id,u.status,u.timezone,u.lifecycle_generation,
      COALESCE(t.auth_generation,0) auth_generation,p.source_generation,p.purge_generation,p.pending_purge_count
      FROM users u LEFT JOIN user_whoop_tokens t ON t.user_id=u.id
      LEFT JOIN phase4_user_state p ON p.user_id=u.id WHERE u.id=?`,args:[uid]};
}

const LIFETIME=15*60*1000;
// Only canonical ASCII ISO TEXT has the same ordering in SQLite BINARY and
// JavaScript. Unsupported rows keep the exact original SQL/clock predicate.
const canonicalLeaseTime=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
 &&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
export function projectContextLeaseData(row,at){
 if(row===undefined)return {supported:true,owner:undefined};
 if(!row||typeof row!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(row)))return {supported:false};
 const d=Object.getOwnPropertyDescriptors(row),owner=d.owner,expiry=d.expires_at;
 if(!owner||!expiry||!Object.hasOwn(owner,'value')||!Object.hasOwn(expiry,'value')||typeof owner.value!=='string'
   ||!canonicalLeaseTime(expiry.value)||!canonicalLeaseTime(at))return {supported:false};
 return {supported:true,owner:expiry.value>at?owner.value:undefined};
}

/** Non-health leases reuse resource_locks. No cache payload is persisted.
 * Consumers must release a context after dropping its transient health bytes.
 * A revoked context is never reusable, including after the purge completes. */
export function createPhase4ContextRegistry({client,keys,now,timestamp,newId}) {
  const local=new WeakMap();
  const prefix=userId=>`p4ctx:${keys.lookup(['context-tenant-v1',userId])}:`;
  async function register(context) {
    const name=prefix(context.userId)+newId(),owner=JSON.stringify([context.purgeGeneration,'ACTIVE']);
    const expires=new Date(now().getTime()+LIFETIME).toISOString();
    await executeCoordination(client,'insert',[name,owner,timestamp(),expires]);
    local.set(context,{name,owner,expires,released:false,values:new Map()});
  }
  function state(context) { const entry=local.get(context);if(!entry || entry.released)fail('PHASE4_CONTEXT_RELEASED');return entry; }
  async function assertLease(context) {
    const entry=state(context);
    if(timestamp()>=entry.expires) { entry.values.clear();fail('PHASE4_CONTEXT_EXPIRED'); }
    const at=timestamp();let owner;
    if(processingContextLeaseDataEligible(client,context,entry.name)){
      const raw=(await client.execute({sql:CONTEXT_LEASE_DATA_SQL,args:[entry.name]})).rows[0],projected=projectContextLeaseData(raw,at);
      if(projected.supported)owner=projected.owner;
      else owner=(await client.execute({sql:'SELECT owner FROM resource_locks WHERE name=? AND expires_at>?',args:[entry.name,at]})).rows[0]?.owner;
    }else owner=(await client.execute({sql:'SELECT owner FROM resource_locks WHERE name=? AND expires_at>?',args:[entry.name,at]})).rows[0]?.owner;
    if(owner!==entry.owner) {entry.values.clear();fail('PHASE4_CONTEXT_REVOKED');}
  }
  // This method itself obtains all DATA from the actual owned client. No
  // caller-supplied lease row or successful assertion can be reused.
  async function assertLeaseAndControlData(context) {
    const entry=state(context);
    if(timestamp()>=entry.expires){entry.values.clear();fail('PHASE4_CONTEXT_EXPIRED');}
    const at=timestamp();
    // Fixed three statements only. The original SQL expiry predicate also
    // retains the registry's fallback semantics for noncanonical lease data.
    const results=await client.batch([
      {sql:'SELECT owner FROM resource_locks WHERE name=? AND expires_at>?',args:[entry.name,at]},
      phase4UserStateStatement(context.userId),
      {sql:'SELECT * FROM phase4_computation_state WHERE user_id=? AND execution_mode=?',args:[context.userId,context.executionMode]},
    ]);
    const owner=results[0].rows[0]?.owner;
    if(owner!==entry.owner){entry.values.clear();fail('PHASE4_CONTEXT_REVOKED');}
    return results.slice(1);
  }
  async function release(context) {
    const entry=local.get(context);if(!entry)fail('PHASE4_SERVER_CONTEXT_REQUIRED');
    entry.values.clear();entry.released=true;
    await executeCoordination(client,'release',[entry.name,entry.owner]);
  }
  async function pending(userId,generation) {
    const rows=(await client.execute({sql:'SELECT name,owner,expires_at FROM resource_locks WHERE substr(name,1,?)=?',args:[prefix(userId).length,prefix(userId)]})).rows;
    let count=0;
    for(const row of rows) {
      let captured;try {captured=JSON.parse(row.owner);}catch {fail('PHASE4_CACHE_LEASE_CORRUPT');}
      if(captured[0]>=generation)continue;
      if(row.expires_at>timestamp())count++;
      else {
        // Observing the new durable generation after bounded lease expiry is
        // required; expiry alone never grants a read or releases this fence.
        await executeCoordination(client,'releaseExpired',[row.name,row.owner,timestamp()]);
      }
    }
    return count;
  }
  function cacheKey(context,identity) {
    return keys.lookup(['context-cache-v1',context.userId,context.executionMode,identity,context.algorithmSetVersion,
      context.inputGeneration,context.lifecycleGeneration,context.authGeneration,context.purgeGeneration]);
  }
  return {register,assertLease,assertLeaseAndControlData,release,pending,clear:context=>local.get(context)?.values.clear(),
    get:(context,identity)=>state(context).values.get(cacheKey(context,identity)),
    set:(context,identity,value)=>state(context).values.set(cacheKey(context,identity),structuredClone(value))};
}
