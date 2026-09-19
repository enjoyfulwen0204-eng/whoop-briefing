import { requirePhase4Keys } from './phase4Keys.js';
import { EXPERIMENT_FIELDS, V22_LEGACY_R_TABLES } from './phase4V22Schema.js';

export const HEALTH_REDACTED = '[HEALTH_CONTENT_REDACTED]';
export const REDACTED_RECEIPT = '{"reply":null,"redacted":true,"reason":"HEALTH_CONTENT_REDACTED"}';
export const EXPERIMENT_SENTINELS = Object.freeze(Object.fromEntries(Object.keys(EXPERIMENT_FIELDS).map(field =>
  [field, field === 'name' ? HEALTH_REDACTED : ['target_metrics','protocol_json','result_json'].includes(field) ? '{}' : null])));
const DIAGNOSTICS = {
  whoop_sync_state: 'last_error', whoop_webhook_events: 'last_error_detail',
  whoop_reconciliation_state: 'last_error_detail', whoop_reconciliation_runs: 'error_detail',
  user_onboarding: 'failure_detail', ai_usage: 'detail', system_heartbeats: 'last_detail',
};
const parse = value => { try { return JSON.parse(value); } catch { return null; } };
const dateRange = (a,b) => typeof a === 'string' && typeof b === 'string'
  && /^\d{4}-\d{2}-\d{2}$/.test(a) && /^\d{4}-\d{2}-\d{2}$/.test(b) && a <= b;
const own = (object, key) => Object.hasOwn(object, key);

async function updateRow(client, table, rowid, patch) {
  const entries = Object.entries(patch);
  await client.execute({ sql: `UPDATE ${table} SET ${entries.map(([n]) => `${n} = ?`).join(',')} WHERE rowid = ?`,
    args: [...entries.map(([,v]) => v), rowid] });
}
export async function addPrivacyLink(client, { userId, mode = 'SHARED', table, artifactId, sourceMode = 'SHARED', sourceType, sourceId, relationship = 'DEPENDS_ON', at }) {
  await client.execute({
    sql: `INSERT INTO phase4_source_links(user_id,artifact_execution_mode,artifact_type,artifact_id,
      source_execution_mode,source_type,source_id,relationship,linked_at) VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT DO NOTHING`, args: [userId,mode,table,artifactId,sourceMode,sourceType,sourceId,relationship,at],
  });
}
const redaction = (at, id) => ({ privacy_artifact_id: id, content_state: 'REDACTED',
  source_linkage_state: 'DISCONNECTED', health_content_redacted_at: at,
  health_content_redaction_reason: 'UNATTRIBUTED_LEGACY', content_digest_salt: null });

/** Each pass uses bounded rowid pages. A per-row completion marker is written
 * last, after deterministic links/classification. An interrupted pass repeats
 * only incomplete rows; no missing link is interpreted as independence. */
async function eachLegacyRow(client, table, callback, { unclassified = true } = {}) {
  let cursor = 0;
  for (;;) {
    const { rows } = await client.execute({
      sql: `SELECT rowid AS migration_rowid, * FROM ${table} WHERE rowid > ?
        ${unclassified ? 'AND privacy_artifact_id IS NULL' : ''} ORDER BY rowid LIMIT 100`, args: [cursor],
    });
    if (!rows.length) return;
    for (const row of rows) await callback(row);
    cursor = Number(rows.at(-1).migration_rowid);
  }
}

async function classifyScope(client, table, row, owner, patch, at) {
  const invalidation = table === 'analytics_invalidation';
  const from = invalidation ? 'affected_from' : 'range_from', to = invalidation ? 'affected_to' : 'range_to';
  if (owner && dateRange(row[from], row[to])) {
    patch.scope_kind = 'HEALTH_DATE_RANGE';
    return;
  }
  const inv = invalidation ? row : (await client.execute({
    sql: 'SELECT * FROM analytics_invalidation WHERE user_id = ?', args: [row.user_id],
  })).rows[0];
  const work = (await client.execute({ sql: 'SELECT * FROM analytics_work_state WHERE user_id = ?', args: [row.user_id] })).rows;
  const caughtUp = owner && row[from] == null && row[to] == null
    && ['LIGHT','HEAVY'].every(cls => work.some(w => w.class === cls && w.done_generation >= (inv?.generation ?? 0)
      && w.range_from == null && w.range_to == null));
  patch.scope_kind = caughtUp ? 'NONE' : 'FULL_TENANT_RECOMPUTE';
  patch[from] = null; patch[to] = null; patch.full_scan_cursor = null;
  if (row[from] != null || row[to] != null) {
    Object.assign(patch, redaction(at, patch.privacy_artifact_id), {
      health_scope_redacted_at: at, health_scope_redaction_reason: 'UNATTRIBUTED_LEGACY',
      scope_revision: Number(row.scope_revision ?? 0) + 1,
    });
    if (invalidation) Object.assign(patch, { resources: null, reasons: 'HEALTH_SCOPE_REDACTED' });
    else Object.assign(patch, { summary_json: '{}', last_error_detail: null, range_generation: null,
      owner: null, lease_expires_at: null, claimed_generation: null, claimed_lifecycle: null,
      claimed_scope_revision: null, claimed_purge_generation: null });
  }
}

