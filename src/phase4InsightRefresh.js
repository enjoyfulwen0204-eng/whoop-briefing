import { fail, readableRow } from './phase4Core.js';
import { canonicalJson } from './phase4EntityStore.js';
import { normalizeInsightIdentity } from './phase4InsightStore.js';
import { OPERATION_RECEIPT_TABLE } from './phase4V27Schema.js';
import { RESULT_AUTHORITY_TABLE } from './phase4V26Schema.js';
import { INTELLIGENCE_VERSIONS } from './phase4IntelligenceRegistry.js';
import { createTargetAuthorityClosure } from './phase4AuthorityClosure.js';

const same = (a, b) => canonicalJson(a) === canonicalJson(b);
const parse = value => { try { return JSON.parse(value); } catch { fail('PHASE4_OPERATION_RECEIPT_INTEGRITY'); } };
const unavailable = () => fail('PHASE4_OPERATION_RESULT_UNAVAILABLE');
const invalid = () => fail('PHASE4_OPERATION_RECEIPT_INTEGRITY');
const operational = new Set(['created_at', 'updated_at', 'content_digest_salt', 'content_state', 'source_linkage_state',
  'health_content_redacted_at', 'health_content_redaction_reason', 'source_subject_deleted_at']);
const semantic = row => Object.fromEntries(Object.entries(row).filter(([key]) => !operational.has(key)));

/** Historical metadata only. This resolver never issues a source reference or
 * makes an old projection readable as current. Its only caller is the explicit
 * INSIGHT_TRANSITION refresh branch inside the existing receipt transaction. */
