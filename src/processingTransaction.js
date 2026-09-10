import { AsyncLocalStorage } from 'node:async_hooks';

/** All stores share this executor, so a processing transaction includes every
 * database side effect, even writes hidden behind a store/helper function. */
export function processingTransactions(base) {
  const scope = new AsyncLocalStorage();
  const client = new Proxy(base, {
    get(target, key) {
      if (key === 'execute' || key === 'batch') {
        const method = target[key].bind(target);
        return async (...args) => {
        const state = scope.getStore();
        if (state?.failure) throw state.failure;
        try { return await (state ? state.tx[key](...args) : method(...args)); }
        catch (error) { if (state) state.failure = error; throw error; }
        };
      }
      const value = target[key];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  // Do not hold a database write transaction while waiting for a provider.
  // Roll back the speculative attempt, obtain/cache parsing outside the transaction,
  // then rerun against fresh database state. No speculative write can commit.
  async function outside(key, call) {
    const state = scope.getStore();
    if (!state) return call();
    if (state.cache.has(key)) return state.cache.get(key);
    const error = new Error('processing_external_input_required');
    state.deferred = { key, call };
    state.failure = error;
    throw error;
  }

  async function transaction(fn, { before, after } = {}) {
    const parent = scope.getStore();
    if (parent) {
      try {
        if (before) await before(client);
        if (after) parent.checks.push(after);
        return await fn();
      } catch (error) { parent.failure = error; throw error; }
    }
    const cache = new Map();
    for (let attempt = 0; attempt < 12; attempt++) {
      const tx = await base.transaction('write');
      const state = { tx, cache, checks: after ? [after] : [], failure: null, deferred: null, committed: [] };
      try {
        const result = await scope.run(state, async () => {
          if (before) await before(client);
          const result = await fn();
          if (state.failure) throw state.failure;
          for (const check of state.checks) await check(client);
          if (state.failure) throw state.failure;
          await tx.commit();
          return result;
        });
        for (const cleanup of state.committed) { try { await cleanup(); } catch { /* TTL recovery */ } }
        return result;
      } catch (error) {
        try { await tx.rollback(); } catch { /* closed/rolled back by storage */ }
        if (!state.deferred) throw error;
      } finally { tx.close(); }
      const { key, call } = state.deferred;
      cache.set(key, await call());
    }
    throw new Error('processing_external_input_limit');
  }
  function afterCommit(fn) {
    const state = scope.getStore();
    if (state) { state.committed.push(fn); return; }
    return fn();
  }
  return { client, transaction, outside, afterCommit, active: () => Boolean(scope.getStore()) };
}
