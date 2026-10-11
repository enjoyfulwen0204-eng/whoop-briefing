import {canonicalJson} from './phase4EntityStore.js';
import {currentDurableExecution,assertExecutionWorkOwner} from './phase4ExecutionContext.js';
const fail=code=>{throw Object.assign(Error(code),{code});};
/** Derived persistence is later than its captured source cutoff. Authorize
 * that timing from durable producer identity, never relabel created_at as a
 * physiological/source capture or accept a caller's future analysis clock. */
export async function verifyBodyEnergyProducer(core,context,row,{allowActive=false}={}){
  const {client,keys}=core;await core.assertContext(context);
  if(row.user_id!==context.userId||row.execution_mode!==context.executionMode||row.input_generation!==context.inputGeneration
    ||row.lifecycle_generation!==context.lifecycleGeneration||row.auth_generation!==context.authGeneration
    ||row.purge_generation!==context.purgeGeneration||row.invalidated_at!==null)fail('BODY_ENERGY_DERIVED_CURRENTNESS_FENCED');
  const created=typeof row.created_at==='string'?Date.parse(row.created_at):NaN,clock=Math.min(core.now().getTime(),Date.now());
  if(!Number.isSafeInteger(row.as_of_epoch_ms)||row.as_of_utc!==new Date(row.as_of_epoch_ms).toISOString()
    ||!Number.isFinite(created)||created<row.as_of_epoch_ms||created>clock)fail('BODY_ENERGY_DERIVED_TIME_INVALID');
  const schema=Number((await client.execute('SELECT MAX(version) v FROM schema_version')).rows[0]?.v);
  if(schema!==32)fail('BODY_ENERGY_DERIVED_V32_AUTHORITY_REQUIRED');
  const producers=(await client.execute({sql:`SELECT p.*,e.state,e.phase,e.generation final_generation,e.execution_seq final_seq,
    e.created_at execution_created_at,e.finalized_at,e.deadline_at FROM phase4_execution_producers p
    JOIN phase4_executions e ON e.execution_id=p.producing_execution_id
    WHERE p.user_id=? AND p.execution_mode=? AND p.input_generation=? ORDER BY p.execution_seq LIMIT 129`,
    args:[context.userId,context.executionMode,context.inputGeneration]})).rows;
  if(!producers.length||producers.length>128)fail('BODY_ENERGY_DERIVED_PRODUCER_REQUIRED');
  const valid=p=>p.phase==='STAGE6_DRAIN'&&p.execution_seq===p.final_seq&&p.producing_generation<=p.final_generation
    &&p.tenant_proof===keys.lookup(['execution-producer-v1',context.userId,context.executionMode,context.inputGeneration,
      p.producing_execution_id,p.execution_seq,p.producing_generation]);
  if(producers.some(p=>!valid(p)))fail('BODY_ENERGY_DERIVED_PRODUCER_INVALID');
  let active;
  const execution=currentDurableExecution();
  if(allowActive&&execution&&execution.receipts!==false){
    const owner=await assertExecutionWorkOwner(client);
    if(owner?.phase==='STAGE6_DRAIN')active=producers.find(p=>p.producing_execution_id===owner.execution_id
      &&p.producing_generation===owner.generation&&p.execution_seq===owner.execution_seq&&p.state==='ESTABLISHED');
  }
  const supported=producers.some(p=>p.execution_created_at<=created&&(p===active&&created<=clock&&created<=p.deadline_at
    ||p.state==='FINALIZED_SUCCESS'&&Number.isSafeInteger(p.finalized_at)&&created<=p.finalized_at&&p.finalized_at<=clock));
  if(!supported||!allowActive&&producers.some(p=>p.state!=='FINALIZED_SUCCESS'))fail('BODY_ENERGY_DERIVED_PRODUCER_NOT_COMPLETED');
  await core.assertContext(context);return {createdAt:created};
}
export async function bodyEnergyMetricAnalysisTime(core,context,artifact,sourceCaptureCutoff){
  if(typeof sourceCaptureCutoff!=='string'||!Number.isFinite(Date.parse(sourceCaptureCutoff))
    ||artifact?.row?.as_of_epoch_ms!==Date.parse(sourceCaptureCutoff))fail('BODY_ENERGY_SOURCE_CUTOFF_MISMATCH');
  const [source]=await core.revalidateSources(context,[artifact.ref]);
  if(source.type!=='body_energy_results'||source.id!==artifact.ref.id||canonicalJson(source.row)!==canonicalJson(artifact.row))
    fail('BODY_ENERGY_DERIVED_SOURCE_REFERENCE_REQUIRED');
  const created=Date.parse(artifact.row.created_at);
  // Earlier-stage isolated fixtures keep their existing exact temporal path.
  if(core.schemaVersion!==32&&created<=Date.parse(sourceCaptureCutoff))return sourceCaptureCutoff;
  const verified=await verifyBodyEnergyProducer(core,context,artifact.row,{allowActive:true});
  // Stable original persistence instant keeps retries/unit identities equal.
  // Original input as_of_utc and actual ingestedAt remain untouched.
  return new Date(verified.createdAt).toISOString();
}
