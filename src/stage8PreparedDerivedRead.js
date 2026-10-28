// Canonical read preparation grants no LIVE producer/publication authority.
// The original HTTP reader consumes one exact snapshot in a short readonly
// receiver, including a server-owned final actor/reply guard when supplied.
import {randomUUID} from 'node:crypto';
import {stage6RuntimeBinding} from './stage6RuntimeBinding.js';
import {requireRuntimeAdmission} from './runtimeAdmission.js';
import {currentDurableExecution,databaseNowMs} from './phase4ExecutionContext.js';
import {currentExecutionBudget,createExecutionBudget,withExecutionBudget} from './executionBudget.js';
import {executeCoordination} from './phase4Coordination.js';
import {readOnlyProcessingCheck} from './processingTransaction.js';
import {preparedReadDisposalFence} from './stage6PreparedDisposal.js';
import {capturePreparedSnapshot,openPreparedMemory,capturePreparedPostImages,preparedImageGuards,erasePreparedSnapshot,preparedAssertion as check} from './stage6PreparedSnapshot.js';
import {createPreparationScheduling} from './stage6PreparationScheduling.js';
import {exactRealStatement} from './exactRealStatement.js';
import {canonicalJson} from './phase4EntityStore.js';
import {createStage8DerivedReader} from './stage8DerivedReader.js';
const fail=code=>{throw Object.assign(Error(code),{code});};
const kinds=new Set(['BODY_ENERGY','EPISODES','EVIDENCE','INSIGHTS']);
export async function preparedStage8DerivedRead({db,keys,admission,eligible,now,bodyEnergyPresentation,input,finish=values=>values}){
 const {base,keys:ownedKeys}=stage6RuntimeBinding(db),{scope,inputGeneration,kinds:requested}=input;
 if(ownedKeys!==keys||base.protocol!=='http'||db.processingTransactionActive()||currentDurableExecution())fail('STAGE8_PREPARED_READ_ROOT_REQUIRED');
 if(!scope?.permitted||scope.purpose!=='SELF_QA'||scope.executionMode!=='LIVE'||!Array.isArray(requested)||!requested.length||requested.length>4
  ||new Set(requested).size!==requested.length||requested.some(kind=>!kinds.has(kind))||!Number.isSafeInteger(inputGeneration)||!Number.isFinite(scope.asOfEpochMs)
  ||Date.parse(scope.asOfUtc)!==scope.asOfEpochMs)fail('STAGE8_DERIVED_SCOPE_REQUIRED');
 const userId=scope.userId,parent=currentExecutionBudget(),started=performance.now(),lifetime=Object.freeze({readId:randomUUID(),owner:randomUUID()}),
  budget=createExecutionBudget({budgetMs:Math.max(1,Math.min(45000,parent?.remainingMs()??45000,scope.asOfEpochMs+120000-Date.now())),signal:parent?.signal});
 let memory,snapshot,guards,result,seal,hold,holdSubmitted=false,memoryClosed=true,memoryCloseAttempted=false,physicalUnknown=false,publication,active=true,primary,cleanupFailure;
 const closeMemory=()=>{if(!memory||memoryCloseAttempted)return;memoryCloseAttempted=true;memory.close();memoryClosed=true;memory=null;};
 const assertOriginal=()=>{
  requireRuntimeAdmission(db.raw,admission,keys,db.transaction);parent?.assert();budget.assert();
  if(!active||!eligible(userId)||now().getTime()<scope.asOfEpochMs||now().getTime()-scope.asOfEpochMs>120000)fail('STAGE8_DERIVED_SCOPE_REQUIRED');
  db.assertLocalRuntimeFences();
 };
 const assertResultTime=()=>{if(result?.some(value=>value.status==='CURRENT'&&(!Number.isFinite(value.validUntil)||value.validUntil<=now().getTime())))fail('STAGE8_PREPARED_READ_EXPIRED');};
 const client={execute:stmt=>call('execute',stmt),batch:(stmts,mode)=>call('batch',stmts,mode)};
 async function call(method,...args){
  assertOriginal();await db.assertRuntimeFences();let value;
  try{value=await base[method](...args);}catch(error){physicalUnknown=true;throw error;}
  await db.assertRuntimeFences();assertOriginal();return value;
 }
 try{return await withExecutionBudget(budget,async()=>{
  assertOriginal();
  // Non-health control metadata only, before the permanent erasure hold and
  // any source/artifact payload. All comparisons are repeated by the receiver.
  const principalStatement={sql:`SELECT u.id,u.status,u.timezone,u.lifecycle_generation,COALESCE(t.auth_generation,0) auth_generation,
   p.source_generation,p.purge_generation,p.pending_purge_count,o.state onboarding_state,c.input_generation,c.last_completed_generation,c.source_generation_seen,c.algorithm_set_version
   FROM users u JOIN phase4_user_state p ON p.user_id=u.id LEFT JOIN user_whoop_tokens t ON t.user_id=u.id JOIN user_onboarding o ON o.user_id=u.id
   JOIN phase4_computation_state c ON c.user_id=u.id AND c.execution_mode='LIVE' WHERE u.id=?`,args:[userId]};
  const initialBudget=createExecutionBudget({budgetMs:Math.max(1,Math.min(5000,budget.remainingMs())),signal:budget.signal,localAuthority:assertOriginal});
  let initial;
  try{initial=await withExecutionBudget(initialBudget,()=>db.readOnlyTransaction(()=>db.transaction(async()=>{
   assertOriginal();const principal=(await db.raw.execute(principalStatement)).rows[0],ready=principal?.status==='ACTIVE'&&principal.onboarding_state==='READY'&&principal.auth_generation>=1&&principal.pending_purge_count===0
    &&principal.input_generation===inputGeneration&&principal.last_completed_generation===inputGeneration&&principal.source_generation_seen===principal.source_generation;
   const value=ready?undefined:await finish(requested.map(kind=>({status:'ANALYSIS_UPDATING',kind,asOfUtc:scope.asOfUtc,items:[]})));
   return {principal,ready,value};
  },{readOnly:true,beforeCommit:readOnlyProcessingCheck(async()=>{assertOriginal();await db.raw.execute(check(`${databaseNowMs}<?`,[initialBudget.deadlineAt],'STAGE8_PREPARED_READ_DEADLINE'));})})));
  }finally{initialBudget.close();}
  if(!initial.ready)return {value:initial.value,diagnostics:{prepared:false,commit:'ACKNOWLEDGED'}};
  const {principal}=initial;
  const predicate=`EXISTS(SELECT 1 FROM users u JOIN phase4_user_state p ON p.user_id=u.id JOIN user_whoop_tokens t ON t.user_id=u.id JOIN user_onboarding o ON o.user_id=u.id
   JOIN phase4_computation_state c ON c.user_id=u.id AND c.execution_mode='LIVE' WHERE u.id=? AND u.status='ACTIVE' AND o.state='READY' AND p.pending_purge_count=0
   AND u.timezone=? AND u.lifecycle_generation=? AND t.auth_generation=? AND p.source_generation=? AND p.purge_generation=? AND c.input_generation=?
   AND c.last_completed_generation=c.input_generation AND c.source_generation_seen=p.source_generation AND c.algorithm_set_version=?)`,
   args=[userId,principal.timezone,principal.lifecycle_generation,principal.auth_generation,principal.source_generation,principal.purge_generation,inputGeneration,principal.algorithm_set_version];
  hold=preparedReadDisposalFence(keys,userId,{...lifetime,purgeGeneration:principal.purge_generation,identity:keys.lookup(['stage8-prepared-read-lifetime-v1',lifetime,scope,requested,inputGeneration])});
  const contextGuard=check(`${predicate} AND EXISTS(SELECT 1 FROM resource_locks WHERE name=? AND owner=? AND expires_at=?) AND ${databaseNowMs}<?`,
   [...args,hold.name,hold.owner,hold.expiresAt,budget.deadlineAt],'STAGE8_PREPARED_READ_FENCED');
  const registration=createExecutionBudget({budgetMs:Math.max(1,Math.min(5000,budget.remainingMs())),signal:budget.signal,localAuthority:assertOriginal});
  try{await withExecutionBudget(registration,()=>db.transaction(async()=>{
   assertOriginal();await db.raw.execute(check(predicate,args,'STAGE8_PREPARED_READ_FENCED'));holdSubmitted=true;
   await executeCoordination(db.raw,'insert',[hold.name,hold.owner,new Date().toISOString(),hold.expiresAt]);await db.raw.execute(contextGuard);
  },{readOnly:true,beforeCommit:readOnlyProcessingCheck(async()=>{assertOriginal();registration.assert();await db.raw.execute(check(`${databaseNowMs}<?`,[registration.deadlineAt],'STAGE8_PREPARED_READ_DEADLINE'));})}));}
  catch(error){if(holdSubmitted)physicalUnknown=true;throw error;}
  finally{registration.close();}
  const closure="SELECT producing_execution_id FROM stage8_live_execution_producers WHERE user_id=? AND execution_mode='LIVE'";
  const filter=(table,columns)=>{
   if(table==='users')return {where:'id=?',args:[userId]};
   if(columns.includes('user_id')){const mode=columns.includes('execution_mode')?'execution_mode':columns.includes('artifact_execution_mode')?'artifact_execution_mode':null;return {where:'user_id=?'+(mode?` AND "${mode}"='LIVE'`:''),args:[userId]};}
   if(['stage8_live_executions','stage8_live_execution_work_receipts'].includes(table))return {where:`execution_id IN (${closure})`,args:[userId]};
   if(table==='resource_locks')return {where:'name=?',args:[hold.name]};
   if(['schema_version','phase4_migration_checkpoints','schema_migration_progress','migration_progress','schema_migration_steps'].includes(table))return {where:'1',args:[]};
   return {where:'0',args:[]};
  };
  snapshot=await capturePreparedSnapshot({client,filter,contextGuard,assertOpen:assertOriginal});
  const scheduling=createPreparationScheduling(assertOriginal);memoryClosed=false;memory=await openPreparedMemory(snapshot,keys,()=>scheduling.checkpoint());
  const local=createStage8DerivedReader({db:memory,keys,admission:await memory.admitRuntime(),eligible:id=>active&&id===userId&&eligible(id),now,bodyEnergyPresentation});
  result=[];for(const kind of requested){assertOriginal();result.push(await local({scope,kind,inputGeneration}));}
  const post=await capturePreparedPostImages(memory,snapshot);
  try{if(canonicalJson(post.map(d=>[d.table,d.rows]))!==canonicalJson(snapshot.descriptors.map(d=>[d.table,d.rows])))fail('STAGE8_PREPARED_READ_MUTATED_SNAPSHOT');}
  finally{for(const d of post)d.rows.length=0;}
  closeMemory();assertOriginal();
  const publications=snapshot.descriptors.find(d=>d.table==='stage8_live_publications'),publicationRow=publications.rows.find(row=>row[publications.columns.indexOf('input_generation')]===inputGeneration),
   publicationWitness=publicationRow?Object.freeze({digest:keys.lookup(['stage8-prepared-read-publication-witness-v1',canonicalJson(Object.fromEntries(publications.columns.map((column,i)=>[column,publicationRow[i]])))]),expiresAt:publicationRow[publications.columns.indexOf('expires_at')]}):null;
  seal=keys.lookup(['stage8-prepared-read-result-v1',lifetime,scope,requested,inputGeneration,snapshot.descriptors.map(d=>[d.table,d.rows]),result]);
  guards=[snapshot.schemaGuard,...preparedImageGuards(snapshot.descriptors),contextGuard];
  const preparationMs=performance.now()-started,at=performance.now();
  publication=createExecutionBudget({budgetMs:Math.max(1,Math.min(5000,budget.remainingMs())),signal:budget.signal,localAuthority:assertOriginal});
  const deadline=()=>db.raw.execute(check(`${databaseNowMs}<?`,[Math.min(publication.deadlineAt,budget.deadlineAt)],'STAGE8_PREPARED_READ_DEADLINE'));
  let submitted=false,value;
  try{value=await withExecutionBudget(publication,()=>db.readOnlyTransaction(()=>db.transaction(async()=>{
   assertOriginal();assertResultTime();if(seal!==keys.lookup(['stage8-prepared-read-result-v1',lifetime,scope,requested,inputGeneration,snapshot.descriptors.map(d=>[d.table,d.rows]),result]))fail('STAGE8_PREPARED_READ_SEAL');
   submitted=true;await db.raw.batch([...guards,check(`${databaseNowMs}<?`,[Math.min(publication.deadlineAt,budget.deadlineAt)],'STAGE8_PREPARED_READ_DEADLINE')].map(exactRealStatement));
   assertOriginal();const output=await finish(structuredClone(result),Object.freeze({publicationWitness}));await deadline();assertOriginal();assertResultTime();return output;
  },{readOnly:true,beforeCommit:readOnlyProcessingCheck(async()=>{assertOriginal();assertResultTime();await deadline();})})));
  }catch(error){if(submitted)physicalUnknown=true;throw error;}
  assertOriginal();return {value,diagnostics:{preparationMs,transactionUpperBoundMs:performance.now()-at,snapshotBytes:snapshot.totalBytes,snapshotPages:snapshot.pages,commit:'ACKNOWLEDGED',nativeMemoryClosed:true,absoluteServerInterruption:'UNKNOWN'}};
 });}catch(error){primary=error;throw error;}
 finally{
  publication?.close();
  try{closeMemory();}catch(error){cleanupFailure=error;}
  erasePreparedSnapshot(snapshot);if(guards)guards.length=0;
  // No health read, old execution settlement or renewed authority here.
  if(holdSubmitted&&hold&&memoryClosed&&!physicalUnknown){const cleanup=createExecutionBudget({budgetMs:5000});
   try{await withExecutionBudget(cleanup,()=>base.execute({sql:'DELETE FROM resource_locks WHERE name=? AND owner=? AND expires_at=?',args:[hold.name,hold.owner,hold.expiresAt]}));}
   catch(error){cleanupFailure=cleanupFailure?new AggregateError([cleanupFailure,error],'STAGE8_PREPARED_READ_CLEANUP_FAILED',{cause:cleanupFailure}):error;}
   finally{cleanup.close();}
  }
  // Cleanup is awaited before releasing a private projection. It cannot renew
  // the original caller's policy, time window or authenticated result expiry.
  try{if(!primary&&!cleanupFailure){assertOriginal();assertResultTime();}}
  catch(error){cleanupFailure=error;}
  if(result)result.length=0;active=false;budget.close();
  if(cleanupFailure)throw primary?new AggregateError([primary,cleanupFailure],'STAGE8_PREPARED_READ_AND_CLEANUP_FAILED',{cause:primary}):cleanupFailure;
 }
}
