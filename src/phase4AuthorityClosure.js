import { fail, readableRow } from './phase4Core.js';
import { physicallyScrubbed } from './phase4Redaction.js';

/** Discovery never trusts mutable naming links. Retained signed projections
 * identify families; a completed purge may remove an audit-only node from
 * discovery, but never satisfies a requested root or predecessor dependency.
 * Callers still validate every selected v25/v26/v27 projection and its roots. */
export function createTargetAuthorityClosure(core,authenticate) {
  const {client}=core;
  async function retained(context,table,rows) {
    const result=[];
    for(const row of rows) {
      if(readableRow(row)){result.push(row);continue;}
      if(!physicallyScrubbed(table,row))fail('CONTENT_REDACTED');
      const completed=(await client.execute({sql:`SELECT 1 FROM health_purge_targets t
        JOIN health_plaintext_purges p ON p.user_id=t.user_id AND p.purge_id=t.purge_id
        WHERE t.user_id=? AND t.artifact_execution_mode=? AND t.artifact_type=? AND t.artifact_id=?
          AND t.state='REDACTED' AND p.state='COMPLETE' AND p.purge_generation=?`,
        args:[context.userId,context.executionMode,table,row.privacy_artifact_id,row.purge_generation]})).rows;
      if(!completed.length)fail('CONTENT_REDACTED');
    }
    return result;
  }
  async function inventory(context,{kind,insightKey=null,insightId=null,metricKey=null,episodeId=null}={}) {
    const episode=kind==='EPISODE',tables={},scope=[context.userId,context.executionMode];
    const names=episode?['observation_episodes','phase4_episode_revisions']
      :['health_insights','insight_revisions','phase4_evidence_result_authorities'];
    for(const table of [...names,'phase4_operation_receipts']) {
      const predicate=table==='phase4_operation_receipts'
        ?episode?" AND (operation_kind LIKE 'EPISODE_%' OR operation_kind IN ('analyzeMetric','expireEpisode'))"
          :" AND (operation_kind LIKE 'INSIGHT_%' OR operation_kind IN ('analyzeAssociationFamily','expireInsight'))":'';
      const rows=(await client.execute({sql:`SELECT * FROM ${table} WHERE user_id=? AND execution_mode=?${predicate} LIMIT 1001`,args:scope})).rows;
      if(rows.length>1000)fail('PHASE4_OPERATION_RESULT_BOUNDS_UNAVAILABLE');
      tables[table]=await retained(context,table,rows);
    }
    let bytes=0;
    const records=tables.phase4_operation_receipts.map(receipt=>{
      bytes+=['request_json','result_json','related_results_json','required_roots_json','schema_contract_json']
        .reduce((n,key)=>n+Buffer.byteLength(receipt[key]??''),0);
      if(bytes>64*1024*1024)fail('PHASE4_OPERATION_RESULT_BOUNDS_UNAVAILABLE');
      return {receipt,decoded:authenticate(context,receipt)};
    });
    const type=episode?'observation_episodes':'health_insights',idField=episode?'episode_id':'id';
    const projections=records.flatMap(record=>record.decoded.related_results_json.filter(target=>target.type===type).map(target=>target.row));
    const requestedId=episode?episodeId:insightId;
    if(requestedId!==null&&!projections.some(row=>row[idField]===requestedId))fail('PHASE4_OPERATION_RESULT_UNAVAILABLE');
    if(!episode&&insightId!==null)insightKey=projections.find(row=>row.id===insightId).insight_key;
    const selected=new Set(projections.filter(row=>episode
      ?metricKey===null||row.subject_key===metricKey:insightKey===null||row.insight_key===insightKey).map(row=>row[idField]));
    // Missing signed authority cannot be certified absent, even if the mutable
    // materialized family/name has been cleared or changed.
    for(const row of tables[type])if(!projections.some(value=>value[idField]===row[idField]))fail('PHASE4_OPERATION_RESULT_UNAVAILABLE');
    for(const row of tables[type])if(episode?row.subject_key===metricKey:row.insight_key===insightKey)selected.add(row[idField]);
    tables[type]=tables[type].filter(row=>selected.has(row[idField]));
    const revisions=episode?'phase4_episode_revisions':'insight_revisions';
    tables[revisions]=tables[revisions].filter(row=>selected.has(row[episode?'episode_id':'insight_id']));
    tables.phase4_operation_receipts=records.filter(({decoded})=>decoded.related_results_json.some(target=>
      target.type===type&&selected.has(target.row[idField]))).map(({receipt})=>receipt);
    if(!episode) {
      const evidence=new Set(records.filter(({receipt})=>tables.phase4_operation_receipts.includes(receipt))
        .flatMap(({decoded})=>decoded.related_results_json.filter(target=>target.type==='evidence_items').map(target=>target.row.evidence_item_id)));
      tables.phase4_evidence_result_authorities=tables.phase4_evidence_result_authorities.filter(row=>{
        let origin;try{origin=JSON.parse(row.original_result_json);}catch{fail('PHASE4_DURABLE_REPLAY_BINDING_INVALID');}
        return evidence.has(row.evidence_item_id)||selected.has(origin?.insight_id);
      });
    }
    return tables;
  }
  return {inventory,retained};
}
