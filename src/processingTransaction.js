import {traceExecutionOperation,countExecutionTelemetry} from './executionTelemetry.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { currentExecutionBudget,ExecutionBudgetError } from './executionBudget.js';
import {prepareExecutionReceipt,appendPreparedExecutionReceipt,withExecutionReceiptTransaction,currentDurableExecution,CommitIndeterminateError,requireSettledOperation,readWorkStep,databaseNowMs} from './phase4ExecutionContext.js';
import {inRuntimeMetadata} from './runtimeMetadataContext.js';
import {reconcileExecution} from './phase4ExecutionStore.js';
import {inExecutionCoordination} from './phase4Coordination.js';
import {createReadSnapshotMemo,readSnapshotKey} from './processingReadSnapshot.js';
const readOnlyChecks=new WeakSet(),controlOnlyChecks=new WeakSet();
const observationEpochs=new WeakMap();
// Data lifetime only, never a permit or successful guard observation. Closed
// typed readers reject their raw union if an intervening business write clears
// the existing transaction-local data snapshot while reads are settling.
export function processingReadObservationEpoch(client){return observationEpochs.get(client)?.()??null;}
export function readOnlyProcessingCheck(check){readOnlyChecks.add(check);return check;}
// Only trusted server checks consisting of non-health control observations
// and explicit runtime brackets use this narrower transport composition.
export function controlOnlyProcessingCheck(check){controlOnlyChecks.add(check);return readOnlyProcessingCheck(check);}
const syncRuntimeChecks=new WeakSet();
// Eligibility only: this does not alter original runChecks ordering or suppress
// any guard. The SYNC composition's runtime check remains first and sequential.
export function syncRuntimeProcessingCheck(check){syncRuntimeChecks.add(check);return check;}
const normalizedSql=sql=>sql.replace(/\s+/g,' ').trim();
const receiptColumns=['execution_id','receipt_key','scope_key','request_digest','step_key','generation','committed_at','result_json'];
const firstAdmissionReads=new Set([
 'SELECT 1 FROM resource_locks WHERE name=? AND owner=? AND expires_at=? AND expires_at>?',
 'SELECT status, lifecycle_generation FROM users WHERE id = ?',
 `SELECT e.*,${receiptColumns.map(name=>`r.${name} AS receipt_${name}`).join(',')}
  FROM phase4_executions e LEFT JOIN phase4_execution_work_receipts r ON r.receipt_key=?
  WHERE e.execution_id=? AND e.owner=? AND e.generation=? AND e.state='ESTABLISHED'
   AND e.lease_until>${databaseNowMs} AND e.deadline_at>${databaseNowMs}`,
].map(normalizedSql));
const rolledBackReadOnly=new WeakMap();
export function consumeReadOnlyRollback(error){
 const proof=error&&typeof error==='object'?rolledBackReadOnly.get(error):null;
 if(!proof||proof.budget!==currentExecutionBudget()||proof.execution!==currentDurableExecution())return false;
 currentExecutionBudget()?.assert();requireSettledOperation();rolledBackReadOnly.delete(error);return true;
}
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
      countExecutionTelemetry('retry_count');
      if(afterBusy)await afterBusy(deadline);
      await new Promise(resolve=>setTimeout(resolve,Math.max(0,Math.min(25*2**Math.min(attempt,4)+Math.floor(Math.random()*10),250,deadline-Date.now()))));
    }
  }
}

/** All stores share this executor, so a processing transaction includes every
 * database side effect, even writes hidden behind a store/helper function. */
