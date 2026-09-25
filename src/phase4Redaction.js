import { fail } from './phase4Core.js';
import { V22_LEGACY_R_TABLES, V22_NEW_R_TABLES } from './phase4V22Schema.js';
import { V23_HEALTH_FIELDS, EPISODE_ACTIVE } from './phase4V23Schema.js';
import { V25_HEALTH_FIELDS } from './phase4V25Schema.js';
import { V24_HEALTH_FIELDS } from './phase4V24Schema.js';
import { HEALTH_REDACTED, REDACTED_RECEIPT, EXPERIMENT_SENTINELS, addPrivacyLink } from './phase4V22Backfill.js';

const nulls=fields=>Object.fromEntries(fields.map(k=>[k,null]));
const DISPOSABLE=new Set(['healthspan_metrics','healthspan_snapshots','prediction_runs','prediction_models','analytics_daily_state']);
const FIELDS=Object.freeze({
  journal_events:{...nulls(['subtype','numeric_value','text_value','unit','severity','note','raw_answer_excerpt','recorded_timezone',
    'time_scope','event_end_at','health_date_alignment','exposure_state','extraction_confidence']),
    event_at:HEALTH_REDACTED,health_date:HEALTH_REDACTED,category:HEALTH_REDACTED,source:HEALTH_REDACTED},
  pending_questions:{question:HEALTH_REDACTED,context_json:'{}',original_message:null,answer_text:null,intent:null},
  telegram_operations:{result_json:REDACTED_RECEIPT},
  proactive_events:{message_text:null,reason_json:'{}',signals_json:'{}',health_date:HEALTH_REDACTED,outcome:null},
  health_insights:{statement:HEALTH_REDACTED,subject:HEALTH_REDACTED,insight_type:HEALTH_REDACTED,evidence_json:'{}',
    sample_count:null,effect_size:null,confidence:null},
  whoop_capabilities:nulls(['latest_value','sample_count','non_null_count','detail']),
  analytics_invalidation:{affected_from:null,affected_to:null,resources:null,reasons:'HEALTH_SCOPE_REDACTED'},
  analytics_work_state:{summary_json:'{}',last_error_detail:null,range_from:null,range_to:null,range_generation:null,
    owner:null,lease_expires_at:null,claimed_generation:null,claimed_lifecycle:null,claimed_scope_revision:null,claimed_purge_generation:null},
  analytics_runs:{detail_json:'{}',error_detail:null}, report_runs:nulls(['detail','health_date','sleep_id','cycle_id']),
  report_claims:{delivery_detail:null},briefing_evaluations:nulls(['reason','detail','target_health_date','observation_age_minutes']),
  whoop_sync_state:{last_error:null},whoop_webhook_events:{last_error_detail:null},
  whoop_reconciliation_state:{last_error_detail:null},whoop_reconciliation_runs:{error_detail:null},
  user_onboarding:{failure_detail:null},ai_usage:{detail:null},system_heartbeats:{last_detail:null},
  proactive_agent_state:{last_checked_health_date:null,last_fingerprint:null},
  journal_coverage_windows:nulls(['window_start_utc','window_end_utc','health_date_start','health_date_end','recorded_timezone',
    'factor_set_version','factor_keys_json','answer_confidence']),
  context_questions:nulls(['factor_question_kind','target_window_start_utc','target_window_end_utc','selected_candidate_key',
    'candidate_diagnostics_json','branch_signatures_json','sensitivity_class','fatigue_class','utility_score','eligibility_threshold',
    'U','D','R','A','T','K','P','F']),
  structured_answer_events:{normalized_answer_json:null},health_purge_replacements:{normalized_replacement_json:null},
  experiment_field_groups:{},
  ...Object.fromEntries(Object.entries({...V23_HEALTH_FIELDS,...V24_HEALTH_FIELDS,...V25_HEALTH_FIELDS}).map(([t,f])=>[t,nulls(f)])),
});
export const PRIVACY_TABLES=Object.freeze([...new Set([...V22_LEGACY_R_TABLES,...V22_NEW_R_TABLES,...Object.keys(FIELDS)])]);

