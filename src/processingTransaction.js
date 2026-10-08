import { AsyncLocalStorage } from 'node:async_hooks';
import { currentExecutionBudget,ExecutionBudgetError } from './executionBudget.js';
import {appendExecutionReceipt,currentDurableExecution,CommitIndeterminateError,requireSettledOperation,readWorkStep} from './phase4ExecutionContext.js';
import {inRuntimeMetadata} from './runtimeMetadataContext.js';
import {reconcileExecution} from './phase4ExecutionStore.js';
import {inExecutionCoordination} from './phase4Coordination.js';
function missingStep(){const execution=currentDurableExecution(),error=Object.assign(Error('EXECUTION_WORK_STEP_REQUIRED'),{code:'EXECUTION_WORK_STEP_REQUIRED'});
 if(execution&&!execution.workRejected)execution.workRejected=error;throw error;}
// This only separates supported read statements from mutations; it never
// supplies a work identity. SQLite CTEs cannot contain DML; their final verb
// must be SELECT. Quoted text/comments and nested expressions are not verbs.
export function readOnlyStatement(statement){
 const sql=typeof statement==='string'?statement:Array.isArray(statement)?statement[0]:statement?.sql??'';
 const tokens=[];let depth=0,ended=false;
 for(let i=0;i<sql.length;){const c=sql[i];
  if(/\s/.test(c)){i++;continue;}
  if(sql.startsWith('--',i)){const end=sql.indexOf('\n',i+2);i=end<0?sql.length:end+1;continue;}
  if(sql.startsWith('/*',i)){const end=sql.indexOf('*/',i+2);if(end<0)return false;i=end+2;continue;}
  if(ended)return false;
  if(c==='\''||c==='"'||c==='`'||c==='['){const end=c==='['?']':c;i++;let closed=false;
   while(i<sql.length){if(sql[i++]===end){if(sql[i]===end){i++;continue;}closed=true;break;}}if(!closed)return false;continue;}
  if(c==='('){depth++;i++;continue;}if(c===')'){if(--depth<0)return false;i++;continue;}
  if(c===';'&&depth===0){ended=true;i++;continue;}
  const word=sql.slice(i).match(/^[a-z_][a-z0-9_]*/i);if(word){if(depth===0)tokens.push(word[0].toUpperCase());i+=word[0].length;continue;}i++;
 }
 if(depth!==0)return false;
 if(tokens[0]==='SELECT')return true;
 if(tokens[0]==='WITH')return tokens.slice(1).find(token=>['SELECT','UPDATE','INSERT','DELETE','REPLACE'].includes(token))==='SELECT';
 if(tokens[0]!=='PRAGMA'||sql.includes('='))return false;
 if(['FOREIGN_KEYS','IGNORE_CHECK_CONSTRAINTS'].includes(tokens[1]))return /^\s*PRAGMA\s+(foreign_keys|ignore_check_constraints)\s*;?\s*$/i.test(sql);
 return ['TABLE_INFO','TABLE_XINFO','DATABASE_LIST','INDEX_LIST','INDEX_INFO','INDEX_XINFO','FOREIGN_KEY_LIST','INTEGRITY_CHECK','FOREIGN_KEY_CHECK'].includes(tokens[1]);
}

// Retry admission and COMMIT, never an application callback. Admission reads
// the winner's receipt under a fresh lock; a busy COMMIT keeps its existing
// transaction. Cleanup transactions use the same finite contention bound.
async function retryContention(call,{afterBusy,deadlineAt=Date.now()+15000}={}) {
  const budget=currentExecutionBudget();
  const deadline=Math.min(deadlineAt,budget?.deadlineAt??Infinity);
  for(let attempt=0;;attempt++) {
    budget?.assert();
    try {return await call();}
    catch(error) {
      if(error.definiteCommitRejection)throw error;
      const busy=[error,error.cause].some(value=>value&&/^(SQLITE_BUSY|SQLITE_LOCKED)(_|$)/.test(value.code??''));
      if(!busy||attempt>=64||Date.now()>=deadline)throw error;
      if(afterBusy)await afterBusy(deadline);
      await new Promise(resolve=>setTimeout(resolve,Math.max(0,Math.min(25*2**Math.min(attempt,4)+Math.floor(Math.random()*10),250,deadline-Date.now()))));
    }
  }
}