async function verifiedExperimentProof(client, keys, attestations, row, field) {
  const matches = attestations.filter(a => a?.userId === row.user_id && a?.experimentId === row.id && a?.field === field);
  if (matches.length !== 1) return null;
  const proof = matches[0];
  if (!keys.verifyAttestation(proof) || !proof.assertionId || !proof.sourceUpdateKey
      || proof.valueLookup !== keys.lookup(['experiment-field-v1',row.user_id,row.id,field,row[field]])) return null;
  if (!(await client.execute({ sql: 'SELECT 1 FROM users WHERE id = ?', args: [row.user_id] })).rows.length) return null;
  if (proof.sourceKind === 'EXPERIMENT_DIRECT_ASSERTION') return field !== 'result_json' && proof.complete === true ? proof : null;
  if (!['JOURNAL_DERIVED','WHOOP_DERIVED','QA_DERIVED','ANALYSIS_DERIVED','MIXED_DERIVED'].includes(proof.sourceKind)
      || proof.complete !== true || !Array.isArray(proof.sources) || !proof.sources.length) return null;
  // A signed inventory attests completeness; each referenced retained root is
  // independently checked against its tenant. Free-form/table-name input is not SQL.
  const roots = { sleep: ['whoop_sleeps','id'], recovery: ['whoop_recoveries','sleep_id'],
    cycle: ['whoop_cycles','id'], workout: ['whoop_workouts','id'], JOURNAL_FACT: ['journal_events','privacy_artifact_id'],
    EXPERIMENT_DIRECT_ASSERTION: ['experiment_field_groups','assertion_id'] };
  for (const s of proof.sources) {
    const root = roots[s.type];
    if (!root || s.userId !== row.user_id || typeof s.id !== 'string') return null;
    const [table,key] = root;
    const found = (await client.execute({ sql: `SELECT * FROM ${table} WHERE user_id = ? AND ${key} = ?`, args: [row.user_id,s.id] })).rows;
    if (found.length !== 1) return null;
    if (s.type === 'JOURNAL_FACT' && (found[0].fact_status !== 'ACTIVE' || found[0].content_state !== 'PRESENT')) return null;
    if (s.type === 'EXPERIMENT_DIRECT_ASSERTION' && (found[0].provenance_state !== 'DIRECT' || found[0].is_current !== 1
      || found[0].content_state !== 'PRESENT')) return null;
    if (['sleep','recovery','cycle','workout'].includes(s.type) && (await client.execute({
      sql: "SELECT 1 FROM whoop_resource_tombstones WHERE user_id = ? AND resource_type = ? AND resource_id = ? AND state = 'ACTIVE'",
      args: [row.user_id,s.type,s.id],
    })).rows.length) return null;
  }
  return proof;
}