export function processingTransactions(base,{privateRuntime=false}={}) {
  const scope = new AsyncLocalStorage();
  const readScope=new AsyncLocalStorage(),activeReadMemos=new Set();
  const invalidateReadMemos=()=>{for(const memo of activeReadMemos)memo.close();};
  const readOnlyWork=new AsyncLocalStorage();
  const fenceScope = new AsyncLocalStorage(), checking = new AsyncLocalStorage();
  const fences = () => checking.getStore() ? [] : (fenceScope.getStore() ?? []);
  async function runChecks(checks,client){
    const fn=value=>typeof value==='function'?value:value.check;
    for(let index=0;index<checks.length;){
      if(!readOnlyChecks.has(fn(checks[index]))){const value=checks[index++];
        if(typeof value==='function')await value(client);else await checking.run(true,()=>value.check(client));continue;}
      const group=[];while(index<checks.length&&readOnlyChecks.has(fn(checks[index])))group.push(fn(checks[index++]));
      // Every original check runs; only independent read transport overlaps.
      // Settle the whole group before rollback, and preserve failure ordering.
      const results=await checking.run({readOnly:true},()=>Promise.allSettled(group.map(check=>Promise.resolve().then(()=>check(client)))));
      const failure=results.find(result=>result.status==='rejected');if(failure)throw failure.reason;
    }
  }
  const fenceChecks=()=> (fenceScope.getStore()??[]).map(check=>({check}));
  const checkFences = client => runChecks(fenceChecks(),client);
  // Several legacy callers intentionally read in Promise.all. Privacy-fenced
  // reads now use this same transactional boundary; serialize root write
  // transactions on a connection, without holding the queue across outside()
  // provider work. Nested calls continue to share the active transaction.
  let rootTail=Promise.resolve();
  const executorOverrides=new Map();
  let reconnectAdmission,rootAdmission,lifetimeEnding;
  const refreshIdleConnection=base.protocol==='file'&&typeof base.reconnect==='function'?async deadlineAt=>retryContention(async()=>{
    invalidateReadMemos();
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
      if(key==='close')return ()=>{invalidateReadMemos();lifetimeEnding?.();return target.close();};
      if(key==='reconnect')return ()=>{invalidateReadMemos();lifetimeEnding?.();throw Object.assign(Error('RUNTIME_REPLACEMENT_REQUIRED'),{code:'RUNTIME_REPLACEMENT_REQUIRED'});};
      if (key === 'execute' || key === 'batch') {
        if(executorOverrides.has(key))return executorOverrides.get(key);
        const method = target[key].bind(target);
        return async (...args) => {
        const query=key==='execute'?(typeof args[0]==='string'?args[0]:args[0]?.sql):'';
        const metadata=inRuntimeMetadata(query);
        if((checking.getStore()?.readOnly||readOnlyWork.getStore())&&(key==='batch'?args[0]:[args[0]]).some(statement=>!readOnlyStatement(statement))){
          const error=Error('PROCESSING_READ_ONLY_CHECK_REQUIRED');if(readOnlyWork.getStore()&&scope.getStore())scope.getStore().failure=error;throw error;
        }
        return traceExecutionOperation(metadata?'DB_METADATA':'DB_QUERY',async()=>{
        countExecutionTelemetry('query_count',key==='batch'&&Array.isArray(args[0])?args[0].length:1);
        if(metadata)countExecutionTelemetry('metadata_query_count');
        const state = scope.getStore();
        if(state?.idleAdmission){
          const sql=query;
          if(!/^\s*(SELECT|PRAGMA)\b/i.test(sql))requireSettledOperation();
          if(!/^\s*(SELECT\b|PRAGMA\s+(foreign_keys|ignore_check_constraints)\b)/i.test(sql))throw Error('RUNTIME_READMISSION_READ_ONLY');
          return method(...args);
        }
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
            if(state.admissionFirst){
              // The installed Hrana driver waits for its first batch before
              // later execute() calls. Prefix the first original readonly
              // admission statement with the original SELECT1 observation;
              // its own BEGIN condition keeps both inside the same root.
              if(!checking.getStore()?.readOnly||statements.some(statement=>!readOnlyStatement(statement)))
                throw Error('PROCESSING_READ_ONLY_CHECK_REQUIRED');
              state.admissionFirst=false;
              // Only these exact non-health metadata projections share BEGIN.
              // Unknown readonly statements retain the original ACK first.
              if(key!=='execute'||typeof query!=='string'||!firstAdmissionReads.has(normalizedSql(query))){
                try{await state.tx.execute('SELECT 1');}
                catch(error){state.admissionBeginFailure=error;throw error;}
                return state.tx[key](...args);
              }
              try{const results=await state.tx.batch(['SELECT 1',...statements]);
                return key==='execute'?results[1]:results.slice(1);
              }catch(error){state.admissionFirstFailure=error;throw error;}
            }
            const memo=state.readMemo,context=readScope.getStore(),sameScope=state.readBudget===currentExecutionBudget()&&state.readExecution===currentDurableExecution();
            const snapshotKey=key==='execute'&&!mutations.length&&!metadata&&sameScope?readSnapshotKey(args[0],context):null;
            if(mutations.length)memo.clear();
            try{
              currentExecutionBudget()?.assert();
              if(snapshotKey){const cached=memo.get(context,snapshotKey);if(cached!==undefined){currentExecutionBudget()?.assert();return cached;}}
              const epoch=memo.epoch(),result=await state.tx[key](...args);currentExecutionBudget()?.assert();
              if(snapshotKey)memo.put(context,snapshotKey,result,epoch);return result;
            }finally{if(mutations.length)memo.clear();}}
          const sql=key==='execute'?(typeof args[0]==='string'?args[0]:args[0]?.sql):'';
          if(rootAdmission&&!metadata)await traceExecutionOperation('RUNTIME_READMISSION',()=>{countExecutionTelemetry('runtime_readmissions');return checking.run(true,()=>scope.run({idleAdmission:true},rootAdmission));});
          // Foundation/schema reads can overlap another process's writer even
          // before a request lease exists. Retry only these read-only statements.
          const readOnly=/^\s*(SELECT\b|PRAGMA\s+(table_info|database_list|index_list|index_info|foreign_key_list|integrity_check|foreign_key_check)\b)/i.test(sql);
          return await (readOnly&&!metadata?retryContention(()=>method(...args),{afterBusy:refreshIdleConnection}):method(...args));
        }
        catch (error) { if (state) state.failure = error; throw error; }
        finally {release?.();}
        });
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
    if(readOnlyWork.getStore()){const error=Error('PROCESSING_READ_ONLY_CHECK_REQUIRED');scope.getStore().failure=error;throw error;}
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
    const guarded=fences().length>0,missingIdentity=parent&&workStep!==undefined&&parent.workStep===undefined&&currentDurableExecution()&&currentDurableExecution().receipts!==false;
    const overlap=parent&&guarded&&!missingIdentity&&controlOnlyChecks.has(before);
    if (guarded&&!overlap) await checkFences();
    if (parent) {
      if(workStep!==undefined&&parent.workStep===undefined&&currentDurableExecution()&&currentDurableExecution().receipts!==false)missingStep();
      try {
        if(overlap){
          // Both original fresh checks run. The narrow before-check reads no
          // health content and supplies its own final runtime bracket. Settle
          // both before business work, retaining the outer fence failure first.
          const observations=await Promise.allSettled([
            Promise.resolve().then(()=>checkFences(client)),Promise.resolve().then(()=>runChecks([before],client)),
          ]);
          for(const result of observations)if(result.status==='rejected')throw result.reason;
        }else if (before) await runChecks([before],client);
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
      const readMemo=createReadSnapshotMemo(),readBudget=currentExecutionBudget(),closeReadMemo=()=>readMemo.close();activeReadMemos.add(readMemo);
      if(readBudget?.signal.aborted)readMemo.close();else readBudget?.signal.addEventListener('abort',closeReadMemo,{once:true});
      const state = { tx:null, cache,readMemo,readBudget,readExecution:execution, checks: after ? [after] : [], finalChecks:beforeCommit?[beforeCommit]:[],commitFences:new Set(commitFence?[commitFence]:[]),
        commitAuthorities:new Set(commitAuthority?[commitAuthority]:[]),workStep,readOnly,replaying:false,receiptWrite:false,failure: null, deferred: null, committed: [], completed: [] };
      let receipt,admissionChecked=false,admissionFailure;
      const observeReceipt=readOnlyProcessingCheck(async()=>{receipt=await readWorkStep(client,['named',state.workStep]);});
      const fixedReceipt=state.workStep!==undefined&&!workStepFrom;
      const admissionChecks=[...fenceChecks(),...(before?[before]:[]),...(fixedReceipt?[observeReceipt]:[])];
      const bundledAdmission=privateRuntime&&base.protocol==='http'&&execution?.claim?.request?.phase==='SYNC'
        &&admissionChecks.length>0&&admissionChecks.every(value=>{
          const check=typeof value==='function'?value:value.check;return readOnlyChecks.has(check)||syncRuntimeChecks.has(check);
        });
      try {
        if(rootAdmission)await traceExecutionOperation('RUNTIME_READMISSION',()=>{countExecutionTelemetry('runtime_readmissions');return checking.run(true,()=>scope.run({idleAdmission:true},rootAdmission));});
        tx=await retryContention(async()=>{
          const opened=await base.transaction('write');
          // HTTP/Hrana transactions lazily submit BEGIN with their first SQL.
          // Force BEGIN acknowledgement before entering any business callback,
          // so explicit contention can retry admission, never business work.
          if(base.protocol==='http')try{
            if(bundledAdmission){
              state.tx=opened;state.admissionFirst=true;state.admissionFirstFailure=null;state.admissionBeginFailure=null;
              // Only the original branded readonly admission observations may
              // share the lazy BEGIN packet. Settle every submitted observation
              // before cleanup; BEGIN failure retains first priority. Business
              // work cannot run until its ACK and every original check pass.
              const results=await Promise.allSettled([
                scope.run(state,()=>withExecutionReceiptTransaction(()=>readOnlyWork.run(true,()=>runChecks(admissionChecks,client)))),
              ]);
              // A check may fail without issuing SQL. BEGIN still has original
              // first failure priority and must acknowledge before that error.
              if(state.admissionFirst){state.admissionFirst=false;await opened.execute('SELECT 1');}
              // The installed driver's public closed flag is true when initial
              // BEGIN failed; an acknowledged BEGIN with failed metadata stays
              // open. Only the former may take original definite-BUSY retry.
              if(state.admissionBeginFailure)throw state.admissionBeginFailure;
              if(state.admissionFirstFailure&&opened.closed)throw state.admissionFirstFailure;
              if(results[0].status==='rejected')admissionFailure=results[0].reason;
              else admissionChecked=true;
            }else await opened.execute('SELECT 1');
          }catch(error){try{await opened.rollback();}catch{}opened.close();state.tx=null;state.failure=null;throw error;}
          return opened;
        },{
          // A failed local BEGIN can retain an unfinished native statement.
          // No transaction/callback exists yet, so discard that idle connection
          // before re-admission; never reconnect an active transaction.
          afterBusy:refreshIdleConnection,
        });state.tx=tx;
        // Metadata failure after acknowledged BEGIN follows the original
        // failure/rollback path. It is never an admission retry or callback run.
        if(admissionFailure)throw admissionFailure;
        if(state.failure)throw state.failure;
        currentExecutionBudget()?.assert();execution?.authority.assert();requireSettledOperation();
        const result = await scope.run(state, () => withExecutionReceiptTransaction(async () => {
          if(!admissionChecked)await runChecks(admissionChecks,client);
          if(workStepFrom&&execution&&execution.receipts!==false){
            state.readOnly=true;const prepared=await workStepFrom(client);state.readOnly=readOnly;
            if(prepared===null){readMemo.close();await tx.rollback();return null;}
            if(typeof prepared!=='string'||!prepared||prepared.length>512)missingStep();
            state.workStep=prepared;
          }
          if(state.workStep!==undefined){if(!fixedReceipt)await observeReceipt();if(receipt){
            state.replaying=true;
            const result=replay?await replay():receipt.result_json===null?null:JSON.parse(receipt.result_json);
            for(const check of state.checks)await check(client);currentExecutionBudget()?.assert();
            readMemo.close();await tx.rollback();return result;
          }}
          const result = await fn();
          if (state.failure) throw state.failure;
          let preparedReceipt;
          const scalar=result===null||typeof result==='boolean'||typeof result==='number'&&Number.isFinite(result)||typeof result==='string'&&/^[a-f0-9]{64}$/.test(result);
          const observeCompletion=readOnlyProcessingCheck(async()=>{
            preparedReceipt=await prepareExecutionReceipt(client,{step:['named',state.workStep],result:discardResult&&!scalar?undefined:result,explicit:true});
          });
          await runChecks([...state.checks,...(state.workWrites?[observeCompletion]:[])],client);
          if (state.failure) throw state.failure;
          if(state.workWrites){state.receiptWrite=true;
            // Preparation accepts only read observations. Preserve the exact
            // counter result at INSERT, after all original checks have passed.
            try{await appendPreparedExecutionReceipt(client,preparedReceipt);}
            finally{state.receiptWrite=false;}}
          await retryContention(async()=>{
            // Recheck ownership after all deferred result validation and before
            // each COMMIT attempt, including time spent waiting on contention.
            await runChecks([...fenceChecks(),...state.finalChecks,...state.commitFences],client);
            if(state.failure)throw state.failure;
            for(const assert of state.commitAuthorities)assert();
            const original=currentExecutionBudget();original?.assert();
            if(original&&original.remainingMs()<25)throw new ExecutionBudgetError();
            const context=currentDurableExecution();const token={};
            context?.pending.add(token);commitSubmitted=true;
            try {readMemo.close();await tx.commit();}
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
        }));
        tx.close();tx=null;releaseRoot();
        for (const cleanup of state.committed) { try { await cleanup(); } catch { /* TTL recovery */ } }
        return result;
      } catch (error) {
        readMemo.close();
        if(error&&typeof error==='object')rolledBackReadOnly.delete(error);
        const context=currentDurableExecution();
        if(commitSubmitted&&context)context.indeterminate=true;
        let rollbackAcknowledged=false;
        try { if(tx){await tx.rollback();rollbackAcknowledged=true;} } catch { /* closed/rolled back by storage */ }
        // Only the new fixed preparation unit can use this private marker.
        // Unknown COMMIT, parent expiry/cancellation, attempted writes/provider
        // work and unacknowledged rollback cannot authorize an independent retry.
        if(state.preparationReadOnly&&rollbackAcknowledged&&!commitSubmitted&&!context?.indeterminate&&!context?.pending?.size&&!context?.workRejected&&!state.workWrites
          &&error?.message!=='PROCESSING_READ_ONLY_CHECK_REQUIRED'&&error?.code!=='COMMIT_INDETERMINATE'
          &&!['SYNC_TIMEOUT','SYNC_CANCELLED','ABORT_ERR'].includes(error?.code)&&error?.name!=='AbortError'){
          try{currentExecutionBudget()?.assert();if(error&&typeof error==='object')rolledBackReadOnly.set(error,{budget:currentExecutionBudget(),execution});}catch{/* original parent remains authoritative */}
        }
        if(context?.indeterminate&&context.claim?.request){
          try{context.reconciliation=await reconcileExecution({raw:base},context.claim.request,context.claim.identity);}
          catch{context.reconciliation={state:'RECONCILIATION_REQUIRED'};}
        }
        if (!state.deferred) throw error;
      } finally {
        readMemo.close();activeReadMemos.delete(readMemo);
        readBudget?.signal.removeEventListener('abort',closeReadMemo);
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
  observationEpochs.set(client,()=>scope.getStore()?.readMemo.epoch()??null);
  const readOnlyTransaction=fn=>{
    if(scope.getStore())throw Error('PROCESSING_READ_ONLY_ROOT_REQUIRED');
    return transaction(()=>{scope.getStore().preparationReadOnly=true;return readOnlyWork.run(true,fn);},{readOnly:true});
  };
  return { client, transaction,readOnlyTransaction,withReadSnapshot:(context,fn)=>privateRuntime?readScope.run(context,fn):fn(),assertFences:()=>checkFences(client),setLifetimeEnding:fn=>{lifetimeEnding=fn;}, setRootAdmission:fn=>{rootAdmission=fn;},setReconnectAdmission:fn=>{reconnectAdmission=fn;}, withFence: (check, fn) => fenceScope.run([...(fenceScope.getStore() ?? []), check], fn), outside, afterCommit, afterCompletion, active: () => Boolean(scope.getStore()) };
}
