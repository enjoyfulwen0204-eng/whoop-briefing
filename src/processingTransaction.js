import { AsyncLocalStorage } from 'node:async_hooks';

// Retry admission and COMMIT, never an application callback. Admission reads
// the winner's receipt under a fresh lock; a busy COMMIT keeps its existing
// transaction. Cleanup transactions use the same finite contention bound.
async function retryContention(call,{afterBusy}={}) {
  const deadline=Date.now()+15000;
  for(let attempt=0;;attempt++) {
    try {return await call();}
    catch(error) {
      const busy=[error,error.cause].some(value=>value&&/^(SQLITE_BUSY|SQLITE_LOCKED)(_|$)/.test(value.code??''));
      if(!busy||attempt>=64||Date.now()>=deadline)throw error;
      if(afterBusy)await afterBusy();
      await new Promise(resolve=>setTimeout(resolve,Math.min(25*2**Math.min(attempt,4),250,deadline-Date.now())));
    }
  }
}

/** All stores share this executor, so a processing transaction includes every
 * database side effect, even writes hidden behind a store/helper function. */
export function processingTransactions(base) {
  const scope = new AsyncLocalStorage();
  // Several legacy callers intentionally read in Promise.all. Privacy-fenced
  // reads now use this same transactional boundary; serialize root write
  // transactions on a connection, without holding the queue across outside()
  // provider work. Nested calls continue to share the active transaction.
  let rootTail=Promise.resolve();
  const executorOverrides=new Map();
  const refreshIdleConnection=base.protocol==='file'&&typeof base.reconnect==='function'?()=>base.reconnect():undefined;
  async function acquireRoot() {
    const prior=rootTail;let release;
    rootTail=new Promise(resolve=>{release=resolve;});await prior;return release;
  }
  const client = new Proxy(base, {
    get(target, key) {
      if (key === 'execute' || key === 'batch') {
        if(executorOverrides.has(key))return executorOverrides.get(key);
        const method = target[key].bind(target);
        return async (...args) => {
        const state = scope.getStore();
        if (state?.failure) throw state.failure;
        const release=state?null:await acquireRoot();
        try {
          if(state)return await state.tx[key](...args);
          const sql=key==='execute'?(typeof args[0]==='string'?args[0]:args[0]?.sql):'';
          // Foundation/schema reads can overlap another process's writer even
          // before a request lease exists. Retry only these read-only statements.
          const readOnly=/^\s*(SELECT\b|PRAGMA\s+(table_info|database_list|index_list|index_info|foreign_key_list|integrity_check|foreign_key_check)\b)/i.test(sql);
          return await (readOnly?retryContention(()=>method(...args),{afterBusy:refreshIdleConnection}):method(...args));
        }
        catch (error) { if (state) state.failure = error; throw error; }
        finally {release?.();}
        };
      }
      const value = target[key];
      return typeof value === 'function' ? value.bind(target) : value;
    },
    set(target,key,value) {
      // Test/fault-injection decorators may call a previously captured facade.
      // Never install that decorator on base: doing so recursively queues the
      // same operation behind its own connection lock.
      if(key==='execute'||key==='batch'){executorOverrides.set(key,value);return true;}
      return Reflect.set(target,key,value);
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

  async function transaction(fn, { before, after, beforeCommit,commitFence } = {}) {
    const parent = scope.getStore();
    if (parent) {
      try {
        if (before) await before(client);
        if (after) parent.checks.push(after);
        if (beforeCommit) parent.finalChecks.push(beforeCommit);
        if (commitFence) parent.commitFences.add(commitFence);
        return await fn();
      } catch (error) { parent.failure = error; throw error; }
    }
    const cache = new Map();
    for (let attempt = 0; attempt < 12; attempt++) {
      const releaseRoot=await acquireRoot();
      let tx;
      const state = { tx:null, cache, checks: after ? [after] : [], finalChecks:beforeCommit?[beforeCommit]:[],commitFences:new Set(commitFence?[commitFence]:[]),
        failure: null, deferred: null, committed: [], completed: [] };
      try {
        tx=await retryContention(()=>base.transaction('write'),{
          // A failed local BEGIN can retain an unfinished native statement.
          // No transaction/callback exists yet, so discard that idle connection
          // before re-admission; never reconnect an active transaction.
          afterBusy:refreshIdleConnection,
        });state.tx=tx;
        const result = await scope.run(state, async () => {
          if (before) await before(client);
          const result = await fn();
          if (state.failure) throw state.failure;
          for (const check of state.checks) await check(client);
          if (state.failure) throw state.failure;
          await retryContention(async()=>{
            // Recheck ownership after all deferred result validation and before
            // each COMMIT attempt, including time spent waiting on contention.
            for(const check of state.finalChecks)await check(client);
            for(const check of state.commitFences)await check(client);
            if(state.failure)throw state.failure;
            await tx.commit();
          });
          return result;
        });
        tx.close();tx=null;releaseRoot();
        for (const cleanup of state.committed) { try { await cleanup(); } catch { /* TTL recovery */ } }
        return result;
      } catch (error) {
        try { await tx?.rollback(); } catch { /* closed/rolled back by storage */ }
        if (!state.deferred) throw error;
      } finally {
        try {tx?.close();} finally {releaseRoot();}
        for(const cleanup of state.completed)await cleanup();
      }
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
  function afterCompletion(fn) {
    const state=scope.getStore();
    if(state){state.completed.push(fn);return;}
    return fn();
  }
  return { client, transaction, outside, afterCommit, afterCompletion, active: () => Boolean(scope.getStore()) };
}
