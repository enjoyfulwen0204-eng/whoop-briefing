import { fail, readableRow } from './phase4Core.js';
import { canonicalJson } from './phase4EntityStore.js';
import { episodeSemanticProjection, EPISODE_OPERATIONAL_FIELDS } from './phase4EpisodeHistory.js';
import { EPISODE_ACTIVE, V23_HEALTH_FIELDS } from './phase4V23Schema.js';
import { INTELLIGENCE_VERSIONS, phase4Metric } from './phase4IntelligenceRegistry.js';
import { evaluateMeaningfulChange } from './phase4Intelligence.js';
import { requireChronology } from './phase4Time.js';
import { createTargetAuthorityClosure } from './phase4AuthorityClosure.js';

const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const invalid=()=>fail('PHASE4_METRIC_REFRESH_AUTHORITY_INVALID');
const parse=value=>{try{return JSON.parse(value);}catch{invalid();}};
const eventProjection=row=>Object.fromEntries(Object.entries(row).filter(([key])=>!EPISODE_OPERATIONAL_FIELDS.includes(key)));

/** No public historical reader and no new calculation engine. Historical
 * snapshots authorize lifecycle context; the existing pure evaluator owns
 * the current calculation. A private request ticket conveys the resulting
 * plan only to the public EPISODE_REFRESH implementation. */
