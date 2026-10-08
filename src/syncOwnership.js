import {executeCoordination} from './phase4Coordination.js';
/** Existing v31 resource_locks is the durable atomic ownership authority.
 * A random owner is also the generation: takeover always replaces it. No DB
 * transaction is held while waiting on WHOOP. */
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { requireUserId } from './userContext.js';
import { SETTLEMENT_MARGIN_MS, createExecutionBudget } from './executionBudget.js';
const scope = new AsyncLocalStorage();
export class SyncOwnershipError extends Error {
  constructor(code) { super(code); this.code = code; }
}
export async function withSyncOwnership({ db, userId, budget, leaseMs }, work) {
  const uid = requireUserId(userId, 'syncOwnership');
  const existing = scope.getStore();
  if (existing?.db === db && existing.userId === uid) { existing.budget.assert(); return work(existing); }
  if (!db.raw || typeof db.withRuntimeFence !== 'function') throw new SyncOwnershipError('SYNC_OWNERSHIP_REQUIRED');
  const ownBudget = !budget; budget ??= createExecutionBudget();
  const ttl = leaseMs ?? budget.remainingMs() + SETTLEMENT_MARGIN_MS;
  if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 195_000) throw new SyncOwnershipError('SYNC_LEASE_INVALID');
  const owner = randomUUID(), name = `phase4:sync:${uid}`, at = new Date().toISOString(), expiresAt = new Date(Date.now()+ttl).toISOString();
  budget.assert();
  const claim = await executeCoordination(db.raw,'claim',[name,owner,at,expiresAt])
  if (claim.rowsAffected !== 1) { if (ownBudget) budget.close(); throw new SyncOwnershipError('SYNC_SCOPE_BUSY'); }
  const check = async client => {
    budget.assert();
    if (client && !(await client.execute({sql:'SELECT 1 FROM resource_locks WHERE name=? AND owner=? AND expires_at=? AND expires_at>?',
      args:[name,owner,expiresAt,new Date().toISOString()]})).rows.length) throw new SyncOwnershipError('SYNC_OWNER_FENCED');
    budget.assert();
  };
  const context = Object.freeze({ db, userId:uid, budget, expiresAt:Date.parse(expiresAt), assertCurrent:()=>check(db.raw) });
  try { return await scope.run(context, () => db.withRuntimeFence(check, () => budget.run(() => work(context)))); }
  finally {
    // Late work retains the aborted/deadline guard; releasing only this owner's
    // row can never release a successor. Failure cleanup may rely on TTL.
    try { await executeCoordination(db.raw,'release',[name,owner]); } catch {}
    if (ownBudget) budget.close();
  }
}
export const currentSyncOwnership = () => scope.getStore();