export async function backfillV22(client, { privacyKeys, experimentAttestations = [] }) {
  const keys = requirePhase4Keys(privacyKeys);
  const keyCheck = keys.lookup(['phase4-lookup-key-check-v1']);
  await client.execute({sql:`INSERT INTO phase4_migration_checkpoints
    (target_version,step_key,last_cursor,postcondition_state,updated_at)
    VALUES (22,'lookup_key_check',?,'COMPLETE',?) ON CONFLICT DO NOTHING`,args:[keyCheck,new Date().toISOString()]});
  if ((await client.execute("SELECT last_cursor FROM phase4_migration_checkpoints WHERE target_version=22 AND step_key='lookup_key_check'")).rows[0].last_cursor !== keyCheck) {
    throw new Error('phase4_lookup_key_mismatch');
  }
  await client.execute({ sql: `INSERT INTO phase4_migration_checkpoints(target_version,step_key,postcondition_state,updated_at)
    VALUES (22,'privacy_backfill','PENDING',?) ON CONFLICT DO NOTHING`, args: [new Date().toISOString()] });
  const at = (await client.execute("SELECT updated_at FROM phase4_migration_checkpoints WHERE target_version=22 AND step_key='privacy_backfill'")).rows[0].updated_at;
  for (const table of V22_LEGACY_R_TABLES) {
    const pk = (await client.execute(`PRAGMA table_info(${table})`)).rows.filter(r => r.pk).sort((a,b) => a.pk-b.pk).map(r => r.name);
    await eachLegacyRow(client, table, async row => {
      let owner = table === 'system_heartbeats' ? (String(row.scope).startsWith('user:') ? String(row.scope).slice(5) : null)
        : table === 'telegram_operations' ? parse(row.result_json)?.userId : row.user_id;
      if (typeof owner !== 'string' || !(await client.execute({ sql: 'SELECT 1 FROM users WHERE id = ?', args: [owner] })).rows.length) owner = null;
      const id = keys.lookup(['privacy-artifact-v1',table,owner ?? row.scope ?? row.user_id ?? 'UNOWNED',
        own(row,'execution_mode') ? row.execution_mode : 'SHARED',pk.map(k => row[k])]);
      const patch = { privacy_artifact_id: id, content_state: 'PRESENT', source_linkage_state: 'COMPLETE' };
      if (table === 'journal_events') {
        patch.logical_fact_id = row.logical_fact_id ?? `legacy-v20:${row.user_id}:${row.id}`;
        patch.revision = row.revision ?? 1; patch.fact_status = row.fact_status ?? 'ACTIVE';
        patch.normalizer_version = row.normalizer_version ?? 'legacy-v20';
        patch.parser_version = row.parser_version ?? 'legacy-v20';
        patch.health_date_alignment = row.health_date_alignment ?? 'LEGACY';
        patch.recorded_timezone = owner ? (await client.execute({ sql: 'SELECT timezone FROM users WHERE id = ?', args: [owner] })).rows[0].timezone : null;
        const recognized = ['alcohol','caffeine','late_meal','food','supplement','medication','sickness','stress','late_sleep',
          'travel','flight','location','exercise_note','sauna','massage'].includes(row.category);
        patch.exposure_state = recognized && (Number(row.numeric_value) > 0 || Number(row.severity) > 0) ? 'EXPOSED' : null;
      }
      if (table === 'telegram_operations') {
        patch.owner_user_id = owner; patch.source_update_key = owner ? String(row.update_id) : null;
        if (!owner) {
          patch.result_json = REDACTED_RECEIPT;
          if (row.delivery_state === 'ACTION_READY') patch.delivery_state = 'NOT_REQUIRED';
          if (row.delivery_state === 'DELIVERY_STARTED') patch.delivery_state = 'AMBIGUOUS';
        }
      }
      if (!owner) {
        Object.assign(patch, redaction(at,id));
        if (DIAGNOSTICS[table]) patch[DIAGNOSTICS[table]] = null;
        else if (table !== 'telegram_operations') throw new Error(`phase4_unattributable_legacy_owner:${table}`);
      }
      if (table === 'analytics_invalidation' || table === 'analytics_work_state') await classifyScope(client,table,row,owner,patch,at);
      if (owner && patch.content_state === 'PRESENT') await addPrivacyLink(client, {
        userId: owner, table, artifactId: id, at,
        sourceType: table === 'journal_events' ? 'JOURNAL_FACT' : 'TENANT_LEGACY',
        sourceId: table === 'journal_events' ? id : owner,
      });
      await updateRow(client,table,row.migration_rowid,patch);
    });
  }
  await eachLegacyRow(client,'experiments',async row => {
    for (const [field,group] of Object.entries(EXPERIMENT_FIELDS)) {
      const existing = (await client.execute({ sql: `SELECT * FROM experiment_field_groups
        WHERE user_id=? AND experiment_id=? AND field_name=? AND is_current=1`, args: [row.user_id,row.id,field] })).rows;
      if (existing.length) continue;
      const proof = await verifiedExperimentProof(client,keys,experimentAttestations,row,field);
      const id = keys.lookup(['privacy-artifact-v1','experiment_field_groups',row.user_id,'SHARED',[row.id,group,field,1]]);
      if (!proof) await client.execute({ sql: `UPDATE experiments SET ${field}=? WHERE user_id=? AND id=?`,
        args: [EXPERIMENT_SENTINELS[field],row.user_id,row.id] });
      if (proof) {
        const sources = proof.sourceKind === 'EXPERIMENT_DIRECT_ASSERTION'
          ? [{ type: 'EXPERIMENT_DIRECT_ASSERTION', id: proof.assertionId }] : proof.sources;
        for (const s of sources) await addPrivacyLink(client,{ userId: row.user_id, table: 'experiment_field_groups',
          artifactId:id,sourceType:s.type,sourceId:s.id,at });
      }
      await client.execute({ sql: `INSERT INTO experiment_field_groups
        (user_id,experiment_id,field_group,field_name,source_kind,assertion_id,source_update_key,writer_kind,
         provenance_state,created_at,updated_at,content_state,source_linkage_state,privacy_artifact_id,
         health_content_redacted_at,health_content_redaction_reason)
        VALUES (?,?,?,?,?,?,?,'LEGACY_BACKFILL',?,?,?,?,?,?,?,?)`,
        args: [row.user_id,row.id,group,field,proof?.sourceKind ?? 'LEGACY_UNPROVEN',
          proof?.sourceKind === 'EXPERIMENT_DIRECT_ASSERTION' ? proof.assertionId : null,proof?.sourceUpdateKey ?? null,
          proof ? (proof.sourceKind === 'EXPERIMENT_DIRECT_ASSERTION' ? 'DIRECT' : 'LINKED') : 'QUARANTINED',
          row.created_at,row.updated_at,proof ? 'PRESENT' : 'REDACTED',proof ? 'COMPLETE' : 'DISCONNECTED',id,
          proof ? null : at,proof ? null : 'UNATTRIBUTED_LEGACY'],
      });
    }
  }, { unclassified: false });
}

