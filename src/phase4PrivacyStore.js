import { fail } from './phase4Core.js';
import { assertPhase4Schema } from './phase4Migrations.js';
import { createPhase4Redactor } from './phase4Redaction.js';
import { canonicalJson } from './phase4EntityStore.js';

const nodeKey=n=>JSON.stringify([n.mode,n.type,n.id]);
const toNode=row=>({mode:row.artifact_execution_mode,type:row.artifact_type,id:row.artifact_id});
/** Disabled persistence protocol, not a worker/command/route. The only exposed
 * operations require a separately branded, authenticated source controller. */
export function createPhase4PrivacyStore(core,queue) {
  const {client,transaction,timestamp,keys}=core,redactor=createPhase4Redactor(core);
  const replacements=new WeakMap();
  const handlers=new Map();
  function registerReplacement(kind,handler) {
    if(handlers.has(kind)||!['JOURNAL_FACT','JOURNAL_COVERAGE','EXPERIMENT_FIELDS'].includes(kind))fail('PHASE4_REPLACEMENT_HANDLER_CONFLICT');
    handlers.set(kind,handler);
  }
  async function prepareReplacement(control,{targetType,targetId,kind,value,sourceKey,parserVersion,normalizerVersion}) {
    await core.assertControl(control);
    const handler=handlers.get(kind);if(!handler)fail('PHASE4_REPLACEMENT_HANDLER_REQUIRED');
    const normalized=await handler.validate(control,value);
    const json=canonicalJson(normalized);
    if(Buffer.byteLength(json)>32768||!sourceKey||!parserVersion||!normalizerVersion)fail('PHASE4_INVALID_REPLACEMENT');
    const ticket=Object.freeze({kind});
    replacements.set(ticket,{userId:control.userId,targetType,targetId,async stage(purgeId,generation) {
      const at=timestamp(),expires=new Date(Date.parse(at)+30*86400000).toISOString();
      await client.execute({sql:`INSERT INTO health_purge_replacements(user_id,purge_id,replacement_kind,normalized_replacement_json,
        replacement_source_key,parser_version,normalizer_version,created_at,expires_at,content_state,source_linkage_state,privacy_artifact_id,purge_generation)
        VALUES (?,?,?,?,?,?,?,?,?,'PRESENT','COMPLETE',?,?)`,args:[control.userId,purgeId,kind,json,sourceKey,parserVersion,normalizerVersion,at,expires,
          keys.lookup(['purge-replacement-v1',control.userId,purgeId]),generation]});
    }});
    return ticket;
  }
  async function ledger(control,purgeId) {
    await core.assertPrivacyControl(control);
    const row=(await client.execute({sql:'SELECT * FROM health_plaintext_purges WHERE user_id=? AND purge_id=?',args:[control.userId,purgeId]})).rows[0];
    if(!row)fail('PHASE4_PURGE_NOT_FOUND');return row;
  }
  async function targetNodes(userId,type,id,{alreadyAdmitted=false}={}) {
    let table,where,args=[userId,id];
    if(type==='JOURNAL_FACT') {table='journal_events';where='user_id=? AND logical_fact_id=?';}
    else if(type==='JOURNAL_COVERAGE') {table='journal_coverage_windows';where='user_id=? AND coverage_window_id=?';}
    else if(type==='EXPERIMENT_FIELD') {table='experiment_field_groups';where='user_id=? AND privacy_artifact_id=?';}
    else if(type==='EXPERIMENT') {table='experiment_field_groups';where='user_id=? AND experiment_id=?';}
    else fail('PHASE4_PURGE_TARGET_REQUIRED');
    const rows=(await client.execute({sql:`SELECT * FROM ${table} WHERE ${where}`,args})).rows;
    if(!rows.length) {
      if(alreadyAdmitted && type==='JOURNAL_FACT' && (await client.execute({sql:
        'SELECT 1 FROM journal_event_tombstones WHERE user_id=? AND logical_fact_id=?',args:[userId,id]})).rows.length)return [];
      fail('PHASE4_PURGE_TARGET_NOT_FOUND');
    }
    if(rows.some(r=>!r.privacy_artifact_id))fail('PHASE4_UNCLASSIFIED_PURGE_TARGET');
    return rows.map(row=>({mode:'SHARED',type:table,id:row.privacy_artifact_id,
      aliases:[...(table==='journal_events'?[['JOURNAL_FACT',row.privacy_artifact_id]]:[]),
        ...(table==='journal_coverage_windows'?[['JOURNAL_COVERAGE',row.coverage_window_id]]:[]),
        ...(table==='experiment_field_groups'&&row.assertion_id?[['EXPERIMENT_DIRECT_ASSERTION',row.assertion_id]]:[])]}));
  }
  async function admit(control,{targetType,targetId,idempotencyKey,operationKind='DELETION',replacement,sourceUpdateId=null}) {
    if(core.processing.active())fail('PHASE4_T0_MUST_BE_STANDALONE');
    await core.assertPrivacyControl(control);
    if(typeof idempotencyKey!=='string'||!idempotencyKey || typeof targetId!=='string'||!targetId
      || !['CORRECTION','DELETION','RETENTION','INCIDENT'].includes(operationKind))fail('PHASE4_PURGE_COMMAND_REQUIRED');
    const prepared=replacement&&replacements.get(replacement);
    if(sourceUpdateId!==null)fail('PHASE4_INBOUND_CONTROL_AUTHORITY_REQUIRED'); // Journal adapter installs authenticated receipt admission in commit 7.
    if(operationKind==='CORRECTION' && (!prepared || prepared.userId!==control.userId || prepared.targetType!==targetType || prepared.targetId!==targetId))
      fail('PHASE4_VALIDATED_REPLACEMENT_REQUIRED');
    // Detect drift before the durable fence, not after a partially applied
    // compatibility path. This is read-only verification of frozen versions.
    await assertPhase4Schema(client,24);
    return transaction(async()=>{
      const state=await core.assertPrivacyControl(control);
      const key=keys.lookup(['purge-command-v1',control.userId,idempotencyKey]);
      const prior=(await client.execute({sql:`SELECT * FROM health_plaintext_purges
        WHERE user_id=? AND deletion_or_correction_idempotency_key=?`,args:[control.userId,key]})).rows[0];
      if(prior) {
        if(prior.target_source_type!==targetType || prior.target_source_id!==targetId || prior.operation_kind!==operationKind
          || prior.source_update_id!==sourceUpdateId)fail('PHASE4_PURGE_REPLAY_CONFLICT');
        return {...prior};
      }
      await targetNodes(control.userId,targetType,targetId);
      if(state.purge_generation===null)fail('PHASE4_PRIVACY_STATE_MISSING');
      const id=core.newId(),at=timestamp(),generation=state.purge_generation+1;
      await client.execute({sql:`UPDATE phase4_user_state SET purge_generation=purge_generation+1,
        pending_purge_count=pending_purge_count+1,updated_at=? WHERE user_id=? AND purge_generation=?`,args:[at,control.userId,state.purge_generation]});
      await client.execute({sql:`INSERT INTO health_plaintext_purges(user_id,purge_id,purge_generation,
        deletion_or_correction_idempotency_key,target_source_type,target_source_id,requested_source_generation,state,
        admitted_at,updated_at,operation_kind,source_update_id) VALUES (?,?,?,?,?,?,?,'ADMITTED',?,?,?,?)`,
        args:[control.userId,id,generation,key,targetType,targetId,state.source_generation,at,at,operationKind,sourceUpdateId]});
      if(prepared)await prepared.stage(id,generation);
      await core.assertPrivacyControl(control);return {...await ledger(control,id)};
    });
  }
  async function discover(userId,purge) {
    const seeds=await targetNodes(userId,purge.target_source_type,purge.target_source_id,{alreadyAdmitted:true});
    const links=(await client.execute({sql:`SELECT * FROM phase4_source_links WHERE user_id=? AND unlinked_at IS NULL`,args:[userId]})).rows;
    const nodes=new Map(),frontier=[...seeds];
    for(const link of links)if(link.source_type==='TENANT_LEGACY' && link.source_execution_mode==='SHARED' && link.source_id===userId)
      frontier.push(toNode(link));
    while(frontier.length) {
      const node=frontier.shift(),key=nodeKey(node);if(nodes.has(key))continue;
      nodes.set(key,node);
      if(nodes.size>100000)fail('PHASE4_PURGE_GRAPH_TOO_LARGE');
      const identities=[[node.type,node.id],...(node.aliases||[])];
      for(const link of links)if(link.source_execution_mode===node.mode && identities.some(([type,id])=>link.source_type===type && link.source_id===id))
        frontier.push(toNode(link));
    }
    return [...nodes.values()];
  }
  async function recordTarget(userId,purgeId,node) {
    await client.execute({sql:`INSERT INTO health_purge_targets(user_id,purge_id,artifact_execution_mode,artifact_type,artifact_id,state)
      VALUES (?,?,?,?,?,'PENDING') ON CONFLICT DO NOTHING`,args:[userId,purgeId,node.mode,node.type,node.id]});
  }
  async function redactTarget(userId,purge,node) {
    await recordTarget(userId,purge.purge_id,node);
    const state=await redactor.apply(userId,node,purge);
    await client.execute({sql:`UPDATE health_purge_targets SET state=?,completed_at=?
      WHERE user_id=? AND purge_id=? AND artifact_execution_mode=? AND artifact_type=? AND artifact_id=?`,
      args:[state,timestamp(),userId,purge.purge_id,node.mode,node.type,node.id]});
  }
  async function unlink(userId,purge,node) {
    await client.execute({sql:`UPDATE phase4_source_links SET unlinked_at=?,purge_id=? WHERE user_id=? AND unlinked_at IS NULL
      AND ((artifact_execution_mode=? AND artifact_type=? AND artifact_id=?) OR (source_execution_mode=? AND source_type=? AND source_id=?))`,
      args:[timestamp(),purge.purge_id,userId,node.mode,node.type,node.id,node.mode,node.type,node.id]});
    for(const [type,id] of node.aliases||[])await client.execute({sql:`UPDATE phase4_source_links SET unlinked_at=?,purge_id=?
      WHERE user_id=? AND unlinked_at IS NULL AND source_execution_mode=? AND source_type=? AND source_id=?`,
      args:[timestamp(),purge.purge_id,userId,node.mode,type,id]});
  }
  async function redact(control,purgeId) {
    try {return await transaction(async()=>{
      const purge=await ledger(control,purgeId);if(purge.state!=='ADMITTED')return {...purge};
      if((await client.execute({sql:`SELECT 1 FROM health_plaintext_purges WHERE user_id=? AND state='ADMITTED' AND purge_generation<?`,
        args:[control.userId,purge.purge_generation]})).rows.length)fail('PHASE4_PRIOR_PURGE_PENDING');
      await redactor.classifyLegacyForPurge(control.userId,purge.purge_generation);
      const at=timestamp(),nodes=await discover(control.userId,purge);
      // Persist the complete opaque closure before mutating or unlinking any
      // content. A transaction failure leaves the independently committed T0.
      for(const node of nodes)await recordTarget(control.userId,purgeId,node);
      for(const node of nodes)await redactTarget(control.userId,purge,node);
      if(purge.target_source_type==='JOURNAL_FACT' && purge.operation_kind==='DELETION') {
        await client.execute({sql:`INSERT INTO journal_event_tombstones(user_id,logical_fact_id,deletion_idempotency_key,deleted_at)
          VALUES (?,?,?,?) ON CONFLICT DO NOTHING`,args:[control.userId,purge.target_source_id,purge.deletion_or_correction_idempotency_key,at]});
      }
      if(purge.operation_kind==='CORRECTION') {
        const staged=(await client.execute({sql:'SELECT * FROM health_purge_replacements WHERE user_id=? AND purge_id=?',args:[control.userId,purgeId]})).rows[0];
        const handler=staged&&handlers.get(staged.replacement_kind);
        if(!staged||!handler||staged.expires_at<=at)fail('PHASE4_VALID_REPLACEMENT_REQUIRED');
        const value=await handler.validate(control,JSON.parse(staged.normalized_replacement_json));
        await handler.commit(control,purge,value,staged);
      }
      await client.execute({sql:'DELETE FROM health_purge_replacements WHERE user_id=? AND purge_id=?',args:[control.userId,purgeId]});
      await client.execute({sql:`UPDATE phase4_user_state SET source_generation=source_generation+1,updated_at=? WHERE user_id=?`,args:[at,control.userId]});
      const state=await core.userState(control.userId);
      await client.execute({sql:`UPDATE phase4_computation_state SET input_generation=input_generation+1,
        source_generation_seen=?,revision=revision+1,updated_at=? WHERE user_id=?`,args:[state.source_generation,at,control.userId]});
      const modes=(await client.execute({sql:'SELECT execution_mode,input_generation FROM phase4_computation_state WHERE user_id=?',args:[control.userId]})).rows;
      for(const mode of modes) {
        await queue.markFull(control.userId,mode.execution_mode,mode.input_generation,purge.purge_generation,'CONTENT_REDACTED');
        for(const table of ['phase4_invalidations','phase4_jobs']) {
          const rows=(await client.execute({sql:`SELECT privacy_artifact_id FROM ${table} WHERE user_id=? AND execution_mode=?`,args:[control.userId,mode.execution_mode]})).rows;
          for(const row of rows) {
            const node={mode:mode.execution_mode,type:table,id:row.privacy_artifact_id};nodes.push(node);await redactTarget(control.userId,purge,node);
          }
        }
      }
      // Only a pre-send reservation can be cancelled by privacy/lifecycle.
      // Started, ambiguous and delivered questions retain their answer window.
      await client.execute({sql:`UPDATE phase4_question_interaction_slots SET state='CANCELLED_PRE_SEND',revision=revision+1,
        cancellation_reason='CONTENT_REDACTED',updated_at=? WHERE user_id=? AND state='RESERVED'`,args:[at,control.userId]});
      await client.execute({sql:`UPDATE outbound_semantic_reservations SET state='CLOSED',closed_reason='CONTENT_REDACTED',closed_at=?
        WHERE user_id=? AND state='RESERVED' AND question_request_id IN
          (SELECT question_request_id FROM phase4_question_interaction_slots s WHERE s.user_id=? AND s.execution_mode=outbound_semantic_reservations.execution_mode AND s.state='CANCELLED_PRE_SEND')`,
        args:[at,control.userId,control.userId]});
      for(const node of nodes)await unlink(control.userId,purge,node);
      if(purge.source_update_id!==null) {
        const id=Number(purge.source_update_id);if(!Number.isSafeInteger(id)||id<0)fail('PHASE4_SOURCE_UPDATE_REQUIRED');
        const prior=(await client.execute({sql:'SELECT owner_user_id,content_state FROM telegram_operations WHERE update_id=?',args:[id]})).rows[0];
        if(prior && prior.owner_user_id!==control.userId)fail('PHASE4_RECEIPT_OWNER_MISMATCH');
        if(!prior)await client.execute({sql:`INSERT INTO telegram_operations(update_id,owner_user_id,source_update_key,result_json,committed_at,
          delivery_state,operation_state,content_state,source_linkage_state,privacy_artifact_id,purge_generation)
          VALUES (?,?,?,?,?,'ACTION_READY','COMMITTED','PRESENT','COMPLETE',?,?)`,args:[id,control.userId,String(id),
            JSON.stringify({reply:purge.operation_kind==='CORRECTION'?'Health record updated.':'Health record deleted.',userId:control.userId}),at,
            keys.lookup(['privacy-artifact-v1','telegram_operations',control.userId,'SHARED',[id]]),state.purge_generation]});
      }
      await client.execute({sql:`UPDATE health_plaintext_purges SET state='DB_REDACTED',db_redacted_at=?,updated_at=?,attempt=attempt+1,last_error_code=NULL
        WHERE user_id=? AND purge_id=? AND state='ADMITTED'`,args:[at,at,control.userId,purgeId]});
      await verify(control,purgeId);return {...await ledger(control,purgeId)};
    });} catch(error) {
      await transaction(async()=>{
        await core.assertPrivacyControl(control);
        await client.execute({sql:`UPDATE health_plaintext_purges SET attempt=attempt+1,last_error_code='REDACTION_FAILED',updated_at=?
          WHERE user_id=? AND purge_id=? AND state='ADMITTED'`,args:[timestamp(),control.userId,purgeId]});
      });
      throw error;
    }
  }
  async function verify(control,purgeId) {
    await ledger(control,purgeId);
    await redactor.verifyNoUnclassifiedPlaintext(control.userId);
    const targets=(await client.execute({sql:'SELECT * FROM health_purge_targets WHERE user_id=? AND purge_id=?',args:[control.userId,purgeId]})).rows;
    if(!targets.length || targets.some(r=>r.state==='PENDING'))fail('PHASE4_PURGE_INCOMPLETE');
    for(const target of targets) {
      const node=toNode(target);await redactor.verify(control.userId,node,target.state);
      if((await client.execute({sql:`SELECT 1 FROM phase4_source_links WHERE user_id=? AND unlinked_at IS NULL AND
        ((artifact_execution_mode=? AND artifact_type=? AND artifact_id=?) OR (source_execution_mode=? AND source_type=? AND source_id=?)
        OR (?='journal_events' AND source_execution_mode='SHARED' AND source_type='JOURNAL_FACT' AND source_id=?))`,
        args:[control.userId,node.mode,node.type,node.id,node.mode,node.type,node.id,node.type,node.id]})).rows.length)
        fail('PHASE4_PURGE_LINK_REMAINS');
    }
    if((await client.execute({sql:'SELECT 1 FROM health_purge_replacements WHERE user_id=? AND purge_id=?',args:[control.userId,purgeId]})).rows.length)
      fail('PHASE4_PURGE_STAGING_REMAINS');
  }
  async function complete(control,purgeId) {
    return transaction(async()=>{
      const purge=await ledger(control,purgeId);if(purge.state==='COMPLETE')return {...purge};
      if(purge.state==='ADMITTED')fail('PHASE4_PURGE_CONTENT_PENDING');
      await verify(control,purgeId);
      const state=await core.userState(control.userId);
      if(await core.contextRegistry.pending(control.userId,state.purge_generation))fail('PHASE4_CACHE_ACK_PENDING');
      const at=timestamp();
      await client.execute({sql:`UPDATE health_plaintext_purges SET state='CACHE_CONFIRMED',cache_confirmed_at=?,updated_at=?
        WHERE user_id=? AND purge_id=? AND state='DB_REDACTED'`,args:[at,at,control.userId,purgeId]});
      const changed=await client.execute({sql:`UPDATE health_plaintext_purges SET state='COMPLETE',completed_at=?,updated_at=?
        WHERE user_id=? AND purge_id=? AND state='CACHE_CONFIRMED'`,args:[at,at,control.userId,purgeId]});
      if(changed.rowsAffected===1) {
        const result=await client.execute({sql:`UPDATE phase4_user_state SET pending_purge_count=pending_purge_count-1,updated_at=?
          WHERE user_id=? AND pending_purge_count>0`,args:[at,control.userId]});
        if(result.rowsAffected!==1)fail('PHASE4_PURGE_COUNTER_INVARIANT');
      }
      return {...await ledger(control,purgeId)};
    });
  }
  return {admit,redact,complete,status:ledger,verify,registerReplacement,prepareReplacement};
}
