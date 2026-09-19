import { fail, readableRow } from './phase4Core.js';
import { R_COLUMNS } from './phase4V22Schema.js';

const IDENTITIES=Object.freeze({
  body_energy_results:['result_lookup_key'],body_energy_checkpoints:['checkpoint_lookup_key'],
  evidence_runs:['deterministic_run_key'],evidence_items:['run_id','item_key'],
  observation_episodes:['episode_id'],episode_observations:['episode_id','observation_key'],
  episode_evidence:['episode_id','evidence_item_id'],episode_events:['deterministic_event_key'],
  episode_semantic_events:['episode_id','resulting_revision'],insight_revisions:['insight_id','revision'],
  context_questions:['request_lookup_key'],structured_answer_events:['source_update_id'],
  phase4_proactive_decisions:['deterministic_decision_key'],outbound_messages:['idempotency_key'],
  outbound_delivery_attempts:['attempt_id'],
});
const PARENTS=Object.freeze({
  body_energy_checkpoints:[['result_id','body_energy_results','result_id']],
  evidence_items:[['run_id','evidence_runs','run_id']],
  observation_episodes:[['latest_evidence_item_id','evidence_items','evidence_item_id'],
    ['explanation_evidence_item_id','evidence_items','evidence_item_id']],
  episode_observations:[['episode_id','observation_episodes','episode_id']],
  episode_evidence:[['episode_id','observation_episodes','episode_id'],['evidence_item_id','evidence_items','evidence_item_id']],
  episode_events:[['episode_id','observation_episodes','episode_id']],
  episode_semantic_events:[['episode_id','observation_episodes','episode_id'],['episode_event_id','episode_events','episode_event_id']],
  context_questions:[['episode_id','observation_episodes','episode_id']],
  structured_answer_events:[['question_request_id','context_questions','question_request_id']],
  phase4_proactive_decisions:[['episode_id','observation_episodes','episode_id'],
    ['episode_semantic_event_id','episode_semantic_events','episode_semantic_event_id'],
    ['question_request_id','context_questions','question_request_id'],['answer_event_id','structured_answer_events','answer_event_id']],
  outbound_messages:[['decision_id','phase4_proactive_decisions','decision_id']],
  outbound_delivery_attempts:[['message_id','outbound_messages','message_id']],
});
const FENCES={input_generation:'inputGeneration',lifecycle_generation:'lifecycleGeneration',auth_generation:'authGeneration'};
const AUTOMATIC=new Set(['user_id','execution_mode',...Object.keys(R_COLUMNS),...Object.keys(FENCES)]);
export function canonicalJson(value) {
  if(value===null || ['string','boolean'].includes(typeof value))return JSON.stringify(value);
  if(typeof value==='number' && Number.isFinite(value))return JSON.stringify(value);
  if(Array.isArray(value))return `[${value.map(canonicalJson).join(',')}]`;
  if(value && Object.getPrototypeOf(value)===Object.prototype)
    return `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  fail('PHASE4_INVALID_JSON');
}

/** Internal append primitive. Only purpose-specific facades expose it; callers
 * cannot set ownership, mode, fences, R, or an arbitrary SQL table/column. */
export function createPhase4EntityStore(core) {
  const {client,timestamp}=core;
  async function validateParents(context,table,row) {
    const refs=[];
    for(const [field,parent,key] of PARENTS[table]||[]) {
      if(row[field]==null)continue;
      const found=await core.artifact(context,parent,{[key]:row[field]});
      if(parent==='evidence_runs' && found.row.state!=='COMPLETED')fail('PHASE4_EVIDENCE_NOT_COMPLETED');
      if(parent==='observation_episodes' && row.episode_revision!=null && row.episode_revision!==found.row.revision)
        fail('PHASE4_EPISODE_REVISION_STALE');
      if(table==='body_energy_checkpoints' && (row.algorithm_version!==found.row.algorithm_version
        || row.checkpoint_as_of_epoch_ms!==found.row.as_of_epoch_ms))fail('PHASE4_CHECKPOINT_PARENT_MISMATCH');
      if(table==='episode_semantic_events' && parent==='episode_events'
        && (found.row.episode_id!==row.episode_id || found.row.resulting_revision!==row.resulting_revision))
        fail('PHASE4_EVENT_PARENT_MISMATCH');
      refs.push(found.ref);
    }
    if(table==='observation_episodes' && !row.latest_evidence_item_id)fail('PHASE4_EPISODE_EVIDENCE_REQUIRED');
    if(table==='insight_revisions') {
      // A current-pointer update is performed by the insight facade in this
      // same transaction. Never accept an unowned/global integer ID.
      const parent=(await client.execute({sql:`SELECT id FROM health_insights WHERE user_id=? AND execution_mode=? AND id=?`,
        args:[context.userId,context.executionMode,row.insight_id]})).rows[0];
      if(!parent)fail('PHASE4_PARENT_NOT_FOUND');
      for(const name of ['supporting_evidence_ids_json','contradicting_evidence_ids_json']) {
        const ids=JSON.parse(row[name]||'[]');if(!Array.isArray(ids))fail('PHASE4_EVIDENCE_IDS_REQUIRED');
        for(const id of ids)refs.push((await core.artifact(context,'evidence_items',{evidence_item_id:id})).ref);
      }
    }
    return refs;
  }
  async function append(context,table,data,sourceRefs=[]) {
    if(!IDENTITIES[table])fail('PHASE4_UNKNOWN_ENTITY');
    return core.run(context,async()=>{
      const info=await core.tableInfo(table),names=new Set(info.map(c=>c.name));
      if(!data || Object.keys(data).some(k=>!names.has(k) || AUTOMATIC.has(k)))fail('PHASE4_INVALID_ENTITY_FIELDS');
      const row={...data};
      for(const [k,v] of Object.entries(row))if(k.endsWith('_json') && v!==null) {
        try { row[k]=canonicalJson(typeof v==='string'?JSON.parse(v):v); } catch { fail('PHASE4_INVALID_JSON'); }
        if(Buffer.byteLength(row[k],'utf8')>262144)fail('PHASE4_JSON_TOO_LARGE');
      }
      for(const k of IDENTITIES[table])if(row[k]===null || row[k]===undefined)fail('PHASE4_IDENTITY_REQUIRED');
      for(const [col,prop] of Object.entries(FENCES))if(names.has(col))row[col]=context[prop];
      const identity=IDENTITIES[table].map(k=>row[k]);
      const existing=(await client.execute({sql:`SELECT * FROM ${table} WHERE user_id=? AND execution_mode=?${IDENTITIES[table].map(k=>` AND ${k}=?`).join('')}`,
        args:[context.userId,context.executionMode,...identity]})).rows[0];
      if(existing) {
        if(!readableRow(existing))fail('CONTENT_REDACTED');
        // Operational auto IDs/times are not part of the candidate's semantic
        // identity; all caller-supplied content must match the durable winner.
        if(Object.keys(row).some(k=>existing[k]!==row[k]))fail('PHASE4_IDENTITY_CONTENT_CONFLICT');
        const pk=Object.fromEntries(info.filter(c=>c.pk&&!['user_id','execution_mode'].includes(c.name)).map(c=>[c.name,existing[c.name]]));
        return {...await core.artifact(context,table,pk),created:false};
      }
      const refs=[...sourceRefs,...await validateParents(context,table,row)];
      if(!refs.length)fail('PHASE4_COMPLETE_PROVENANCE_REQUIRED');
      await core.revalidateSources(context,refs);
      if(table==='body_energy_results') {
        if(!Number.isSafeInteger(row.as_of_epoch_ms) || Math.abs(row.as_of_epoch_ms)>8640000000000000
          || new Date(row.as_of_epoch_ms).toISOString()!==row.as_of_utc)fail('PHASE4_INVALID_EXACT_AS_OF');
      }
      if(table==='body_energy_checkpoints' && (row.checkpoint_as_of_epoch_ms>core.now().getTime()
        || row.checkpoint_bucket_start%900000!==0 || row.checkpoint_as_of_epoch_ms!==row.checkpoint_bucket_start+900000))
        fail('PHASE4_INVALID_CHECKPOINT');
      const record={...row,...core.envelope(context,table,identity)};
      if(table==='outbound_messages')record.payload_hash=core.keys.digest(record.content_digest_salt,canonicalJson([record.payload_text??null,record.payload_json??null]));
      for(const c of info.filter(c=>c.pk && !['user_id','execution_mode'].includes(c.name)))
        if(record[c.name]===undefined)record[c.name]=core.newId();
      for(const time of ['created_at','updated_at'])if(names.has(time)&&record[time]===undefined)record[time]=timestamp();
      const fields=Object.keys(record);
      await client.execute({sql:`INSERT INTO ${table}(${fields.join(',')}) VALUES (${fields.map(()=>'?').join(',')})`,args:fields.map(k=>record[k])});
      await core.link(context,table,record.privacy_artifact_id,refs);
      const key=Object.fromEntries(info.filter(c=>c.pk&&!['user_id','execution_mode'].includes(c.name)).map(c=>[c.name,record[c.name]]));
      return {...await core.artifact(context,table,key),created:true};
    });
  }
  async function completeEvidence(context,runId,patch) {
    const allowed=['sample_count','exclusion_count','unknown_eligible_days','eligible_observation_days','unknown_fraction',
      'input_manifest_json','missingness_json','input_manifest_hash','multiple_testing_family'];
    if(!patch || Object.keys(patch).some(k=>!allowed.includes(k)))fail('PHASE4_INVALID_EVIDENCE_PATCH');
    return core.run(context,async()=>{
      const {row}=await core.artifact(context,'evidence_runs',{run_id:runId});
      if(row.state!=='STARTED')fail('PHASE4_EVIDENCE_ALREADY_FINAL');
      const final={...row,...patch};
      for(const field of ['sample_count','exclusion_count','unknown_eligible_days','eligible_observation_days'])
        if(final[field]!=null&&(!Number.isSafeInteger(final[field])||final[field]<0))fail('PHASE4_INVALID_EVIDENCE_COUNTS');
      const n=final.unknown_eligible_days,d=final.eligible_observation_days,f=final.unknown_fraction;
      if(n!=null||d!=null||f!=null) {
        if(n==null||d==null||n>d||(d===0?f!==null:f!==n/d))fail('PHASE4_INVALID_UNKNOWN_FRACTION');
      }
      const values={...patch};for(const k of Object.keys(values))if(k.endsWith('_json'))values[k]=canonicalJson(values[k]);
      const fields=Object.keys(values);
      const result=await client.execute({sql:`UPDATE evidence_runs SET ${fields.map(k=>`${k}=?`).concat("state='COMPLETED'",'completed_at=?').join(',')}
        WHERE user_id=? AND execution_mode=? AND run_id=? AND state='STARTED' AND input_generation=?`,
        args:[...fields.map(k=>values[k]),timestamp(),context.userId,context.executionMode,runId,context.inputGeneration]});
      if(result.rowsAffected!==1)fail('PHASE4_CAS_LOST');
      return core.artifact(context,'evidence_runs',{run_id:runId});
    });
  }
  return Object.freeze({append,validateParents,completeEvidence});
}
