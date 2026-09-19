import { AsyncLocalStorage } from 'node:async_hooks';
import { requireUserId } from './userContext.js';
import { requirePhase4Keys } from './phase4Keys.js';
import { addPrivacyLink } from './phase4V22Backfill.js';
import { V22_LEGACY_R_TABLES } from './phase4V22Schema.js';
import { fail } from './phase4Core.js';
import { isAccountInactiveError, isLifecycleFenced, LifecycleContextError } from './accountLifecycle.js';

const DIAGNOSTIC_FIELDS={whoop_sync_state:['last_error'],whoop_webhook_events:['last_error_detail'],
  whoop_reconciliation_state:['last_error_detail'],whoop_reconciliation_runs:['error_detail'],
  user_onboarding:['failure_detail'],ai_usage:['detail'],system_heartbeats:['last_detail'],
  analytics_runs:['error_detail'],analytics_work_state:['last_error_detail']};
const SCOPE=new Set(['analytics_invalidation','analytics_work_state']);
const DIAGNOSTIC_CODES="'scope_missing','ACCOUNT_INACTIVE','AUTH_REQUIRED','OPERATION_FAILED','ECONNRESET','ECONNREFUSED','ETIMEDOUT','ENOTFOUND','SQLITE_BUSY','ABORT_ERR'";
const sqlOf=statement=>typeof statement==='string'?statement:statement.sql;

/** Scoped compatibility SQL facade. Read CTEs shadow only known health tables
 * within one statement, so joins/subqueries/aggregates share the same positive
 * R predicate. There is no persisted view, schema mutation, or SQL from input.
 * Writes and their provenance are enclosed by the existing processing TX. */
