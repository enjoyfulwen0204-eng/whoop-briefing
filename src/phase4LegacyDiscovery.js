import { fail, readableRow } from './phase4Core.js';
import { INTELLIGENCE_VERSIONS } from './phase4IntelligenceRegistry.js';
import { canonicalJson } from './phase4EntityStore.js';
import { canonicalInstant } from './phase4Time.js';
import { canonicalSourceVersion } from './phase4SourceVersion.js';
import { createResultAuthority } from './phase4ResultAuthority.js';
import { RESULT_AUTHORITY_TABLE } from './phase4V26Schema.js';

export const LEGACY_DISCOVERY_BUDGET=Object.freeze({runs:500,authorities:1000,deadlineMs:5000});
const unavailable=()=>fail('PHASE4_LEGACY_DISCOVERY_UNAVAILABLE');
const invalid=()=>fail('PHASE4_DURABLE_REPLAY_BINDING_INVALID');
const ordered=values=>[...new Set(values.map(canonicalJson))].sort();
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);

/** Exact-key misses cannot bypass old authenticated input identities. Scope is
 * tenant/mode/input generation only; mutable subject/method/time selectors are
 * never the completeness boundary. Missing old operation facts are unavailable,
 * never filled in from the new request or rewritten as new receipts. */
export function createLegacyDiscovery(core) {
  const authority=createResultAuthority(core);
  return async function discover(context,kind,request) {
    if(!['analyzeMetric','analyzeAssociationFamily'].includes(kind))return;
    const start=performance.now(),scope=[context.userId,context.executionMode,context.inputGeneration];
    const check=()=>{if(performance.now()-start>LEGACY_DISCOVERY_BUDGET.deadlineMs)unavailable();};
    const runs=(await core.client.execute({sql:`SELECT * FROM evidence_runs WHERE user_id=? AND execution_mode=?
      AND input_generation=? ORDER BY run_id LIMIT ?`,args:[...scope,LEGACY_DISCOVERY_BUDGET.runs+1]})).rows;
    const authorities=(await core.client.execute({sql:`SELECT * FROM ${RESULT_AUTHORITY_TABLE} WHERE user_id=? AND execution_mode=?
      AND input_generation=? ORDER BY evidence_item_id,result_scope LIMIT ?`,args:[...scope,LEGACY_DISCOVERY_BUDGET.authorities+1]})).rows;
    if(runs.length>LEGACY_DISCOVERY_BUDGET.runs||authorities.length>LEGACY_DISCOVERY_BUDGET.authorities)unavailable();
    const runIds=new Set(runs.map(run=>run.run_id));
    for(const row of authorities)if(!runIds.has(row.run_id))invalid();
    const matches=[];
    for(const run of runs) {
      check();
      if(!readableRow(run))fail('CONTENT_REDACTED');
      let manifest;try{manifest=JSON.parse(run.input_manifest_json);}catch{invalid();}
      if(!manifest?.manifest_version)unavailable();
      // Verifies the historical hash and original key from the stored bytes.
      await authority.descriptorsForRun(context,run);check();
      if(manifest.request_scope&&(manifest.request_scope.timezone!==context.timezone||manifest.request_scope.algorithm!==context.algorithmSetVersion
        ||manifest.request_scope.lifecycle!==context.lifecycleGeneration||manifest.request_scope.auth!==context.authGeneration
        ||manifest.request_scope.purge!==context.purgeGeneration||!same(manifest.request_scope.versions,INTELLIGENCE_VERSIONS)))continue;
      let equivalent=false;
      if(kind==='analyzeMetric'&&manifest.manifest_version.startsWith('phase4-metric-evidence-input-')) {
        const refs=manifest.quality?.provenance;
        if(!Array.isArray(refs))unavailable();
        equivalent=(manifest.refresh_preparation===true)===(request.refresh===true)
          &&manifest.metric_key===request.metricKey&&canonicalInstant(manifest.as_of_utc)===request.asOfUtc
          &&same(ordered(refs.map(([type,id,version])=>[type,id,canonicalSourceVersion(version)])),
            ordered([request.currentSource,...request.baselineSources].map(ref=>[ref.source_type,ref.source_id,ref.source_version])))
          &&manifest.current?.sourceId===request.currentSource.source_id
          &&(!manifest.window_family||manifest.window_family===request.windowFamily);
      } else if(kind==='analyzeAssociationFamily'&&manifest.manifest_version.startsWith('phase4-association-family-input-')) {
        const stored=manifest.hypotheses;
        if(!Array.isArray(stored))unavailable();
        equivalent=(manifest.lifecycle_mode??null)===(request.lifecycleMode??null)
          &&manifest.multiple_testing_family===request.multipleTestingFamily&&canonicalInstant(manifest.as_of_utc)===request.asOfUtc
          &&same(ordered(stored.map(h=>[h.factor,h.outcome_metric,h.lag_days,h.comparison_health_dates])),
            ordered(request.hypotheses.map(h=>[h.factor,h.outcomeMetric,h.lagDays,h.comparisonHealthDates])))
          &&stored.every(h=>{
            const asked=request.hypotheses.find(q=>q.factor===h.factor&&q.outcomeMetric===h.outcome_metric&&q.lagDays===h.lag_days);
            return same(ordered(h.days.filter(day=>day.outcomeSource).map(day=>{const [type,id,version]=day.outcomeSource;return [type,id,canonicalSourceVersion(version)];})),
              ordered(asked.outcomeSources.map(ref=>[ref.source_type,ref.source_id,ref.source_version])))
              &&same(ordered(h.journal_authority.map(ref=>[ref.type,ref.id,ref.revision,canonicalInstant(ref.createdAt)])),
                ordered([...asked.journalFactSources,...asked.coverageSources].filter(ref=>ref.source_id)
                  .map(ref=>[ref.source_type,ref.source_id,ref.source_version,ref.created_at])));
          });
      }
      if(!equivalent)continue;
      const records=authorities.filter(row=>row.run_id===run.run_id);
      const items=(await core.client.execute({sql:'SELECT * FROM evidence_items WHERE user_id=? AND execution_mode=? AND run_id=?',
        args:[context.userId,context.executionMode,run.run_id]})).rows;
      if(!records.length){matches.push({run,complete:false});continue;}
      for(const row of records) {
        const item=items.find(item=>item.evidence_item_id===row.evidence_item_id);
        if(!item)invalid();
        const verified=authority.authenticate(context,row,item,run);
        await authority.validateRoots(context,row,verified.manifest);check();
      }
      // A v26 result is not a complete public operation receipt, even if its
      // origin is authentic. A v27 receipt miss with equivalent input also
      // fails closed: it may indicate a missing receipt or unknown dimension.
      matches.push({run,complete:false});
    }
    check();
    // Association has one run per focus in a family. Only duplicate focus
    // identities are ambiguous, rather than a legitimate multi-hypothesis set.
    const groups=new Map();
    for(const {run} of matches) {
      const manifest=JSON.parse(run.input_manifest_json),focus=kind==='analyzeMetric'?'metric':manifest.focus_key;
      groups.set(focus,(groups.get(focus)??0)+1);
    }
    if([...groups.values()].some(count=>count>1))fail('PHASE4_LEGACY_IDENTITY_AMBIGUOUS');
    if(matches.length)fail('PHASE4_OPERATION_RESULT_UNAVAILABLE');
  };
}
