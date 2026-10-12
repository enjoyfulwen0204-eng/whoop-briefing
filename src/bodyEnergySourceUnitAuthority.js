import {bodySha256} from './briefingTriggerAuth.js';
import {canonicalJson} from './phase4EntityStore.js';
import {validatePhaseRequest,canonicalPhaseRequest,isContinuationRequest} from './phase4ExecutionStore.js';
import {JOB_KINDS} from './phase4V24Schema.js';
const fail=code=>{throw Object.assign(Error(code),{code});};
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const outcomes=new Set(['COMPLETE','PARTIAL','NO_WORK','NO_ELIGIBLE_WORK','BUDGET_EXHAUSTED','DISABLED','POLICY_DEFERRED']);
/** Body source-unit completion only. This fresh readonly consumer rechecks
 * persisted evidence; it never borrows a producer's old job lease, issues a
 * cross-root proof token, grants publication, or completes any family/job. */
export function createBodyEnergySourceUnitAuthority(core,{body,receipts}){
  const {client,keys}=core;
  async function verify(context,stored){
    const {computation}=await core.assertContext(context),{row,manifest}=stored;
    if(context.executionMode!=='SHADOW'||![32,33].includes(Number((await client.execute('SELECT MAX(version) v FROM schema_version')).rows[0]?.v)))
      fail('BODY_ENERGY_SOURCE_UNIT_SCOPE_REQUIRED');
    if(row.user_id!==context.userId||row.execution_mode!==context.executionMode||row.invalidated_at!==null
      ||row.input_generation!==context.inputGeneration||row.lifecycle_generation!==context.lifecycleGeneration
      ||row.auth_generation!==context.authGeneration||row.purge_generation!==context.purgeGeneration
      ||manifest.source_generation!==context.sourceGeneration)fail('BODY_ENERGY_SOURCE_UNIT_STALE');
    const clock=core.now().getTime(),created=Date.parse(row.created_at);
    if(!integer(clock)||clock>Date.now()||!integer(row.as_of_epoch_ms)||row.as_of_utc!==new Date(row.as_of_epoch_ms).toISOString()
      ||!Number.isFinite(created)||created<row.as_of_epoch_ms||created>clock)fail('BODY_ENERGY_SOURCE_UNIT_TIME_INVALID');
    const domain=await receipts.readBodyPublicationSource(context,row);
    if(!domain)return null;
    const {receipt,job,roots}=domain;
    if(!job)return null;
    const expected={userId:context.userId,executionMode:context.executionMode,requestedGeneration:context.inputGeneration,
      sourceGeneration:context.sourceGeneration,lifecycleGeneration:context.lifecycleGeneration,
      authGeneration:context.authGeneration,purgeGeneration:context.purgeGeneration,algorithmSetVersion:context.algorithmSetVersion};
    if(Object.entries(expected).some(([key,value])=>job[key]!==value)||!JOB_KINDS.includes(job.jobKind)
      ||!integer(job.scopeRevision)||typeof job.owner!=='string'||!job.owner
      ||!Number.isFinite(Date.parse(job.expiresAt)))fail('BODY_ENERGY_SOURCE_UNIT_BINDING_INVALID');
    const identities=new Set(roots.map(root=>canonicalJson([root.type,String(root.id),root.mode,root.as_of??null])));
    if(identities.size!==roots.length)fail('BODY_ENERGY_SOURCE_UNIT_ROOTS_AMBIGUOUS');
    // Physiological roots plus the exact Body projection must be present.
    // USER is a privacy dependency, not an extra numerical input root: its
    // identity/generations/timezone are bound in the authenticated envelope
    // and independently freshly checked by assertContext above and below.
    const needed=[...body.privacyDependencies(context.userId,row).filter(root=>root.type!=='USER'),
      {type:'body_energy_results',id:row.privacy_artifact_id,mode:context.executionMode}];
    if(needed.some(root=>!identities.has(canonicalJson([root.type,String(root.id),root.mode,null]))))
      fail('BODY_ENERGY_SOURCE_UNIT_ROOTS_INCOMPLETE');
    const domainCreated=Date.parse(receipt.created_at);
    if(!Number.isFinite(domainCreated)||domainCreated<created||domainCreated>clock)fail('BODY_ENERGY_SOURCE_UNIT_TIME_INVALID');
    // Reuse exactly the original immutable named source boundary, not the
    // producer claim (which exists before a Body calculation even starts).
    const facts=[context.userId,context.executionMode,job.jobKind,job.requestedGeneration,job.scopeRevision,
      ['USER',context.userId,JSON.stringify(['USER',context.userId]),computation.updated_at]],
      step=keys.lookup(['phase4-logical-work-v1','stage6.body-source',facts]);
    const producers=(await client.execute({sql:`SELECT p.*,e.state,e.phase,e.generation final_generation,e.execution_seq final_seq,
      e.identity_digest,e.scope_key,e.canonical_request_json,e.created_at execution_created_at,e.deadline_at,e.lease_until,
      e.work_committed_at,e.finalized_at,e.result_json,e.result_digest,e.release_sha,e.trigger_source,e.config_proof,e.sync_execution_id
      FROM phase4_execution_producers p JOIN phase4_executions e ON e.execution_id=p.producing_execution_id
      WHERE p.user_id=? AND p.execution_mode=? AND p.input_generation=? ORDER BY p.execution_seq LIMIT 129`,
      args:[context.userId,context.executionMode,context.inputGeneration]})).rows;
    if(producers.length>128)fail('BODY_ENERGY_SOURCE_UNIT_PRODUCER_BOUNDS');
    const eligible=[];
    for(const p of producers){
      const key=keys.lookup(['execution-work-step-v2',p.identity_digest,p.scope_key,['named',step]]);
      const work=(await client.execute({sql:'SELECT * FROM phase4_execution_work_receipts WHERE execution_id=? AND receipt_key=?',
        args:[p.producing_execution_id,key]})).rows[0];
      if(!work)continue;
      // A complete source may be awaiting parent reconciliation. It remains
      // unavailable, including ESTABLISHED/unknown COMMIT and failure states.
      if(p.state!=='FINALIZED_SUCCESS'||p.execution_created_at>created)continue;
      if(p.phase!=='STAGE6_DRAIN'||p.execution_seq!==p.final_seq||!integer(p.producing_generation)
        ||p.producing_generation<1||p.producing_generation>p.final_generation
        ||p.tenant_proof!==keys.lookup(['execution-producer-v1',context.userId,context.executionMode,context.inputGeneration,
          p.producing_execution_id,p.execution_seq,p.producing_generation]))fail('BODY_ENERGY_SOURCE_UNIT_PRODUCER_INVALID');
      if(work.execution_id!==p.producing_execution_id||work.step_key!==key||work.receipt_key!==key
        ||work.scope_key!==p.scope_key||work.request_digest!==p.identity_digest||!integer(work.generation)||work.generation<1
        ||work.generation>p.producing_generation||!integer(work.committed_at))fail('BODY_ENERGY_SOURCE_UNIT_RECEIPT_INVALID');
      // Nested domain writes and their full v27 receipt share the source
      // transaction. Only its outer named boundary has a v32 work receipt.
      const ordered=[p.execution_created_at,row.as_of_epoch_ms,created,domainCreated,work.committed_at,p.work_committed_at,p.finalized_at];
      if(ordered.some(value=>!integer(value))||ordered.some((value,index)=>index&&value<ordered[index-1])
        ||p.finalized_at>clock||p.finalized_at>=p.deadline_at||p.finalized_at>=p.lease_until
        ||work.committed_at>Date.parse(job.expiresAt))fail('BODY_ENERGY_SOURCE_UNIT_TIME_INVALID');
      let request,result;try{request=validatePhaseRequest(JSON.parse(p.canonical_request_json));result=JSON.parse(p.result_json);}catch{fail('BODY_ENERGY_SOURCE_UNIT_PARENT_INVALID');}
      if(canonicalPhaseRequest(request)!==p.canonical_request_json
        ||isContinuationRequest(request)&&bodySha256(p.canonical_request_json)!==p.identity_digest
        ||request.requestId!==p.producing_execution_id||request.phase!==p.phase||request.executionMode!==context.executionMode
        ||request.releaseSha!==p.release_sha||request.triggerSource!==p.trigger_source||request.configProof!==p.config_proof
        ||request.syncRequestId!==p.sync_execution_id
        ||p.scope_key!==bodySha256(JSON.stringify(['phase4-execution-scope-v1',p.phase,context.executionMode,p.config_proof]))
        ||typeof p.result_json!=='string'||bodySha256(p.result_json)!==p.result_digest
        ||result.version!==2||result.identity!==p.identity_digest||result.releaseSha!==p.release_sha||result.phase!==p.phase
        ||result.source!==p.trigger_source||result.executionMode!==context.executionMode||result.configProof!==p.config_proof
        ||!outcomes.has(result.outcome))fail('BODY_ENERGY_SOURCE_UNIT_PARENT_INVALID');
      eligible.push({executionId:p.producing_execution_id,sourceReceiptKey:key,
        domainOperationKey:receipt.operation_key,domainReceiptHmac:receipt.receipt_hmac,parentResultDigest:p.result_digest});
    }
    await core.assertContext(context);
    // This receipt owns the original complete result. All current input/root
    // checks still run above; unrelated sibling work never becomes complete.
    return eligible.length?Object.freeze({purpose:'BODY_SOURCE_UNIT_PUBLICATION_V1',...eligible[0]}):null;
  }
  return Object.freeze({verify});
}
