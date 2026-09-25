import { fail, readableRow } from './phase4Core.js';
import { canonicalJson } from './phase4EntityStore.js';
import { addPrivacyLink } from './phase4V22Backfill.js';
import { RESULT_AUTHORITY_TABLE as TABLE, RESULT_AUTHORITY_VERSION as VERSION, RESULT_ROOT_VERSION } from './phase4V26Schema.js';
import { createBodyEnergyStore } from './bodyEnergyStore.js';

const invalid=()=>fail('PHASE4_DURABLE_REPLAY_BINDING_INVALID');
const incomplete=()=>fail('PHASE4_REQUIRED_ROOT_AUTHORITY_INCOMPLETE');
const parse=value=>{try{return JSON.parse(value);}catch{invalid();}};
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const ordered=values=>[...new Map(values.map(v=>[canonicalJson(v),v])).values()]
  .sort((a,b)=>canonicalJson(a).localeCompare(canonicalJson(b)));
const operational=new Set(['created_at','updated_at','completed_at','content_state','source_linkage_state',
  'health_content_redacted_at','health_content_redaction_reason','source_subject_deleted_at','purge_generation',
  'content_digest_salt','invalidated_at','fact_status','status','superseded_at','invalidation_reason','raw_json']);
const projection=row=>Object.fromEntries(Object.entries(row).filter(([k])=>!operational.has(k)));
const healthVersion=row=>canonicalJson([row.updated_at??null,row.synced_at??null,row.as_of_utc??null,row.score_state??null]);

/** Only registered calculation inputs define completeness. source_links are
 * secondary indexes, never consulted to enumerate required semantic roots.
 * Derived inputs are flattened from their versioned calculation manifests. */
