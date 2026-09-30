import { fail,readableRow } from './phase4Core.js';
import { canonicalJson } from './phase4EntityStore.js';
import { episodeSemanticProjection } from './phase4EpisodeHistory.js';
import { canonicalEpisodeData } from './phase4IntelligenceStore.js';
import { requireChronology } from './phase4Time.js';
import { createTargetAuthorityClosure } from './phase4AuthorityClosure.js';

const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const invalid=()=>fail('PHASE4_EPISODE_RECURRENCE_AUTHORITY_INVALID');
const ambiguous=()=>fail('PHASE4_EPISODE_PREDECESSOR_AMBIGUOUS');
const parse=value=>{try{return JSON.parse(value);}catch{invalid();}};

/** Explicit EPISODE_OPEN authority only. Historical metadata never becomes a
 * current reference. Signed inventories, not a mutable absence query, prove
 * that the terminal parent has no different successor. */
export function createEpisodeRecurrenceAuthority(core,{authenticate,metricRefresh}) {
  const {client,keys}=core,plans=new WeakMap();
  const closure=createTargetAuthorityClosure(core,authenticate);
  async function inventory(context,target={}) {
    const tables=await closure.inventory(context,{kind:'EPISODE',...target});
    const histories=new Map();let bytes=0;
    for(const receipt of tables.phase4_operation_receipts) {
      bytes+=['request_json','result_json','related_results_json','required_roots_json','schema_contract_json']
        .reduce((sum,name)=>sum+Buffer.byteLength(receipt[name]??''),0);
      if(bytes>64*1024*1024)fail('PHASE4_OPERATION_RESULT_BOUNDS_UNAVAILABLE');
      const decoded=authenticate(context,receipt);
      for(const target of decoded.related_results_json.filter(value=>value.type==='phase4_episode_revisions')) {
        const snapshot=target.row,value=parse(snapshot.snapshot_json),row=value.episode;
        if(!readableRow(snapshot)||snapshot.snapshot_version!=='episode-revision-v1'
          ||canonicalJson(value)!==snapshot.snapshot_json
          ||keys.digest(snapshot.content_digest_salt,snapshot.snapshot_json)!==snapshot.snapshot_hash
          ||value.semantic_at!==snapshot.semantic_at||row.episode_id!==snapshot.episode_id||row.revision!==snapshot.revision
          ||row.user_id!==context.userId||row.execution_mode!==context.executionMode
          ||!decoded.related_results_json.some(t=>t.type==='observation_episodes'&&same(episodeSemanticProjection(t.row),row)))invalid();
        let history=histories.get(row.episode_id);if(!history)histories.set(row.episode_id,history=new Map());
        const previous=history.get(row.revision);
        if(previous&&!same(previous.snapshot,snapshot))invalid();
        history.set(row.revision,{row,snapshot,receipt});
      }
    }
    for(const snapshot of tables.phase4_episode_revisions) {
      if(!readableRow(snapshot))fail('CONTENT_REDACTED');
      if(!same(histories.get(snapshot.episode_id)?.get(snapshot.revision)?.snapshot??null,snapshot))invalid();
    }
    const latest=new Map();
    for(const [id,history] of histories) {
      const revisions=[...history.keys()].sort((a,b)=>a-b),tip=history.get(revisions.at(-1));
      if(revisions.some((n,i)=>n!==i+1))invalid();
      const materialized=tables.observation_episodes.find(row=>row.episode_id===id);
      if(!readableRow(materialized))fail(materialized?'CONTENT_REDACTED':'PHASE4_EPISODE_HISTORY_UNAVAILABLE');
      if(!same(episodeSemanticProjection(materialized),tip.row))invalid();
      for(const entry of history.values()) {
        if(!tables.phase4_episode_revisions.some(row=>same(row,entry.snapshot)))invalid();
        for(const field of ['episode_family_key','fingerprint','reopens_episode_id','reverses_episode_id','opened_at'])
          if(entry.row[field]!==tip.row[field])invalid();
      }
      latest.set(id,tip);
    }
    if(tables.observation_episodes.some(row=>!histories.has(row.episode_id)))fail('PHASE4_EPISODE_HISTORY_UNAVAILABLE');
    return {latest,histories};
  }
  async function validate(context,request,successorId=null) {
    const id=request.reopensEpisodeId;
    const {latest,histories}=await inventory(context,{episodeId:id,metricKey:request.identity.metric}),entry=latest.get(id);
    if(!entry)fail('PHASE4_EPISODE_HISTORY_UNAVAILABLE');
    if(entry.row.revision!==request.predecessorRevision)fail('PHASE4_EPISODE_CAS_LOST');
    const prior=await metricRefresh.historical(context,{episodeId:id,expectedRevision:request.predecessorRevision,identity:request.identity},
      {terminal:true,successorId});
    // The boundary is the authenticated terminal transition, including the
    // frozen equality policy (requireChronology rejects only strictly before).
    if(prior.row.resolved_at!==entry.snapshot.semantic_at||parse(entry.snapshot.snapshot_json).event.to_state!=='RESOLVED')invalid();
    requireChronology(request.semanticAt,entry.snapshot.semantic_at,core.now());
    if(Date.parse(request.semanticAt)-Date.parse(entry.snapshot.semantic_at)>7*86400000)fail('PHASE4_INVALID_REOPEN');
    const successors=[...latest.values()].filter(value=>value.row.reopens_episode_id===id);
    if(successors.length>1||successors.some(value=>value.row.episode_id!==successorId))ambiguous();
    if(successorId&&!successors.some(value=>value.row.episode_id===successorId))invalid();
    for(const other of latest.values())if(other.row.episode_id!==id&&other.row.episode_id!==successorId
      &&other.row.fingerprint===prior.row.fingerprint&&other.row.state==='RESOLVED'
      &&other.snapshot.semantic_at>=entry.snapshot.semantic_at)ambiguous();
    const fresh=await metricRefresh.fresh(context,request),{input,item}=fresh,calculation=input.calculation;
    if(!calculation.qualified||!calculation.targetEpisodeState||calculation.direction!==request.identity.direction
      ||!['AVAILABLE','LIMITED'].includes(input.quality.status)||input.quality.confidence<=0)fail('PHASE4_EPISODE_RECURRENCE_EVIDENCE_REQUIRED');
    const data=canonicalEpisodeData(context,{current:input.current,calculation,asOfUtc:request.semanticAt,
      confidence:parse(item.row.provenance_json).confidence});
    const semanticEvent={eventKind:'OPENED',severityOrdinal:calculation.severity,claimKey:`metric:${input.metric_key}`,
      semanticContentHash:calculation.semanticHash};
    if(!same(request.data,data)||!same(request.semanticEvent,semanticEvent)||data.expires_at<=request.semanticAt)
      fail('PHASE4_EPISODE_RECURRENCE_PROJECTION_INVALID');
    if(successorId) {
      const first=histories.get(successorId)?.get(1)?.row;
      if(!first||first.input_generation!==context.inputGeneration||first.fingerprint!==prior.row.fingerprint
        ||first.opened_at!==request.semanticAt||first.latest_evidence_item_id!==request.evidenceItemId)invalid();
    }
    return {prior};
  }
  async function prepare(context,request) {
    const plan=await validate(context,request);plans.set(request,{context,plan});return plan;
  }
  async function consume(context,request) {
    const ticket=plans.get(request);if(ticket?.context!==context)fail('PHASE4_EPISODE_RECURRENCE_AUTHORITY_REQUIRED');
    const current=await validate(context,request);
    if(!same(current.prior.binding,ticket.plan.prior.binding))invalid();
    await core.assertContext(context);return current;
  }
  return {prepare,consume,validate,inventory};
}