export async function verifyV22Data(client, { backfill = false } = {}) {
  const reject = async (sql, label) => { if ((await client.execute(sql)).rows.length) throw new Error(`phase4_v22_postcondition:${label}`); };
  if (!backfill) return;
  for (const table of V22_LEGACY_R_TABLES) {
    await reject(`SELECT 1 FROM ${table} WHERE privacy_artifact_id IS NULL LIMIT 1`, `${table}_identity`);
    await reject(`SELECT 1 FROM ${table} WHERE content_state='REDACTED' AND
      (health_content_redacted_at IS NULL OR health_content_redaction_reason IS NULL OR content_digest_salt IS NOT NULL) LIMIT 1`, `${table}_redaction`);
    const owner = table === 'system_heartbeats' ? 'substr(p.scope,6)' : table === 'telegram_operations' ? 'p.owner_user_id' : 'p.user_id';
    await reject(`SELECT 1 FROM ${table} p WHERE content_state='PRESENT' AND (source_linkage_state <> 'COMPLETE'
      OR health_content_redacted_at IS NOT NULL OR NOT EXISTS (
      SELECT 1 FROM phase4_source_links l WHERE l.user_id=${owner} AND l.artifact_id=p.privacy_artifact_id AND l.artifact_type='${table}'
        AND l.unlinked_at IS NULL)) LIMIT 1`, `${table}_linkage`);
    if (DIAGNOSTICS[table]) await reject(`SELECT 1 FROM ${table} WHERE content_state='REDACTED'
      AND ${DIAGNOSTICS[table]} IS NOT NULL LIMIT 1`, `${table}_diagnostic_redaction`);
  }
  await reject(`SELECT 1 FROM telegram_operations WHERE owner_user_id IS NULL
    AND (content_state <> 'REDACTED' OR result_json <> '${REDACTED_RECEIPT}' OR delivery_state IN ('ACTION_READY','DELIVERY_STARTED')) LIMIT 1`, 'receipt_quarantine');
  await reject(`SELECT 1 FROM journal_events WHERE logical_fact_id IS NULL OR revision <> 1 OR fact_status <> 'ACTIVE'
    OR exposure_state = 'CONFIRMED_UNEXPOSED' LIMIT 1`, 'journal_backfill');
  await reject(`SELECT 1 FROM experiments e WHERE (SELECT count(*) FROM experiment_field_groups f
    WHERE f.user_id=e.user_id AND f.experiment_id=e.id AND f.is_current=1 AND f.field_revision=1) <> 10 LIMIT 1`, 'ten_experiment_leaves');
  for (const [field,sentinel] of Object.entries(EXPERIMENT_SENTINELS)) {
    const condition = sentinel === null ? `e.${field} IS NOT NULL` : `e.${field} IS NOT '${sentinel}'`;
    await reject(`SELECT 1 FROM experiment_field_groups f JOIN experiments e ON e.user_id=f.user_id AND e.id=f.experiment_id
      WHERE f.field_name='${field}' AND f.is_current=1 AND f.content_state='REDACTED' AND (${condition}) LIMIT 1`, `experiment_${field}_redaction`);
  }
  await reject(`SELECT 1 FROM experiment_field_groups f WHERE f.content_state='PRESENT' AND
    (f.provenance_state NOT IN ('DIRECT','LINKED') OR f.source_linkage_state <> 'COMPLETE' OR NOT EXISTS
      (SELECT 1 FROM phase4_source_links l WHERE l.user_id=f.user_id AND l.artifact_id=f.privacy_artifact_id AND l.unlinked_at IS NULL)) LIMIT 1`, 'experiment_provenance');
}
