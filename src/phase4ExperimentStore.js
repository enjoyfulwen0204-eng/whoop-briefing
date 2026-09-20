import { fail, readableRow, requireInteger } from './phase4Core.js';
import { EXPERIMENT_FIELDS } from './phase4V22Schema.js';
import { EXPERIMENT_SENTINELS, addPrivacyLink } from './phase4V22Backfill.js';
import { canonicalJson } from './phase4EntityStore.js';

const JSON_FIELDS=new Set(['target_metrics','protocol_json','result_json']);
function fieldValue(field,value) {
  if(!Object.hasOwn(EXPERIMENT_FIELDS,field))fail('PHASE4_EXPERIMENT_FIELD_REQUIRED');
  if(value===null) {if(field==='name')fail('PHASE4_EXPERIMENT_NAME_REQUIRED');return null;}
  if(JSON_FIELDS.has(field)) {
    const json=canonicalJson(typeof value==='string'?JSON.parse(value):value);
    if(Buffer.byteLength(json)>32768)fail('PHASE4_EXPERIMENT_VALUE_TOO_LARGE');return json;
  }
  if(typeof value!=='string'||[...value].length>2000)fail('PHASE4_EXPERIMENT_VALUE_INVALID');
  if(EXPERIMENT_FIELDS[field]==='SCHEDULE' && (!/^\d{4}-\d{2}-\d{2}$/.test(value)
    ||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value))fail('PHASE4_EXPERIMENT_DATE_INVALID');
  return value;
}

