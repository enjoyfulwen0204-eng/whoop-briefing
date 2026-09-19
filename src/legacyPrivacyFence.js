import { requireUserId } from './userContext.js';
import { fail } from './phase4Core.js';
import { randomUUID } from 'node:crypto';
import { createPhase4ContextRegistry } from './phase4Cache.js';
import { AccountInactiveError } from './accountLifecycle.js';

/** Compatibility fence for pre-Phase-4 server APIs. This never grants LIVE
 * computation authority and never starts an analytics/delivery worker. */
export function legacyPrivacyFence(client,keys) {
  const registry=createPhase4ContextRegistry({client,keys,now:()=>new Date(),timestamp:()=>new Date().toISOString(),newId:()=>randomUUID()});
  let installed=false;
  async function available() {
    if(installed)return true;
    installed=(await client.execute('PRAGMA table_info(telegram_operations)')).rows.some(c=>c.name==='content_state');
    return installed;
  }
  async function capture(userId) {
    if(!await available())return null;
    const uid=requireUserId(userId,'privacyFence');
    const user=(await client.execute({sql:`SELECT u.id,u.status,u.lifecycle_generation,
      COALESCE(t.auth_generation,0) auth_generation FROM users u LEFT JOIN user_whoop_tokens t ON t.user_id=u.id WHERE u.id=?`,args:[uid]})).rows[0];
    if(!user)fail('PHASE4_TENANT_NOT_FOUND');
    if(user.status!=='ACTIVE')throw new AccountInactiveError(uid);
    // Existing server APIs support users created after migration. Metadata is
    // initialized lazily, with no LIVE row or reset of an existing counter.
    const at=new Date().toISOString();
    await client.execute({sql:`INSERT INTO phase4_user_state(user_id,created_at,updated_at) VALUES (?,?,?) ON CONFLICT DO NOTHING`,args:[uid,at,at]});
    const state=(await client.execute({sql:'SELECT purge_generation,pending_purge_count FROM phase4_user_state WHERE user_id=?',args:[uid]})).rows[0];
    if(!state || state.pending_purge_count!==0)fail('PHASE4_PURGE_FENCED');
    await client.execute({sql:`INSERT INTO phase4_computation_state(user_id,execution_mode,source_generation_seen,algorithm_set_version,created_at,updated_at)
      SELECT user_id,'SHADOW',source_generation,'phase4-foundation-v1',?,? FROM phase4_user_state WHERE user_id=? ON CONFLICT DO NOTHING`,args:[at,at,uid]});
    return Object.freeze({userId:uid,purgeGeneration:state.purge_generation,lifecycleGeneration:user.lifecycle_generation,authGeneration:user.auth_generation});
  }
  async function assert(fence) {
    if(!fence)return;
    const row=(await client.execute({sql:`SELECT p.purge_generation,p.pending_purge_count,u.status,u.lifecycle_generation,
      COALESCE(t.auth_generation,0) auth_generation FROM phase4_user_state p JOIN users u ON u.id=p.user_id
      LEFT JOIN user_whoop_tokens t ON t.user_id=u.id WHERE p.user_id=?`,args:[fence.userId]})).rows[0];
    if(!row || row.pending_purge_count!==0 || row.purge_generation!==fence.purgeGeneration)fail('PHASE4_PURGE_FENCED');
    if(row.status!=='ACTIVE'||row.lifecycle_generation!==fence.lifecycleGeneration)throw new AccountInactiveError(fence.userId);
    if(row.auth_generation!==fence.authGeneration)fail('PHASE4_AUTH_FENCED');
  }
  return {available,capture,assert,track:async fence=>{if(fence)await registry.register(fence);},
    release:async fence=>{if(fence)await registry.release(fence);},checkLease:async fence=>{if(fence)await registry.assertLease(fence);}};
}