/** All stores share this executor, so a processing transaction includes every
 * database side effect, even writes hidden behind a store/helper function. */
export function processingTransactions(base,{privateRuntime=false}={}) {
  const scope = new AsyncLocalStorage();
  const fenceScope = new AsyncLocalStorage(), checking = new AsyncLocalStorage();
  const fences = () => checking.getStore() ? [] : (fenceScope.getStore() ?? []);
  const checkFences = client => checking.run(true, async () => { for (const check of fenceScope.getStore() ?? []) await check(client); });
  // Several legacy callers intentionally read in Promise.all. Privacy-fenced
  // reads now use this same transactional boundary; serialize root write
  // transactions on a connection, without holding the queue across outside()
  // provider work. Nested calls continue to share the active transaction.
  let rootTail=Promise.resolve();
  const executorOverrides=new Map();
  let reconnectAdmission,rootAdmission,lifetimeEnding;
  const refreshIdleConnection=base.protocol==='file'&&typeof base.reconnect==='function'?async deadlineAt=>retryContention(async()=>{
    if(currentDurableExecution()){
      lifetimeEnding?.();base.close();throw Object.assign(Error('RUNTIME_REPLACEMENT_REQUIRED'),{code:'RUNTIME_REPLACEMENT_REQUIRED'});
    }
    await base.reconnect();
    // The root queue is held and no transaction exists. Re-admission is a
    // private read-only path on this idle connection, never a callback replay.
    if(reconnectAdmission)await checking.run(true,()=>scope.run({idleAdmission:true},reconnectAdmission));
  },{deadlineAt}):undefined;
  async function acquireRoot() {
    const prior=rootTail;let release;
    rootTail=new Promise(resolve=>{release=resolve;});await prior;return release;
  }
  const client = new Proxy(base, {
    get(target, key) {
      if(privateRuntime&&['transaction','executeMultiple','migrate','sync','limit','_getStream'].includes(key))return undefined;
      if(key==='close')return ()=>{lifetimeEnding?.();return target.close();};
      if(key==='reconnect')return ()=>{lifetimeEnding?.();throw Object.assign(Error('RUNTIME_REPLACEMENT_REQUIRED'),{code:'RUNTIME_REPLACEMENT_REQUIRED'});};
      if (key === 'execute' || key === 'batch') {
        if(executorOverrides.has(key))return executorOverrides.get(key);
        const method = target[key].bind(target);
        return async (...args) => {
        const state = scope.getStore();
        if(state?.idleAdmission){
          const sql=key==='execute'?(typeof args[0]==='string'?args[0]:args[0]?.sql):'';
          if(!/^\s*(SELECT|PRAGMA)\b/i.test(sql))requireSettledOperation();
          if(!/^\s*(SELECT\b|PRAGMA\s+(foreign_keys|ignore_check_constraints)\b)/i.test(sql))throw Error('RUNTIME_READMISSION_READ_ONLY');
          return method(...args);
        }
        const query=key==='execute'?(typeof args[0]==='string'?args[0]:args[0]?.sql):'';
        const metadata=inRuntimeMetadata(query);
        const guarded = fences().length > 0 && !metadata;
        if (guarded) {
          await checkFences();
          const sql = key === 'execute' ? (typeof args[0] === 'string' ? args[0] : args[0]?.sql) : '';
          if (!state && !readOnlyStatement(args[0]))
            return transaction(() => client[key](...args));
        }
        if (state?.failure) throw state.failure;
        const release=state?null:await acquireRoot();
        try {
          if(state){
            const statements=key==='batch'?args[0]:[args[0]];
            const mutations=statements.filter(statement=>{
              const sql=typeof statement==='string'?statement:Array.isArray(statement)?statement[0]:statement?.sql??'';
              return !readOnlyStatement(statement)&&!inRuntimeMetadata(sql);
            });
            if(mutations.length){requireSettledOperation();
              const context=currentDurableExecution();if(context&&context.receipts!==false){
                const coordination=mutations.every(inExecutionCoordination);
                if(state.replaying||state.readOnly&&!coordination)missingStep();
                if(state.workStep===undefined&&!coordination&&!state.receiptWrite)missingStep();
              }
              if(!mutations.every(inExecutionCoordination)&&!state.receiptWrite)state.workWrites=true;}
            return await state.tx[key](...args);}
          const sql=key==='execute'?(typeof args[0]==='string'?args[0]:args[0]?.sql):'';
          if(rootAdmission&&!metadata)await checking.run(true,()=>scope.run({idleAdmission:true},rootAdmission));
          // Foundation/schema reads can overlap another process's writer even
          // before a request lease exists. Retry only these read-only statements.
          const readOnly=/^\s*(SELECT\b|PRAGMA\s+(table_info|database_list|index_list|index_info|foreign_key_list|integrity_check|foreign_key_check)\b)/i.test(sql);
          return await (readOnly&&!metadata?retryContention(()=>method(...args),{afterBusy:refreshIdleConnection}):method(...args));
        }
        catch (error) { if (state) state.failure = error; throw error; }
        finally {release?.();}
        };
      }
      const value = target[key];
      return typeof value === 'function' ? value.bind(target) : value;
    },
    set(target,key,value) {
      if(privateRuntime&&['closed','close','reconnect','transaction'].includes(key))throw Error('PRIVATE_CLIENT_CONTROL_FORBIDDEN');
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

  async function transaction(fn, { before, after, beforeCommit,commitFence,commitAuthority,workStep,workStepFrom,readOnly=false,discardResult=false,replay } = {}) {
    const parent = scope.getStore();
    if (fences().length) await checkFences();
    if (parent) {
      if(workStep!==undefined&&parent.workStep===undefined&&currentDurableExecution()&&currentDurableExecution().receipts!==false)missingStep();
      try {
        if (before) await before(client);
        if (after) parent.checks.push(after);
        if (beforeCommit) parent.finalChecks.push(beforeCommit);
        if (commitFence) parent.commitFences.add(commitFence);
        if (commitAuthority) parent.commitAuthorities.add(commitAuthority);
        return await fn();
      } catch (error) { parent.failure = error; throw error; }
    }
    const cache = new Map();
    requireSettledOperation();
    const execution=currentDurableExecution();
    if(execution&&execution.receipts!==false&&workStep===undefined&&!workStepFrom&&!readOnly&&!inExecutionCoordination())missingStep();
    if(workStepFrom!==undefined&&typeof workStepFrom!=='function')missingStep();
    if(workStep!==undefined&&(typeof workStep!=='string'||!workStep||workStep.length>512))missingStep();
    for (let attempt = 0; attempt < 12; attempt++) {
      const releaseRoot=await acquireRoot();
      let tx,commitSubmitted=false;
      const state = { tx:null, cache, checks: after ? [after] : [], finalChecks:beforeCommit?[beforeCommit]:[],commitFences:new Set(commitFence?[commitFence]:[]),
        commitAuthorities:new Set(commitAuthority?[commitAuthority]:[]),workStep,readOnly,replaying:false,receiptWrite:false,failure: null, deferred: null, committed: [], completed: [] };
      try {
        if(rootAdmission)await checking.run(true,()=>scope.run({idleAdmission:true},rootAdmission));
        tx=await retryContention(async()=>{
          const opened=await base.transaction('write');
          // HTTP/Hrana transactions lazily submit BEGIN with their first SQL.
          // Force BEGIN acknowledgement before entering any business callback,
          // so explicit contention can retry admission, never business work.
          if(base.protocol==='http')try{await opened.execute('SELECT 1');}
          catch(error){try{await opened.rollback();}catch{}opened.close();throw error;}
          return opened;
        },{
          // A failed local BEGIN can retain an unfinished native statement.
          // No transaction/callback exists yet, so discard that idle connection
          // before re-admission; never reconnect an active transaction.
          afterBusy:refreshIdleConnection,
        });state.tx=tx;
        const result = await scope.run(state, async () => {
          if (fences().length) await checkFences(client);
          if (before) await before(client);
          if(workStepFrom&&execution&&execution.receipts!==false){
            state.readOnly=true;const prepared=await workStepFrom(client);state.readOnly=readOnly;
            if(prepared===null){await tx.rollback();return null;}
            if(typeof prepared!=='string'||!prepared||prepared.length>512)missingStep();
            state.workStep=prepared;
          }
          if(state.workStep!==undefined){const receipt=await readWorkStep(client,['named',state.workStep]);if(receipt){
            state.replaying=true;
            const result=replay?await replay():receipt.result_json===null?null:JSON.parse(receipt.result_json);
            for(const check of state.checks)await check(client);currentExecutionBudget()?.assert();
            await tx.rollback();return result;
          }}
          const result = await fn();
          if (state.failure) throw state.failure;
          for (const check of state.checks) await check(client);
          if (state.failure) throw state.failure;
          if(state.workWrites){state.receiptWrite=true;
            const scalar=result===null||typeof result==='boolean'||typeof result==='number'&&Number.isFinite(result)||typeof result==='string'&&/^[a-f0-9]{64}$/.test(result);
            try{await appendExecutionReceipt(client,{step:['named',state.workStep],result:discardResult&&!scalar?undefined:result,explicit:true});}
            finally{state.receiptWrite=false;}}
          await retryContention(async()=>{
            // Recheck ownership after all deferred result validation and before
            // each COMMIT attempt, including time spent waiting on contention.
            if (fences().length) await checkFences(client);
            for(const check of state.finalChecks)await check(client);
            for(const check of state.commitFences)await check(client);
            if(state.failure)throw state.failure;
            for(const assert of state.commitAuthorities)assert();
            const original=currentExecutionBudget();original?.assert();
            if(original&&original.remainingMs()<25)throw new ExecutionBudgetError();
            const context=currentDurableExecution();const token={};
            context?.pending.add(token);commitSubmitted=true;
            try {await tx.commit();}
            catch(error){
              // Explicit SQLite BUSY leaves this native transaction open: retry
              // its COMMIT only. Every other acknowledgement is indeterminate.
              if(/^(SQLITE_BUSY|SQLITE_LOCKED)(_|$)/.test(error?.code??'')&&!tx.closed){commitSubmitted=false;throw error;}
              if(/^SQLITE_(?:BUSY|LOCKED|CONSTRAINT|ERROR|MISMATCH|RANGE|TOOBIG)(_|$)/.test(error?.code??'')){
                commitSubmitted=false;
                throw Object.assign(new Error('COMMIT_REJECTED'),{code:error.code,cause:error,definiteCommitRejection:true});
              }
              if(context)context.indeterminate=true;
              throw new CommitIndeterminateError();
            }finally{context?.pending.delete(token);}
          });
          return result;
        });
        tx.close();tx=null;releaseRoot();
        for (const cleanup of state.committed) { try { await cleanup(); } catch { /* TTL recovery */ } }
        return result;
      } catch (error) {
        const context=currentDurableExecution();
        if(commitSubmitted&&context)context.indeterminate=true;
        try { await tx?.rollback(); } catch { /* closed/rolled back by storage */ }
        if(context?.indeterminate&&context.claim?.request){
          try{context.reconciliation=await reconcileExecution({raw:base},context.claim.request,context.claim.identity);}
          catch{context.reconciliation={state:'RECONCILIATION_REQUIRED'};}
        }
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
  return { client, transaction,setLifetimeEnding:fn=>{lifetimeEnding=fn;}, setRootAdmission:fn=>{rootAdmission=fn;},setReconnectAdmission:fn=>{reconnectAdmission=fn;}, withFence: (check, fn) => fenceScope.run([...(fenceScope.getStore() ?? []), check], fn), outside, afterCommit, afterCompletion, active: () => Boolean(scope.getStore()) };
}