export function createMetricRefreshAuthority(core,{authenticate,authorities,validateEvidence,retainedReceipt}) {
  const {client,keys}=core,plans=new WeakMap();
  const closure=createTargetAuthorityClosure(core,authenticate);
  async function historical(context,{episodeId,expectedRevision,identity},{terminal=false,successorId=null}={}) {
    const args=[context.userId,context.executionMode,episodeId];
    const snapshots=(await client.execute({sql:`SELECT * FROM phase4_episode_revisions WHERE user_id=? AND execution_mode=?
      AND episode_id=? ORDER BY revision LIMIT 1001`,args})).rows;
    if(!snapshots.length||snapshots.length>1000)fail('PHASE4_EPISODE_HISTORY_UNAVAILABLE');
    const receipts=(await closure.inventory(context,{kind:'EPISODE',episodeId,metricKey:identity?.metric})).phase4_operation_receipts;
    if(receipts.length>1000)fail('PHASE4_OPERATION_RESULT_BOUNDS_UNAVAILABLE');
    let bytes=0;
    const signed=[];
    for(const receipt of receipts) {
      bytes+=Buffer.byteLength(receipt.related_results_json??'');
      if(bytes>64*1024*1024)fail('PHASE4_OPERATION_RESULT_BOUNDS_UNAVAILABLE');
      signed.push({receipt,decoded:authenticate(context,receipt)});
    }
    // A removed snapshot or rolled-back materialized pointer cannot conceal
    // a later lifecycle fact that is still present in authenticated receipts.
    for(const {decoded} of signed)for(const target of decoded.related_results_json) {
      if(target.row?.episode_id!==episodeId)continue;
      if(target.type==='phase4_episode_revisions'&&!snapshots.some(snapshot=>same(snapshot,target.row)))invalid();
      if(target.type==='observation_episodes') {
        const snapshot=snapshots.find(snapshot=>snapshot.revision===target.row.revision);
        if(!snapshot||!same(parse(snapshot.snapshot_json).episode,episodeSemanticProjection(target.row)))invalid();
      }
    }
    let latest;
    for(const [index,snapshot] of snapshots.entries()) {
      if(!readableRow(snapshot))fail('CONTENT_REDACTED');
      const value=parse(snapshot.snapshot_json);
      if(snapshot.revision!==index+1||snapshot.snapshot_version!=='episode-revision-v1'
        ||keys.digest(snapshot.content_digest_salt,snapshot.snapshot_json)!==snapshot.snapshot_hash
        ||canonicalJson(value)!==snapshot.snapshot_json||value.version!==snapshot.snapshot_version
        ||value.semantic_at!==snapshot.semantic_at)invalid();
      for(const field of ['user_id','execution_mode','episode_id','revision','input_generation','lifecycle_generation','auth_generation','purge_generation'])
        if(value.episode?.[field]!==snapshot[field])invalid();
      const event=(await client.execute({sql:`SELECT * FROM episode_events WHERE user_id=? AND execution_mode=?
        AND episode_id=? AND resulting_revision=?`,args:[...args,snapshot.revision]})).rows;
      if(event.length!==1||!readableRow(event[0])||event[0].episode_event_id!==snapshot.episode_event_id
        ||!same(eventProjection(event[0]),value.event)||value.event.to_state!==value.episode.state)invalid();
      const matches=signed.filter(({decoded})=>decoded.related_results_json.some(target=>
        target.type==='phase4_episode_revisions'&&same(target.row,snapshot)));
      if(!matches.length)fail('PHASE4_OPERATION_RESULT_UNAVAILABLE');
      for(const match of matches)if(!match.decoded.related_results_json.some(target=>target.type==='observation_episodes'
        &&same(episodeSemanticProjection(target.row),value.episode)))invalid();
      latest={snapshot,value,...matches[0]};
    }
    if(latest.snapshot.revision!==expectedRevision)fail('PHASE4_EPISODE_CAS_LOST');
    const row=(await client.execute({sql:'SELECT * FROM observation_episodes WHERE user_id=? AND execution_mode=? AND episode_id=?',args})).rows[0];
    if(!readableRow(row))fail('CONTENT_REDACTED');
    if(!same(episodeSemanticProjection(row),latest.value.episode))invalid();
    if(!identity||Object.keys(identity).sort().join(',')!=='algorithmMajor,direction,domain,metric,subject,windowFamily')
      fail('PHASE4_EPISODE_IDENTITY_REQUIRED');
    const family=keys.lookup(['episode-family-v1',context.userId,identity.domain,identity.metric,identity.algorithmMajor,identity.subject,identity.windowFamily]);
    if(row.episode_family_key!==family||row.fingerprint!==keys.lookup(['episode-fingerprint-v1',family,identity.direction]))
      fail('PHASE4_EPISODE_IDENTITY_REQUIRED');
    if((await client.execute({sql:`SELECT 1 FROM observation_episodes WHERE user_id=? AND execution_mode=? AND episode_family_key=?
      AND episode_id<>? AND episode_id<>? AND state IN ('OPEN','UPDATING','ESCALATED','EXPLAINED','STABILIZING') LIMIT 1`,
      args:[context.userId,context.executionMode,family,episodeId,successorId??episodeId]})).rows.length)fail('PHASE4_EPISODE_PREDECESSOR_AMBIGUOUS');
    if(terminal?latest.value.episode.state!=='RESOLVED':!EPISODE_ACTIVE.includes(latest.value.episode.state))
      fail(terminal?'PHASE4_EPISODE_TERMINAL_PREDECESSOR_REQUIRED':'PHASE4_EPISODE_TERMINAL_REFRESH');
    if(row.invalidated_at||row.input_generation>=context.inputGeneration)fail('PHASE4_EPISODE_REFRESH_INVALID');
    await retainedReceipt(context,latest.receipt,latest.decoded);
    if(latest.receipt.operation_kind==='EPISODE_REFRESH'&&latest.decoded.result_json.metricRefreshAuthority)
      await retained(context,latest.decoded.result_json.metricRefreshAuthority.predecessor);
    if(latest.receipt.operation_kind==='EPISODE_OPEN'&&latest.decoded.result_json.terminalRecurrenceAuthority)
      await retained(context,latest.decoded.result_json.terminalRecurrenceAuthority.predecessor);
    return {row:latest.value.episode,semanticAt:latest.snapshot.semantic_at,binding:{episodeId,revision:expectedRevision,
      inputGeneration:row.input_generation,snapshotHash:latest.snapshot.snapshot_hash,operationKind:latest.receipt.operation_kind,
      receiptKey:latest.receipt.operation_key,receiptHmac:latest.receipt.receipt_hmac}};
  }
  async function retained(context,binding,depth=0) {
    if(depth>=1000)fail('PHASE4_OPERATION_RESULT_BOUNDS_UNAVAILABLE');
    const row=(await client.execute({sql:`SELECT * FROM phase4_operation_receipts WHERE user_id=? AND execution_mode=?
      AND operation_kind=? AND operation_key=?`,args:[context.userId,context.executionMode,binding.operationKind,binding.receiptKey]})).rows[0];
    if(!row||row.receipt_hmac!==binding.receiptHmac)invalid();
    const decoded=authenticate(context,row);
    if(!decoded.related_results_json.some(target=>target.type==='phase4_episode_revisions'
      &&target.row.episode_id===binding.episodeId&&target.row.revision===binding.revision
      &&target.row.input_generation===binding.inputGeneration&&target.row.snapshot_hash===binding.snapshotHash))invalid();
    await retainedReceipt(context,row,decoded);
    if(row.operation_kind==='EPISODE_REFRESH'&&decoded.result_json.metricRefreshAuthority)
      await retained(context,decoded.result_json.metricRefreshAuthority.predecessor,depth+1);
    if(row.operation_kind==='EPISODE_OPEN'&&decoded.result_json.terminalRecurrenceAuthority)
      await retained(context,decoded.result_json.terminalRecurrenceAuthority.predecessor,depth+1);
  }
  async function fresh(context,request) {
    await validateEvidence(context,request.evidenceItemId);
    const item=await core.artifact(context,'evidence_items',{evidence_item_id:request.evidenceItemId});
    const run=await core.artifact(context,'evidence_runs',{run_id:item.row.run_id}),input=parse(run.row.input_manifest_json);
    const authority=await authorities.read(context,request.evidenceItemId,'METRIC');
    const contract=phase4Metric(input.metric_key),identity=request.identity;
    if(input.refresh_preparation!==true||authority.origin!==null||!same(authority.calculation,input.calculation)
      ||identity.algorithmMajor!==INTELLIGENCE_VERSIONS.algorithm||identity.metric!==input.metric_key
      ||identity.domain!==contract.domain||identity.subject!==input.metric_key||identity.windowFamily!==input.window_family)
      fail('PHASE4_METRIC_REFRESH_EVIDENCE_IDENTITY');
    const scope=input.request_scope;
    if(scope.source!==context.sourceGeneration||scope.input!==context.inputGeneration||scope.lifecycle!==context.lifecycleGeneration||scope.auth!==context.authGeneration
      ||scope.purge!==context.purgeGeneration||scope.algorithm!==context.algorithmSetVersion||scope.timezone!==context.timezone
      ||!same(scope.versions,INTELLIGENCE_VERSIONS)||input.as_of_utc!==request.semanticAt)fail('PHASE4_METRIC_REFRESH_EVIDENCE_SCOPE');
    return {item,run,input,contract};
  }
  async function prepare(context,request) {
    const prior=await historical(context,request),evidence=await fresh(context,request);
    requireChronology(request.semanticAt,prior.semanticAt,core.now());
    const {input,item,contract}=evidence,old=prior.row,baseline=input.baseline;
    // These are the exact canonical inputs to the independently sealed
    // observation calculation, including candidates excluded from sampling.
    // Reconstructing them from only the selected baseline would change math.
    const priorQualifying=input.prior_qualifying;
    if(!Array.isArray(priorQualifying)||priorQualifying.length>64)invalid();
    const calculation=evaluateMeaningfulChange({metricKey:input.metric_key,current:input.current,baseline,quality:input.quality,priorQualifying,
      activeEpisode:{state:old.state,direction:old.direction,severity:old.severity,stabilizationStartedAt:old.stabilization_started_at},
      recentSemanticHashes:old.semantic_summary_hash?[old.semantic_summary_hash]:[],nowUtc:request.semanticAt});
    if(!calculation.targetEpisodeState)fail('PHASE4_METRIC_REFRESH_NO_EPISODE');
    const confidence=parse(item.row.provenance_json).confidence;
    const projection=Object.fromEntries(V23_HEALTH_FIELDS.observation_episodes.filter(key=>key!=='max_semantic_severity_ordinal').map(key=>[key,null]));
    Object.assign(projection,{episode_type:'METRIC_DEVIATION',domain:request.identity.domain,subject_key:input.metric_key,
      direction:old.direction,severity:calculation.severity,current_confidence:Math.min(calculation.confidence,confidence.score),
      current_novelty:Number(calculation.novelty),explained_status:0,first_observed_at:old.first_observed_at,
      last_observed_at:input.current.observedAt,last_material_change_at:request.semanticAt,
      stabilization_started_at:calculation.targetEpisodeState==='STABILIZING'?(old.stabilization_started_at??request.semanticAt):null,
      health_window_start:input.current.observedAt,health_window_end:request.semanticAt,timezone:context.timezone});
    let state=calculation.targetEpisodeState??old.state,reason='NEW_EVIDENCE';
    if(calculation.classification==='CONTINUING_CHANGE'&&state==='OPEN')state='UPDATING';
    if(state==='EXPLAINED')state='UPDATING'; // Old explanations are not current evidence.
    if(calculation.classification==='DIRECTION_REVERSAL'){state='RESOLVED';reason='DIRECTION_REVERSAL';}
    else if(calculation.classification==='RESOLVED')reason='RESOLUTION_HOLD';
    else if(calculation.classification==='IMPROVING')reason='CLOSE_THRESHOLD';
    else if(calculation.classification==='WORSENING')reason='SEVERITY_CROSSING';
    if(Date.parse(input.current.observedAt)-Date.parse(old.last_observed_at)>36*60*60*1000&&calculation.qualified) {
      state='EXPIRED';reason='CONTINUITY_GAP';
    }
    const expiresAt=new Date(Date.parse(input.current.observedAt)+contract.episodeExpiryMs).toISOString();
    if(expiresAt<=request.semanticAt&&state!=='RESOLVED'){state='EXPIRED';reason='WINDOW_EXPIRED';}
    const plan={projection,state,reason,calculation,prior,expiresAt};
    plans.set(request,{context,plan});return plan;
  }
  return {prepare,retained,fresh,historical,plan:(context,request)=>plans.get(request)?.context===context?plans.get(request).plan:null};
}
