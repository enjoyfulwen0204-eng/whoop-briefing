import { fail, requireInteger, readableRow, DERIVED_TABLES } from './phase4Core.js';
import { canonicalJson } from './phase4EntityStore.js';
import { EPISODE_SNAPSHOT_VERSION } from './phase4V25Schema.js';
import { addPrivacyLink } from './phase4V22Backfill.js';

// Everything else is snapshot-authoritative, including newly added columns.
// See the complete column classification in docs/phase4-stage5-rc4-verification.md.
export const EPISODE_OPERATIONAL_FIELDS = Object.freeze(['created_at','updated_at','content_digest_salt','content_state',
  'source_linkage_state','health_content_redacted_at','health_content_redaction_reason','source_subject_deleted_at']);
export const EPISODE_DELIVERY_FIELDS = Object.freeze(['last_question_id','last_delivered_notification_id','last_ambiguous_attempt_id']);
const excluded=new Set([...EPISODE_OPERATIONAL_FIELDS,...EPISODE_DELIVERY_FIELDS]);
export const episodeSemanticProjection = row => Object.fromEntries(Object.entries(row).filter(([key])=>!excluded.has(key)));
const eventProjection = row => Object.fromEntries(Object.entries(row).filter(([key])=>!EPISODE_OPERATIONAL_FIELDS.includes(key)));
const invalid=()=>fail('PHASE4_DURABLE_REPLAY_BINDING_INVALID');
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);

export function requireSemanticTime(value) {
  if(value===null||value===undefined||value==='')fail('PHASE4_SEMANTIC_TIME_REQUIRED');
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    ||!Number.isFinite(Date.parse(value)))fail('PHASE4_SEMANTIC_TIME_INVALID');
  const date=value.slice(0,10);
  if(new Date(`${date}T00:00:00.000Z`).toISOString().slice(0,10)!==date)fail('PHASE4_SEMANTIC_TIME_INVALID');
  return new Date(value).toISOString();
}