export function createLegacyHealthAdapter({client,processing,privacy,keys}) {
  const calls=new AsyncLocalStorage(),shapes=new Map();
  const quoted=table=>new RegExp(`\\b${table}\\b`,'i');
  async function shape(table) {
    if(!shapes.has(table))shapes.set(table,(await client.execute(`PRAGMA table_info(${table})`)).rows);
    return shapes.get(table);
  }
  async function classify(table,call) {
    const info=await shape(table),uid=call.userId,at=new Date().toISOString();
    if(!info.some(c=>c.name==='content_state'))fail('PHASE4_COMPATIBILITY_SCHEMA_MISSING');
    const pk=info.filter(c=>c.pk).sort((a,b)=>a.pk-b.pk).map(c=>c.name);
    const rows=(await client.execute({sql:`SELECT * FROM ${table} WHERE user_id=? AND privacy_artifact_id IS NULL`,args:[uid]})).rows;
    for(const row of rows) {
      const id=requirePhase4Keys(keys).lookup(['privacy-artifact-v1',table,uid,row.execution_mode??'SHARED',pk.map(k=>row[k])]);
      const patch={privacy_artifact_id:id,content_state:'PRESENT',source_linkage_state:'COMPLETE',purge_generation:call.fence.purgeGeneration};
      if(table==='journal_events')Object.assign(patch,{logical_fact_id:`legacy-write:${uid}:${row.id}`,revision:1,fact_status:'ACTIVE',
        parser_version:'legacy-write-v1',normalizer_version:'legacy-write-v1',health_date_alignment:'LEGACY',
        exposure_state:Number(row.numeric_value)>0||Number(row.severity)>0?'EXPOSED':null});
      if(table==='health_insights')patch.legacy_classification='LEGACY_UNVERIFIED';
      const fields=Object.keys(patch);
      await client.execute({sql:`UPDATE ${table} SET ${fields.map(k=>`${k}=?`).join(',')} WHERE user_id=?${pk.map(k=>` AND ${k}=?`).join('')}`,
        args:[...fields.map(k=>patch[k]),uid,...pk.map(k=>row[k])]});
      await addPrivacyLink(client,{userId:uid,table,artifactId:id,sourceType:table==='journal_events'?'JOURNAL_FACT':'TENANT_LEGACY',
        sourceId:table==='journal_events'?id:uid,at});
    }
    if(DIAGNOSTIC_FIELDS[table])await client.execute({sql:`UPDATE ${table} SET ${DIAGNOSTIC_FIELDS[table].map(k=>`${k}=CASE WHEN ${k} IN (${DIAGNOSTIC_CODES}) THEN ${k} ELSE NULL END`).join(',')} WHERE user_id=?`,args:[uid]});
  }
  async function execute(statement) {
    const call=calls.getStore(),sql=sqlOf(statement);
    if(!call?.enabled)return client.execute(statement);
    if(/^\s*(SELECT|WITH)\b/i.test(sql)) {
      const tables=V22_LEGACY_R_TABLES.filter(t=>quoted(t).test(sql)&&!['telegram_operations','system_heartbeats'].includes(t));
      if(!tables.length)return client.execute(statement);
      if(/\bmain\s*\./i.test(sql))fail('PHASE4_UNSCOPED_HEALTH_SQL');
      const ctes=tables.map(table=>`${table} AS (SELECT * FROM main.${table} WHERE user_id=? AND
        ((content_state='PRESENT' AND source_linkage_state='COMPLETE' AND health_content_redacted_at IS NULL)
          ${SCOPE.has(table)?"OR scope_kind='FULL_TENANT_RECOMPUTE'":''})
        ${table==='journal_events'?"AND fact_status='ACTIVE'":''}
        ${table==='pending_questions'?"AND context_question_id IS NULL":''}
        ${table==='health_insights'?"AND legacy_classification IS NOT 'PHASE4'":''})`).join(',');
      const original=typeof statement==='string'?{}:statement;
      return client.execute({...original,sql:/^\s*WITH\s/i.test(sql)?sql.replace(/^\s*WITH\s/i,`WITH ${ctes}, `):`WITH ${ctes} ${sql}`,
        args:[...tables.map(()=>call.userId),...(original.args||[])]});
    }
    const table=sql.match(/^\s*(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE|DELETE\s+FROM)\s+["`]?([a-z_]+)/i)?.[1];
    if(!V22_LEGACY_R_TABLES.includes(table)||['telegram_operations','system_heartbeats'].includes(table))return client.execute(statement);
    // Never allow legacy UPDATE/DELETE to refill or discard a permanent
    // redacted artifact. Operational transport truth has dedicated methods.
    const before=(await client.execute({sql:`SELECT * FROM ${table} WHERE user_id=? AND content_state='REDACTED'`,args:[call.userId]})).rows;
    const result=await client.execute(statement);
    if(before.length && !SCOPE.has(table)) {
      const after=(await client.execute({sql:`SELECT * FROM ${table} WHERE user_id=? AND content_state='REDACTED'`,args:[call.userId]})).rows;
      if(JSON.stringify(before)!==JSON.stringify(after))fail('CONTENT_REDACTED');
    }
    await classify(table,call);return result;
  }
  const scopedClient=new Proxy(client,{get(target,property) {
    if(property==='execute')return execute;
    if(property==='batch')return async statements=>{const results=[];for(const s of statements)results.push(await execute(s));return results;};
    const value=Reflect.get(target,property);return typeof value==='function'?value.bind(target):value;
  }});
  function wrap(store,names=Object.keys(store)) {
    return Object.fromEntries(Object.entries(store).map(([name,fn])=>[name,!names.includes(name)?fn:async(...args)=>{
      if(!await privacy.available())return fn(...args);
      const uid=requireUserId(typeof args[0]==='object'?args[0]?.userId:args[0],name);
      // Preserve finite no-op contracts without executing health SQL. Missing
      // lifecycle authority is still an error, including for inactive users.
      if(name==='saveCapabilities' && !isLifecycleFenced(args[2]?.expectedLifecycleGeneration))
        throw new LifecycleContextError('saveCapabilities');
      return processing.transaction(async()=>{
        let fence;
        try {fence=await privacy.capture(uid);} catch(error) {
          if(!isAccountInactiveError(error))throw error;
          if(name==='saveCapabilities')return 0;
          if(name==='getCapabilities')return {};
          if(name==='claimAnalyticsWork')return null;
          if(name==='holdsAnalyticsWork')return false;
          if(/Analytics/.test(name))throw Object.assign(new Error('analytics_account_inactive'),{code:error.code});
          throw error;
        }
        const call={enabled:true,userId:uid,fence};
        if(name==='claimProactiveEvent') {
          const barrier=keys.lookup(['legacy-proactive-barrier-v1',uid,args[1]?.idempotencyKey]);
          const consumed=(await client.execute({sql:`SELECT lifecycle_generation FROM proactive_events
            WHERE user_id=? AND idempotency_key=? AND content_state='REDACTED'`,args:[uid,barrier]})).rows[0];
          if(consumed)return {claimed:false,id:null,lifecycleGeneration:consumed.lifecycle_generation};
        }
        if(name==='openPendingQuestion'||name==='claimProactiveEvent'&&args[1]?.decision==='ASK_CONTEXT') {
          const occupant=(await client.execute({sql:`SELECT 1 FROM phase4_question_interaction_slots WHERE user_id=? AND execution_mode='LIVE'
            AND origin='PHASE4' AND state IN ('RESERVED','DELIVERY_STARTED','AMBIGUOUS_WAIT','AWAITING_ANSWER')`,args:[uid]})).rows.length;
          const cutover=(await client.execute({sql:`SELECT 1 FROM tenant_delivery_modes WHERE user_id=? AND execution_mode='LIVE'
            AND message_family='CONTEXT_QUESTION' AND mode IN ('PHASE4','CUTOVER_PENDING')`,args:[uid]})).rows.length;
          if(occupant||cutover)fail('PHASE4_LEGACY_QUESTION_BLOCKED');
        }
        if(['resolvePendingQuestion','cancelPendingQuestion','expirePendingQuestion'].includes(name)) {
          if((await client.execute({sql:'SELECT 1 FROM pending_questions WHERE user_id=? AND id=? AND context_question_id IS NOT NULL',args:[uid,args[1]]})).rows.length)
            fail('PHASE4_STRUCTURED_ANSWER_ROUTE_REQUIRED');
        }
        const result=await calls.run(call,()=>fn(...args));
        await privacy.assert(fence);return result;
      });
    }]));
  }
  return {client:scopedClient,wrap};
}
