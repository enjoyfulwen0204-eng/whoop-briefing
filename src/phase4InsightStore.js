import { fail, readableRow, requireInteger } from './phase4Core.js';
import { INSIGHT_DISPOSITIONS } from './phase4V23Schema.js';
import { canonicalJson } from './phase4EntityStore.js';
import { validateEvidenceConfidence } from './phase4Intelligence.js';

const NEXT={HYPOTHESIS:['EMERGING','RETIRED'],EMERGING:['SUPPORTED','WEAKENED','RETIRED'],
  SUPPORTED:['WEAKENED','RETIRED'],WEAKENED:['EMERGING','SUPPORTED','RETIRED'],RETIRED:[]};
const IDENTITY=['subject','outcome','direction','exposureCategory','algorithmFamily','evidenceContractMajor'];
const REASONS=['CANDIDATE_EVIDENCE','REPEATED_EVIDENCE','REPLICATED_SUPPORT','CONTRADICTORY_EVIDENCE',...INSIGHT_DISPOSITIONS];
const normalized=value=>typeof value==='string'?value.normalize('NFC').trim().replace(/\s+/g,' ').toLowerCase():'';

/** Persistence/lifecycle validation only. No statistical method, policy worker,
 * model or delivery path is executed here. Promotion consumes durable evidence
 * and its recorded guardrail inputs, never a caller's "promote" boolean. */