export function createPhase4Redactor(core) {
  const {client,timestamp,keys}=core;
  const info=new Map();
  async function shape(table) {
    if(!PRIVACY_TABLES.includes(table))fail('PHASE4_UNKNOWN_PURGE_ARTIFACT');
    if(!info.has(table))info.set(table,(await client.execute(`PRAGMA table_info(${table})`)).rows);
    return info.get(table);
  }
  async function locate(userId,node) {
    const columns=await shape(node.type),owner=node.type==='telegram_operations'?'owner_user_id':node.type==='system_heartbeats'?'scope':'user_id';
    const mode=columns.some(c=>c.name==='execution_mode')&&node.mode!=='SHARED';
    const where=`${owner}=? AND privacy_artifact_id=?${mode?' AND execution_mode=?':''}`;
    const args=[owner==='scope'?`user:${userId}`:userId,node.id,...(mode?[node.mode]:[])];
    const rows=(await client.execute({sql:`SELECT * FROM ${node.type} WHERE ${where}`,args})).rows;
    if(rows.length>1)fail('PHASE4_PURGE_IDENTITY_COLLISION');
    return {row:rows[0],where,args,columns};
  }
  async function incompleteLegacy(userId) {
    const found=[];
    for(const table of V22_LEGACY_R_TABLES) {
      const owner=table==='telegram_operations'?'owner_user_id':table==='system_heartbeats'?'scope':'user_id';
      const rows=(await client.execute({sql:`SELECT * FROM ${table} r WHERE ${owner}=? AND content_state<>'REDACTED'
        AND (privacy_artifact_id IS NULL OR NOT EXISTS (SELECT 1 FROM phase4_source_links l
          WHERE l.user_id=? AND l.artifact_type=? AND l.artifact_id=r.privacy_artifact_id AND l.unlinked_at IS NULL))`,
        args:[owner==='scope'?`user:${userId}`:userId,userId,table]})).rows;
      for(const row of rows)found.push({table,row});
    }
    return found;
  }
  async function classifyLegacyForPurge(userId,generation) {
    // Some operational legacy writers only store non-health metadata. If a
    // health-bearing row nevertheless arrived without provenance, it must not
    // disappear from traversal merely because its artifact ID is absent.
    for(const {table,row} of await incompleteLegacy(userId)) {
      const columns=await shape(table),pk=columns.filter(c=>c.pk).sort((a,b)=>a.pk-b.pk).map(c=>c.name);
      const id=row.privacy_artifact_id??keys.lookup(['privacy-artifact-v1',table,userId,row.execution_mode??'SHARED',pk.map(k=>row[k])]);
      await client.execute({sql:`UPDATE ${table} SET privacy_artifact_id=?,content_state='PRESENT',source_linkage_state='COMPLETE',purge_generation=?
        WHERE ${pk.map(k=>`${k}=?`).join(' AND ')}`,args:[id,generation,...pk.map(k=>row[k])]});
      await addPrivacyLink(client,{userId,table,artifactId:id,sourceType:table==='journal_events'?'JOURNAL_FACT':'TENANT_LEGACY',
        sourceId:table==='journal_events'?id:userId,at:timestamp()});
    }
  }
  async function verifyNoUnclassifiedPlaintext(userId) {
    for(const {table,row} of await incompleteLegacy(userId)) {
      if(DISPOSABLE.has(table)||Object.entries(FIELDS[table]??{}).some(([field,sentinel])=>row[field]!=null&&row[field]!==sentinel))
        fail('PHASE4_UNCLASSIFIED_PLAINTEXT_REMAINS');
    }
  }
  async function apply(userId,node,purge) {
    const {row,where,args}=await locate(userId,node);if(!row)return 'REMOVED';
    if(node.type==='journal_events'&&purge.operation_kind==='DELETION'&&purge.target_source_type==='JOURNAL_FACT'
      &&row.logical_fact_id===purge.target_source_id) {
      // Logical deletion removes every revision, including previously redacted
      // correction audit rows; the dedicated non-health tombstone survives.
      await client.execute({sql:`DELETE FROM journal_events WHERE ${where}`,args});return 'REMOVED';
    }
    if(row.content_state==='REDACTED')return 'REDACTED';
    if(DISPOSABLE.has(node.type)) {
      await client.execute({sql:`DELETE FROM ${node.type} WHERE ${where}`,args});return 'REMOVED';
    }
    if(!FIELDS[node.type])fail('PHASE4_MISSING_REDACTION_POLICY');
    const at=timestamp(),deletion=purge.operation_kind==='DELETION',reason=purge.operation_kind==='CORRECTION'?'SOURCE_CORRECTED':
      purge.operation_kind==='RETENTION'?'RETENTION_EXPIRED':purge.operation_kind==='INCIDENT'?'INCIDENT_COPY':'SOURCE_DELETED';
    const patch={...FIELDS[node.type],content_state:'REDACTED',source_linkage_state:'DISCONNECTED',health_content_redacted_at:at,
      health_content_redaction_reason:reason,source_subject_deleted_at:deletion?at:null,content_digest_salt:null,purge_generation:purge.purge_generation};
    if(node.type==='journal_events') {
      Object.assign(patch,{fact_status:'SUPERSEDED',invalidated_at:at,invalidation_reason:reason});
    }
    if(node.type==='journal_coverage_windows')patch.status=deletion?'DELETED':'SUPERSEDED';
    if(node.type==='pending_questions' && row.status==='OPEN')patch.status='CANCELLED';
    if(node.type==='telegram_operations') {
      if(row.delivery_state==='ACTION_READY')patch.delivery_state='NOT_REQUIRED';
      if(row.delivery_state==='DELIVERY_STARTED')patch.delivery_state='AMBIGUOUS';
    }
    if(node.type==='proactive_events')patch.idempotency_key=keys.lookup(['legacy-proactive-barrier-v1',userId,row.idempotency_key]);
    if(node.type==='health_insights')Object.assign(patch,{status:'RETIRED',retired_at:at,
      ...(row.legacy_classification==='PHASE4'?{lifecycle_disposition:'INVALIDATED',invalidated_at:at}:{})});
    if(node.type==='evidence_runs')Object.assign(patch,{state:'INVALIDATED',invalidated_at:at});
    if(['body_energy_results','evidence_items','episode_observations','phase4_proactive_decisions'].includes(node.type))patch.invalidated_at=at;
    if(node.type==='observation_episodes' && EPISODE_ACTIVE.includes(row.state))Object.assign(patch,{state:'INVALIDATED',invalidated_at:at});
    if(node.type==='episode_evidence')patch.unlinked_at=at;
    if(['analytics_invalidation','analytics_work_state','phase4_invalidations','phase4_jobs'].includes(node.type)) {
      Object.assign(patch,{scope_kind:'FULL_TENANT_RECOMPUTE',scope_revision:row.scope_revision+1,
        health_scope_redacted_at:at,health_scope_redaction_reason:reason,full_scan_cursor:null});
      if(node.type==='analytics_work_state')Object.assign(patch,{status:'PENDING',last_error_class:null,next_attempt_at:null});
      if(node.type.startsWith('phase4_'))patch.reason_codes_json='["HEALTH_SCOPE_REDACTED"]';
      if(node.type==='phase4_jobs')Object.assign(patch,{state:'PENDING',lease_owner:null,lease_expires_at:null,
        claimed_generation:null,claimed_lifecycle_generation:null,claimed_auth_generation:null,claimed_scope_revision:null,
        claimed_purge_generation:null,last_error_code:null,next_attempt_at:null});
    }
    if(node.type==='experiment_field_groups') {
      if(!Object.hasOwn(EXPERIMENT_SENTINELS,row.field_name))fail('PHASE4_EXPERIMENT_FIELD_REQUIRED');
      if(row.is_current===1)await client.execute({sql:`UPDATE experiments SET ${row.field_name}=?,updated_at=? WHERE user_id=? AND id=?`,
        args:[EXPERIMENT_SENTINELS[row.field_name],at,userId,row.experiment_id]});
      Object.assign(patch,{provenance_state:'REDACTED',updated_at:at});
    }
    if(node.type==='outbound_messages') {
      patch.revision=row.revision+1;patch.updated_at=at;
      if(['PROPOSED','ELIGIBLE','CLAIMED'].includes(row.state))Object.assign(patch,{state:'INVALIDATED',terminal_reason:'CONTENT_REDACTED',lease_owner:null,lease_expires_at:null});
      if(row.state==='FAILED_DEFINITE')Object.assign(patch,{state:'FAILED_TERMINAL',terminal_reason:'CONTENT_REDACTED'});
      if(['PROPOSED','ELIGIBLE','CLAIMED','FAILED_DEFINITE'].includes(row.state)) {
        await client.execute({sql:`UPDATE outbound_semantic_reservations SET state='CLOSED',closed_reason='CONTENT_REDACTED',closed_at=?
          WHERE user_id=? AND execution_mode=? AND reservation_id=? AND state='RESERVED'`,args:[at,userId,row.execution_mode,row.reservation_id]});
      }
    }
    const fields=Object.keys(patch);
    await client.execute({sql:`UPDATE ${node.type} SET ${fields.map(k=>`${k}=?`).join(',')} WHERE ${where}`,args:[...fields.map(k=>patch[k]),...args]});
    return 'REDACTED';
  }
  async function verify(userId,node,targetState) {
    const {row}=await locate(userId,node);
    if(targetState==='REMOVED') {if(row)fail('PHASE4_PURGE_ROW_REAPPEARED');return;}
    if(!row&&(await client.execute({sql:`SELECT 1 FROM health_purge_targets t JOIN health_plaintext_purges p
      ON p.user_id=t.user_id AND p.purge_id=t.purge_id WHERE t.user_id=? AND t.artifact_execution_mode=?
      AND t.artifact_type=? AND t.artifact_id=? AND t.state='REMOVED' AND p.state IN ('DB_REDACTED','CACHE_CONFIRMED','COMPLETE')`,
      args:[userId,node.mode,node.type,node.id]})).rows.length)return;
    if(!row || row.content_state!=='REDACTED' || row.source_linkage_state!=='DISCONNECTED'
      || !row.health_content_redacted_at || row.content_digest_salt!==null)fail('PHASE4_REDACTION_POSTCONDITION');
    for(const [field,value] of Object.entries(FIELDS[node.type]||{}))if(row[field]!==value)fail('PHASE4_REDACTION_PLAINTEXT_REMAINS');
    if(node.type==='experiment_field_groups' && row.is_current===1) {
      const projection=(await client.execute({sql:`SELECT ${row.field_name} value FROM experiments WHERE user_id=? AND id=?`,args:[userId,row.experiment_id]})).rows[0];
      if(projection?.value!==EXPERIMENT_SENTINELS[row.field_name])fail('PHASE4_EXPERIMENT_PLAINTEXT_REMAINS');
    }
  }
  return {apply,verify,locate,classifyLegacyForPurge,verifyNoUnclassifiedPlaintext};
}
