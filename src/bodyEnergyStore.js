import { BODY_ENERGY as C, bodyEnergyVersion } from './bodyEnergyRegistry.js';
import { selectBodyEnergyInputs, exactBodyInstant, validHealthDate } from './bodyEnergyInputs.js';
import { calculateBodyEnergy } from './bodyEnergy.js';
import { canonicalJson } from './phase4EntityStore.js';
import { fail, readableRow } from './phase4Core.js';

const columns={
  sleep:'id,health_date,start_at,end_at,nap,score_state,sleep_performance_percentage,updated_at,synced_at',
  recovery:'sleep_id,health_date,score_state,user_calibrating,hrv_rmssd_milli,resting_heart_rate,updated_at,synced_at',
  cycle:'id,start_at,end_at,strain,updated_at,synced_at',workout:'id,start_at,end_at,strain,updated_at,synced_at',
};
const tables={sleep:'whoop_sleeps',recovery:'whoop_recoveries',cycle:'whoop_cycles',workout:'whoop_workouts'};

/** Callable persistence only. A branded context and captured ticket are the
 * authority; there is no caller-supplied manifest, tenant override or LIVE
 * switch. Historical audit intentionally never returns a current-source ref. */
export function createBodyEnergyStore(core,entities,queue) {
  const {client,keys}=core,tickets=new WeakMap();
  function request(options) {
    if(!options||Object.keys(options).some(k=>!['asOfEpochMs','asOfUtc','targetHealthDate','algorithmVersion','supersedesResultId'].includes(k)))
      fail('BODY_ENERGY_INVALID_REQUEST');
    exactBodyInstant(options.asOfEpochMs,options.asOfUtc);
    if(options.asOfEpochMs>core.now().getTime())fail('BODY_ENERGY_FUTURE_REQUEST');
    bodyEnergyVersion(options.algorithmVersion);
    if(options.targetHealthDate!=null&&!validHealthDate(options.targetHealthDate))fail('BODY_ENERGY_INVALID_HEALTH_DATE');
    return {...options,algorithmVersion:options.algorithmVersion??C.algorithm,targetHealthDate:options.targetHealthDate??null,
      supersedesResultId:options.supersedesResultId??null};
  }
  const lookup=(context,date,ms,algorithm,generation=context.inputGeneration)=>keys.lookup([
    'body-energy-result-v1',context.userId,date,ms,algorithm,generation,context.executionMode]);
  async function find(context,key) {
    return (await client.execute({sql:`SELECT * FROM body_energy_results WHERE user_id=? AND execution_mode=? AND result_lookup_key=?`,
      args:[context.userId,context.executionMode,key]})).rows[0];
  }
  function calculationHash(row,result) {
    return keys.digest(row.content_digest_salt,canonicalJson({result_lookup_key:row.result_lookup_key,calculation:result}));
  }
  function reproduce(context,row) {
    if(!readableRow(row))fail('CONTENT_REDACTED');
    if(row.lifecycle_generation!==context.lifecycleGeneration||row.auth_generation!==context.authGeneration)fail('PHASE4_PARENT_STALE');
    const manifest=JSON.parse(row.input_manifest_json),calculation=calculateBodyEnergy(manifest);
    if(keys.digest(row.content_digest_salt,canonicalJson(manifest))!==row.input_manifest_hash
      ||calculationHash(row,calculation)!==row.result_hash||row.value!==calculation.value
      ||row.quality_state!==calculation.quality_state||row.confidence!==calculation.confidence
      ||row.confidence_label!==calculation.confidence_label||row.driver_json!==canonicalJson(calculation.drivers)
      ||row.missingness_json!==canonicalJson(calculation.reasons))fail('BODY_ENERGY_REPRODUCTION_CONFLICT');
    return {row:{...row},manifest,calculation};
  }
  async function prepare(context,options) {
    const req=request(options);
    return core.run(context,async()=>{
      const rows=async(table,fields)=>[...(await client.execute({sql:`SELECT user_id,${fields} FROM ${table} WHERE user_id=?`,args:[context.userId]})).rows];
      const sources={};for(const type of Object.keys(tables))sources[type]=await rows(tables[type],columns[type]);
      const selection=selectBodyEnergyInputs({userId:context.userId,timezone:context.timezone,asOfEpochMs:req.asOfEpochMs,
        targetHealthDate:req.targetHealthDate,lifecycleGeneration:context.lifecycleGeneration,authGeneration:context.authGeneration,sources,
        sync:await rows('whoop_sync_state','resource,last_success_at,updated_at'),
        access:await rows('whoop_resource_access','resource,status,auth_generation,lifecycle_generation'),
        capabilities:await rows('whoop_capabilities','key,status,lifecycle_generation'),
        tombstones:await rows('whoop_resource_tombstones','resource_type,resource_id,state')});
      const manifest={...selection.manifest,input_generation:context.inputGeneration,lifecycle_generation:context.lifecycleGeneration,
        auth_generation:context.authGeneration,source_generation:context.sourceGeneration};
      // A retained post-as-of canonical/sync version is not a revision archive.
      // The exact persisted tuple can still be replayed by compute/readExact.
      if(selection.notReproducible)fail('NOT_REPRODUCIBLE_FROM_RETAINED_INPUTS');
      const calculation=calculateBodyEnergy(manifest),refs=[];
      for(const source of selection.references)refs.push((await core.root(context,source.type,source.id)).ref);
      refs.push((await core.root(context,'USER',context.userId)).ref);
      const ticket=Object.freeze({kind:'BODY_ENERGY_CAPTURE'});
      const cacheKey=['body-energy-capture-v1',core.newId()];
      core.contextRegistry.set(context,cacheKey,{req,manifest,calculation});
      tickets.set(ticket,{context,cacheKey,refs});return ticket;
    });
  }
  async function persist(context,ticket) {
    const captured=tickets.get(ticket);
    if(!captured||captured.context!==context)fail('BODY_ENERGY_CAPTURE_REQUIRED');
    return core.run(context,async()=>{
      const payload=core.contextRegistry.get(context,captured.cacheKey);
      if(!payload)fail('BODY_ENERGY_CAPTURE_EVICTED');
      const {req,manifest,calculation}=payload,{refs}=captured,json=canonicalJson(manifest);
      if(Buffer.byteLength(json)>262144)fail('PHASE4_JSON_TOO_LARGE');
      const key=lookup(context,manifest.health_date,req.asOfEpochMs,req.algorithmVersion),prior=await find(context,key);
      if(prior) {
        if(!readableRow(prior))fail('CONTENT_REDACTED');
        if(prior.input_manifest_json!==json||prior.result_hash!==calculationHash(prior,calculation)
          ||prior.supersedes_result_id!==req.supersedesResultId)fail('BODY_ENERGY_IDENTITY_CONTENT_CONFLICT');
        return {...reproduce(context,prior),created:false};
      }
      await core.revalidateSources(context,refs);
      if(req.supersedesResultId!==null) {
        const previous=(await client.execute({sql:`SELECT * FROM body_energy_results WHERE user_id=? AND execution_mode=? AND result_id=?`,
          args:[context.userId,context.executionMode,req.supersedesResultId]})).rows[0];
        if(!previous)fail('PHASE4_PARENT_NOT_FOUND');
        reproduce(context,previous);
        if(previous.input_generation>=context.inputGeneration||previous.as_of_epoch_ms>req.asOfEpochMs)fail('BODY_ENERGY_INVALID_SUPERSESSION');
      }
      const row={...core.envelope(context,'body_energy_results',[key]),result_id:core.newId(),result_lookup_key:key,
        as_of_epoch_ms:req.asOfEpochMs,as_of_utc:exactBodyInstant(req.asOfEpochMs),wake_at_utc:manifest.wake_at_utc,
        timezone:manifest.timezone,health_date:manifest.health_date,value:calculation.value,quality_state:calculation.quality_state,
        confidence:calculation.confidence,confidence_label:calculation.confidence_label,
        algorithm_version:C.algorithm,constants_version:C.constants,baseline_version:C.baseline,metric_registry_version:C.metrics,
        input_generation:context.inputGeneration,lifecycle_generation:context.lifecycleGeneration,auth_generation:context.authGeneration,
        input_manifest_json:json,driver_json:canonicalJson(calculation.drivers),missingness_json:canonicalJson(calculation.reasons),
        supersedes_result_id:req.supersedesResultId,created_at:core.timestamp()};
      row.input_manifest_hash=keys.digest(row.content_digest_salt,json);row.result_hash=calculationHash(row,calculation);
      const fields=Object.keys(row);
      await client.execute({sql:`INSERT INTO body_energy_results(${fields.join(',')}) VALUES (${fields.map(()=>'?').join(',')})`,args:fields.map(k=>row[k])});
      await core.link(context,'body_energy_results',row.privacy_artifact_id,refs);
      if(manifest.reasons.includes('HEALTH_DATE_REALIGNMENT'))
        await queue.markFull(context.userId,context.executionMode,context.inputGeneration,context.purgeGeneration,'REPAIR_REQUIRED');
      if(req.supersedesResultId!==null)await client.execute({sql:`UPDATE body_energy_results SET invalidated_at=COALESCE(invalidated_at,?),
        invalidation_reason=COALESCE(invalidation_reason,'SOURCE_CORRECTION') WHERE user_id=? AND execution_mode=? AND result_id=?`,
        args:[core.timestamp(),context.userId,context.executionMode,req.supersedesResultId]});
      return {...reproduce(context,await find(context,key)),created:true};
    });
  }
  async function compute(context,options) {
    const req=request(options);
    return core.run(context,async()=>{
      if(req.targetHealthDate!==null) {
        const prior=await find(context,lookup(context,req.targetHealthDate,req.asOfEpochMs,req.algorithmVersion));
        if(prior)return {...reproduce(context,prior),created:false};
      }
      return persist(context,await prepare(context,req));
    });
  }
  async function audit(context,resultId) {
    return core.run(context,async()=>{
      const row=(await client.execute({sql:`SELECT * FROM body_energy_results WHERE user_id=? AND execution_mode=? AND result_id=?`,
        args:[context.userId,context.executionMode,resultId]})).rows[0];
      if(!row)fail('PHASE4_PARENT_NOT_FOUND');return reproduce(context,row);
    });
  }
  async function readExact(context,{healthDate,asOfEpochMs,algorithmVersion=C.algorithm,inputGeneration=context.inputGeneration}) {
    exactBodyInstant(asOfEpochMs);bodyEnergyVersion(algorithmVersion);
    if(!validHealthDate(healthDate)||!Number.isSafeInteger(inputGeneration)||inputGeneration<0||inputGeneration>context.inputGeneration)fail('BODY_ENERGY_INVALID_IDENTITY');
    return core.run(context,async()=>{
      const row=await find(context,lookup(context,healthDate,asOfEpochMs,algorithmVersion,inputGeneration));
      if(!row)fail('NOT_REPRODUCIBLE_FROM_RETAINED_INPUTS');return reproduce(context,row);
    });
  }
  async function checkpoint(context,{bucketStart,algorithmVersion=C.algorithm}) {
    bodyEnergyVersion(algorithmVersion);
    if(!Number.isSafeInteger(bucketStart)||bucketStart%C.checkpointMs!==0)fail('PHASE4_INVALID_CHECKPOINT');
    const closing=bucketStart+C.checkpointMs;exactBodyInstant(closing);
    if(closing>core.now().getTime())fail('PHASE4_INVALID_CHECKPOINT');
    return core.run(context,async()=>{
      const key=keys.lookup(['body-energy-checkpoint-v1',context.userId,context.executionMode,'PERIODIC_15M',bucketStart,algorithmVersion,context.inputGeneration]);
      const existing=(await client.execute({sql:`SELECT * FROM body_energy_checkpoints WHERE user_id=? AND execution_mode=? AND checkpoint_lookup_key=?`,
        args:[context.userId,context.executionMode,key]})).rows[0];
      if(existing) {
        if(!readableRow(existing))fail('CONTENT_REDACTED');
        return {row:{...existing},result:await audit(context,existing.result_id),created:false};
      }
      const candidates=(await client.execute({sql:`SELECT * FROM body_energy_results WHERE user_id=? AND execution_mode=? AND as_of_epoch_ms=?
        AND algorithm_version=? AND input_generation=? AND invalidated_at IS NULL`,args:[context.userId,context.executionMode,closing,algorithmVersion,context.inputGeneration]})).rows;
      // Reuse only an unambiguous, exact closing result, never a bucket-rounded
      // arbitrary instant. Otherwise the selector resolves the health day.
      const result=candidates.length===1?reproduce(context,candidates[0]):await compute(context,{asOfEpochMs:closing,algorithmVersion});
      const stored=await entities.append(context,'body_energy_checkpoints',{checkpoint_kind:'PERIODIC_15M',checkpoint_bucket_start:bucketStart,
        checkpoint_as_of_epoch_ms:closing,result_id:result.row.result_id,algorithm_version:algorithmVersion,checkpoint_lookup_key:key});
      return {...stored,result};
    });
  }
  async function auditCheckpoint(context,checkpointId) {
    return core.run(context,async()=>{
      const row=(await client.execute({sql:'SELECT * FROM body_energy_checkpoints WHERE user_id=? AND execution_mode=? AND checkpoint_id=?',
        args:[context.userId,context.executionMode,checkpointId]})).rows[0];
      if(!row)fail('PHASE4_PARENT_NOT_FOUND');
      if(!readableRow(row))fail('CONTENT_REDACTED');
      const result=await audit(context,row.result_id);
      if(result.row.as_of_epoch_ms!==row.checkpoint_as_of_epoch_ms||result.row.input_generation!==row.input_generation
        ||result.row.algorithm_version!==row.algorithm_version)fail('PHASE4_CHECKPOINT_PARENT_MISMATCH');
      return {row:{...row},result};
    });
  }
  return Object.freeze({prepare,persist,compute,audit,readExact,checkpoint,auditCheckpoint,
    read:(context,resultId)=>core.artifact(context,'body_energy_results',{result_id:resultId})});
}