export function createInsightRefreshAuthority(core, { authenticate, authorities, validateEvidence }) {
  const { client, keys } = core;
  const closure=createTargetAuthorityClosure(core,authenticate);
  async function inventory(context,target={}) {
    const scope = [context.userId, context.executionMode], tables = await closure.inventory(context,{kind:'INSIGHT',...target});
    const histories = new Map(), revisions = new Map(), identities = new Map();
    let bytes = 0;
    for (const receipt of tables[OPERATION_RECEIPT_TABLE]) {
      bytes += ['request_json', 'result_json', 'related_results_json', 'required_roots_json', 'schema_contract_json']
        .reduce((sum, name) => sum + Buffer.byteLength(receipt[name] ?? ''), 0);
      if (bytes > 64 * 1024 * 1024) fail('PHASE4_INSIGHT_DISCOVERY_BOUNDS_UNAVAILABLE');
      const decoded = authenticate(context, receipt);
      for (const target of decoded.related_results_json) {
        if (target.type === 'insight_revisions') {
          const key = canonicalJson([target.row.insight_id, target.row.revision]), prior = revisions.get(key);
          if (prior && !same(prior, target.row)) invalid();
          revisions.set(key, target.row);
        }
        if (target.type !== 'health_insights') continue;
        const row = target.row;
        if (!Number.isSafeInteger(row.id) || !Number.isSafeInteger(row.current_revision) || row.current_revision < 1
          || !same(target.key, { id: row.id }) || target.id !== row.privacy_artifact_id) invalid();
        let history = histories.get(row.id);
        if (!history) histories.set(row.id, history = new Map());
        const prior = history.get(row.current_revision);
        if (prior && !same(prior.row, row)) invalid();
        history.set(row.current_revision, { row, receipt, decoded });
        if (receipt.operation_kind === 'INSIGHT_CREATE' && row.current_revision === 1) {
          if (decoded.request_json.profiles?.insight_identity !== 'domain-insight-identity-once-v1') unavailable();
          const identity = decoded.request_json.request.identity, old = identities.get(row.id);
          if (old && !same(old, identity)) invalid();
          identities.set(row.id, identity);
        }
      }
    }
    for (const row of tables.health_insights) if (!histories.has(row.id)) unavailable();
    for (const row of tables.insight_revisions) {
      if (!readableRow(row)) fail('CONTENT_REDACTED');
      const signed = revisions.get(canonicalJson([row.insight_id, row.revision]));
      if (!signed) unavailable();
      if (!same(row, signed)) invalid();
    }
    for (const row of revisions.values()) if (!tables.insight_revisions.some(value =>
      value.insight_id === row.insight_id && value.revision === row.revision)) unavailable();
    for (const authority of tables[RESULT_AUTHORITY_TABLE]) {
      const item = (await client.execute({ sql: 'SELECT * FROM evidence_items WHERE user_id=? AND execution_mode=? AND evidence_item_id=?',
        args: [...scope, authority.evidence_item_id] })).rows[0];
      const run = (await client.execute({ sql: 'SELECT * FROM evidence_runs WHERE user_id=? AND execution_mode=? AND run_id=?',
        args: [...scope, authority.run_id] })).rows[0];
      const verified = authorities.authenticate(context, authority, item, run);
      if (authority.result_scope !== 'METRIC' && verified.origin !== null) {
        const origin = verified.origin, revision = revisions.get(canonicalJson([origin.insight_id, origin.revision]));
        if (!revision || !histories.has(origin.insight_id)) unavailable();
        if (canonicalJson(revision) !== origin.revision_json) invalid();
      }
    }
    return { tables, histories, revisions, identities };
  }
  async function predecessor(context, request) {
    const identity = normalizeInsightIdentity(request.identity), state = await inventory(context,{insightId:request.insightId});
    const history = state.histories.get(request.insightId);
    if (!history) unavailable();
    const numbers = [...history.keys()].sort((a, b) => a - b), latest = history.get(numbers.at(-1));
    if (numbers.length !== latest.row.current_revision || numbers.some((n, i) => n !== i + 1)) unavailable();
    if (latest.row.current_revision !== request.expectedRevision) fail('PHASE4_INSIGHT_CAS_LOST');
    if (!same(state.identities.get(request.insightId) ?? null, identity)) fail('PHASE4_INSIGHT_IDENTITY_MISMATCH');
    const key = keys.lookup(['insight-key-v1', context.userId,
      ...['subject', 'outcome', 'direction', 'exposureCategory', 'algorithmFamily', 'evidenceContractMajor'].map(name => identity[name])]);
    if (key !== latest.row.insight_key) invalid();
    for (const [id, values] of state.histories) {
      const tip = values.get(Math.max(...values.keys())).row;
      if (id !== request.insightId && (tip.supersedes_id === request.insightId
        || tip.insight_key === key && tip.status !== 'RETIRED')) fail('PHASE4_INSIGHT_PREDECESSOR_AMBIGUOUS');
    }
    for (const { row } of history.values()) if (row.insight_key !== key
      || row.supersedes_id !== latest.row.supersedes_id || row.first_detected_at !== latest.row.first_detected_at) invalid();
    const current = state.tables.health_insights.find(row => row.id === request.insightId);
    if (!readableRow(current)) fail('CONTENT_REDACTED');
    if (!same(semantic(current), semantic(latest.row))) invalid();
    if (latest.row.status === 'RETIRED' || latest.row.lifecycle_disposition) fail('PHASE4_INSIGHT_TERMINAL_REFRESH');
    if(Date.parse(latest.row.expires_at)<=Date.parse(request.semanticAt)) {
      const disposition=latest.row.status==='HYPOTHESIS'?'REJECTED':'EXPIRED';
      if(request.status!=='RETIRED'||request.disposition!==disposition||request.reason!==disposition)
        fail('PHASE4_INSIGHT_TERMINAL_REFRESH');
    }
    if (latest.row.input_generation >= context.inputGeneration || current.invalidated_at) fail('PHASE4_INSIGHT_REFRESH_INVALID');
    await retainedReceipt(context,latest.receipt,latest.decoded);
    return { insightId: request.insightId, revision: request.expectedRevision, inputGeneration: latest.row.input_generation,
      identity, operationKind:latest.receipt.operation_kind,receiptKey: latest.receipt.operation_key, receiptHmac: latest.receipt.receipt_hmac };
  }
  async function retainedReceipt(context,receipt,decoded,depth=0) {
    if(depth>1000)fail('PHASE4_INSIGHT_DISCOVERY_BOUNDS_UNAVAILABLE');
    // Every signed root must still physically exist and pass current privacy /
    // access checks. Old values are metadata only and are never calculation inputs.
    for (const root of decoded.required_roots_json.roots) {
      if (root.mode === 'SHARED') {
        if (root.as_of) await core.validateHistoricalJournal(context, { type: root.type, id: root.id, historicalAsOf: root.as_of });
        else await core.root(context, root.type, root.id);
      } else {
        if (!['evidence_items', 'body_energy_results'].includes(root.type)) invalid();
        const retained = (await client.execute({ sql: `SELECT * FROM ${root.type} WHERE user_id=? AND execution_mode=? AND privacy_artifact_id=?`,
          args: [context.userId, context.executionMode, root.id] })).rows[0];
        if (!readableRow(retained) || retained.invalidated_at) fail('CONTENT_REDACTED');
      }
    }
    for (const target of decoded.related_results_json) {
      if (['health_insights', 'observation_episodes'].includes(target.type)) continue;
      const contract = decoded.schema_contract_json[target.type];
      const info = (await client.execute(`PRAGMA table_info(${target.type})`)).rows
        .map(column => ({ name: column.name, type: column.type, notnull: column.notnull, pk: column.pk }));
      if (!same(info, contract)) unavailable();
      const names = Object.keys(target.key);
      if (!same(names.sort(), contract.filter(column => column.pk && !['user_id', 'execution_mode'].includes(column.name)).map(column => column.name).sort())) invalid();
      const row = (await client.execute({ sql: `SELECT * FROM ${target.type} WHERE user_id=? AND execution_mode=? AND ${names.map(name => `${name}=?`).join(' AND ')}`,
        args: [context.userId, context.executionMode, ...names.map(name => target.key[name])] })).rows[0];
      if (!readableRow(row)) fail('CONTENT_REDACTED');
      if (!same(row, target.row)) invalid();
    }
    if(receipt.operation_kind==='INSIGHT_TRANSITION'&&decoded.result_json.refreshPredecessor)
      await retained(context,decoded.result_json.refreshPredecessor,depth+1);
  }
  async function retained(context,binding,depth=0) {
    const receipt=(await client.execute({sql:`SELECT * FROM ${OPERATION_RECEIPT_TABLE}
      WHERE user_id=? AND execution_mode=? AND operation_kind=? AND operation_key=?`,
      args:[context.userId,context.executionMode,binding.operationKind,binding.receiptKey]})).rows[0];
    if(!receipt)unavailable();
    const decoded=authenticate(context,receipt);
    if(receipt.receipt_hmac!==binding.receiptHmac||!decoded.related_results_json.some(target=>
      target.type==='health_insights'&&target.row.id===binding.insightId&&target.row.current_revision===binding.revision
      &&target.row.input_generation===binding.inputGeneration))invalid();
    await retainedReceipt(context,receipt,decoded,depth);
  }
  async function fresh(context, request, binding) {
    const ids = [...(request.supportingEvidenceIds ?? []), ...(request.contradictingEvidenceIds ?? [])];
    if (!ids.length) fail('PHASE4_INSIGHT_EVIDENCE_REQUIRED');
    for (const id of ids) {
      await validateEvidence(context, id);
      const item = await core.artifact(context, 'evidence_items', { evidence_item_id: id });
      const run = await core.artifact(context, 'evidence_runs', { run_id: item.row.run_id });
      const manifest = parse(run.row.input_manifest_json), hypothesis = manifest.hypotheses?.find(h =>
        `${h.factor}:${h.outcome_metric}:lag-${h.lag_days}` === manifest.focus_key);
      if (!hypothesis || run.row.method !== 'JOURNAL_ASSOCIATION') fail('PHASE4_INSIGHT_REFRESH_EVIDENCE_IDENTITY');
      const target = normalizeInsightIdentity({ subject: `journal:${hypothesis.factor}`, outcome: hypothesis.outcome_metric,
        direction: item.row.direction, exposureCategory: hypothesis.factor, algorithmFamily: 'journal-association', evidenceContractMajor: '1' });
      const expected = binding.identity;
      const contradiction = (request.contradictingEvidenceIds ?? []).includes(id);
      if (!same(target, contradiction ? { ...expected, direction: expected.direction === 'lower' ? 'higher' : 'lower' } : expected))
        fail('PHASE4_INSIGHT_REFRESH_EVIDENCE_IDENTITY');
      const scope = manifest.request_scope;
      if (!scope || manifest.lifecycle_mode==='EVIDENCE_ONLY'&&scope.source!==context.sourceGeneration
        || scope.input !== context.inputGeneration || scope.lifecycle !== context.lifecycleGeneration
        || scope.auth !== context.authGeneration || scope.purge !== context.purgeGeneration
        || scope.algorithm !== context.algorithmSetVersion || scope.timezone !== context.timezone||!same(scope.versions,INTELLIGENCE_VERSIONS)
        || Date.parse(manifest.as_of_utc) > Date.parse(request.semanticAt)) fail('PHASE4_INSIGHT_REFRESH_EVIDENCE_SCOPE');
    }
  }
  return { predecessor, fresh, inventory, retained, retainedReceipt };
}
