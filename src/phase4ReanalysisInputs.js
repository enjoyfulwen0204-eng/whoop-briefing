import { fail } from './phase4Core.js';
import { canonicalMetricSourceValue,canonicalAssociationOutcomeValue } from './phase4IntelligenceStore.js';
import { buildPersonalBaseline } from './phase4Intelligence.js';
import { phase4Metric } from './phase4IntelligenceRegistry.js';
import { addDays,localDate } from './time.js';
import { CATEGORIES } from './journal.js';

const whoop={sleep:['whoop_sleeps','id'],recovery:['whoop_recoveries','sleep_id'],cycle:['whoop_cycles','id'],workout:['whoop_workouts','id']};
const retained="content_state='PRESENT' AND source_linkage_state='COMPLETE' AND health_content_redacted_at IS NULL";
export const REANALYSIS_INPUT_POLICY=Object.freeze({associationDays:30,associationWindows:2,associationLagDays:1,
  sourcePageSize:32,baselineDiscoveryLimit:512,journalLimit:400});

export function createReanalysisInputs(core,stores) {
  const {client}=core;
  function sourceQuery(context,type) {
    const [table,key]=whoop[type];
    return {sql:`SELECT r.* FROM ${table} r WHERE r.user_id=?
      AND EXISTS(SELECT 1 FROM whoop_resource_access a WHERE a.user_id=r.user_id AND a.resource='${type}'
        AND a.status='ACCESSIBLE' AND a.auth_generation=? AND a.lifecycle_generation=?)
      AND NOT EXISTS(SELECT 1 FROM whoop_capabilities c WHERE c.user_id=r.user_id AND c.key='${type}'
        AND c.lifecycle_generation=? AND c.status IN ('UNSUPPORTED','UNAVAILABLE'))
      AND NOT EXISTS(SELECT 1 FROM whoop_resource_tombstones t WHERE t.user_id=r.user_id AND t.resource_type='${type}'
        AND t.resource_id=CAST(r.${key} AS TEXT) AND t.state='ACTIVE')`,
      args:[context.userId,context.authGeneration,context.lifecycleGeneration,context.lifecycleGeneration],key};
  }
  async function enumerate(context,cursor=null,limit=32) {
    if(!Number.isSafeInteger(limit)||limit<1||limit>100)fail('PHASE4_SCAN_PAGE_INVALID');
    const parts=[],args=[];
    for(const [type,[,key]] of Object.entries(whoop)) {
      const query=sourceQuery(context,type);
      parts.push(`SELECT '${type}' source_type,CAST(${key} AS TEXT) source_id FROM (${query.sql})`);args.push(...query.args);
    }
    for(const [type,table,key,predicate] of [
      ['JOURNAL_FACT','journal_events','privacy_artifact_id',"fact_status='ACTIVE'"],
      ['JOURNAL_COVERAGE','journal_coverage_windows','coverage_window_id',"status='ACTIVE'"],
      ['EXPERIMENT_DIRECT_ASSERTION','experiment_field_groups','assertion_id',"is_current=1 AND provenance_state='DIRECT' AND assertion_id IS NOT NULL"],
    ]) {
      parts.push(`SELECT '${type}' source_type,${key} source_id FROM ${table} WHERE user_id=? AND ${retained} AND ${predicate}`);
      args.push(context.userId);
    }
    parts.push("SELECT 'USER' source_type,? source_id");args.push(context.userId);
    return (await client.execute({sql:`SELECT source_type,source_id,json_array(source_type,source_id) cursor
      FROM (${parts.join(' UNION ALL ')}) WHERE json_array(source_type,source_id)>? COLLATE BINARY
      ORDER BY cursor COLLATE BINARY LIMIT ?`,args:[...args,cursor??'',limit]})).rows;
  }
  const eligible=(type,row)=>type==='sleep'?row.score_state==='SCORED'&&row.nap===0
    :type==='recovery'?row.score_state==='SCORED'&&row.user_calibrating===0
      :type==='cycle'?row.score_state==null||row.score_state==='SCORED':true;
  async function latest(context,type) {
    const q=sourceQuery(context,type),time=type==='sleep'?'end_at':type==='recovery'?'updated_at':'COALESCE(end_at,updated_at)';
    const scored=type==='sleep'?" AND score_state='SCORED' AND nap=0":type==='recovery'?" AND score_state='SCORED' AND user_calibrating=0"
      :type==='cycle'?" AND (score_state IS NULL OR score_state='SCORED')":'';
    return (await client.execute({sql:`SELECT * FROM (${q.sql}) WHERE 1=1 ${scored} ORDER BY ${time} DESC,${q.key} COLLATE BINARY LIMIT 1`,args:q.args})).rows[0]??null;
  }
  async function metric(context,metricKey,current,asOfUtc) {
    const contract=phase4Metric(metricKey),type=contract.sourceType;
    if(type==='body_energy_results') {
      const value=canonicalMetricSourceValue(metricKey,{type,id:current.row.result_id,row:current.row},context,asOfUtc);
      const rows=(await client.execute({sql:`SELECT * FROM body_energy_results WHERE user_id=? AND execution_mode=?
        AND input_generation=? AND lifecycle_generation=? AND auth_generation=? AND purge_generation=?
        AND health_date>=? AND health_date<? AND quality_state IN ('AVAILABLE','LIMITED') AND ${retained}
        ORDER BY health_date DESC,result_id COLLATE BINARY LIMIT 513`,args:[context.userId,context.executionMode,
          context.inputGeneration,context.lifecycleGeneration,context.authGeneration,context.purgeGeneration,
          addDays(value.healthDate,-contract.baselineLookbackDays),value.healthDate]})).rows;
      if(rows.length>512)fail('PHASE4_BASELINE_INPUT_BOUNDED');
      const observations=rows.map(row=>canonicalMetricSourceValue(metricKey,{type,id:row.result_id,row},context,asOfUtc));
      const selected=buildPersonalBaseline({metricKey,targetHealthDate:value.healthDate,asOfUtc,observations}),refs=[];
      for(const row of selected.samples)refs.push((await stores.readArtifact(context,type,{result_id:row.sourceId})).ref);
      return {metricKey,currentSource:current.ref,baselineSources:refs,asOfUtc,windowFamily:'STAGE6_CURRENT_BODY_ENERGY'};
    }
    const q=sourceQuery(context,type),value=canonicalMetricSourceValue(metricKey,{type,id:String(current.row[q.key]),row:current.row},context,asOfUtc);
    const firstDay=addDays(value.healthDate,-contract.baselineLookbackDays);
    const dateColumn=type==='cycle'?'COALESCE(end_at,updated_at)':'health_date';
    const rows=(await client.execute({sql:`SELECT * FROM (${q.sql}) WHERE ${dateColumn}>=? AND ${dateColumn}<?
      ORDER BY ${dateColumn} DESC,${q.key} COLLATE BINARY LIMIT 513`,args:[...q.args,
        type==='cycle'?addDays(firstDay,-1):firstDay,type==='cycle'?addDays(value.healthDate,1):value.healthDate]})).rows;
    if(rows.length>512)fail('PHASE4_BASELINE_INPUT_BOUNDED');
    const observations=rows.filter(row=>eligible(type,row)).map(row=>canonicalMetricSourceValue(metricKey,{type,id:String(row[q.key]),row},context,asOfUtc))
      .filter(row=>row.healthDate>=firstDay&&row.healthDate<value.healthDate);
    // The frozen baseline selector chooses the latest valid representative per
    // health day and its registered 30-day sample target. It owns the math.
    const selected=buildPersonalBaseline({metricKey,targetHealthDate:value.healthDate,asOfUtc,observations});
    const refs=[];for(const source of selected.samples)refs.push((await stores.root(context,type,source.sourceId)).ref);
    return {metricKey,currentSource:current.ref,baselineSources:refs,asOfUtc,windowFamily:windowFamily(metricKey)};
  }
  async function associations(context,metricKey,asOfUtc,windowIndex=0) {
    const type=phase4Metric(metricKey).sourceType;
    if(!whoop[type])return null;
    const end=addDays(localDate(new Date(asOfUtc),context.timezone),-30*windowIndex),start=addDays(end,-29),factorStart=addDays(start,-1),factorEnd=addDays(end,-1);
    const facts=(await client.execute({sql:`SELECT * FROM journal_events WHERE user_id=? AND ${retained} AND fact_status='ACTIVE'
      AND health_date>=? AND health_date<=? ORDER BY privacy_artifact_id LIMIT 401`,args:[context.userId,factorStart,factorEnd]})).rows;
    const coverage=(await client.execute({sql:`SELECT * FROM journal_coverage_windows WHERE user_id=? AND ${retained} AND status='ACTIVE'
      AND health_date_end>=? AND health_date_start<=? ORDER BY coverage_window_id LIMIT 401`,args:[context.userId,factorStart,factorEnd]})).rows;
    if(facts.length+coverage.length>400)fail('PHASE4_ASSOCIATION_HYPOTHESIS_INVALID');
    const factors=[...new Set([...facts.map(row=>row.category),...coverage.flatMap(row=>JSON.parse(row.factor_keys_json))])]
      .filter(factor=>CATEGORIES.includes(factor)&&factor!=='custom').sort();
    if(!factors.length)return null;
    if(factors.length>16)fail('PHASE4_ASSOCIATION_FAMILY_INVALID');
    const q=sourceQuery(context,type),dateColumn=type==='cycle'?'COALESCE(end_at,updated_at)':'health_date';
    const rows=(await client.execute({sql:`SELECT * FROM (${q.sql}) WHERE ${dateColumn}>=? AND ${dateColumn}<=?
      ORDER BY updated_at DESC,${q.key} COLLATE BINARY LIMIT 401`,args:[...q.args,
        type==='cycle'?addDays(start,-1):start,type==='cycle'?addDays(end,1):end]})).rows;
    if(rows.length>400)fail('PHASE4_ASSOCIATION_HYPOTHESIS_INVALID');
    const outcomes=new Map();for(const row of rows) {
      const value=canonicalAssociationOutcomeValue(metricKey,{type,id:String(row[q.key]),row},context,asOfUtc);
      if(value.healthDate>=start&&value.healthDate<=end&&!outcomes.has(value.healthDate))outcomes.set(value.healthDate,row);
    }
    const outcomeSources=[];for(const row of outcomes.values())outcomeSources.push((await stores.root(context,type,String(row[q.key]))).ref);
    const factRefs=[];for(const row of facts)factRefs.push((await stores.root(context,'JOURNAL_FACT',row.privacy_artifact_id)).ref);
    const coverageRefs=[];for(const row of coverage)coverageRefs.push((await stores.root(context,'JOURNAL_COVERAGE',row.coverage_window_id)).ref);
    return {asOfUtc,multipleTestingFamily:`stage6:${metricKey}:lag1:window${windowIndex}`,
      hypotheses:factors.map(factor=>({factor,outcomeMetric:metricKey,lagDays:1,
        comparisonHealthDates:Array.from({length:30},(_,i)=>addDays(start,i)),outcomeSources,
        journalFactSources:factRefs,coverageSources:coverageRefs}))};
  }
  return {enumerate,latest,metric,associations,eligible};
}
export function windowFamily(metricKey) {
  return {recovery_score:'DAILY_RECOVERY',hrv:'DAILY_HRV',rhr:'DAILY_RHR'}[metricKey]??`STAGE6_CURRENT_${metricKey.toUpperCase()}`;
}
