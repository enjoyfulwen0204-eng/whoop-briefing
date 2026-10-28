// LIVE-only preparation. Original registered execution + processing root own
// publication; a memory result or a SHADOW/pilot grant is never sufficient.
import {currentDurableExecution,withDurableExecution,assertExecutionWorkOwner,databaseNowMs,requireSettledOperation,workStepKey,CommitIndeterminateError} from './phase4ExecutionContext.js';
import {liveProducerConfiguration,isLiveExecution,authorizeStage8LiveProducer,registerLiveExecution,liveScopeDigest} from './stage8LiveProducerAuthority.js';
import {currentExecutionBudget,createExecutionBudget,withExecutionBudget} from './executionBudget.js';
import {stage6RuntimeBinding} from './stage6RuntimeBinding.js';
import {createPhase4Stage6} from './phase4Reanalysis.js';
import {STAGE8_LIVE_DRAIN_BUDGET} from './stage8LiveDrainPolicy.js';
import {LIVE_TABLES} from './stage8LiveAllocation.js';
import {V23_TABLES} from './phase4V23Schema.js';
import {V25_TABLES} from './phase4V25Schema.js';
import {createPreparationScheduling} from './stage6PreparationScheduling.js';
import {workStepOptions} from './phase4WorkStep.js';
import {readOnlyProcessingCheck} from './processingTransaction.js';
import {canonicalJson} from './phase4EntityStore.js';
import {preparedDisposalFence} from './stage6PreparedDisposal.js';
import {capturePreparedSnapshot,openPreparedMemory,capturePreparedPostImages,preparedImageGuards,erasePreparedSnapshot,preparedAssertion as check} from './stage6PreparedSnapshot.js';
const fail=code=>{throw Object.assign(Error(code),{code});};
const plans=new WeakMap(),preparedExecutions=new WeakSet();
// Canonical artifact families and final-job invalidation settlement are still
// bound to the exact tenant/LIVE preimage, postimage and original work receipt.
const writable=new Set([...Object.values(LIVE_TABLES),...V23_TABLES,...V25_TABLES,'resource_locks','phase4_jobs','phase4_computation_state','phase4_invalidations',
 'health_insights','evidence_runs','evidence_run_items','evidence_run_sources','evidence_items','phase4_source_links',
 'phase4_evidence_links','phase4_insight_links','phase4_insight_provenance','phase4_health_episodes','phase4_episode_events',
 'health_episodes','health_episode_events','body_energy_results','stage8_live_job_completions']);

