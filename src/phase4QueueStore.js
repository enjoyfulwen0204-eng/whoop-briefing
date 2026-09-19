import { fail, requireInteger, readableRow } from './phase4Core.js';
import { JOB_KINDS, SCOPE_REASON_CODES, OPERATION_ERROR_CODES } from './phase4V24Schema.js';

export function createPhase4QueueStore(core) {
  const {client,transaction,keys,timestamp}=core,leases=new WeakMap();
  const requireKind=kind=>{if(!JOB_KINDS.includes(kind))fail('PHASE4_JOB_KIND_REQUIRED');return kind;};
  const reason=code=>{if(!SCOPE_REASON_CODES.includes(code))fail('PHASE4_SCOPE_REASON_REQUIRED');return JSON.stringify([code]);};
  const id=(table,userId,mode,kind)=>keys.lookup(['privacy-artifact-v1',table,userId,mode,kind?[userId,mode,kind]:[userId,mode]]);
  async function markFull(userId,mode,generation,purgeGeneration,reasonCode) {
    if(!core.processing.active())fail('PHASE4_TRANSACTION_REQUIRED');
    const at=timestamp(),reasons=reason(reasonCode);
    for(const [table,kind] of [['phase4_invalidations',null],...JOB_KINDS.map(k=>['phase4_jobs',k])]) {
      const artifactId=id(table,userId,mode,kind);
      await client.execute({sql:`INSERT INTO ${table}
        (user_id,execution_mode,${kind?'job_kind,':''}requested_generation,scope_kind,reason_codes_json,updated_at,
          content_state,source_linkage_state,privacy_artifact_id,purge_generation)
        VALUES (?,?${kind?',?':''},?,'FULL_TENANT_RECOMPUTE',?,?,'PRESENT','COMPLETE',?,?)
        ON CONFLICT(user_id,execution_mode${kind?',job_kind':''}) DO UPDATE SET
          requested_generation=MAX(requested_generation,excluded.requested_generation),scope_kind='FULL_TENANT_RECOMPUTE',
          affected_from=NULL,affected_to=NULL,subject_key=NULL,full_scan_cursor=NULL,scope_revision=scope_revision+1,
          reason_codes_json=excluded.reason_codes_json,updated_at=excluded.updated_at,
          purge_generation=excluded.purge_generation,content_state='PRESENT',source_linkage_state='COMPLETE',
          health_content_redacted_at=NULL,health_content_redaction_reason=NULL,source_subject_deleted_at=NULL,
          health_scope_redacted_at=NULL,health_scope_redaction_reason=NULL,content_digest_salt=NULL
          ${kind?",state='PENDING',attempt=0,next_attempt_at=NULL,lease_owner=NULL,lease_expires_at=NULL,claimed_generation=NULL,claimed_lifecycle_generation=NULL,claimed_auth_generation=NULL,claimed_scope_revision=NULL,claimed_purge_generation=NULL,last_error_code=NULL":''}`,
      args:[userId,mode,...(kind?[kind]:[]),generation,reasons,at,artifactId,purgeGeneration]});
      // Queue scope is the ADR's explicit mutable-content reset exception.
      // This is new non-health FULL scope, never a restored old interval.
      await client.execute({sql:`INSERT INTO phase4_source_links
        (user_id,artifact_execution_mode,artifact_type,artifact_id,source_execution_mode,source_type,source_id,relationship,linked_at)
        VALUES (?,?,?,?,'SHARED','USER',?,'DEPENDS_ON',?)
        ON CONFLICT DO UPDATE SET unlinked_at=NULL,purge_id=NULL,linked_at=excluded.linked_at`,
      args:[userId,mode,table,artifactId,userId,at]});
    }
  }
  async function sourceChanged(control,{reasonCode='SOURCE_CHANGED'}={}) {
    return transaction(async()=>{
      const state=await core.assertControl(control);
      if(state.pending_purge_count!==0 || state.purge_generation===null)fail('PHASE4_PURGE_FENCED');
      const result=await advanceSource(control.userId,reasonCode);
      await core.assertControl(control);return result;
    });
  }
  async function advanceSource(userId,reasonCode='SOURCE_CHANGED',{removal=false}={}) {
      if(!core.processing.active())fail('PHASE4_TRANSACTION_REQUIRED');
      const state=(await client.execute({sql:'SELECT * FROM phase4_user_state WHERE user_id=?',args:[userId]})).rows[0];
      if(!state || (!removal && state.pending_purge_count!==0))fail('PHASE4_PURGE_FENCED');
      const at=timestamp();
      await client.execute({sql:`UPDATE phase4_user_state SET source_generation=source_generation+1,updated_at=? WHERE user_id=?`,args:[at,userId]});
      const generation=state.source_generation+1;
      await client.execute({sql:`UPDATE phase4_computation_state SET input_generation=input_generation+1,
        source_generation_seen=?,revision=revision+1,updated_at=? WHERE user_id=?`,args:[generation,at,userId]});
      const modes=(await client.execute({sql:'SELECT execution_mode,input_generation FROM phase4_computation_state WHERE user_id=?',args:[userId]})).rows;
      for(const mode of modes)await markFull(userId,mode.execution_mode,mode.input_generation,state.purge_generation,reasonCode);
      return {sourceGeneration:generation,modes:modes.map(r=>({...r}))};
  }
  async function read(context,jobKind) {
    requireKind(jobKind);
    return core.run(context,async()=>{
      const row=(await client.execute({sql:'SELECT * FROM phase4_jobs WHERE user_id=? AND execution_mode=? AND job_kind=?',
        args:[context.userId,context.executionMode,jobKind]})).rows[0];
      if(!row)return null;
      const full=row.scope_kind==='FULL_TENANT_RECOMPUTE';
      if(!full && row.scope_kind==='HEALTH_DATE_RANGE' && !readableRow(row))fail('CONTENT_REDACTED');
      return {...row,affected_from:full?null:row.affected_from,affected_to:full?null:row.affected_to,subject_key:full?null:row.subject_key,
        freshness:full?'PENDING':row.scope_kind==='NONE' && row.completed_generation>=row.requested_generation?'CURRENT':'PENDING'};
    });
  }
  async function claim(context,{jobKind,owner,leaseMs=60000}) {
    requireKind(jobKind);requireInteger(leaseMs,1);
    if(typeof owner!=='string' || !owner || leaseMs>15*60000)fail('PHASE4_LEASE_REQUIRED');
    return core.run(context,async()=>{
      const at=timestamp(),expiry=new Date(Date.parse(at)+leaseMs).toISOString();
      const row=await read(context,jobKind);
      if(row && row.requested_generation!==context.inputGeneration)fail('PHASE4_INPUT_FENCED');
      if(!row || row.freshness==='CURRENT' || row.state==='REPAIR_REQUIRED'
        || (row.next_attempt_at && row.next_attempt_at>at) || (row.lease_owner && row.lease_expires_at>at))return null;
      const result=await client.execute({sql:`UPDATE phase4_jobs SET state='RUNNING',lease_owner=?,lease_expires_at=?,
        claimed_generation=requested_generation,claimed_lifecycle_generation=?,claimed_auth_generation=?,
        claimed_scope_revision=scope_revision,claimed_purge_generation=?,attempt=attempt+1,updated_at=?
        WHERE user_id=? AND execution_mode=? AND job_kind=? AND requested_generation=? AND scope_revision=?
          AND (lease_owner IS NULL OR lease_expires_at<=?)`,
      args:[owner,expiry,context.lifecycleGeneration,context.authGeneration,context.purgeGeneration,at,
        context.userId,context.executionMode,jobKind,row.requested_generation,row.scope_revision,at]});
      if(result.rowsAffected!==1)return null;
      const lease=Object.freeze({userId:context.userId,executionMode:context.executionMode,jobKind,owner,expiresAt:expiry,
        requestedGeneration:row.requested_generation,scopeRevision:row.scope_revision,purgeGeneration:context.purgeGeneration,
        lifecycleGeneration:context.lifecycleGeneration,authGeneration:context.authGeneration});
      leases.set(lease,context);return lease;
    });
  }
  async function complete(context,lease) {
    if(lease?.userId!==context.userId || lease?.executionMode!==context.executionMode)fail('PHASE4_LEASE_SCOPE_MISMATCH');
    if(leases.get(lease)!==context)fail('PHASE4_SERVER_LEASE_REQUIRED');
    requireKind(lease.jobKind);
    return core.run(context,async()=>{
      const row=await read(context,lease.jobKind);
      // Foundation contains no authorized whole-source scan worker. In
      // particular, null dates or equal generations cannot satisfy this proof.
      if(row?.scope_kind==='FULL_TENANT_RECOMPUTE')fail('PHASE4_FULL_PASS_NOT_AUTHORIZED');
      const result=await client.execute({sql:`UPDATE phase4_jobs SET completed_generation=requested_generation,state='COMPLETED',
        scope_kind='NONE',affected_from=NULL,affected_to=NULL,subject_key=NULL,full_scan_cursor=NULL,lease_owner=NULL,lease_expires_at=NULL,
        claimed_generation=NULL,claimed_lifecycle_generation=NULL,claimed_auth_generation=NULL,claimed_scope_revision=NULL,
        claimed_purge_generation=NULL,updated_at=? WHERE user_id=? AND execution_mode=? AND job_kind=? AND lease_owner=? AND lease_expires_at=?
        AND lease_expires_at>? AND requested_generation=? AND claimed_generation=? AND scope_revision=? AND claimed_scope_revision=?
        AND claimed_purge_generation=? AND claimed_lifecycle_generation=? AND claimed_auth_generation=?`,
      args:[timestamp(),context.userId,context.executionMode,lease.jobKind,lease.owner,lease.expiresAt,timestamp(),
        lease.requestedGeneration,lease.requestedGeneration,lease.scopeRevision,lease.scopeRevision,lease.purgeGeneration,
        lease.lifecycleGeneration,lease.authGeneration]});
      if(result.rowsAffected!==1)fail('PHASE4_LEASE_CAS_LOST');return true;
    });
  }
  async function failJob(context,lease,{errorCode,retryDelayMs=60000}={}) {
    if(leases.get(lease)!==context)fail('PHASE4_SERVER_LEASE_REQUIRED');
    if(!OPERATION_ERROR_CODES.includes(errorCode))fail('PHASE4_OPERATION_ERROR_REQUIRED');
    requireInteger(retryDelayMs,1000);if(retryDelayMs>15*60000)fail('PHASE4_RETRY_DELAY_INVALID');
    return core.run(context,async()=>{
      const row=await read(context,lease.jobKind),repair=row?.attempt>=3||errorCode==='INVARIANT_VIOLATION'||errorCode==='REPAIR_REQUIRED';
      const result=await client.execute({sql:`UPDATE phase4_jobs SET state=?,last_error_code=?,next_attempt_at=?,updated_at=?,
        lease_owner=NULL,lease_expires_at=NULL,claimed_generation=NULL,claimed_lifecycle_generation=NULL,claimed_auth_generation=NULL,
        claimed_scope_revision=NULL,claimed_purge_generation=NULL
        WHERE user_id=? AND execution_mode=? AND job_kind=? AND state='RUNNING' AND lease_owner=? AND lease_expires_at=?
          AND lease_expires_at>? AND requested_generation=? AND claimed_generation=? AND scope_revision=? AND claimed_scope_revision=?
          AND claimed_purge_generation=? AND claimed_lifecycle_generation=? AND claimed_auth_generation=?`,
        args:[repair?'REPAIR_REQUIRED':'RETRY_WAIT',errorCode,repair?null:new Date(Date.parse(timestamp())+retryDelayMs).toISOString(),timestamp(),
          context.userId,context.executionMode,lease.jobKind,lease.owner,lease.expiresAt,timestamp(),lease.requestedGeneration,
          lease.requestedGeneration,lease.scopeRevision,lease.scopeRevision,lease.purgeGeneration,lease.lifecycleGeneration,lease.authGeneration]});
      if(result.rowsAffected!==1)fail('PHASE4_LEASE_CAS_LOST');
      return read(context,lease.jobKind);
    });
  }
  return {markFull,advanceSource,sourceChanged,read,claim,complete,fail:failJob};
}