export function createPhase4ExperimentStore(core,privacy,queue) {
  const {client,transaction,timestamp,keys}=core,tickets=new WeakMap();
  async function assertNotDeleted(userId,experimentId) {
    if((await client.execute({sql:`SELECT 1 FROM health_plaintext_purges WHERE user_id=? AND target_source_type='EXPERIMENT'
      AND target_source_id=? AND operation_kind='DELETION'`,args:[userId,String(experimentId)]})).rows.length)fail('PHASE4_EXPERIMENT_DELETED');
  }
  async function assertDirect(control,{field,value,sourceUpdateKey,writerKind='EXPERIMENT_API'}) {
    const state=await core.assertControl(control);
    if(state.pending_purge_count)fail('PHASE4_PURGE_FENCED');
    if(field==='result_json'||!['EXPERIMENT_FLOW','EXPERIMENT_API'].includes(writerKind)
      ||typeof sourceUpdateKey!=='string'||!sourceUpdateKey)fail('PHASE4_DIRECT_ASSERTION_REQUIRED');
    const proof=Object.freeze({field});tickets.set(proof,{userId:control.userId,field,value:fieldValue(field,value),
      lifecycleGeneration:state.lifecycle_generation,authGeneration:state.auth_generation,purgeGeneration:state.purge_generation,
      sourceUpdateKey:keys.lookup(['experiment-assertion-source-v1',control.userId,sourceUpdateKey]),writerKind,kind:'DIRECT',sourceKind:'EXPERIMENT_DIRECT_ASSERTION',sources:[]});return proof;
  }
  async function attestDerived(context,{field,value,sourceUpdateKey,sourceRefs}) {
    return core.run(context,async()=>{
      const refs=await core.revalidateSources(context,sourceRefs);
      if(!refs.length||refs.some(s=>s.type==='USER'||s.mode!=='SHARED')||!sourceUpdateKey)fail('PHASE4_COMPLETE_DERIVATION_REQUIRED');
      const types=new Set(refs.map(s=>['sleep','recovery','cycle','workout'].includes(s.type)?'WHOOP':s.type==='JOURNAL_FACT'||s.type==='JOURNAL_COVERAGE'?'JOURNAL':
        s.type==='TELEGRAM_OPERATION'?'QA':'ANALYSIS'));
      const sourceKind=types.size===1?`${[...types][0]}_DERIVED`:'MIXED_DERIVED';
      const proof=Object.freeze({field});tickets.set(proof,{userId:context.userId,field,value:fieldValue(field,value),
        lifecycleGeneration:context.lifecycleGeneration,authGeneration:context.authGeneration,purgeGeneration:context.purgeGeneration,
        sourceUpdateKey:keys.lookup(['experiment-analysis-source-v1',context.userId,sourceUpdateKey]),
        writerKind:'EXPERIMENT_ANALYSIS',kind:'LINKED',sourceKind,
        sources:refs.map(s=>({type:s.type,id:s.id,mode:s.mode,snapshot:keys.lookup(['experiment-source-snapshot-v1',s.row])}))});return proof;
    });
  }
  async function validateSources(userId,sources) {
    const state=await core.userState(userId);
    const ROOTS={sleep:['whoop_sleeps','id'],recovery:['whoop_recoveries','sleep_id'],cycle:['whoop_cycles','id'],workout:['whoop_workouts','id'],
      JOURNAL_FACT:['journal_events','privacy_artifact_id'],JOURNAL_COVERAGE:['journal_coverage_windows','coverage_window_id'],
      EXPERIMENT_DIRECT_ASSERTION:['experiment_field_groups','assertion_id'],TELEGRAM_OPERATION:['telegram_operations','update_id']};
    for(const source of sources) {
      const spec=source.mode==='SHARED'?ROOTS[source.type]:null;
      if(!spec)fail('PHASE4_EXPERIMENT_SHARED_SOURCE_REQUIRED');
      const [table,key]=spec,owner=table==='telegram_operations'?'owner_user_id':'user_id';
      const row=(await client.execute({sql:`SELECT * FROM ${table} WHERE ${owner}=? AND ${key}=?`,args:[userId,source.id]})).rows[0];
      if(!row || ('content_state' in row&&!readableRow(row)) || keys.lookup(['experiment-source-snapshot-v1',row])!==source.snapshot)
        fail('PHASE4_EXPERIMENT_SOURCE_CHANGED');
      if(source.type==='JOURNAL_FACT'&&row.fact_status!=='ACTIVE'||source.type==='JOURNAL_COVERAGE'&&row.status!=='ACTIVE'
        ||source.type==='EXPERIMENT_DIRECT_ASSERTION'&&(row.is_current!==1||row.provenance_state!=='DIRECT'))fail('PHASE4_EXPERIMENT_SOURCE_CHANGED');
      if(['sleep','recovery','cycle','workout'].includes(source.type)) {
        const access=(await client.execute({sql:`SELECT 1 FROM whoop_resource_access WHERE user_id=? AND resource=? AND status='ACCESSIBLE'
          AND auth_generation=? AND lifecycle_generation=?`,args:[userId,source.type,state.auth_generation,state.lifecycle_generation]})).rows.length;
        if(state.status!=='ACTIVE'||state.auth_generation<1||!access)fail('PHASE4_RESOURCE_FENCED');
      }
      if(['sleep','recovery','cycle','workout'].includes(source.type) && (await client.execute({sql:`SELECT 1 FROM whoop_resource_tombstones
        WHERE user_id=? AND resource_type=? AND resource_id=? AND state='ACTIVE'`,args:[userId,source.type,source.id]})).rows.length)
        fail('PHASE4_SOURCE_DELETED');
    }
  }
  async function writeLeaf(userId,experimentId,field,revision,proof,{generation,sourceKey,supersedes=null}) {
    const at=timestamp(),present=Boolean(proof),value=present?proof.value:EXPERIMENT_SENTINELS[field];
    if(proof?.kind==='LINKED')await validateSources(userId,proof.sources);
    if(proof) {
      const state=await core.userState(userId);
      if(state.status!=='ACTIVE'||proof.lifecycleGeneration!==state.lifecycle_generation||proof.authGeneration!==state.auth_generation
        ||(!state.pending_purge_count&&proof.purgeGeneration!==state.purge_generation))fail('PHASE4_EXPERIMENT_PROOF_STALE');
    }
    const id=keys.lookup(['privacy-artifact-v1','experiment_field_groups',userId,'SHARED',[experimentId,EXPERIMENT_FIELDS[field],field,revision]]);
    const assertion=proof?.kind==='DIRECT'?keys.lookup(['experiment-assertion-v1',userId,experimentId,field,revision,proof.sourceUpdateKey]):null;
    await client.execute({sql:`UPDATE experiment_field_groups SET is_current=0 WHERE user_id=? AND experiment_id=? AND field_name=? AND is_current=1`,args:[userId,experimentId,field]});
    await client.execute({sql:`INSERT INTO experiment_field_groups(user_id,experiment_id,field_group,field_name,field_revision,is_current,
      source_kind,assertion_id,source_update_key,writer_kind,provenance_state,supersedes_privacy_artifact_id,created_at,updated_at,
      content_state,source_linkage_state,privacy_artifact_id,purge_generation,content_digest_salt,health_content_redacted_at,health_content_redaction_reason)
      VALUES (?,?,?,?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,args:[userId,experimentId,EXPERIMENT_FIELDS[field],field,revision,
      proof?.sourceKind??'LEGACY_UNPROVEN',assertion,sourceKey,proof?.writerKind??'EXPERIMENT_API',proof?.kind??'QUARANTINED',supersedes,at,at,
      present?'PRESENT':'REDACTED',present?'COMPLETE':'DISCONNECTED',id,generation,present?keys.newSalt():null,present?null:at,present?null:'UNATTRIBUTED_LEGACY']});
    await client.execute({sql:`UPDATE experiments SET ${field}=?,updated_at=? WHERE user_id=? AND id=?`,args:[value,at,userId,experimentId]});
    if(proof?.kind==='DIRECT')await addPrivacyLink(client,{userId,table:'experiment_field_groups',artifactId:id,sourceType:'EXPERIMENT_DIRECT_ASSERTION',sourceId:assertion,at});
    if(proof?.kind==='LINKED')for(const source of proof.sources)await addPrivacyLink(client,{userId,table:'experiment_field_groups',artifactId:id,
      sourceMode:source.mode,sourceType:source.type,sourceId:source.id,at});
    return id;
  }
  async function create(control,{creationKey,fields={},proofs={},status='DRAFT'}) {
    if(typeof creationKey!=='string'||!creationKey||status!=='DRAFT'||Object.keys(fields).some(f=>!Object.hasOwn(EXPERIMENT_FIELDS,f)))
      fail('PHASE4_EXPERIMENT_CREATE_REQUIRED');
    for(const field of Object.keys(fields))if(!proofs[field])fail('PHASE4_EXPERIMENT_PROVENANCE_REQUIRED');
    return transaction(async()=>{
      const state=await core.assertControl(control);if(state.pending_purge_count)fail('PHASE4_PURGE_FENCED');
      const key=keys.lookup(['experiment-create-v1',control.userId,creationKey]);
      const prior=(await client.execute({sql:'SELECT experiment_id,content_state FROM experiment_field_groups WHERE user_id=? AND source_update_key=?',args:[control.userId,key]})).rows;
      if(prior.length) {
        return {experimentId:prior[0].experiment_id,created:false,redacted:prior.some(r=>r.content_state==='REDACTED')};
      }
      const at=timestamp();
      const result=await client.execute({sql:`INSERT INTO experiments(user_id,name,status,created_at,updated_at) VALUES (?,?,'DRAFT',?,?)`,
        args:[control.userId,EXPERIMENT_SENTINELS.name,at,at]}),id=Number(result.lastInsertRowid);
      for(const field of Object.keys(EXPERIMENT_FIELDS)) {
        const proof=proofs[field]?tickets.get(proofs[field]):null;
        if(proofs[field] && (!proof||proof.userId!==control.userId||proof.field!==field||proof.value!==fieldValue(field,fields[field]??null)))
          fail('PHASE4_EXPERIMENT_PROOF_MISMATCH');
        await writeLeaf(control.userId,id,field,1,proof,{generation:state.purge_generation,sourceKey:key});
      }
      await queue.advanceSource(control.userId,'SOURCE_CHANGED');
      await core.assertControl(control);return {experimentId:id,created:true};
    });
  }
  async function read(control,experimentId,{requiredFields=[]}={}) {
    requireInteger(experimentId,1);
    return transaction(async()=>{
      const state=await core.assertControl(control);if(state.pending_purge_count)fail('PHASE4_PURGE_FENCED');
      const row=(await client.execute({sql:'SELECT * FROM experiments WHERE user_id=? AND id=?',args:[control.userId,experimentId]})).rows[0];
      if(!row)return null;
      const leaves=(await client.execute({sql:'SELECT * FROM experiment_field_groups WHERE user_id=? AND experiment_id=? AND is_current=1',args:[control.userId,experimentId]})).rows;
      if(leaves.length!==10)fail('PHASE4_EXPERIMENT_CLASSIFICATION_INCOMPLETE');
      const result={...row},redactedFields=[];
      let context;
      try {for(const field of Object.keys(EXPERIMENT_FIELDS)) {
        const leaf=leaves.find(r=>r.field_name===field);
        let valid=readableRow(leaf)&&['DIRECT','LINKED'].includes(leaf.provenance_state);
        if(valid) {
          const links=(await client.execute({sql:`SELECT source_type,source_id,source_execution_mode FROM phase4_source_links
            WHERE user_id=? AND artifact_type='experiment_field_groups' AND artifact_id=? AND unlinked_at IS NULL`,
            args:[control.userId,leaf.privacy_artifact_id]})).rows;
          valid=links.length>0;
          if(leaf.provenance_state==='DIRECT')valid=valid&&leaf.assertion_id!=null&&leaf.source_kind==='EXPERIMENT_DIRECT_ASSERTION'
            &&links.every(l=>l.source_execution_mode==='SHARED'&&l.source_type==='EXPERIMENT_DIRECT_ASSERTION'&&l.source_id===leaf.assertion_id);
          else if(valid) {
            context??=await core.capture(control.userId,{executionMode:'SHADOW'});
            for(const link of links) {
              if(link.source_execution_mode!=='SHARED'){valid=false;break;}
              try {await core.root(context,link.source_type,link.source_id);}
              catch(error) {if(error.name!=='Phase4InvariantError')throw error;valid=false;break;}
            }
          }
        }
        if(!valid) {result[field]=EXPERIMENT_SENTINELS[field];redactedFields.push(field);}
      }} finally {if(context)core.processing.afterCommit(()=>transaction(()=>core.contextRegistry.release(context)));}
      if(requiredFields.some(f=>!Object.hasOwn(EXPERIMENT_FIELDS,f)||redactedFields.includes(f)))fail('PHASE4_EXPERIMENT_REQUIRED_FIELD_REDACTED');
      await core.assertControl(control);return {row:result,fields:leaves.map(r=>({...r})),redactedFields};
    });
  }
  async function writeNewFields(control,{experimentId,fields={},proofs={},sourceKey,status}) {
    if(!sourceKey || Object.keys(fields).some(f=>!Object.hasOwn(EXPERIMENT_FIELDS,f))
      || status!==undefined&&!['DRAFT','RUNNING','COMPLETED','ABANDONED'].includes(status))fail('PHASE4_EXPERIMENT_PATCH_INVALID');
    for(const field of Object.keys(fields))if(!proofs[field])fail('PHASE4_EXPERIMENT_PROVENANCE_REQUIRED');
    return transaction(async()=>{
      const state=await core.assertControl(control);if(state.pending_purge_count)fail('PHASE4_PURGE_FENCED');
      await assertNotDeleted(control.userId,experimentId);
      const existing=await read(control,experimentId);if(!existing)return false;
      let changed=false;
      for(const [field,value] of Object.entries(fields)) {
        const leaf=existing.fields.find(r=>r.field_name===field),normalized=fieldValue(field,value),proof=proofs[field]?tickets.get(proofs[field]):null;
        if(proofs[field]&&(!proof||proof.userId!==control.userId||proof.field!==field||proof.value!==normalized))fail('PHASE4_EXPERIMENT_PROOF_MISMATCH');
        if(readableRow(leaf)) {
          if(existing.row[field]===normalized)continue; // exact replay is not a new assertion
          fail('PHASE4_EXPERIMENT_CORRECTION_CONTROL_REQUIRED');
        }
        if(!proof && existing.row[field]===EXPERIMENT_SENTINELS[field])continue;
        await writeLeaf(control.userId,experimentId,field,leaf.field_revision+1,proof,{generation:state.purge_generation,
          sourceKey:keys.lookup(['experiment-field-update-v1',control.userId,experimentId,field,sourceKey]),supersedes:leaf.privacy_artifact_id});
        changed=true;
      }
      if(status!==undefined)await client.execute({sql:'UPDATE experiments SET status=?,updated_at=? WHERE user_id=? AND id=?',
        args:[status,timestamp(),control.userId,experimentId]});
      if(changed||status!==undefined&&status!==existing.row.status)await queue.advanceSource(control.userId,'SOURCE_CHANGED');
      await core.assertControl(control);return true;
    });
  }
  privacy.registerReplacement('EXPERIMENT_FIELDS',{
    async validate(control,value,{purge=null}={}) {
      const state=await core.assertControl(control);
      if(!value||value.userId!==control.userId||!Number.isSafeInteger(value.experimentId)||!Array.isArray(value.fields)||value.fields.length!==1)
        fail('PHASE4_EXPERIMENT_REPLACEMENT_INVALID');
      await assertNotDeleted(control.userId,value.experimentId);
      const old=(await client.execute({sql:`SELECT * FROM experiment_field_groups WHERE user_id=? AND privacy_artifact_id=?`,
        args:[control.userId,value.targetId]})).rows[0];
      if(!old||old.experiment_id!==value.experimentId||old.field_name!==value.fields[0].field||old.is_current!==1
        ||old.field_revision!==value.expectedRevision||(purge&&purge.target_source_id!==value.targetId))fail('PHASE4_EXPERIMENT_REVISION_CONFLICT');
      for(const proof of value.fields) {
        if(proof.userId!==control.userId||!['DIRECT','LINKED'].includes(proof.kind)||proof.value!==fieldValue(proof.field,proof.value)
          || (proof.kind==='DIRECT'&&(proof.field==='result_json'||proof.sourceKind!=='EXPERIMENT_DIRECT_ASSERTION')))
          fail('PHASE4_EXPERIMENT_REPLACEMENT_INVALID');
        if(proof.lifecycleGeneration!==state.lifecycle_generation||proof.authGeneration!==state.auth_generation
          ||proof.purgeGeneration!==(purge?purge.purge_generation-1:state.purge_generation))fail('PHASE4_EXPERIMENT_PROOF_STALE');
        if(proof.kind==='LINKED')await validateSources(control.userId,proof.sources);
      }
      return value;
    },
    async commit(control,purge,value,staged) {
      const old=(await client.execute({sql:'SELECT * FROM experiment_field_groups WHERE user_id=? AND privacy_artifact_id=?',args:[control.userId,purge.target_source_id]})).rows[0];
      const proof=value.fields[0];
      if(!old||old.experiment_id!==value.experimentId||old.field_name!==proof.field||old.is_current!==1||old.content_state!=='REDACTED')
        fail('PHASE4_EXPERIMENT_REVISION_CONFLICT');
      await writeLeaf(control.userId,old.experiment_id,old.field_name,old.field_revision+1,proof,
        {generation:purge.purge_generation,sourceKey:staged.replacement_source_key,supersedes:old.privacy_artifact_id});
    },
  });
  async function correct(control,{experimentId,field,expectedRevision,assertion,idempotencyKey,sourceUpdateId=null}) {
    requireInteger(expectedRevision,1);
    await core.assertPrivacyControl(control);
    const prior=(await client.execute({sql:`SELECT * FROM health_plaintext_purges WHERE user_id=? AND deletion_or_correction_idempotency_key=?`,
      args:[control.userId,keys.lookup(['purge-command-v1',control.userId,idempotencyKey])]})).rows[0];
    if(prior) {
      const target=(await client.execute({sql:`SELECT experiment_id,field_name,field_revision FROM experiment_field_groups
        WHERE user_id=? AND privacy_artifact_id=?`,args:[control.userId,prior.target_source_id]})).rows[0];
      if(prior.target_source_type!=='EXPERIMENT_FIELD'||prior.operation_kind!=='CORRECTION'||prior.source_update_id!==sourceUpdateId
        ||target?.experiment_id!==experimentId||target.field_name!==field||target.field_revision!==expectedRevision)fail('PHASE4_PURGE_REPLAY_CONFLICT');
      await privacy.redact(control,prior.purge_id);return prior.purge_id;
    }
    await assertNotDeleted(control.userId,experimentId);
    const proof=tickets.get(assertion);
    if(!proof||proof.userId!==control.userId||proof.field!==field)fail('PHASE4_EXPERIMENT_PROOF_MISMATCH');
    const existing=await read(control,experimentId),old=existing?.fields.find(r=>r.field_name===field);
    if(!old||old.field_revision!==expectedRevision)fail('PHASE4_EXPERIMENT_REVISION_CONFLICT');
    const replacement=await privacy.prepareReplacement(control,{targetType:'EXPERIMENT_FIELD',targetId:old.privacy_artifact_id,kind:'EXPERIMENT_FIELDS',
      value:{userId:control.userId,experimentId,targetId:old.privacy_artifact_id,expectedRevision,fields:[proof]},sourceKey:proof.sourceUpdateKey,parserVersion:'experiment-field-v1',normalizerVersion:'experiment-field-v1'});
    const purge=await privacy.admit(control,{targetType:'EXPERIMENT_FIELD',targetId:old.privacy_artifact_id,operationKind:'CORRECTION',replacement,idempotencyKey,sourceUpdateId});
    await privacy.redact(control,purge.purge_id);return purge.purge_id;
  }
  return {assertDirect,attestDerived,create,read,correct,writeNewFields};
}
