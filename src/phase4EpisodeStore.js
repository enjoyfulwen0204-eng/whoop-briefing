import { fail, requireInteger } from './phase4Core.js';
import { EPISODE_ACTIVE, V23_HEALTH_FIELDS } from './phase4V23Schema.js';
import { canonicalJson } from './phase4EntityStore.js';

const NEXT={OPEN:['UPDATING','ESCALATED','EXPLAINED','STABILIZING'],UPDATING:['ESCALATED','EXPLAINED','STABILIZING'],
  ESCALATED:['UPDATING','EXPLAINED','STABILIZING'],EXPLAINED:['UPDATING','ESCALATED','STABILIZING'],
  STABILIZING:['UPDATING','ESCALATED','EXPLAINED','RESOLVED']};
const PATCH_FIELDS=new Set(['severity','current_confidence','explained_status','explanation_evidence_item_id','explanation_context_id',
  'last_observed_at','latest_evidence_item_id','semantic_summary_hash','explanation_json','current_context_json','current_novelty',
  'max_semantic_severity_ordinal']);
export function createPhase4EpisodeStore(core,entities) {
  const {client,keys,timestamp}=core;
  const current=(context,id)=>core.artifact(context,'observation_episodes',{episode_id:id});
  async function open(context,{identity,data,evidenceItemId,reopensEpisodeId=null,reversesEpisodeId=null}) {
    return core.run(context,async()=>{
      if(!identity || Object.keys(identity).sort().join(',')!=='algorithmMajor,direction,domain,metric,subject,windowFamily'
        || Object.values(identity).some(v=>typeof v!=='string'||!v||v.length>128))fail('PHASE4_EPISODE_IDENTITY_REQUIRED');
      const family=keys.lookup(['episode-family-v1',context.userId,identity.domain,identity.metric,identity.algorithmMajor,identity.subject,identity.windowFamily]);
      const fingerprint=keys.lookup(['episode-fingerprint-v1',family,identity.direction]);
      const active=(await client.execute({sql:`SELECT episode_id,fingerprint FROM observation_episodes
        WHERE user_id=? AND execution_mode=? AND episode_family_key=? AND state IN ('OPEN','UPDATING','ESCALATED','EXPLAINED','STABILIZING')`,
        args:[context.userId,context.executionMode,family]})).rows[0];
      if(active) {
        if(active.fingerprint!==fingerprint)fail('PHASE4_DIRECTION_REVERSAL_TRANSACTION_REQUIRED');
        return {...await current(context,active.episode_id),created:false};
      }
      if(reopensEpisodeId) {
        const prior=(await current(context,reopensEpisodeId)).row;
        if(prior.state!=='RESOLVED'||prior.fingerprint!==fingerprint||!prior.resolved_at
          || Date.parse(timestamp())-Date.parse(prior.resolved_at)>7*86400000)fail('PHASE4_INVALID_REOPEN');
      }
      if(reversesEpisodeId) {
        const prior=(await current(context,reversesEpisodeId)).row;
        if(prior.state!=='RESOLVED'||prior.resolution_reason!=='DIRECTION_REVERSAL'||prior.episode_family_key!==family
          || prior.direction===identity.direction)fail('PHASE4_INVALID_REVERSAL');
      }
      if(!data || data.state || data.revision || data.fingerprint || data.episode_family_key || data.last_question_id
        || data.last_delivered_notification_id || data.last_ambiguous_attempt_id)fail('PHASE4_EPISODE_OPEN_FIELDS');
      const source=await core.artifact(context,'evidence_items',{evidence_item_id:evidenceItemId});
      const id=core.newId(),at=timestamp();
      const episode=await entities.append(context,'observation_episodes',{...data,episode_id:id,fingerprint,episode_family_key:family,
        domain:identity.domain,subject_key:identity.subject,direction:identity.direction,state:'OPEN',revision:1,
        latest_evidence_item_id:evidenceItemId,opened_at:at,reopens_episode_id:reopensEpisodeId,reverses_episode_id:reversesEpisodeId},[source.ref]);
      await entities.append(context,'episode_events',{episode_id:id,deterministic_event_key:keys.lookup(['episode-open-v1',context.userId,context.executionMode,id]),
        event_kind:'STATE_TRANSITION',from_state:null,to_state:'OPEN',reason:'QUALIFIED_EVIDENCE',expected_revision:0,resulting_revision:1,
        actor_type:'DETERMINISTIC_ENGINE',evidence_references_json:[evidenceItemId]},[source.ref]);
      return episode;
    });
  }
  async function reviseInternal(context,{episodeId,expectedRevision,toState,patch={},sourceRefs=[],reasonCode,
    closeThresholdPassed=false,resolutionHoldMs=86400000},directionReversal=false) {
    requireInteger(expectedRevision,1);requireInteger(resolutionHoldMs,1);
    if(Object.keys(patch).some(k=>!PATCH_FIELDS.has(k)))fail('PHASE4_INVALID_EPISODE_PATCH');
    if(!['NEW_EVIDENCE','SEVERITY_CROSSING','PERSISTENCE','ACTIONABILITY','CURRENT_EXPLANATION','CLOSE_THRESHOLD',
      'RESOLUTION_HOLD','WINDOW_EXPIRED','SOURCE_INVALIDATED','DIRECTION_REVERSAL'].includes(reasonCode))fail('PHASE4_EPISODE_REASON_REQUIRED');
    return core.run(context,async()=>{
      const episode=await current(context,episodeId),row=episode.row;
      if(resolutionHoldMs<86400000)fail('PHASE4_REGISTERED_RESOLUTION_HOLD_REQUIRED');
      const sources=await core.revalidateSources(context,sourceRefs);
      if(!sources.length)fail('PHASE4_NEW_EVIDENCE_REQUIRED');
      const changeKey=keys.digest(row.content_digest_salt,canonicalJson(sources.map(s=>[s.type,s.id,s.mode,s.row]).sort((a,b)=>canonicalJson(a).localeCompare(canonicalJson(b)))));
      const eventKey=keys.lookup(['episode-change-v1',context.userId,context.executionMode,episodeId,changeKey,row.state===toState?'SAME_STATE_REVISION':'STATE_TRANSITION']);
      const prior=(await client.execute({sql:`SELECT episode_event_id,to_state,reason FROM episode_events WHERE user_id=? AND execution_mode=? AND deterministic_event_key=?`,
        args:[context.userId,context.executionMode,eventKey]})).rows[0];
      if(prior) {
        if(prior.to_state!==toState || prior.reason!==reasonCode)fail('PHASE4_IDENTITY_CONTENT_CONFLICT');
        return {...await core.artifact(context,'episode_events',{episode_event_id:prior.episode_event_id}),created:false};
      }
      if(!EPISODE_ACTIVE.includes(row.state))fail('PHASE4_EPISODE_TERMINAL');
      if(row.revision!==expectedRevision)fail('PHASE4_EPISODE_CAS_LOST');
      const at=timestamp(),same=row.state===toState;
      if(!same && !NEXT[row.state]?.includes(toState) && !['EXPIRED','INVALIDATED'].includes(toState)
        && !(toState==='RESOLVED'&&directionReversal))fail('PHASE4_ILLEGAL_EPISODE_TRANSITION');
      if(toState==='RESOLVED') {
        if(directionReversal && (!core.processing.active()||reasonCode!=='DIRECTION_REVERSAL'))fail('PHASE4_INVALID_REVERSAL');
        if(!directionReversal && (row.state!=='STABILIZING'||!closeThresholdPassed||!row.stabilization_started_at
          || Date.parse(at)-Date.parse(row.stabilization_started_at)<resolutionHoldMs))fail('PHASE4_RESOLUTION_HOLD_NOT_MET');
      }
      if(toState==='EXPIRED' && (!row.expires_at||row.expires_at>at))fail('PHASE4_EXPIRY_NOT_REACHED');
      if(toState==='STABILIZING' && !closeThresholdPassed)fail('PHASE4_CLOSE_THRESHOLD_REQUIRED');
      if(patch.severity!=null && row.severity!=null && patch.severity<row.severity && !closeThresholdPassed)fail('PHASE4_HYSTERESIS_REQUIRED');
      if(toState==='EXPLAINED' && !(patch.explanation_evidence_item_id??row.explanation_evidence_item_id))fail('PHASE4_CURRENT_EXPLANATION_REQUIRED');
      const changes={...patch};
      for(const key of ['explanation_json','current_context_json'])if(Object.hasOwn(changes,key))changes[key]=canonicalJson(changes[key]);
      const parentRefs=await entities.validateParents(context,'observation_episodes',{...row,...changes});
      if(same && Object.entries(changes).every(([k,v])=>row[k]===v))return {...episode,created:false};
      Object.assign(changes,{state:toState,revision:row.revision+1,updated_at:at});
      if(!same)changes.last_material_change_at=at;
      if(!same && toState==='STABILIZING')changes.stabilization_started_at=at;
      if(!same && toState==='RESOLVED')Object.assign(changes,{resolved_at:at,resolution_reason:directionReversal?'DIRECTION_REVERSAL':'RESOLUTION_HOLD'});
      if(!same && toState==='INVALIDATED')changes.invalidated_at=at;
      const entries=Object.entries(changes);
      const event=await entities.append(context,'episode_events',{episode_id:episodeId,deterministic_event_key:eventKey,
        event_kind:same?'SAME_STATE_REVISION':'STATE_TRANSITION',from_state:row.state,to_state:toState,reason:reasonCode,
        expected_revision:expectedRevision,resulting_revision:expectedRevision+1,actor_type:'DETERMINISTIC_ENGINE',
        evidence_references_json:sources.map(s=>[s.type,s.id])},sourceRefs);
      const result=await client.execute({sql:`UPDATE observation_episodes SET ${entries.map(([k])=>`${k}=?`).join(',')}
        WHERE user_id=? AND execution_mode=? AND episode_id=? AND revision=?`,args:[...entries.map(([,v])=>v),context.userId,context.executionMode,episodeId,expectedRevision]});
      if(result.rowsAffected!==1)fail('PHASE4_EPISODE_CAS_LOST');
      await core.link(context,'observation_episodes',row.privacy_artifact_id,[...sourceRefs,...parentRefs]);
      return toState==='INVALIDATED'?{eventId:event.row.episode_event_id,created:true}:event;
    });
  }
  async function reverse(context,{prior,opposite}) {
    return core.run(context,async()=>{
      await reviseInternal(context,{...prior,toState:'RESOLVED',reasonCode:'DIRECTION_REVERSAL'},true);
      return open(context,{...opposite,reversesEpisodeId:prior.episodeId});
    });
  }
  async function refresh(context,{episodeId,expectedRevision,identity,projection,evidenceItemId}) {
    requireInteger(expectedRevision,1);
    return core.run(context,async()=>{
      const row=(await client.execute({sql:`SELECT episode_id,fingerprint,episode_family_key,state,revision,input_generation,
        privacy_artifact_id,content_state,source_linkage_state,health_content_redacted_at,invalidated_at
        FROM observation_episodes WHERE user_id=? AND execution_mode=? AND episode_id=?`,args:[context.userId,context.executionMode,episodeId]})).rows[0];
      if(!row||row.content_state!=='PRESENT'||row.source_linkage_state!=='COMPLETE'||row.health_content_redacted_at)fail('CONTENT_REDACTED');
      if(!EPISODE_ACTIVE.includes(row.state)||row.invalidated_at||row.input_generation>=context.inputGeneration)fail('PHASE4_EPISODE_REFRESH_INVALID');
      if(row.revision!==expectedRevision)fail('PHASE4_EPISODE_CAS_LOST');
      if(!identity||Object.keys(identity).sort().join(',')!=='algorithmMajor,direction,domain,metric,subject,windowFamily')fail('PHASE4_EPISODE_IDENTITY_REQUIRED');
      const family=keys.lookup(['episode-family-v1',context.userId,identity.domain,identity.metric,identity.algorithmMajor,identity.subject,identity.windowFamily]);
      if(family!==row.episode_family_key||keys.lookup(['episode-fingerprint-v1',family,identity.direction])!==row.fingerprint)fail('PHASE4_EPISODE_IDENTITY_REQUIRED');
      const fields=V23_HEALTH_FIELDS.observation_episodes.filter(k=>k!=='max_semantic_severity_ordinal');
      if(!projection||Object.keys(projection).sort().join(',')!==[...fields].sort().join(',')
        ||projection.domain!==identity.domain||projection.subject_key!==identity.subject||projection.direction!==identity.direction)
        fail('PHASE4_COMPLETE_CURRENT_PROJECTION_REQUIRED');
      const item=await core.artifact(context,'evidence_items',{evidence_item_id:evidenceItemId});
      const changes={...projection,latest_evidence_item_id:evidenceItemId,input_generation:context.inputGeneration,
        lifecycle_generation:context.lifecycleGeneration,auth_generation:context.authGeneration,purge_generation:context.purgeGeneration,
        revision:expectedRevision+1,updated_at:timestamp()};
      for(const k of ['explanation_json','current_context_json'])if(changes[k]!==null)changes[k]=canonicalJson(changes[k]);
      const refs=await entities.validateParents(context,'observation_episodes',changes);
      const names=Object.keys(changes);
      const result=await client.execute({sql:`UPDATE observation_episodes SET ${names.map(k=>`${k}=?`).join(',')}
        WHERE user_id=? AND execution_mode=? AND episode_id=? AND revision=? AND input_generation=?`,
        args:[...names.map(k=>changes[k]),context.userId,context.executionMode,episodeId,expectedRevision,row.input_generation]});
      if(result.rowsAffected!==1)fail('PHASE4_EPISODE_CAS_LOST');
      await core.link(context,'observation_episodes',row.privacy_artifact_id,[item.ref,...refs]);
      await entities.append(context,'episode_events',{episode_id:episodeId,
        deterministic_event_key:keys.lookup(['episode-refresh-v1',context.userId,context.executionMode,episodeId,evidenceItemId]),
        event_kind:'SAME_STATE_REVISION',from_state:row.state,to_state:row.state,reason:'NEW_EVIDENCE',expected_revision:expectedRevision,
        resulting_revision:expectedRevision+1,actor_type:'DETERMINISTIC_ENGINE',evidence_references_json:[evidenceItemId]},[item.ref]);
      return current(context,episodeId);
    });
  }
  async function semantic(context,{episodeId,expectedRevision,episodeEventId,eventKind,severityOrdinal=null,
    explainedUncertaintyKey=null,claimKey=null,recommendedActionKey=null,semanticContentHash}) {
    requireInteger(expectedRevision,1);
    if(!['OPENED','ESCALATED','EXPLAINED','MATERIAL_ESCALATION'].includes(eventKind)||!semanticContentHash)
      fail('PHASE4_SEMANTIC_EVENT_INVALID');
    return core.run(context,async()=>{
      const episode=await current(context,episodeId);
      if(episode.row.revision!==expectedRevision)fail('PHASE4_EPISODE_CAS_LOST');
      const event=await core.artifact(context,'episode_events',{episode_event_id:episodeEventId});
      if(event.row.episode_id!==episodeId||event.row.resulting_revision!==expectedRevision)fail('PHASE4_EVENT_PARENT_MISMATCH');
      const prior=(await client.execute({sql:`SELECT * FROM episode_semantic_events WHERE user_id=? AND execution_mode=?
        AND episode_id=? AND resulting_revision=?`,args:[context.userId,context.executionMode,episodeId,expectedRevision]})).rows[0];
      let semantic;
      if(prior) {
        if(prior.episode_event_id!==episodeEventId||prior.event_kind!==eventKind||prior.severity_ordinal!==severityOrdinal
          ||prior.claim_key!==claimKey||prior.semantic_content_hash!==semanticContentHash)fail('PHASE4_IDENTITY_CONTENT_CONFLICT');
        semantic=await core.artifact(context,'episode_semantic_events',{episode_semantic_event_id:prior.episode_semantic_event_id});
      } else semantic=await entities.append(context,'episode_semantic_events',{episode_id:episodeId,resulting_revision:expectedRevision,
          episode_event_id:episodeEventId,event_kind:eventKind,severity_ordinal:severityOrdinal,
          explained_uncertainty_key:explainedUncertaintyKey,claim_key:claimKey,recommended_action_key:recommendedActionKey,
          semantic_content_hash:semanticContentHash,predecessor_semantic_event_id:episode.row.last_semantic_event_id,
          algorithm_version:'phase4-intelligence-v1'},[event.ref]);
      const maximum=severityOrdinal===null?episode.row.max_semantic_severity_ordinal
        :Math.max(episode.row.max_semantic_severity_ordinal??0,severityOrdinal);
      const updated=await client.execute({sql:`UPDATE observation_episodes SET last_semantic_event_id=?,max_semantic_severity_ordinal=?
        WHERE user_id=? AND execution_mode=? AND episode_id=? AND revision=?
          AND (last_semantic_event_id IS ? OR last_semantic_event_id=?)`,args:[semantic.row.episode_semantic_event_id,maximum,
        context.userId,context.executionMode,episodeId,expectedRevision,prior?.predecessor_semantic_event_id??episode.row.last_semantic_event_id,
        semantic.row.episode_semantic_event_id]});
      if(updated.rowsAffected!==1)fail('PHASE4_EPISODE_CAS_LOST');
      return semantic;
    });
  }
  return {open,revise:(context,change)=>reviseInternal(context,change),reverse,refresh,semantic,read:current};
}
