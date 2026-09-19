import { fail } from './phase4Core.js';

const LIFETIME=15*60*1000;
/** Non-health leases reuse resource_locks. No cache payload is persisted.
 * Consumers must release a context after dropping its transient health bytes.
 * A revoked context is never reusable, including after the purge completes. */
export function createPhase4ContextRegistry({client,keys,now,timestamp,newId}) {
  const local=new WeakMap();
  const prefix=userId=>`p4ctx:${keys.lookup(['context-tenant-v1',userId])}:`;
  async function register(context) {
    const name=prefix(context.userId)+newId(),owner=JSON.stringify([context.purgeGeneration,'ACTIVE']);
    const expires=new Date(now().getTime()+LIFETIME).toISOString();
    await client.execute({sql:'INSERT INTO resource_locks(name,owner,acquired_at,expires_at) VALUES (?,?,?,?)',args:[name,owner,timestamp(),expires]});
    local.set(context,{name,owner,expires,released:false,values:new Map()});
  }
  function state(context) { const entry=local.get(context);if(!entry || entry.released)fail('PHASE4_CONTEXT_RELEASED');return entry; }
  async function assertLease(context) {
    const entry=state(context);
    if(timestamp()>=entry.expires) { entry.values.clear();fail('PHASE4_CONTEXT_EXPIRED'); }
    const row=(await client.execute({sql:'SELECT owner FROM resource_locks WHERE name=? AND expires_at>?',args:[entry.name,timestamp()]})).rows[0];
    if(row?.owner!==entry.owner) {entry.values.clear();fail('PHASE4_CONTEXT_REVOKED');}
  }
  async function release(context) {
    const entry=local.get(context);if(!entry)fail('PHASE4_SERVER_CONTEXT_REQUIRED');
    entry.values.clear();entry.released=true;
    await client.execute({sql:'DELETE FROM resource_locks WHERE name=? AND owner=?',args:[entry.name,entry.owner]});
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
        await client.execute({sql:'DELETE FROM resource_locks WHERE name=? AND owner=? AND expires_at<=?',args:[row.name,row.owner,timestamp()]});
      }
    }
    return count;
  }
  function cacheKey(context,identity) {
    return keys.lookup(['context-cache-v1',context.userId,context.executionMode,identity,context.algorithmSetVersion,
      context.inputGeneration,context.lifecycleGeneration,context.authGeneration,context.purgeGeneration]);
  }
  return {register,assertLease,release,pending,
    get:(context,identity)=>state(context).values.get(cacheKey(context,identity)),
    set:(context,identity,value)=>state(context).values.set(cacheKey(context,identity),structuredClone(value))};
}