export function createResultAuthority(core) {
  const {client,keys}=core;
  const hash=(salt,domain,value)=>keys.digest(salt,canonicalJson([domain,value]));
  const seal=row=>hash(row.content_digest_salt,VERSION,Object.fromEntries(Object.entries(row)
    .filter(([k])=>!['authority_hmac','health_content_redacted_at','health_content_redaction_reason',
      'source_subject_deleted_at'].includes(k))));
  const artifactId=(context,id,scope)=>keys.lookup(['privacy-artifact-v1',TABLE,context.userId,context.executionMode,[id,scope]]);

  async function resolve(context,entry) {
    if(entry.mode==='SHARED') {
      if(entry.as_of!==null) {
        const row=await core.validateHistoricalJournal(context,{type:entry.type,id:entry.id,
          historicalAsOf:entry.as_of,row:null});
        return {row,ref:null};
      }
      return core.root(context,entry.type,entry.id);
    }
    if(entry.mode!==context.executionMode||!['evidence_items','body_energy_results'].includes(entry.type))invalid();
    const key=entry.type==='evidence_items'?'evidence_item_id':'result_id';
    const row=(await client.execute({sql:`SELECT ${key} id FROM ${entry.type} WHERE user_id=? AND execution_mode=? AND privacy_artifact_id=?`,
      args:[context.userId,context.executionMode,entry.id]})).rows[0];
    if(!row)fail('PHASE4_SOURCE_NOT_FOUND');
    return core.artifact(context,entry.type,{[key]:row.id});
  }
  async function descriptorsForRun(context,run) {
    const input=parse(run.input_manifest_json),descriptors=[];
    const add=(type,id,version=null,asOf=null)=>{
      if(typeof type!=='string'||typeof id!=='string'||!id)incomplete();
      descriptors.push({type,id,mode:type==='body_energy_results'?context.executionMode:'SHARED',version,as_of:asOf});
    };
    if(input?.manifest_version==='phase4-metric-evidence-input-v1') {
      if(!Array.isArray(input.quality?.provenance)||!input.quality.provenance.length)incomplete();
      for(const ref of input.quality.provenance) {
        if(!Array.isArray(ref)||ref.length!==3)incomplete();
        add(...ref);
      }
    } else if(input?.manifest_version==='phase4-association-family-input-v1') {
      if(!Array.isArray(input.hypotheses)||!input.hypotheses.length)incomplete();
      for(const hypothesis of input.hypotheses) {
        if(!Array.isArray(hypothesis.days)||!Array.isArray(hypothesis.journal_authority))incomplete();
        for(const day of hypothesis.days)if(day.outcomeSource)add(...day.outcomeSource);
        for(const ref of hypothesis.journal_authority)add(ref.type,ref.id,ref.revision,ref.asOfUtc);
      }
    } else incomplete();
    const metric=input.manifest_version==='phase4-metric-evidence-input-v1';
    const inputHash=keys.lookup([metric?'phase4-evidence-input-v1':'phase4-association-input-v1',
      context.userId,context.executionMode,run.input_generation,canonicalJson(input)]);
    const runKey=keys.lookup(['phase4-evidence-run-v1',context.userId,context.executionMode,
      metric?'PERSONAL_BASELINE_DEVIATION':'JOURNAL_ASSOCIATION',
      ...(metric?[input.metric_key]:[input.multiple_testing_family,input.focus_key]),input.as_of_utc,run.input_generation,inputHash]);
    if(run.input_manifest_hash!==inputHash||run.deterministic_run_key!==runKey)invalid();
    return ordered(descriptors);
  }
  async function captureRoots(context,refs,salt) {
    const inputs=await core.revalidateSources(context,refs),pending=inputs.map(source=>({type:source.type,id:source.id,
      mode:source.mode,as_of:source.historicalAsOf??null,version:null})),entries=new Map(),seen=new Set();
    while(pending.length) {
      const descriptor=pending.shift(),identity=canonicalJson([descriptor.mode,descriptor.type,descriptor.id,descriptor.as_of]);
      if(seen.has(identity)) {
        if(descriptor.version!==null&&descriptor.version!==entries.get(identity).version)
          fail('PHASE4_REQUIRED_ROOT_VERSION_MISMATCH');
        if(!descriptor.expected)continue;
      }
      seen.add(identity);if(seen.size>10000)incomplete();
      const {row}=await resolve(context,descriptor);
      if(descriptor.expected)for(const [field,value] of Object.entries(descriptor.expected))
        if((row[field]??null)!==value)fail('PHASE4_REQUIRED_ROOT_VERSION_MISMATCH');
      if(descriptor.version!==null) {
        const version=descriptor.as_of!==null?row.revision:healthVersion(row);
        if(version!==descriptor.version)fail('PHASE4_REQUIRED_ROOT_VERSION_MISMATCH');
      }
      const {expected,...stable}=descriptor;
      entries.set(identity,{...stable,version:descriptor.as_of!==null?row.revision
        :['sleep','recovery','cycle','workout','body_energy_results'].includes(descriptor.type)?healthVersion(row):null,
      content_hash:hash(salt,'required-root-content-v1',projection(row))});
      if(descriptor.type==='evidence_items') {
        const run=await core.artifact(context,'evidence_runs',{run_id:row.run_id});
        pending.push(...await descriptorsForRun(context,run.row));
        const existing=(await client.execute({sql:`SELECT result_scope FROM ${TABLE} WHERE user_id=? AND execution_mode=? AND evidence_item_id=?`,
          args:[context.userId,context.executionMode,row.evidence_item_id]})).rows;
        for(const value of existing) {
          const authority=await read(context,row.evidence_item_id,value.result_scope);
          pending.push(...authority.manifest.roots.map(({content_hash,...root})=>root));
        }
      } else if(descriptor.type==='body_energy_results') {
        const audited=await createBodyEnergyStore(core).audit(context,row.result_id),m=audited.manifest;
        if(m.manifest_version!=='body-energy-inputs-v1')incomplete();
        const add=(type,value)=>{if(value)pending.push({type,id:String(value[type==='recovery'?'sleep_id':'id']),
          mode:'SHARED',as_of:null,version:null,expected:value});};
        add('sleep',m.main_sleep);add('recovery',m.recovery);
        for(const value of [...m.baseline.hrv,...m.baseline.rhr]){add('sleep',value.sleep);add('recovery',value.recovery);}
        for(const value of m.load.rows)add(m.load.kind==='CYCLE'?'cycle':'workout',value);
        for(const value of m.naps)add('sleep',value.source);
        for(const value of m.exclusions)if(value.id!==null)pending.push({type:value.resource==='baseline'?'sleep':value.resource,
          id:value.id,mode:'SHARED',as_of:null,version:null});
      } else if(!['sleep','recovery','cycle','workout','JOURNAL_FACT','JOURNAL_COVERAGE','USER'].includes(descriptor.type))incomplete();
    }
    if(!entries.size)incomplete();
    return {version:RESULT_ROOT_VERSION,model:'FLATTENED_CALCULATION_INPUTS',roots:ordered([...entries.values()])};
  }
  async function validateRoots(context,row,manifest) {
    if(!manifest||manifest.version!==RESULT_ROOT_VERSION||manifest.model!=='FLATTENED_CALCULATION_INPUTS'
      ||!Array.isArray(manifest.roots)||!manifest.roots.length||manifest.roots.length>10000
      ||!same(manifest.roots,ordered(manifest.roots)))invalid();
    for(const entry of manifest.roots) {
      if(!same(Object.keys(entry).sort(),['as_of','content_hash','id','mode','type','version'])
        ||typeof entry.id!=='string'||!entry.id||typeof entry.content_hash!=='string')invalid();
      const source=await resolve(context,entry);
      if(entry.version!==null&&(entry.as_of!==null?source.row.revision:healthVersion(source.row))!==entry.version)
        fail('PHASE4_REQUIRED_ROOT_VERSION_MISMATCH');
      if(hash(row.content_digest_salt,'required-root-content-v1',projection(source.row))!==entry.content_hash)
        fail('PHASE4_REQUIRED_ROOT_VERSION_MISMATCH');
    }
  }
  async function read(context,evidenceItemId,scope) {
    return core.run(context,async()=>{
      const row=(await client.execute({sql:`SELECT * FROM ${TABLE} WHERE user_id=? AND execution_mode=? AND evidence_item_id=? AND result_scope=?`,
        args:[context.userId,context.executionMode,evidenceItemId,scope]})).rows[0];
      if(!row)fail('PHASE4_EVIDENCE_RESULT_AUTHORITY_UNAVAILABLE');
      if(!readableRow(row))fail('CONTENT_REDACTED');
      try {
        if(row.authority_version!==VERSION||row.privacy_artifact_id!==artifactId(context,evidenceItemId,scope)
          ||seal(row)!==row.authority_hmac)invalid();
      }catch{invalid();}
      for(const [column,value] of [['input_generation',context.inputGeneration],['lifecycle_generation',context.lifecycleGeneration],
        ['auth_generation',context.authGeneration]])if(row[column]!==value)fail('PHASE4_PARENT_STALE');
      const origin=parse(row.original_result_json),manifest=parse(row.required_roots_json);
      if(canonicalJson(origin)!==row.original_result_json||canonicalJson(manifest)!==row.required_roots_json)invalid();
      const item=await core.artifact(context,'evidence_items',{evidence_item_id:evidenceItemId});
      const run=await core.artifact(context,'evidence_runs',{run_id:row.run_id});
      if(item.row.run_id!==row.run_id||run.row.state!=='COMPLETED'
        ||hash(row.content_digest_salt,'result-input-v1',run.row.input_manifest_json)!==row.input_manifest_hash
        ||hash(row.content_digest_salt,'result-item-v1',projection(item.row))!==row.item_hash)invalid();
      await validateRoots(context,row,manifest);
      return {row,origin,manifest};
    });
  }
  async function persist(context,{item,run,scope,origin,sourceRefs}) {
    if(!core.processing.active())fail('PHASE4_TRANSACTION_REQUIRED');
    if(context.executionMode!=='SHADOW')fail('PHASE4_INTELLIGENCE_SHADOW_ONLY');
    // This method is internal to the deterministic calculation transaction.
    // Existing/legacy items may never acquire an origin on later reuse.
    if(!item.created)fail('PHASE4_EVIDENCE_RESULT_AUTHORITY_UNAVAILABLE');
    if(scope==='METRIC'&&origin!==null) {
      const snapshot=(await client.execute({sql:`SELECT * FROM phase4_episode_revisions WHERE user_id=? AND execution_mode=?
        AND episode_id=? AND revision=? AND episode_event_id=?`,args:[context.userId,context.executionMode,
        origin.episode_id,origin.revision,origin.episode_event_id]})).rows[0];
      if(!readableRow(snapshot)||keys.digest(snapshot.content_digest_salt,snapshot.snapshot_json)!==snapshot.snapshot_hash)invalid();
      const value=parse(snapshot.snapshot_json);
      if(value.episode.latest_evidence_item_id!==item.row.evidence_item_id
        ||!parse(value.event.evidence_references_json).some(ref=>ref[0]==='evidence_items'&&ref[1]===item.row.evidence_item_id))invalid();
    }
    const envelope=core.envelope(context,TABLE,[item.row.evidence_item_id,scope]);
    const roots=await captureRoots(context,sourceRefs,envelope.content_digest_salt);
    const record={...envelope,evidence_item_id:item.row.evidence_item_id,run_id:run.row.run_id,result_scope:scope,authority_version:VERSION,
      original_result_json:canonicalJson(origin),required_roots_json:canonicalJson(roots),
      input_manifest_hash:hash(envelope.content_digest_salt,'result-input-v1',run.row.input_manifest_json),
      item_hash:hash(envelope.content_digest_salt,'result-item-v1',projection(item.row)),
      input_generation:context.inputGeneration,lifecycle_generation:context.lifecycleGeneration,auth_generation:context.authGeneration,
      created_at:core.timestamp()};
    for(const field of ['original_result_json','required_roots_json'])if(Buffer.byteLength(record[field])>1048576)incomplete();
    record.authority_hmac=seal(record);
    const fields=Object.keys(record);
    await client.execute({sql:`INSERT INTO ${TABLE}(${fields.join(',')}) VALUES (${fields.map(()=>'?').join(',')})`,args:fields.map(k=>record[k])});
    for(const source of [...roots.roots,{type:'evidence_items',id:item.row.privacy_artifact_id,mode:context.executionMode,as_of:null}])
      await addPrivacyLink(client,{userId:context.userId,mode:context.executionMode,table:TABLE,artifactId:envelope.privacy_artifact_id,
        sourceMode:source.mode,sourceType:source.type,sourceId:source.id,
        relationship:source.as_of?`DEPENDS_ON_AS_OF:${source.as_of}`:'DEPENDS_ON',at:core.timestamp()});
    return record;
  }
  async function metricOrigin(context,itemId,{episodeId,revision}={}) {
    const authority=await read(context,itemId,'METRIC'),origin=authority.origin;
    if(episodeId!==undefined&&(origin?.episode_id!==episodeId||origin?.revision!==revision))invalid();
    if(origin!==null) {
      if(!same(Object.keys(origin).sort(),['episode_event_id','episode_id','prior_semantic_hash','revision'])
        ||!Number.isSafeInteger(origin.revision)||origin.revision<1
        ||!(origin.prior_semantic_hash===null||typeof origin.prior_semantic_hash==='string'))invalid();
      const memberships=(await client.execute({sql:`SELECT * FROM episode_evidence WHERE user_id=? AND execution_mode=? AND evidence_item_id=?`,
        args:[context.userId,context.executionMode,itemId]})).rows;
      if(memberships.length!==1||!readableRow(memberships[0])||memberships[0].unlinked_at!==null
        ||memberships[0].episode_id!==origin.episode_id||memberships[0].episode_revision!==origin.revision)invalid();
      const event=(await client.execute({sql:`SELECT episode_event_id FROM episode_events WHERE user_id=? AND execution_mode=?
        AND episode_id=? AND resulting_revision=?`,args:[context.userId,context.executionMode,origin.episode_id,origin.revision]})).rows;
      if(event.length!==1||event[0].episode_event_id!==origin.episode_event_id)invalid();
    }
    return authority;
  }
  async function episodeDependencies(context,episode) {
    if(!episode)return [];
    const snapshots=(await client.execute({sql:`SELECT * FROM phase4_episode_revisions WHERE user_id=? AND execution_mode=?
      AND episode_id=? AND revision<=? AND input_generation=? ORDER BY revision`,
      args:[context.userId,context.executionMode,episode.episode_id,episode.revision,context.inputGeneration]})).rows;
    if(!snapshots.length||snapshots.at(-1).revision!==episode.revision)incomplete();
    const refs=[],ids=new Set([episode.latest_evidence_item_id,episode.explanation_evidence_item_id].filter(Boolean));
    for(const snapshot of snapshots) {
      if(!readableRow(snapshot)||keys.digest(snapshot.content_digest_salt,snapshot.snapshot_json)!==snapshot.snapshot_hash)invalid();
      const value=parse(snapshot.snapshot_json);
      if(snapshot.revision===episode.revision&&Object.entries(value.episode).some(([key,value])=>episode[key]!==value))invalid();
      for(const [type,id] of parse(value.event.evidence_references_json)) {
        if(type==='evidence_items')ids.add(id);
        else if(['sleep','recovery','cycle','workout','JOURNAL_FACT','JOURNAL_COVERAGE','USER'].includes(type))
          refs.push((await core.root(context,type,id)).ref);
        else incomplete();
      }
    }
    for(const id of ids)refs.push((await core.artifact(context,'evidence_items',{evidence_item_id:id})).ref);
    return refs;
  }
  return Object.freeze({read,persist,metricOrigin,episodeDependencies});
}