export function createStage8LivePreparedWorker({db,keys,capability}){
 const g=liveProducerConfiguration(capability,db.raw,keys),{base,keys:ownedKeys}=stage6RuntimeBinding(db);
 if(g.db!==db||ownedKeys!==keys||base.protocol!=='http')fail('LIVE_PREPARED_OWNED_HTTP_REQUIRED');
 let lastPublication,lastDisposal;
 const assertOriginal=(p)=>{
  if(![p.execution,p.activeChild].includes(currentDurableExecution())||!isLiveExecution(p.execution,db.raw,keys,p.userId,p.context))fail('LIVE_PREPARED_EXECUTION_REQUIRED');
  liveProducerConfiguration(capability,db.raw,keys,p.userId);p.budget.assert();p.execution.authority.assert();db.assertLocalRuntimeFences();
 };
 const clientFor=p=>{
  const call=async(method,...args)=>{
   assertOriginal(p);await db.assertRuntimeFences();let value;
   try{value=await base[method](...args);}catch(error){p.physicalJoinUnknown=true;throw error;}
   await db.assertRuntimeFences();assertOriginal(p);return value;
  };
  return {execute:stmt=>call('execute',stmt),batch:(stmts,mode)=>call('batch',stmts,mode)};
 };
 async function prepare({userId,context}){
  const execution=currentDurableExecution(),budget=currentExecutionBudget();
  if(!budget||context?.userId!==userId||context.executionMode!=='LIVE'||!isLiveExecution(execution,db.raw,keys,userId,context)||execution.receipts===false||db.processingTransactionActive())fail('LIVE_PREPARED_EXECUTION_REQUIRED');
  requireSettledOperation();if(preparedExecutions.has(execution))fail('LIVE_PREPARED_ORIGINAL_ALREADY_PREPARED');preparedExecutions.add(execution);
  const p={execution,budget,userId,context,status:'PREPARING',memoryClosed:true,physicalJoinUnknown:false},started=performance.now(),client=clientFor(p);
  assertOriginal(p);const owner=await assertExecutionWorkOwner(db.raw);
  const prefix=`p4ctx:${keys.lookup(['context-tenant-v1',userId])}:`,hold=preparedDisposalFence(keys,userId,execution.claim,context.purgeGeneration),name=hold.name;
  const expiry=Math.min(owner.deadline_at,owner.lease_until,budget.deadlineAt),leaseOwner=hold.owner;
  const principal=`EXISTS(SELECT 1 FROM users u JOIN user_whoop_tokens t ON t.user_id=u.id JOIN phase4_user_state p ON p.user_id=u.id JOIN phase4_computation_state c ON c.user_id=u.id AND c.execution_mode='LIVE' JOIN user_onboarding o ON o.user_id=u.id
   WHERE u.id=? AND u.status='ACTIVE' AND o.state='READY' AND p.pending_purge_count=0 AND u.timezone=? AND u.lifecycle_generation=? AND t.auth_generation=? AND p.purge_generation=? AND p.source_generation=? AND c.input_generation=? AND c.algorithm_set_version=?)`;
  const scopeArgs=[userId,context.timezone,context.lifecycleGeneration,context.authGeneration,context.purgeGeneration,context.sourceGeneration,context.inputGeneration,context.algorithmSetVersion];
  const contextGuard=check(`EXISTS(SELECT 1 FROM resource_locks WHERE name=? AND owner=? AND expires_at=? AND ${databaseNowMs}<?) AND ${principal}`,
   [name,leaseOwner,hold.expiresAt,expiry,...scopeArgs],'LIVE_PREPARED_AUTHORITY_REVOKED');
  const release=async()=>{
   const joined=p.memoryClosed&&!p.physicalJoinUnknown;
   lastDisposal={buffersDropped:true,physicalJoin:joined?'KNOWN':'UNKNOWN',holdReleased:false,requiresPhysicalDisposalProof:!joined};
   if(!joined)return;
   // Closed, exact non-health cleanup only. This independent cleanup clock
   // cannot authorize health reads, work, new receipts or old-RID settlement.
   const cleanup=createExecutionBudget({budgetMs:5000});
   try{await withExecutionBudget(cleanup,()=>base.execute({sql:'DELETE FROM resource_locks WHERE name=? AND owner=? AND expires_at=?',args:[name,leaseOwner,hold.expiresAt]}));lastDisposal.holdReleased=true;}
   catch{lastDisposal.requiresPhysicalDisposalProof=true;}
   finally{cleanup.close();}
  };
  p.release=release;p.expiry=expiry;
  let memory,snapshot,post,active=false,child;const effects=[];p.effects=effects;
  try{
   await g.transaction(async()=>{
    assertOriginal(p);const result=await db.raw.execute({sql:`INSERT INTO resource_locks(name,owner,acquired_at,expires_at) SELECT ?,?,?,? WHERE ${principal} AND ${databaseNowMs}<?`,args:[name,leaseOwner,new Date().toISOString(),hold.expiresAt,...scopeArgs,expiry]});
    if(result.rowsAffected!==1)fail('LIVE_PREPARED_AUTHORITY_REVOKED');
   },workStepOptions('stage8.prepared-context-registration',[name,leaseOwner,expiry],{discardResult:true}));
   const closure=`SELECT ? UNION SELECT producing_execution_id FROM stage8_live_execution_producers WHERE user_id=? AND execution_mode='LIVE'`;
   const filter=(table,columns)=>{
    if(table==='users')return {where:'id=?',args:[userId]};
    if(columns.includes('user_id')){const mode=columns.includes('execution_mode')?'execution_mode':columns.includes('artifact_execution_mode')?'artifact_execution_mode':null;return {where:'user_id=?'+(mode?` AND "${mode}"='LIVE'`:''),args:[userId]};}
    if(['stage8_live_executions','stage8_live_execution_work_receipts'].includes(table))return {where:`execution_id IN (${closure})`,args:[execution.claim.executionId,userId]};
    if(table==='resource_locks')return {where:'name=? OR substr(name,1,?)=?',args:[`phase4-stage6-pass:${JSON.stringify([userId,'LIVE'])}`,prefix.length,prefix]};
    if(table==='system_heartbeats')return {where:"scope IN ('global',?)",args:['user:'+userId]};
    if(['schema_version','phase4_migration_checkpoints','schema_migration_progress','migration_progress','schema_migration_steps'].includes(table))return {where:'1',args:[]};
    return {where:'0',args:[]};
   };
   snapshot=await capturePreparedSnapshot({client,filter,contextGuard,assertOpen:()=>assertOriginal(p)});
   const scheduling=createPreparationScheduling(()=>assertOriginal(p));p.memoryClosed=false;memory=await openPreparedMemory(snapshot,keys,()=>scheduling.checkpoint());
   const admission=await memory.admitRuntime();active=true;
   const localCapability=await authorizeStage8LiveProducer({db:memory,keys,admission,releaseSha:g.releaseSha,configProof:g.configProof,
    enabled:()=>active&&isLiveExecution(execution,db.raw,keys,userId,context)&&g.enabled(),eligible:id=>id===userId&&g.eligible(id)});
   child={claim:execution.claim,keys,pending:new Set(),authority:{assert(){assertOriginal(p);if(!active)fail('LIVE_PREPARED_RECEIVER_CLOSED');}}};p.activeChild=child;
   registerLiveExecution(localCapability,child,memory.raw,keys,userId,context);
   const seen=new WeakSet(),execute=memory.raw.execute,batch=memory.raw.batch;
   const record=(stmt,result)=>{
    const sql=typeof stmt==='string'?stmt:stmt.sql;if(!/^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql))return;
    if(seen.has(result))return;seen.add(result);
    const table=/^\s*(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM|REPLACE\s+INTO)\s+"?([a-z0-9_]+)"?/i.exec(sql)?.[1],args=typeof stmt==='string'?[]:stmt.args??[];
    if(!writable.has(table)){const error=Object.assign(Error('LIVE_PREPARED_EFFECT_TARGET_REJECTED'),{code:'LIVE_PREPARED_EFFECT_TARGET_REJECTED',target:table});p.preparationFailure??=error;throw error;}
    if(table==='resource_locks'&&!(args[0]===`phase4-stage6-pass:${JSON.stringify([userId,'LIVE'])}`||typeof args[0]==='string'&&args[0].startsWith(prefix)))fail('LIVE_PREPARED_FOREIGN_LOCK');
    if(!Number.isSafeInteger(result.rowsAffected)||result.rowsAffected<0)fail('LIVE_PREPARED_EFFECT_ACK_REQUIRED');
    const effect={sql,args:structuredClone(args),rowsAffected:result.rowsAffected};
    if(!memory.processingTransactionActive())fail('LIVE_PREPARED_UNOWNED_EFFECT');
    memory.afterProcessingCommit(()=>effects.push(effect));
   };
   memory.raw.execute=async stmt=>{assertOriginal(p);const value=await execute(stmt);record(stmt,value);assertOriginal(p);return value;};
   memory.raw.batch=async(stmts,...args)=>{assertOriginal(p);const values=await batch(stmts,...args);stmts.forEach((stmt,i)=>record(stmt,values[i]));assertOriginal(p);return values;};
   let result;
   await withDurableExecution(child,async()=>{
    const worker=await createPhase4Stage6({db:memory,keys,admission,executionMode:'LIVE',liveProducingAuthority:localCapability});
    result=await memory.withRuntimeFence(()=>assertOriginal(p),()=>worker.drain({userId,triggerSource:'manual',budget:STAGE8_LIVE_DRAIN_BUDGET}));
    requireSettledOperation();if(child.pending.size||child.indeterminate||child.workRejected||memory.processingTransactionActive())fail('LIVE_PREPARED_RECEIVER_UNSETTLED');
    if(p.preparationFailure)throw p.preparationFailure;
    if(result.failedJobs||result.outcome==='FAILED')fail('LIVE_PREPARED_CALCULATION_FAILED');
    const noWork=['NO_WORK','NO_ELIGIBLE_WORK'].includes(result.outcome);
    if(!(result.processedItems||result.unitsCommitted||result.completedJobs||noWork))fail('LIVE_PREPARED_NO_COMMITTED_UNIT');
    post=await capturePreparedPostImages(memory,snapshot);requireSettledOperation();
   });
   memory.close();memory=null;p.memoryClosed=true;active=false;p.activeChild=null;assertOriginal(p);
   // The original code owns SQL and every graph image. A caller receives only
   // an opaque identity; materialized health data remains in this private map.
   const seal=keys.lookup(['stage8-live-prepared-unit-v1',execution.claim.identity,execution.claim.scopeKey,execution.claim.owner,execution.claim.generation,
    liveScopeDigest(keys,context),snapshot.descriptors.map(d=>[d.table,d.rows]),post.map(d=>[d.table,d.rows]),effects,result]);
   const options=workStepOptions('stage8.live-prepared-publication',[liveScopeDigest(keys,context),seal]);
   const receiptKey=workStepKey(execution,['named',options.workStep]);
   Object.assign(p,{snapshot,post,effects,result:structuredClone(result),seal,receiptKey,options,contextGuard,status:'PREPARED',preparationMs:performance.now()-started});
   const plan=Object.freeze({});plans.set(plan,p);return plan;
  }catch(error){
   active=false;p.activeChild=null;let closeError;
   try{if(memory){memory.close();p.memoryClosed=true;}}catch(failure){closeError=failure;}
   finally{erasePreparedSnapshot(snapshot);for(const d of post??[])d.rows.length=0;effects.length=0;await release();}
   if(closeError)throw new AggregateError([error,closeError],'LIVE_PREPARED_FAILURE_AND_CLOSE_FAILURE',{cause:error});throw error;
  }
 }
 async function reconcile(p){
  // This read grants no renewed budget, producer authority or finalization.
  // Keep the original sticky uncertainty even when the unit is now durable.
  try{
   assertOriginal(p);
   const row=(await base.execute({sql:`SELECT r.*,e.owner,e.generation owner_generation,e.state owner_state,e.deadline_at,e.lease_until,e.identity_digest,e.canonical_request_json,${databaseNowMs} observed_at FROM stage8_live_execution_work_receipts r JOIN stage8_live_executions e ON e.execution_id=r.execution_id WHERE r.receipt_key=? AND r.execution_id=?`,args:[p.receiptKey,p.execution.claim.executionId]})).rows[0];
   assertOriginal(p);const c=p.execution.claim;
   const committed=!!row&&row.execution_id===c.executionId&&row.receipt_key===p.receiptKey&&row.step_key===p.receiptKey&&row.scope_key===c.scopeKey&&row.request_digest===c.identity
    &&row.generation===c.generation&&row.result_json===JSON.stringify(p.seal)&&row.owner===c.owner&&row.owner_generation===c.generation&&row.owner_state==='ESTABLISHED'
    &&row.identity_digest===c.identity&&row.canonical_request_json===canonicalJson(c.request)&&row.observed_at<Math.min(row.deadline_at,row.lease_until,p.expiry);
   p.execution.reconciliation={state:committed?'PREPARED_UNIT_COMMITTED_UNFINALIZED':'RECONCILIATION_REQUIRED',receiptKey:p.receiptKey};
  }catch{p.execution.reconciliation={state:'RECONCILIATION_REQUIRED',receiptKey:p.receiptKey};}
 }
 async function publish(plan){
  const p=plans.get(plan);if(!p||p.status!=='PREPARED')fail('LIVE_PREPARED_PLAN_REQUIRED');
  if(currentDurableExecution()!==p.execution||currentExecutionBudget()!==p.budget)fail('LIVE_PREPARED_BUDGET_REQUIRED');
  p.status='PUBLISHING';const started=performance.now();let callbackRan=false,publication;
  try{
   assertOriginal(p);publication=createExecutionBudget({budgetMs:Math.max(1,Math.min(5000,p.budget.remainingMs())),signal:p.budget.signal,localAuthority:()=>assertOriginal(p)});
   const value=await withExecutionBudget(publication,()=>g.transaction(async()=>{
    callbackRan=true;assertOriginal(p);
    const stmts=[p.contextGuard,p.snapshot.schemaGuard,...preparedImageGuards(p.snapshot.descriptors)];
    for(const e of p.effects)stmts.push({sql:e.sql,args:e.args},check('changes()=?',[e.rowsAffected],'LIVE_PREPARED_EFFECT_MISMATCH'));
    stmts.push(...preparedImageGuards(p.post),p.contextGuard,check(`${databaseNowMs}<?`,[Math.min(p.expiry,publication.deadlineAt)],'LIVE_PREPARED_DEADLINE'));
    // A rejected/cancelled SDK promise is not a physical transport join.
    // Until the whole original root acknowledges its terminal, every failure
    // after this health-bearing submission retains the independent purge hold.
    p.healthBatchSubmitted=true;await db.raw.batch(stmts);assertOriginal(p);return p.seal;
   },{...p.options,
    before:readOnlyProcessingCheck(async()=>{
     assertOriginal(p);if((await db.raw.execute({sql:'SELECT 1 FROM stage8_live_execution_work_receipts WHERE receipt_key=?',args:[p.receiptKey]})).rows.length)fail('LIVE_PREPARED_RECEIPT_ALREADY_EXISTS');
    }),
    beforeCommit:readOnlyProcessingCheck(async()=>{assertOriginal(p);await db.raw.execute(check(`${databaseNowMs}<?`,[Math.min(p.expiry,publication.deadlineAt)],'LIVE_PREPARED_DEADLINE'));}),
   }));
   if(!callbackRan||value!==p.seal)fail('LIVE_PREPARED_REPLAY_NOT_FRESH');
   p.budget.assert();lastPublication={preparationMs:p.preparationMs,transactionUpperBoundMs:performance.now()-started,effects:p.effects.length,snapshotBytes:p.snapshot.totalBytes,snapshotPages:p.snapshot.pages,commit:'ACKNOWLEDGED',absoluteServerInterruption:'UNKNOWN'};
   return structuredClone(p.result);
  }catch(error){
   if(p.healthBatchSubmitted)p.physicalJoinUnknown=true;
   if(error?.code==='COMMIT_INDETERMINATE'||p.execution.indeterminate||p.execution.pending.size){p.physicalJoinUnknown=true;await reconcile(p);throw new CommitIndeterminateError();}
   throw error;
  }finally{publication?.close();p.status='CONSUMED';await dispose(plan);}
 }
 async function dispose(plan){
  const p=plans.get(plan);if(!p)return;if(p.status==='PUBLISHING')fail('LIVE_PREPARED_PUBLICATION_IN_FLIGHT');
  plans.delete(plan);erasePreparedSnapshot(p.snapshot);for(const d of p.post??[])d.rows.length=0;p.effects.length=0;await p.release();
 }
 return Object.freeze({prepare,publish,dispose,drain:async options=>{const plan=await prepare(options);try{return await publish(plan);}finally{await dispose(plan);}},
  status:()=>Object.freeze({publication:lastPublication?{...lastPublication}:null,disposal:lastDisposal?{...lastDisposal}:null})});
}
