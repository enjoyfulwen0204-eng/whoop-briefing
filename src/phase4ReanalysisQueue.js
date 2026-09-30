import { randomUUID } from 'node:crypto';
import { fail } from './phase4Core.js';
import { JOB_KINDS, OPERATION_ERROR_CODES } from './phase4V24Schema.js';

export const STAGE6_RETRY_MS=Object.freeze([60000,300000,900000,3600000,21600000]);
const active="(scope_kind<>'NONE' OR completed_generation<requested_generation)";
export const tenantPassLockName=(userId,mode)=>`phase4-stage6-pass:${JSON.stringify([userId,mode])}`;

/** Internal worker queue. Only the drain holds leases and end-of-scope proofs;
 * the public Foundation queue still cannot settle a FULL pass. */
export function createReanalysisQueue(core) {
  if(![28,29].includes(core.schemaVersion))fail('PHASE4_STAGE6_SCHEMA_REQUIRED');
  const {client,transaction,timestamp}=core,leases=new WeakMap(),proofs=new WeakMap();
  const read=(context,kind)=>client.execute({sql:'SELECT * FROM phase4_jobs WHERE user_id=? AND execution_mode=? AND job_kind=?',
    args:[context.userId,context.executionMode,kind]}).then(result=>result.rows[0]);
  async function select({limit=8,userId=null}={}) {
    if(!Number.isSafeInteger(limit)||limit<1||limit>100)fail('PHASE4_DRAIN_BUDGET_INVALID');
    const rows=(await client.execute({sql:`SELECT user_id,job_kind FROM (
      SELECT j.*,ROW_NUMBER() OVER(PARTITION BY j.user_id ORDER BY j.updated_at,j.job_kind) AS position
      FROM phase4_jobs j JOIN users u ON u.id=j.user_id JOIN phase4_user_state p ON p.user_id=j.user_id
      WHERE j.execution_mode='SHADOW' AND u.status='ACTIVE' AND p.pending_purge_count=0
        AND (j.scope_kind<>'NONE' OR j.completed_generation<j.requested_generation)
        AND (j.next_attempt_at IS NULL OR j.next_attempt_at<=?) AND (j.lease_owner IS NULL OR j.lease_expires_at<=?)
        AND NOT EXISTS(SELECT 1 FROM resource_locks l
          WHERE l.name='phase4-stage6-pass:'||json_array(j.user_id,j.execution_mode) AND l.expires_at>?)
        ${userId===null?'':'AND j.user_id=?'}) WHERE position=1 ORDER BY updated_at,user_id,job_kind LIMIT ?`,
      args:[timestamp(),timestamp(),timestamp(),...(userId===null?[]:[userId]),limit]})).rows;
    return rows.map(row=>({userId:row.user_id,jobKind:row.job_kind}));
  }
  async function claim(context,kind,{leaseMs=60000}={}) {
    if(context.executionMode!=='SHADOW'||!JOB_KINDS.includes(kind))fail('PHASE4_STAGE6_SHADOW_REQUIRED');
    if(!Number.isSafeInteger(leaseMs)||leaseMs<1000||leaseMs>120000)fail('PHASE4_DRAIN_BUDGET_INVALID');
    return core.run(context,async()=>{
      const row=await read(context,kind),at=timestamp();
      if(!row||row.scope_kind==='NONE'&&row.completed_generation>=row.requested_generation
        ||row.next_attempt_at>at||row.lease_owner&&row.lease_expires_at>at)return null;
      if(row.requested_generation!==context.inputGeneration)fail('PHASE4_INPUT_FENCED');
      const current=await core.assertContext(context);
      const resume=row.claimed_generation===context.inputGeneration&&row.claimed_lifecycle_generation===context.lifecycleGeneration
        &&row.claimed_auth_generation===context.authGeneration&&row.claimed_purge_generation===context.purgeGeneration
        &&row.claimed_scope_revision===row.scope_revision;
      const binding=Object.freeze({userId:context.userId,executionMode:'SHADOW',jobKind:kind,owner:randomUUID(),
        tenantPass:tenantPassLockName(context.userId,context.executionMode),
        expiresAt:new Date(Date.parse(at)+leaseMs).toISOString(),requestedGeneration:context.inputGeneration,scopeRevision:row.scope_revision,
        sourceGeneration:context.sourceGeneration,lifecycleGeneration:context.lifecycleGeneration,authGeneration:context.authGeneration,
        purgeGeneration:context.purgeGeneration,algorithmSetVersion:context.algorithmSetVersion});
      const locked=await client.execute({sql:`INSERT INTO resource_locks(name,owner,acquired_at,expires_at) VALUES (?,?,?,?)
        ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,acquired_at=excluded.acquired_at,expires_at=excluded.expires_at
        WHERE resource_locks.expires_at<=excluded.acquired_at`,args:[binding.tenantPass,binding.owner,at,binding.expiresAt]});
      if(locked.rowsAffected!==1)return null;
      const changed=await client.execute({sql:`UPDATE phase4_jobs SET state='RUNNING',lease_owner=?,lease_expires_at=?,
        claimed_generation=?,claimed_lifecycle_generation=?,claimed_auth_generation=?,claimed_scope_revision=?,claimed_purge_generation=?,
        full_scan_cursor=?,updated_at=? WHERE user_id=? AND execution_mode='SHADOW' AND job_kind=?
        AND requested_generation=? AND scope_revision=? AND (lease_owner IS NULL OR lease_expires_at<=?)`,
        args:[binding.owner,binding.expiresAt,context.inputGeneration,context.lifecycleGeneration,context.authGeneration,row.scope_revision,
          context.purgeGeneration,resume?row.full_scan_cursor:null,at,context.userId,kind,context.inputGeneration,row.scope_revision,at]});
      if(changed.rowsAffected!==1)fail('PHASE4_LEASE_CAS_LOST');
      const lease=Object.freeze({binding,cursor:resume?row.full_scan_cursor:null,asOfUtc:current.computation.updated_at});
      leases.set(lease,{context,cursor:lease.cursor});return lease;
    });
  }
  async function checkTenant(lease) {
    const b=lease.binding;
    if(!(await client.execute({sql:'SELECT 1 FROM resource_locks WHERE name=? AND owner=? AND expires_at=? AND expires_at>?',
      args:[b.tenantPass,b.owner,b.expiresAt,timestamp()]})).rows.length)fail('PHASE4_LEASE_CAS_LOST');
  }
  const releaseTenant=lease=>client.execute({sql:'DELETE FROM resource_locks WHERE name=? AND owner=?',
    args:[lease.binding.tenantPass,lease.binding.owner]});
  async function abandon(lease) {
    if(!leases.has(lease))return;
    await releaseTenant(lease);leases.delete(lease);
  }
  async function check(context,lease) {
    if(leases.get(lease)?.context!==context)fail('PHASE4_SERVER_LEASE_REQUIRED');
    await checkTenant(lease);
    const row=await read(context,lease.binding.jobKind),b=lease.binding;
    if(!row||row.state!=='RUNNING'||row.lease_owner!==b.owner||row.lease_expires_at!==b.expiresAt||row.lease_expires_at<=timestamp()
      ||row.requested_generation!==b.requestedGeneration||row.claimed_generation!==b.requestedGeneration
      ||row.scope_revision!==b.scopeRevision||row.claimed_scope_revision!==b.scopeRevision
      ||row.claimed_purge_generation!==b.purgeGeneration||row.claimed_lifecycle_generation!==b.lifecycleGeneration
      ||row.claimed_auth_generation!==b.authGeneration)fail('PHASE4_LEASE_CAS_LOST');
    return row;
  }
  const owned=(context,lease,fn,{assertBudget=()=>{}}={})=>core.withJobFence(lease.binding,async activeContext=>{
    assertBudget();if(activeContext!==context)fail('PHASE4_LEASE_SCOPE_MISMATCH');await check(context,lease);
  },()=>core.run(context,fn));
  async function checkpoint(context,lease,cursor) {
    if(!core.processing.active()||!core.jobAuthority())fail('PHASE4_TRANSACTION_REQUIRED');
    await check(context,lease);
    if(typeof cursor!=='string'||!cursor||cursor.length>4096)fail('PHASE4_SCAN_CURSOR_INVALID');
    await client.execute({sql:'UPDATE phase4_jobs SET full_scan_cursor=?,updated_at=? WHERE user_id=? AND execution_mode=? AND job_kind=?',
      args:[cursor,timestamp(),context.userId,context.executionMode,lease.binding.jobKind]});
    core.processing.afterCommit(()=>{leases.get(lease).cursor=cursor;});
  }
  async function end(context,lease,enumerate,options={}) {
    return owned(context,lease,async()=>{
      const row=await check(context,lease);
      if((await enumerate(row.full_scan_cursor,1)).length)fail('PHASE4_FULL_PASS_INCOMPLETE');
      const proof=Object.freeze({});proofs.set(proof,{lease,cursor:row.full_scan_cursor});return proof;
    },options);
  }
  async function complete(context,lease,proof,{assertBudget=()=>{}}={}) {
    const pass=proofs.get(proof);
    if(pass?.lease!==lease)fail('PHASE4_FULL_PASS_NOT_AUTHORIZED');
    const b=lease.binding;
    const settled=async()=>{
      assertBudget();
      if(b.expiresAt<=timestamp())fail('PHASE4_LEASE_CAS_LOST');
      await checkTenant(lease);
      await core.assertContext(context);const row=await read(context,b.jobKind);
      if(!row||row.scope_revision!==b.scopeRevision||row.requested_generation!==b.requestedGeneration
        ||row.completed_generation!==b.requestedGeneration||row.scope_kind!=='NONE'||row.lease_owner!==null)
        fail('PHASE4_LEASE_CAS_LOST');
    };
    await transaction(async()=>{
      assertBudget();
      const row=await check(context,lease);
      if(row.full_scan_cursor!==pass.cursor)fail('PHASE4_FULL_PASS_INCOMPLETE');
      await client.execute({sql:`UPDATE phase4_jobs SET completed_generation=requested_generation,scope_kind='NONE',state='COMPLETED',
        affected_from=NULL,affected_to=NULL,subject_key=NULL,full_scan_cursor=NULL,unresolved_since=NULL,attempt=0,next_attempt_at=NULL,
        last_error_code=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=?
        WHERE user_id=? AND execution_mode='SHADOW' AND job_kind=?`,args:[timestamp(),context.userId,b.jobKind]});
      const remaining=(await client.execute({sql:`SELECT 1 FROM phase4_jobs WHERE user_id=? AND execution_mode='SHADOW' AND ${active} LIMIT 1`,
        args:[context.userId]})).rows.length;
      if(!remaining) {
        await client.execute({sql:`UPDATE phase4_computation_state SET last_completed_generation=input_generation
          WHERE user_id=? AND execution_mode='SHADOW' AND input_generation=?`,args:[context.userId,b.requestedGeneration]});
        await client.execute({sql:`UPDATE phase4_invalidations SET scope_kind='NONE',full_scan_cursor=NULL,affected_from=NULL,affected_to=NULL,subject_key=NULL
          WHERE user_id=? AND execution_mode='SHADOW' AND requested_generation=?`,args:[context.userId,b.requestedGeneration]});
        const at=timestamp();
        await client.execute({sql:`INSERT INTO system_heartbeats(scope,component,last_ok_at,last_detail,updated_at)
          VALUES (?,'phase4_stage6_shadow',?,NULL,?) ON CONFLICT(scope,component) DO UPDATE SET
          last_ok_at=excluded.last_ok_at,last_detail=NULL,updated_at=excluded.updated_at`,args:[`user:${context.userId}`,at,at]});
      }
    },{before:()=>core.assertContext(context),after:settled,commitFence:settled});
    await releaseTenant(lease);
    proofs.delete(proof);leases.delete(lease);
  }
  async function release(context,lease,{errorCode=null}={}) {
    if(errorCode!==null&&!OPERATION_ERROR_CODES.includes(errorCode))fail('PHASE4_OPERATION_ERROR_REQUIRED');
    const result=await core.run(context,async()=>{
      const row=await check(context,lease),attempt=row.attempt+(errorCode?1:0),at=timestamp();
      const next=errorCode?new Date(Date.parse(at)+STAGE6_RETRY_MS[Math.min(attempt,5)-1]).toISOString():row.next_attempt_at;
      await client.execute({sql:`UPDATE phase4_jobs SET state=?,attempt=?,next_attempt_at=?,last_error_code=?,
        lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE user_id=? AND execution_mode='SHADOW' AND job_kind=?`,
        args:[attempt>=5?'REPAIR_REQUIRED':attempt?'RETRY_WAIT':'PENDING',attempt,next,errorCode??row.last_error_code,at,context.userId,lease.binding.jobKind]});
      core.processing.afterCommit(()=>leases.delete(lease));
      await transaction(async()=>{}, {commitFence:async()=>{
        await checkTenant(lease);const settled=await read(context,lease.binding.jobKind);
        if(settled.lease_owner!==null||settled.scope_revision!==lease.binding.scopeRevision
          ||settled.requested_generation!==lease.binding.requestedGeneration)fail('PHASE4_LEASE_CAS_LOST');
      }});
      return {attempt,nextAttemptAt:next,state:attempt>=5?'REPAIR_REQUIRED':attempt?'RETRY_WAIT':'PENDING'};
    });
    await releaseTenant(lease);return result;
  }
  return Object.freeze({select,claim,check,owned,checkpoint,end,complete,release,abandon});
}
