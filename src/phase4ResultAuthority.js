import { healthSourceVersion, canonicalSourceVersion, canonicalSourceTime } from './phase4SourceVersion.js';
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
const legacyHealthVersion=row=>canonicalJson([row.updated_at??null,row.synced_at??null,row.as_of_utc??null,row.score_state??null]);
const healthVersion=healthSourceVersion;
const NORMALIZED_ROOT_VERSION='stage5-required-roots-v2';
const NULL_PROJECTION_VERSION='stage5-null-metric-result-v2';
const rootProjection=(row,type,version)=>version===NORMALIZED_ROOT_VERSION&&['sleep','recovery','cycle','workout','body_energy_results'].includes(type)
  ?Object.fromEntries(Object.entries(projection(row)).map(([k,v])=>[k,k.endsWith('_at')||k==='as_of_utc'?canonicalSourceTime(v):v])):projection(row);

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
        if(descriptor.version!==null&&canonicalSourceVersion(descriptor.version)!==entries.get(identity).version)
          fail('PHASE4_REQUIRED_ROOT_VERSION_MISMATCH');
        if(!descriptor.expected)continue;
      }
      seen.add(identity);if(seen.size>10000)incomplete();
      const {row}=await resolve(context,descriptor);
      if(descriptor.expected)for(const [field,value] of Object.entries(descriptor.expected))
        if((row[field]??null)!==value)fail('PHASE4_REQUIRED_ROOT_VERSION_MISMATCH');
      if(descriptor.version!==null) {
        const version=descriptor.as_of!==null?row.revision:healthVersion(row);
        if(version!==canonicalSourceVersion(descriptor.version))fail('PHASE4_REQUIRED_ROOT_VERSION_MISMATCH');
      }
      const {expected,...stable}=descriptor;
      entries.set(identity,{...stable,version:descriptor.as_of!==null?row.revision
        :['sleep','recovery','cycle','workout','body_energy_results'].includes(descriptor.type)?healthVersion(row):null,
      content_hash:hash(salt,'required-root-content-v1',rootProjection(row,descriptor.type,NORMALIZED_ROOT_VERSION))});
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
    return {version:NORMALIZED_ROOT_VERSION,model:'FLATTENED_CALCULATION_INPUTS',roots:ordered([...entries.values()])};
  }
  function validateManifest(manifest,mode) {
    if(!manifest||![RESULT_ROOT_VERSION,NORMALIZED_ROOT_VERSION].includes(manifest.version)||manifest.model!=='FLATTENED_CALCULATION_INPUTS'
      ||!Array.isArray(manifest.roots)||!manifest.roots.length||manifest.roots.length>10000
      ||!same(manifest.roots,ordered(manifest.roots)))invalid();
    for(const entry of manifest.roots) {
      if(!same(Object.keys(entry).sort(),['as_of','content_hash','id','mode','type','version'])
        ||typeof entry.id!=='string'||!entry.id||typeof entry.content_hash!=='string'
        ||!['SHARED',mode].includes(entry.mode)
        ||!['sleep','recovery','cycle','workout','body_energy_results','evidence_items','JOURNAL_FACT','JOURNAL_COVERAGE','USER'].includes(entry.type))invalid();
    }
  }
  async function validateRoots(context,row,manifest) {
    validateManifest(manifest,context.executionMode);
    for(const entry of manifest.roots) {
      const source=await resolve(context,entry);
      if(entry.version!==null&&(entry.as_of!==null?source.row.revision:(manifest.version===NORMALIZED_ROOT_VERSION?healthVersion:legacyHealthVersion)(source.row))!==entry.version)
        fail('PHASE4_REQUIRED_ROOT_VERSION_MISMATCH');
      if(hash(row.content_digest_salt,'required-root-content-v1',rootProjection(source.row,entry.type,manifest.version))!==entry.content_hash)
        fail('PHASE4_REQUIRED_ROOT_VERSION_MISMATCH');
    }
  }
  // This exact verifier is shared by authorized reads and redaction discovery.
  // Redaction does not require roots to remain readable or old generations to
  // equal the newly admitted purge generation; identity and HMAC never relax.
  function verifyEnvelope(context,row) {
    if(!readableRow(row))fail('CONTENT_REDACTED');
    try {
      if(row.user_id!==context.userId||row.execution_mode!==context.executionMode||row.execution_mode!=='SHADOW'
        ||!['METRIC','INSIGHT_CURRENT','INSIGHT_CONTRADICTION'].includes(row.result_scope)
        ||row.authority_version!==VERSION||row.privacy_artifact_id!==artifactId(context,row.evidence_item_id,row.result_scope)
        ||seal(row)!==row.authority_hmac)invalid();
    }catch{invalid();}
  }
  function authenticate(context,row,item,run) {
    verifyEnvelope(context,row);
    if(!readableRow(item)||!readableRow(run))fail('CONTENT_REDACTED');
    if(item.user_id!==row.user_id||run.user_id!==row.user_id||item.execution_mode!==row.execution_mode
      ||run.execution_mode!==row.execution_mode||item.evidence_item_id!==row.evidence_item_id
      ||item.run_id!==row.run_id||run.run_id!==row.run_id||run.state!=='COMPLETED'
      ||hash(row.content_digest_salt,'result-input-v1',run.input_manifest_json)!==row.input_manifest_hash
      ||hash(row.content_digest_salt,'result-item-v1',projection(item))!==row.item_hash)invalid();
    for(const field of ['input_generation','lifecycle_generation','auth_generation'])if(run[field]!==row[field])invalid();
    const payload=parse(row.original_result_json),manifest=parse(row.required_roots_json);
    if(canonicalJson(payload)!==row.original_result_json||canonicalJson(manifest)!==row.required_roots_json)invalid();
    validateManifest(manifest,row.execution_mode);
    if(payload?.version!==undefined) {
      if(row.result_scope!=='METRIC'||payload.version!==NULL_PROJECTION_VERSION||payload.origin!==null
        ||!same(Object.keys(payload).sort(),['calculation','origin','version'])||!payload.calculation
        ||payload.calculation.targetEpisodeState!==null||typeof payload.calculation.classification!=='string')invalid();
      return {origin:null,calculation:payload.calculation,manifest};
    }
    if(payload!==null) {
      if(row.result_scope==='METRIC') {
        if(!same(Object.keys(payload).sort(),['episode_event_id','episode_id','prior_semantic_hash','revision'])
          ||typeof payload.episode_id!=='string'||typeof payload.episode_event_id!=='string'
          ||!(payload.prior_semantic_hash===null||typeof payload.prior_semantic_hash==='string'))invalid();
      } else {
        const version=payload.projection_version;
        if(version!==undefined&&version!=='stage5-insight-result-v2')invalid();
        const fields=['insight_id','revision','revision_json',...(version?['projection_version','last_recalculated_at','retired_at']:[])];
        if(!same(Object.keys(payload).sort(),fields.sort())||!Number.isSafeInteger(payload.insight_id)||payload.insight_id<1
          ||typeof payload.revision_json!=='string')invalid();
        if(version)for(const field of ['last_recalculated_at','retired_at'])
          if(payload[field]!==null&&(typeof payload[field]!=='string'||!Number.isFinite(Date.parse(payload[field]))
            ||new Date(payload[field]).toISOString()!==payload[field]))invalid();
      }
      if(!Number.isSafeInteger(payload.revision)||payload.revision<1)invalid();
    }
    return {origin:payload,calculation:null,manifest};
  }
  async function validateExisting(context,itemId,{required=false}={}) {
    const scopes=(await client.execute({sql:`SELECT result_scope FROM ${TABLE} WHERE user_id=? AND execution_mode=? AND evidence_item_id=?`,
      args:[context.userId,context.executionMode,itemId]})).rows;
    if(required&&!scopes.length)fail('PHASE4_EVIDENCE_RESULT_AUTHORITY_UNAVAILABLE');
    for(const {result_scope:scope} of scopes)await read(context,itemId,scope);
  }
  async function read(context,evidenceItemId,scope) {
    return core.run(context,async()=>{
      const row=(await client.execute({sql:`SELECT * FROM ${TABLE} WHERE user_id=? AND execution_mode=? AND evidence_item_id=? AND result_scope=?`,
        args:[context.userId,context.executionMode,evidenceItemId,scope]})).rows[0];
      if(!row)fail('PHASE4_EVIDENCE_RESULT_AUTHORITY_UNAVAILABLE');
      verifyEnvelope(context,row);
      const item=await core.artifact(context,'evidence_items',{evidence_item_id:evidenceItemId});
      const run=await core.artifact(context,'evidence_runs',{run_id:row.run_id});
      const verified=authenticate(context,row,item.row,run.row),{origin,manifest}=verified;
      for(const [column,value] of [['input_generation',context.inputGeneration],['lifecycle_generation',context.lifecycleGeneration],
        ['auth_generation',context.authGeneration]])if(row[column]!==value)fail('PHASE4_PARENT_STALE');
      await validateRoots(context,row,manifest);
      return {row,...verified};
    });
  }
  async function persist(context,{item,run,scope,origin,calculation,sourceRefs}) {
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
      original_result_json:canonicalJson(scope==='METRIC'&&origin===null
        ?{version:NULL_PROJECTION_VERSION,origin:null,calculation}:origin),required_roots_json:canonicalJson(roots),
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
    if(episodeId!==undefined&&origin?.episode_id!==episodeId||revision!==undefined&&origin?.revision!==revision)invalid();
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
  async function privacyDependencies(userId,row) {
    const context={userId,executionMode:row.execution_mode},scope=[userId,row.execution_mode];
    const item=(await client.execute({sql:'SELECT * FROM evidence_items WHERE user_id=? AND execution_mode=? AND evidence_item_id=?',
      args:[...scope,row.evidence_item_id]})).rows[0];
    const run=(await client.execute({sql:'SELECT * FROM evidence_runs WHERE user_id=? AND execution_mode=? AND run_id=?',
      args:[...scope,row.run_id]})).rows[0];
    const targets=[],add=(type,value)=>{if(value?.privacy_artifact_id)targets.push({mode:row.execution_mode,type,id:value.privacy_artifact_id});};
    // Identity is the trusted registry boundary, even when payload HMAC fails.
    if(row.user_id!==userId||row.execution_mode!=='SHADOW'||!item||!run||item.run_id!==run.run_id
      ||row.privacy_artifact_id!==artifactId(context,row.evidence_item_id,row.result_scope)
      ||item.privacy_artifact_id!==keys.lookup(['privacy-artifact-v1','evidence_items',userId,row.execution_mode,[item.run_id,item.item_key]])
      ||run.privacy_artifact_id!==keys.lookup(['privacy-artifact-v1','evidence_runs',userId,row.execution_mode,[run.deterministic_run_key]]))
      fail('PHASE4_PURGE_AUTHORITY_INVALID');
    add(TABLE,row);add('evidence_items',item);add('evidence_runs',run);
    let verified;
    try {verified=authenticate(context,row,item,run);}catch {verified=null;}
    // A corrupt manifest supplies no edges and makes no retention decision.
    // The independently keyed run manifest bounds conservative invalidation.
    let roots;
    if(verified)roots=verified.manifest.roots;
    else {
      try {roots=await descriptorsForRun(context,run);}catch {fail('PHASE4_PURGE_AUTHORITY_INVALID');}
    }
    const episodeIds=new Set(),insightIds=new Set();
    const addEvidenceRoot=async id=>{
      const evidence=(await client.execute({sql:'SELECT privacy_artifact_id FROM evidence_items WHERE user_id=? AND execution_mode=? AND evidence_item_id=?',
        args:[...scope,id]})).rows[0];
      if(!evidence)fail('PHASE4_PURGE_AUTHORITY_INVALID');
      roots.push({mode:row.execution_mode,type:'evidence_items',id:evidence.privacy_artifact_id});
    };
    if(verified?.origin) {
      const origin=verified.origin;
      if(row.result_scope==='METRIC') {
        const snapshot=(await client.execute({sql:`SELECT * FROM phase4_episode_revisions WHERE user_id=? AND execution_mode=?
          AND episode_id=? AND revision=? AND episode_event_id=?`,args:[...scope,origin.episode_id,origin.revision,origin.episode_event_id]})).rows[0];
        if(snapshot&&readableRow(snapshot)&&keys.digest(snapshot.content_digest_salt,snapshot.snapshot_json)!==snapshot.snapshot_hash)invalid();
        episodeIds.add(origin.episode_id);
      } else {
        const revision=(await client.execute({sql:'SELECT * FROM insight_revisions WHERE user_id=? AND execution_mode=? AND insight_id=? AND revision=?',
          args:[...scope,origin.insight_id,origin.revision]})).rows[0];
        if(revision&&readableRow(revision)&&canonicalJson({...revision})!==origin.revision_json)invalid();
        insightIds.add(origin.insight_id);
      }
    }
    // Scoped ownership/references are a conservative redaction boundary, never
    // a read authority or an inferred original origin. They also cover interim
    // revisions created in the same transaction before the returned revision.
    for(const value of (await client.execute({sql:'SELECT episode_id FROM episode_evidence WHERE user_id=? AND execution_mode=? AND evidence_item_id=?',
      args:[...scope,item.evidence_item_id]})).rows)episodeIds.add(value.episode_id);
    for(const revision of (await client.execute({sql:'SELECT * FROM insight_revisions WHERE user_id=? AND execution_mode=?',args:scope})).rows) {
      let ids;try {ids=[...JSON.parse(revision.supporting_evidence_ids_json??'[]'),...JSON.parse(revision.contradicting_evidence_ids_json??'[]')];}
      catch {fail('PHASE4_PURGE_AUTHORITY_INVALID');}
      if(ids.includes(item.evidence_item_id))insightIds.add(revision.insight_id);
    }
    for(const id of insightIds)for(const table of ['health_insights','insight_revisions']) {
      const column=table==='health_insights'?'id':'insight_id';
      for(const value of (await client.execute({sql:`SELECT * FROM ${table} WHERE user_id=? AND execution_mode=? AND ${column}=?`,args:[...scope,id]})).rows) {
        add(table,value);
        if(!verified&&table==='insight_revisions') {
          let refs;try {refs=[...JSON.parse(value.supporting_evidence_ids_json??'[]'),...JSON.parse(value.contradicting_evidence_ids_json??'[]')];}
          catch {fail('PHASE4_PURGE_AUTHORITY_INVALID');}
          for(const evidenceId of refs)await addEvidenceRoot(evidenceId);
        }
      }
    }
    for(const id of episodeIds)for(const table of ['observation_episodes','phase4_episode_revisions','episode_events','episode_evidence','episode_observations','episode_semantic_events'])
      for(const value of (await client.execute({sql:`SELECT * FROM ${table} WHERE user_id=? AND execution_mode=? AND episode_id=?`,args:[...scope,id]})).rows) {
        add(table,value);
        if(!verified&&table==='phase4_episode_revisions'&&value.content_state==='PRESENT') {
          // An invalid v26 payload cannot hide dependencies already sealed by
          // v25. Authenticate those bytes independently; never reconstruct them.
          let snapshot,refs;
          try {
            snapshot=JSON.parse(value.snapshot_json);refs=JSON.parse(snapshot.event.evidence_references_json);
            if(value.snapshot_version!=='episode-revision-v1'||canonicalJson(snapshot)!==value.snapshot_json
              ||keys.digest(value.content_digest_salt,value.snapshot_json)!==value.snapshot_hash
              ||snapshot.episode.user_id!==userId||snapshot.episode.execution_mode!==row.execution_mode
              ||snapshot.episode.episode_id!==id||snapshot.episode.revision!==value.revision
              ||!Array.isArray(refs))throw Error();
          }catch {fail('PHASE4_PURGE_AUTHORITY_INVALID');}
          for(const ref of refs) {
            if(!Array.isArray(ref)||ref.length!==2)fail('PHASE4_PURGE_AUTHORITY_INVALID');
            if(ref[0]==='evidence_items')await addEvidenceRoot(ref[1]);
            else if(['sleep','recovery','cycle','workout','JOURNAL_FACT','JOURNAL_COVERAGE','USER'].includes(ref[0]))
              roots.push({mode:'SHARED',type:ref[0],id:ref[1]});
            else fail('PHASE4_PURGE_AUTHORITY_INVALID');
          }
        }
      }
    return {roots,targets};
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
  return Object.freeze({read,persist,metricOrigin,episodeDependencies,validateExisting,privacyDependencies});
}
