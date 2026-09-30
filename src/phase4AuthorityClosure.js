import { fail, readableRow } from './phase4Core.js';
import { physicallyScrubbed } from './phase4Redaction.js';
import { createReceiptRouting } from './phase4ReceiptRouting.js';
import { phase4Metric } from './phase4IntelligenceRegistry.js';

/** Discovery never trusts mutable naming links. Retained signed projections
 * identify families; a completed purge may remove an audit-only node from
 * discovery, but never satisfies a requested root or predecessor dependency.
 * Callers still validate every selected v25/v26/v27 projection and its roots. */
export function createTargetAuthorityClosure(core,authenticate) {
  const {client}=core,routing=core.schemaVersion>=29?createReceiptRouting(client,core.keys):null;
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
  async function inventory(context,{kind,insightKey=null,insightId=null,metricKey=null,episodeId=null,episodeFamilyKey=null}={}) {
    if(routing)return scopedInventory(context,{kind,insightKey,insightId,metricKey,episodeId,episodeFamilyKey});
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
  async function scopedInventory(context,{kind,insightKey,insightId,metricKey,episodeId,episodeFamilyKey}) {
    const episode=kind==='EPISODE',type=episode?'observation_episodes':'health_insights',
      idField=episode?'episode_id':'id',revisionTable=episode?'phase4_episode_revisions':'insight_revisions',
      requestedId=episode?episodeId:insightId,scope=[context.userId,context.executionMode];
    if(requestedId!==null) {
      const routed=await routing.inventory(context,episode?'EPISODE_ID':'INSIGHT_ID',requestedId);
      if(routed.unknown)fail('PHASE4_RECEIPT_ROUTE_LEGACY_UNKNOWN');
      const projections=[];
      for(const receipt of routed.receipts)for(const target of authenticate(context,receipt).related_results_json)
        if(target.type===type&&target.row?.[idField]===requestedId)projections.push(target.row);
      if(!projections.length)fail('PHASE4_OPERATION_RESULT_UNAVAILABLE');
      const identities=new Set(projections.map(row=>episode?row.subject_key:row.insight_key));
      if(identities.size!==1)fail('PHASE4_OPERATION_RECEIPT_INTEGRITY');
      const discovered=[...identities][0];
      if(episode){
        if(metricKey!==null&&metricKey!==discovered||episodeFamilyKey!==null
          &&projections.some(row=>row.episode_family_key!==episodeFamilyKey))fail('PHASE4_EPISODE_IDENTITY_REQUIRED');
        metricKey=discovered;
      }
      else {if(insightKey!==null&&insightKey!==discovered)fail('PHASE4_INSIGHT_IDENTITY_MISMATCH');insightKey=discovered;}
    }
    if(episode?metricKey===null:insightKey===null)fail('PHASE4_RECEIPT_ROUTE_TARGET_REQUIRED');
    const identity=episode?episodeFamilyKey??[metricKey,phase4Metric(metricKey).domain]:insightKey;
    const selected=await routing.inventory(context,episode&&episodeFamilyKey?'EPISODE_FAMILY':kind,identity);
    if(selected.unknown)fail('PHASE4_RECEIPT_ROUTE_LEGACY_UNKNOWN');
    const records=[];let bytes=0;
    for(const receipt of await retained(context,'phase4_operation_receipts',selected.receipts)) {
      bytes+=['request_json','result_json','related_results_json','required_roots_json','schema_contract_json']
        .reduce((n,key)=>n+Buffer.byteLength(receipt[key]??''),0);
      if(bytes>64*1024*1024)fail('PHASE4_OPERATION_RESULT_BOUNDS_UNAVAILABLE');
      records.push({receipt,decoded:authenticate(context,receipt)});
    }
    const projections=records.flatMap(({decoded})=>decoded.related_results_json.filter(target=>target.type===type)
      .map(target=>target.row));
    const ids=new Set(projections.filter(row=>episode?row.subject_key===metricKey
      &&(episodeFamilyKey===null||row.episode_family_key===episodeFamilyKey):row.insight_key===insightKey)
      .map(row=>row[idField]));
    if(requestedId!==null&&!ids.has(requestedId))fail('PHASE4_OPERATION_RESULT_UNAVAILABLE');
    const hints=(await client.execute({sql:`SELECT * FROM ${type} WHERE user_id=? AND execution_mode=?
      AND ${episode?episodeFamilyKey?'episode_family_key':'subject_key':'insight_key'}=? LIMIT 1001`,
      args:[...scope,episode?episodeFamilyKey??metricKey:insightKey]})).rows;
    if(hints.length>1000)fail('PHASE4_OPERATION_RESULT_BOUNDS_UNAVAILABLE');
    const scopedReceiptKeys=new Set(records.map(({receipt})=>`${receipt.operation_kind}:${receipt.operation_key}`));
    for(const hint of await retained(context,type,hints))if(!ids.has(hint[idField])) {
      // A mutable parent name can point into this family without changing its
      // independently signed route. Ignore only parents whose ID route proves
      // that every producer belongs outside the target receipt inventory.
      const byId=await routing.inventory(context,episode?'EPISODE_ID':'INSIGHT_ID',hint[idField]);
      if(byId.unknown||!byId.receipts.length||byId.receipts.some(receipt=>
        scopedReceiptKeys.has(`${receipt.operation_kind}:${receipt.operation_key}`)))
        fail('PHASE4_OPERATION_RESULT_UNAVAILABLE');
    }
    const tables={[type]:[],[revisionTable]:[],phase4_operation_receipts:records.map(value=>value.receipt)};
    if(!episode)tables.phase4_evidence_result_authorities=[];
    for(const id of ids) {
      const row=(await client.execute({sql:`SELECT * FROM ${type} WHERE user_id=? AND execution_mode=? AND ${idField}=?`,
        args:[...scope,id]})).rows[0];
      if(!row)fail('PHASE4_OPERATION_RESULT_UNAVAILABLE');
      tables[type].push(...await retained(context,type,[row]));
      const revisions=(await client.execute({sql:`SELECT * FROM ${revisionTable} WHERE user_id=? AND execution_mode=?
        AND ${episode?'episode_id':'insight_id'}=? ORDER BY revision LIMIT 1001`,args:[...scope,id]})).rows;
      if(revisions.length>1000)fail('PHASE4_OPERATION_RESULT_BOUNDS_UNAVAILABLE');
      tables[revisionTable].push(...await retained(context,revisionTable,revisions));
      if(tables[revisionTable].length>1000)fail('PHASE4_OPERATION_RESULT_BOUNDS_UNAVAILABLE');
    }
    if(!episode) {
      const evidence=new Set(records.flatMap(({decoded})=>decoded.related_results_json
        .filter(target=>target.type==='evidence_items').map(target=>target.row.evidence_item_id)));
      // An orphan v26 origin can outlive its parent. The origin's ID remains a
      // search hint; every selected authority is authenticated by the caller.
      const all=(await client.execute({sql:`SELECT * FROM phase4_evidence_result_authorities
        WHERE user_id=? AND execution_mode=? ORDER BY evidence_item_id,result_scope`,args:scope})).rows;
      for(const row of all) {
        let origin=null;
        if(row.original_result_json!==null)try{origin=JSON.parse(row.original_result_json);}catch{
          fail('PHASE4_DURABLE_REPLAY_BINDING_INVALID');
        }
        if(evidence.has(row.evidence_item_id)||ids.has(origin?.insight_id))
          tables.phase4_evidence_result_authorities.push(...await retained(context,'phase4_evidence_result_authorities',[row]));
        if(tables.phase4_evidence_result_authorities.length>1000)fail('PHASE4_OPERATION_RESULT_BOUNDS_UNAVAILABLE');
      }
    }
    return tables;
  }
  return {inventory,retained};
}
