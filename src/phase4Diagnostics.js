import { unresolvedWork } from './phase4V28Schema.js';

/** Operational aggregates only: no source identities, claims or health values. */
export async function phase4Backlog(db,{now=new Date()}={}) {
  const at=now.toISOString();
  const row=(await db.raw.execute({sql:`SELECT COUNT(*) pending_jobs,COUNT(DISTINCT user_id) pending_tenants,
    MIN(unresolved_since) oldest_known_since,SUM(unresolved_since IS NULL) unknown_legacy_jobs,
    SUM(attempt>0 AND attempt<5 AND state<>'REPAIR_REQUIRED') retrying_jobs,SUM(state='REPAIR_REQUIRED' OR attempt>=5) repair_jobs,
    SUM(lease_owner IS NOT NULL AND lease_expires_at>?) leased_jobs
    FROM phase4_jobs WHERE execution_mode='SHADOW' AND ${unresolvedWork('')}`,args:[at]})).rows[0];
  const lag=(await db.raw.execute(`SELECT MAX(input_generation-last_completed_generation) generation_lag
    FROM phase4_computation_state WHERE execution_mode='SHADOW'`)).rows[0]?.generation_lag??0;
  const version=Number((await db.raw.execute('SELECT MAX(version) AS v FROM schema_version')).rows[0].v);
  const finalized=version>=32?(await db.raw.execute(`SELECT MAX(e.finalized_at) completed_at FROM phase4_execution_producers p
    JOIN phase4_executions e ON e.execution_id=p.producing_execution_id
    JOIN phase4_computation_state c ON c.user_id=p.user_id AND c.execution_mode=p.execution_mode AND c.input_generation=p.input_generation
    WHERE e.state='FINALIZED_SUCCESS' AND c.last_completed_generation=c.input_generation
     AND NOT EXISTS(SELECT 1 FROM phase4_execution_producers sibling JOIN phase4_executions s ON s.execution_id=sibling.producing_execution_id
      WHERE sibling.user_id=p.user_id AND sibling.execution_mode=p.execution_mode AND sibling.input_generation=p.input_generation AND s.state<>'FINALIZED_SUCCESS')`)).rows[0]?.completed_at:null;
  const last=version>=32?(finalized===null?null:new Date(finalized).toISOString()):
    (await db.raw.execute("SELECT MAX(last_ok_at) completed_at FROM system_heartbeats WHERE component='phase4_stage6_shadow'")).rows[0]?.completed_at??null;
  const age=row.oldest_known_since===null?null:Math.max(0,now.getTime()-Date.parse(row.oldest_known_since));
  const unknown=Number(row.unknown_legacy_jobs??0),pending=Number(row.pending_jobs);
  return Object.freeze({pendingTenants:Number(row.pending_tenants),pendingJobs:pending,
    oldestKnownUnresolvedSince:row.oldest_known_since,oldestKnownAgeMs:age,
    oldestUnresolvedAgeMs:unknown?null:age,ageAuthority:!pending?'IDLE':unknown?'UNKNOWN_LEGACY':'EXACT',unknownLegacyJobs:unknown,
    retryingJobs:Number(row.retrying_jobs??0),repairJobs:Number(row.repair_jobs??0),leasedJobs:Number(row.leased_jobs??0),
    latestSuccessfulCompletion:last,generationLag:Number(lag),
    severity:row.repair_jobs>0||age>6*3600000?'ACTIONABLE':unknown||age>2*3600000?'DEGRADED':'HEALTHY'});
}