export function createPhase4InsightStore(core,entities) {
  const {client,keys}=core;
  function identityKey(context,identity) {
    if(!identity || Object.keys(identity).sort().join(',')!==[...IDENTITY].sort().join(','))fail('PHASE4_INSIGHT_IDENTITY_REQUIRED');
    const values=IDENTITY.map(k=>normalized(identity[k]));
    if(values.some(v=>!v||v.length>256))fail('PHASE4_INSIGHT_IDENTITY_REQUIRED');
    return keys.lookup(['insight-key-v1',context.userId,...values]);
  }
  async function support(context,ids,contract) {
    if(!Array.isArray(ids)||ids.length>100||new Set(ids).size!==ids.length)fail('PHASE4_EVIDENCE_IDS_REQUIRED');
    const values=[];
    for(const id of ids) {
      const item=await core.artifact(context,'evidence_items',{evidence_item_id:id});
      const run=await core.artifact(context,'evidence_runs',{run_id:item.row.run_id});
      if(run.row.state!=='COMPLETED'||run.row.evidence_contract_version!==contract)fail('PHASE4_EVIDENCE_CONTRACT_MISMATCH');
      values.push({item,run});
    }
    return values;
  }
  function promotion(context,items,status,semanticAt) {
    const qualified=items.filter(({item:{row:i},run:{row:r}})=>{
      let p,c;try {p=JSON.parse(i.provenance_json??'null');c=JSON.parse(i.confound_json??'null');}catch{return false;}
      const confidence=p?.confidence,components=confidence?.components;
      try {validateEvidenceConfidence(confidence);}catch {return false;}
      // Missing stored replication/confound inputs fail closed. They are
      // populated by a registered evidence method, not by this repository.
      return r.promotion_confound_version==='unknown-promotion-confound-v1'
        && r.eligible_observation_days>0 && r.unknown_eligible_days>=0
        && r.unknown_eligible_days<=r.eligible_observation_days
        && r.unknown_fraction===r.unknown_eligible_days/r.eligible_observation_days && r.unknown_fraction<=.5
        && i.exposed_count>=8 && i.confirmed_unexposed_count>=8 && i.exposed_count+i.confirmed_unexposed_count>=30
        && ['LIMITED','AVAILABLE'].includes(i.quality) && Number.isFinite(i.effect)
        && confidence.score>=.5
        && components && ['dataQuality','sampleSufficiency','replication','effectStability','recency','multiplicityControl','softConfoundFraction']
          .every(key=>Number.isFinite(components[key])&&components[key]>=0&&components[key]<=1)
        && p?.replication_windows?.length>=2 && p.replication_windows.every((w,j,a)=>
          Number.isFinite(Date.parse(w.start))&&Number.isFinite(Date.parse(w.end))&&w.start<w.end
          && w.direction===i.direction && (j===0||a[j-1].end<=w.start))
        && Date.parse(p.replication_windows.at(-1).end)-Date.parse(p.replication_windows[0].start)>=7*86400000
        && Number.isFinite(p.minimum_effect_size) && p.minimum_effect_size>0 && Math.abs(i.effect)>=p.minimum_effect_size
        && c?.hard_flags?.length===0 && c?.outcome_missing_fraction_exposed<=.4 && c?.outcome_missing_fraction_unexposed<=.4
        && c.outcome_missing_fraction_exposed>=0 && c.outcome_missing_fraction_unexposed>=0
        && Date.parse(r.window_end_utc)<=Date.parse(semanticAt)
        && Date.parse(r.window_end_utc)>=Date.parse(semanticAt)-90*86400000;
    });
    if(!qualified.length)fail('PHASE4_REPEATED_EVIDENCE_REQUIRED');
    if(status==='SUPPORTED') {
      const supported=qualified.filter(({item:{row:i},run:{row:r}})=>r.multiple_testing_family && i.adjusted_significance!=null
        && i.adjusted_significance<=.10 && r.window_end_utc>=new Date(Date.parse(semanticAt)-30*86400000).toISOString());
      if(!supported.some((a,j)=>supported.some((b,k)=>j!==k && a.run.row.run_id!==b.run.row.run_id
        && a.item.row.direction===b.item.row.direction
        && (a.run.row.window_end_utc<=b.run.row.window_start_utc||b.run.row.window_end_utc<=a.run.row.window_start_utc))))
        fail('PHASE4_INDEPENDENT_REPLICATION_REQUIRED');
    }
  }
  async function read(context,insightId,{history=false,asOfUtc=null}={}) {
    return core.run(context,async()=>{
      const artifact=await core.artifact(context,'health_insights',{id:insightId});
      const r=artifact.row,semanticAt=asOfUtc;
      if(!history&&!Number.isFinite(Date.parse(semanticAt)))fail('PHASE4_SEMANTIC_TIME_REQUIRED');
      if(!history&&(r.status==='RETIRED'||r.lifecycle_disposition||r.expires_at<=semanticAt))fail('PHASE4_INSIGHT_NOT_CURRENT');
      const revision=await core.artifact(context,'insight_revisions',{insight_id:insightId,revision:r.current_revision});
      if(revision.row.status!==r.status||revision.row.lifecycle_disposition!==r.lifecycle_disposition)fail('PHASE4_INSIGHT_POINTER_INVALID');
      return {...artifact,revision:revision.row};
    });
  }
  async function appendRevision(context,row,{status,disposition=null,claim,supportingEvidenceIds=[],contradictingEvidenceIds=[],reason,semanticAt}) {
    if(!NEXT[status] || (status==='RETIRED')!==(disposition!==null)
      || disposition!==null&&!INSIGHT_DISPOSITIONS.includes(disposition)||!REASONS.includes(reason)
      || typeof claim!=='string'||!claim.trim()||[...claim].length>4000)fail('PHASE4_INSIGHT_REVISION_INVALID');
    const supporting=await support(context,supportingEvidenceIds,row.evidence_contract_version);
    const contradicting=await support(context,contradictingEvidenceIds,row.evidence_contract_version);
    if(!supporting.length&&!contradicting.length)fail('PHASE4_INSIGHT_EVIDENCE_REQUIRED');
    if(['EMERGING','SUPPORTED'].includes(status))promotion(context,supporting,status,semanticAt);
    if(status==='WEAKENED'&&!contradicting.length)fail('PHASE4_CONTRADICTORY_EVIDENCE_REQUIRED');
    const revision=await entities.append(context,'insight_revisions',{insight_id:row.id,revision:(row.current_revision??0)+1,
      status,lifecycle_disposition:disposition,normalized_claim:claim,claim_hash:keys.digest(row.content_digest_salt,claim),
      evidence_contract_version:row.evidence_contract_version,supporting_evidence_ids_json:supportingEvidenceIds,
      contradicting_evidence_ids_json:contradictingEvidenceIds,transition_reason:reason},
      [...supporting,...contradicting].map(v=>v.item.ref));
    await core.link(context,'health_insights',row.privacy_artifact_id,[revision.ref]);
    return revision;
  }
  async function create(context,{identity,claim,evidenceContractVersion,supportingEvidenceIds,expiresAt,creationKey,supersedesId=null,semanticAt=null}) {
    return core.run(context,async()=>{
      const at=semanticAt;
      if(!Number.isFinite(Date.parse(at)))fail('PHASE4_SEMANTIC_TIME_REQUIRED');
      if(!creationKey||!evidenceContractVersion||!Number.isFinite(Date.parse(expiresAt))||expiresAt<=at
        || Date.parse(expiresAt)>Date.parse(at)+90*86400000)fail('PHASE4_INSIGHT_CREATE_INVALID');
      const key=identityKey(context,identity);
      const artifactId=keys.lookup(['insight-creation-v1',context.userId,context.executionMode,creationKey]);
      const prior=(await client.execute({sql:'SELECT * FROM health_insights WHERE user_id=? AND execution_mode=? AND privacy_artifact_id=?',args:[context.userId,context.executionMode,artifactId]})).rows[0];
      if(prior) {
        if(!readableRow(prior))fail('CONTENT_REDACTED');
        if(prior.insight_key!==key||prior.statement!==claim)fail('PHASE4_IDENTITY_CONTENT_CONFLICT');
        return {...await read(context,prior.id,{history:true}),created:false};
      }
      if(supersedesId!=null)await read(context,supersedesId,{history:true});
      const r={...core.envelope(context,'health_insights',[creationKey]),privacy_artifact_id:artifactId,
        insight_type:normalized(identity.algorithmFamily),subject:normalized(identity.subject),statement:claim,status:'HYPOTHESIS',
        first_detected_at:at,insight_key:key,evidence_contract_version:evidenceContractVersion,expires_at:expiresAt,
        lifecycle_generation:context.lifecycleGeneration,auth_generation:context.authGeneration,input_generation:context.inputGeneration,
        supersedes_id:supersedesId};
      // The unclassified stub cannot be read by any Phase 4 API. It and its
      // first revision become visible together at this transaction's commit.
      const fields=Object.keys(r),insert=await client.execute({sql:`INSERT INTO health_insights(${fields.join(',')}) VALUES (${fields.map(()=>'?').join(',')})`,args:fields.map(k=>r[k])});
      r.id=Number(insert.lastInsertRowid);
      await appendRevision(context,r,{status:'HYPOTHESIS',claim,supportingEvidenceIds,reason:'CANDIDATE_EVIDENCE',semanticAt:at});
      await client.execute({sql:`UPDATE health_insights SET legacy_classification='PHASE4',current_revision=1
        WHERE user_id=? AND execution_mode=? AND id=? AND current_revision IS NULL`,args:[context.userId,context.executionMode,r.id]});
      return {...await read(context,r.id,{asOfUtc:at}),created:true};
    });
  }
  async function transition(context,{insightId,expectedRevision,status,disposition=null,claim,supportingEvidenceIds,contradictingEvidenceIds=[],reason,refresh=false,semanticAt=null}) {
    requireInteger(expectedRevision,1);
    return core.run(context,async()=>{
      const at=semanticAt;if(!Number.isFinite(Date.parse(at)))fail('PHASE4_SEMANTIC_TIME_REQUIRED');
      // Refresh admits no stale health projection as input. Its predecessor is
      // read as lifecycle/identity metadata only; claim and evidence must be
      // newly supplied and validated in the current computation generation.
      const row=refresh?(await client.execute({sql:`SELECT id,status,current_revision,privacy_artifact_id,content_digest_salt,
        content_state,source_linkage_state,health_content_redacted_at,invalidated_at,legacy_classification,evidence_contract_version,input_generation
        FROM health_insights WHERE user_id=? AND execution_mode=? AND id=?`,args:[context.userId,context.executionMode,insightId]})).rows[0]
        :(await read(context,insightId,{history:true})).row;
      if(!readableRow(row))fail('CONTENT_REDACTED');
      if(row.invalidated_at||row.legacy_classification!=='PHASE4'||refresh&&row.input_generation>=context.inputGeneration)fail('PHASE4_INSIGHT_REFRESH_INVALID');
      if(row.current_revision!==expectedRevision)fail('PHASE4_INSIGHT_CAS_LOST');
      if(!NEXT[row.status]?.includes(status)&&!(refresh&&row.status===status&&status!=='RETIRED'))fail('PHASE4_ILLEGAL_INSIGHT_TRANSITION');
      const revision=await appendRevision(context,row,{status,disposition,claim,supportingEvidenceIds,contradictingEvidenceIds,reason,semanticAt:at});
      const changed=await client.execute({sql:`UPDATE health_insights SET status=?,lifecycle_disposition=?,statement=?,current_revision=?,
        version=version+1,last_recalculated_at=?,retired_at=?,input_generation=?,lifecycle_generation=?,auth_generation=?,purge_generation=?
        WHERE user_id=? AND execution_mode=? AND id=? AND current_revision=? AND input_generation=?`,
        args:[status,disposition,claim,revision.row.revision,at,status==='RETIRED'?at:null,
          context.inputGeneration,context.lifecycleGeneration,context.authGeneration,context.purgeGeneration,
          context.userId,context.executionMode,insightId,expectedRevision,row.input_generation]});
      if(changed.rowsAffected!==1)fail('PHASE4_INSIGHT_CAS_LOST');
      return read(context,insightId,{history:true});
    });
  }
  return {create,transition,read};
}