export function createEpisodeHistory(core) {
  const {client,keys}=core,table='phase4_episode_revisions';
  async function validateEpisode(row) {
    const fields=(await core.tableInfo('observation_episodes')).filter(c=>!excluded.has(c.name));
    if(!row||!same(Object.keys(row).sort(),fields.map(c=>c.name).sort()))invalid();
    for(const field of fields) {
      const value=row[field.name];
      if(value===null){if(field.notnull)invalid();continue;}
      if(field.type==='TEXT'&&typeof value!=='string'||field.type==='INTEGER'&&!Number.isSafeInteger(value)
        ||field.type==='REAL'&&(typeof value!=='number'||!Number.isFinite(value)))invalid();
      if(field.name.endsWith('_json')) {
        try {if(canonicalJson(JSON.parse(value))!==value)invalid();}catch {invalid();}
      }
    }
  }
  async function origin(context,episodeId,revision,eventId) {
    const events=(await client.execute({sql:`SELECT * FROM episode_events WHERE user_id=? AND execution_mode=?
      AND episode_id=? AND resulting_revision=?`,args:[context.userId,context.executionMode,episodeId,revision]})).rows;
    if(events.length!==1||events[0].episode_event_id!==eventId||events[0].expected_revision!==revision-1
      ||!readableRow(events[0]))invalid();
    return events[0];
  }
  async function persist(context,row,eventId,semanticAt) {
    if(!core.processing.active())fail('PHASE4_TRANSACTION_REQUIRED');
    semanticAt=requireSemanticTime(semanticAt);
    for(const [field,value] of [['user_id',context.userId],['execution_mode',context.executionMode],
      ['input_generation',context.inputGeneration],['lifecycle_generation',context.lifecycleGeneration],
      ['auth_generation',context.authGeneration],['purge_generation',context.purgeGeneration]])if(row[field]!==value)invalid();
    const episode=episodeSemanticProjection(row);await validateEpisode(episode);
    const event=await origin(context,row.episode_id,row.revision,eventId);
    if(event.to_state!==row.state||event.input_generation!==row.input_generation)invalid();
    const snapshot={version:EPISODE_SNAPSHOT_VERSION,semantic_at:semanticAt,episode,event:eventProjection(event)};
    const json=canonicalJson(snapshot);
    if(Buffer.byteLength(json)>1048576)fail('PHASE4_JSON_TOO_LARGE');
    const envelope=core.envelope(context,table,[row.episode_id,row.revision]);
    const record={...envelope,episode_id:row.episode_id,revision:row.revision,episode_event_id:eventId,
      snapshot_version:EPISODE_SNAPSHOT_VERSION,semantic_at:semanticAt,snapshot_json:json,
      snapshot_hash:keys.digest(envelope.content_digest_salt,json),input_generation:context.inputGeneration,
      lifecycle_generation:context.lifecycleGeneration,auth_generation:context.authGeneration,created_at:core.timestamp()};
    const fields=Object.keys(record);
    await client.execute({sql:`INSERT INTO ${table}(${fields.join(',')}) VALUES (${fields.map(()=>'?').join(',')})`,
      args:fields.map(k=>record[k])});
    // Origin and materialization were validated inside this transaction. Direct
    // edges deliberately also cover an INVALIDATED revision, which is stored
    // but cannot be read as a healthy parent. Purge traverses both edges.
    for(const [type,id] of [['episode_events',event.privacy_artifact_id],['observation_episodes',row.privacy_artifact_id]])
      await addPrivacyLink(client,{userId:context.userId,mode:context.executionMode,table,artifactId:envelope.privacy_artifact_id,
        sourceMode:context.executionMode,sourceType:type,sourceId:id,relationship:'DEPENDS_ON',at:core.timestamp()});
  }
  async function read(context,{episodeId,revision,evidenceItemId=null,semanticAt=null}) {
    requireInteger(revision,1);
    return core.run(context,async()=>{
      const found=(await client.execute({sql:`SELECT * FROM ${table} WHERE user_id=? AND execution_mode=? AND episode_id=? AND revision=?`,
        args:[context.userId,context.executionMode,episodeId,revision]})).rows[0];
      if(!found)fail('PHASE4_EPISODE_HISTORY_UNAVAILABLE');
      if(!readableRow(found))fail('CONTENT_REDACTED');
      if(found.privacy_artifact_id!==keys.lookup(['privacy-artifact-v1',table,context.userId,context.executionMode,[episodeId,revision]]))invalid();
      let snapshot;
      try {
        if(found.snapshot_version!==EPISODE_SNAPSHOT_VERSION||typeof found.snapshot_json!=='string'
          ||Buffer.byteLength(found.snapshot_json)>1048576||keys.digest(found.content_digest_salt,found.snapshot_json)!==found.snapshot_hash)invalid();
        snapshot=JSON.parse(found.snapshot_json);
        if(!same(Object.keys(snapshot).sort(),['episode','event','semantic_at','version'])
          ||canonicalJson(snapshot)!==found.snapshot_json||snapshot.version!==found.snapshot_version
          ||requireSemanticTime(snapshot.semantic_at)!==found.semantic_at)invalid();
      } catch {invalid();}
      const row=snapshot.episode;await validateEpisode(row);
      for(const key of ['user_id','execution_mode','episode_id','revision','input_generation','lifecycle_generation','auth_generation','purge_generation'])
        if(row[key]!==found[key])invalid();
      if(semanticAt!==null&&requireSemanticTime(semanticAt)!==found.semantic_at)invalid();
      const event=await origin(context,episodeId,revision,found.episode_event_id);
      if(!same(eventProjection(event),snapshot.event)||event.to_state!==row.state||event.input_generation!==row.input_generation)invalid();
      const artifact=await core.artifact(context,table,{episode_id:episodeId,revision});
      const current=await core.artifact(context,'observation_episodes',{episode_id:episodeId});
      for(const key of ['user_id','execution_mode','episode_id','privacy_artifact_id','fingerprint','episode_family_key',
        'reopens_episode_id','reverses_episode_id','opened_at','domain','subject_key','direction'])if(current.row[key]!==row[key])invalid();
      if(current.row.revision<revision||current.row.revision===revision&&!same(episodeSemanticProjection(current.row),row))invalid();
      const bindings=[
        [table,artifact.row.privacy_artifact_id,'episode_events',event.privacy_artifact_id],
        [table,artifact.row.privacy_artifact_id,'observation_episodes',row.privacy_artifact_id],
      ];
      let refs;try {refs=JSON.parse(event.evidence_references_json);}catch {invalid();}
      if(!Array.isArray(refs)||!refs.length)invalid();
      for(const ref of refs) {
        if(!Array.isArray(ref)||ref.length!==2||ref.some(value=>typeof value!=='string'||!value))invalid();
        if(ref[0]==='evidence_items') {
          const item=await core.artifact(context,'evidence_items',{evidence_item_id:ref[1]});
          bindings.push(['episode_events',event.privacy_artifact_id,'evidence_items',item.row.privacy_artifact_id]);
        } else bindings.push(['episode_events',event.privacy_artifact_id,ref[0],ref[1],
          DERIVED_TABLES.includes(ref[0])?context.executionMode:'SHARED']);
      }
      if(evidenceItemId!==null&&(!refs.some(ref=>ref[0]==='evidence_items'&&ref[1]===evidenceItemId)
        ||row.latest_evidence_item_id!==evidenceItemId))invalid();
      for(const [type,id,parentType,parentId,mode=context.executionMode] of bindings) {
        const links=(await client.execute({sql:`SELECT 1 FROM phase4_source_links WHERE user_id=? AND artifact_execution_mode=?
          AND artifact_type=? AND artifact_id=? AND source_execution_mode=? AND source_type=? AND source_id=? AND unlinked_at IS NULL`,
          args:[context.userId,context.executionMode,type,id,mode,parentType,parentId]})).rows;
        if(links.length!==1)invalid();
      }
      // Only operational fields come from the current row. Delivery pointers
      // have no historical meaning. All semantics, including fences, are full
      // snapshot values; the stable branded artifact ref remains compatible.
      return {row:{...Object.fromEntries(EPISODE_OPERATIONAL_FIELDS.map(k=>[k,current.row[k]])),
        ...Object.fromEntries(EPISODE_DELIVERY_FIELDS.map(k=>[k,null])),...row},ref:current.ref};
    });
  }
  return Object.freeze({persist,read});
}
