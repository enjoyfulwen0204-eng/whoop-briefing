import { AsyncLocalStorage } from 'node:async_hooks';
import { fail, readableRow, DERIVED_TABLES } from './phase4Core.js';
import { BODY_ENERGY } from './bodyEnergyRegistry.js';
import { INTELLIGENCE_VERSIONS } from './phase4IntelligenceRegistry.js';
import { episodeSemanticProjection } from './phase4EpisodeHistory.js';
import { canonicalJson } from './phase4EntityStore.js';
import { canonicalInstant, semanticTime, requireChronology } from './phase4Time.js';
import { healthSourceVersion } from './phase4SourceVersion.js';
import { createResultAuthority } from './phase4ResultAuthority.js';
import { addPrivacyLink } from './phase4V22Backfill.js';
import { OPERATION_RECEIPT_TABLE as TABLE, OPERATION_RECEIPT_VERSION as VERSION } from './phase4V27Schema.js';

const instances=new WeakMap();
const invalid=()=>fail('PHASE4_OPERATION_RECEIPT_INTEGRITY');
const unavailable=()=>fail('PHASE4_OPERATION_RESULT_UNAVAILABLE');
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const parse=value=>{try{return JSON.parse(value);}catch{invalid();}};
const unordered=new Set(['baselineSources','sourceRefs','outcomeSources','journalFactSources','coverageSources',
  'hypotheses','comparisonHealthDates','supportingEvidenceIds','contradictingEvidenceIds']);
const times=new Set(['asOfUtc','semanticAt','expiresAt','opened_at','resolved_at','expires_at','last_observed_at',
  'first_observed_at','last_material_change_at','stabilization_started_at','window_start_utc','window_end_utc']);
const episodeDelivery=new Set(['last_question_id','last_delivered_notification_id','last_ambiguous_attempt_id']);
const operationResult=value=>Boolean(value.row?.privacy_artifact_id||value.run?.row?.run_id
  ||value.episode?.row?.episode_id||value.result?.row?.result_id||value.eventId
  ||value.item?.row?.evidence_item_id&&value.analysis||Array.isArray(value.items)&&Array.isArray(value.runs));
const fences=context=>[context.inputGeneration,context.lifecycleGeneration,context.authGeneration,context.purgeGeneration];
const ordered=values=>[...new Map(values.map(value=>[canonicalJson(value),value])).values()]
  .sort((a,b)=>canonicalJson(a).localeCompare(canonicalJson(b)));

/** This boundary owns the complete public return tree. New row columns are
 * semantic by default; schema growth makes old incomplete receipts unavailable.
 * Capabilities are reissued only after receipt, roots and fences authenticate.
 * It never merges current semantic fields into historical content. */
export function createOperationReceipts(core) {
  if(instances.has(core))return instances.get(core);
  const {client,keys}=core,authorities=createResultAuthority(core);
  const producerScope=new AsyncLocalStorage();
  const identity=(context,kind,key)=>keys.lookup(['privacy-artifact-v1',TABLE,context.userId,context.executionMode,[kind,key]]);
  const seal=row=>keys.digest(row.content_digest_salt,canonicalJson([VERSION,Object.fromEntries(Object.entries(row)
    .filter(([key])=>!['receipt_hmac','health_content_redacted_at','health_content_redaction_reason','source_subject_deleted_at'].includes(key)))]));
  const requestEnvelope=(context,kind,request)=>({version:'stage5-semantic-request-v1',operation_kind:kind,request,
    scope:{user_id:context.userId,execution_mode:context.executionMode,timezone:context.timezone,
      algorithm_set_version:context.algorithmSetVersion,generations:fences(context)},
    profiles:{time:'explicit-offset-lossless-milliseconds-v1',intelligence:INTELLIGENCE_VERSIONS,
      ...(kind.startsWith('BODY_ENERGY_')?{body_energy:BODY_ENERGY}:{})}});
  const keyForEnvelope=envelope=>keys.lookup(['stage5-operation-key-v1',canonicalJson(envelope)]);

  async function prepare(context,request,kind=null) {
    if(kind==='analyzeMetric'&&(!request||Object.keys(request).sort().join(',')!=='asOfUtc,baselineSources,currentSource,metricKey,windowFamily'))
      fail('PHASE4_METRIC_ANALYSIS_REQUEST_INVALID');
    if(kind==='analyzeAssociationFamily'&&(!request||Object.keys(request).sort().join(',')!=='asOfUtc,hypotheses,multipleTestingFamily'))
      fail('PHASE4_ASSOCIATION_FAMILY_INVALID');
    const defaults={
      EPISODE_OPEN:{reopensEpisodeId:null,reversesEpisodeId:null,semanticEvent:null},
      EPISODE_REVISE:{patch:{},sourceRefs:[],closeThresholdPassed:false,resolutionHoldMs:86400000,continuityGapPassed:false,semanticEvent:null},
      INSIGHT_CREATE:{supersedesId:null},
      INSIGHT_TRANSITION:{disposition:null,contradictingEvidenceIds:[],refresh:false,expiresAt:null},
      BODY_ENERGY_COMPUTE:{algorithmVersion:BODY_ENERGY.algorithm,targetHealthDate:null,supersedesResultId:null},
      BODY_ENERGY_CHECKPOINT:{algorithmVersion:BODY_ENERGY.algorithm},
    };
    request={...defaults[kind],...request};
    const refs=[],referenceIdentities=new WeakMap(),asOf=request?.asOfUtc??request?.semanticAt;
    async function visit(value,key='') {
      if(core.isReference(value)) {
        const supplied=value;
        let source=core.validateReferences(context,[value])[0];
        if(asOf&&['JOURNAL_FACT','JOURNAL_COVERAGE'].includes(source.type)) {
          const selected=await core.journalSourcesAsOf(context,[value],canonicalInstant(asOf));
          if(!selected.length) {
            const absent={source_type:source.type,absent_as_of:canonicalInstant(asOf)};
            referenceIdentities.set(supplied,absent);return absent;
          }
          source=selected[0];value=source.ref;
        }
        refs.push(value);
        const identity={source_type:source.type,source_id:source.id,source_mode:source.mode,
          source_version:['sleep','recovery','cycle','workout','body_energy_results'].includes(source.type)
            ?healthSourceVersion(source.row):source.row?.revision??null,as_of:source.historicalAsOf??null,...(['JOURNAL_FACT','JOURNAL_COVERAGE'].includes(source.type)
            ?{created_at:canonicalInstant(source.row.created_at)}:{})};
        referenceIdentities.set(supplied,identity);referenceIdentities.set(value,identity);return identity;
      }
      if(value===null||typeof value!=='object')return times.has(key)&&value!==null&&value!==undefined?canonicalInstant(value):value;
      if(Array.isArray(value)) {
        let values=[];for(const entry of value)values.push(await visit(entry));
        if(['journalFactSources','coverageSources'].includes(key))values=values.filter(entry=>!entry?.absent_as_of);
        if(unordered.has(key)) {
          const unique=ordered(values);
          if(unique.length!==values.length)fail('PHASE4_SEMANTIC_SOURCE_DUPLICATE');
          return unique;
        }
        return values;
      }
      const entries=[];for(const [name,entry] of Object.entries(value))entries.push([name,await visit(entry,name)]);
      return Object.fromEntries(entries);
    }
    const normalized=await visit(request);
    // Current and baseline cannot be separately branded aliases of one source.
    if(normalized.currentSource&&normalized.baselineSources?.some(value=>same(value,normalized.currentSource)))
      fail('PHASE4_SEMANTIC_SOURCE_DUPLICATE');
    function argumentsFor(value,key='') {
      if(core.isReference(value))return {argument:value,identity:referenceIdentities.get(value)??{source_type:value.type,source_id:value.id}};
      if(value===null||typeof value!=='object') {
        const result=times.has(key)&&value!==null&&value!==undefined?canonicalInstant(value):value;
        return {argument:result,identity:result};
      }
      if(Array.isArray(value)) {
        let entries=value.map(entry=>argumentsFor(entry));
        if(['journalFactSources','coverageSources'].includes(key))entries=entries.filter(entry=>!entry.identity?.absent_as_of);
        if(unordered.has(key))entries.sort((a,b)=>canonicalJson(a.identity).localeCompare(canonicalJson(b.identity)));
        return {argument:entries.map(entry=>entry.argument),identity:entries.map(entry=>entry.identity)};
      }
      const entries=Object.entries(value).map(([key,entry])=>[key,argumentsFor(entry,key)]);
      return {argument:Object.fromEntries(entries.map(([key,entry])=>[key,entry.argument])),
        identity:Object.fromEntries(entries.map(([key,entry])=>[key,entry.identity]))};
    }
    return {normalized,refs,semanticRequest:argumentsFor(request).argument};
  }
  async function encode(context,result,request) {
    const contracts={},related=[],refs=[];let projectionRole='RESULT';
    async function visit(value) {
      if(core.isReference(value)) {
        const source=core.validateReferences(context,[value])[0];
        if(!DERIVED_TABLES.includes(source.type))invalid();
        const info=(await client.execute(`PRAGMA table_info(${source.type})`)).rows;
        if(!same(Object.keys(source.row).sort(),info.map(column=>column.name).sort()))unavailable();
        contracts[source.type]=info.map(column=>({name:column.name,type:column.type,notnull:column.notnull,pk:column.pk}));
        const key=Object.fromEntries(info.filter(column=>column.pk&&!['user_id','execution_mode'].includes(column.name))
          .map(column=>[column.name,source.row[column.name]]));
        related.push({type:source.type,id:source.id,mode:source.mode,key,row:{...source.row},projection_role:projectionRole});refs.push(value);
        return {$operation_reference:{type:source.type,id:source.id,mode:source.mode,key,row:{...source.row}}};
      }
      if(value===undefined)invalid();
      if(value===null||typeof value!=='object')return value;
      if(Array.isArray(value)){const list=[];for(const entry of value)list.push(await visit(entry));return list;}
      // Body Energy's retained API intentionally has no current-source ref.
      // Register its complete row without adding a capability to that return.
      if(value.row&&!value.ref&&(value.row.result_id||value.row.checkpoint_id)) {
        const table=value.row.checkpoint_id?'body_energy_checkpoints':'body_energy_results';
        await visit(core.reference(context,table,value.row.privacy_artifact_id,context.executionMode,value.row));
      }
      const episodeRow=value.episode_id&&value.state&&Number.isSafeInteger(value.revision);
      const entries=[];for(const [key,entry] of Object.entries(value))entries.push([key,episodeRow&&episodeDelivery.has(key)?null:await visit(entry)]);
      return Object.fromEntries(entries);
    }
    const tree=await visit(result),episodes=new Map(),insights=new Map();
    for(const target of related) {
      if(target.row.episode_id)episodes.set(target.row.episode_id,target.row.revision??target.row.resulting_revision);
      if(target.type==='health_insights')insights.set(target.row.id,target.row.current_revision);
    }
    for(const episodeId of [request.episodeId,request.prior?.episodeId,result?.reversedEpisodeId,
      result?.row?.reverses_episode_id,result?.row?.reopens_episode_id].filter(Boolean))if(!episodes.has(episodeId)) {
      const row=(await client.execute({sql:'SELECT revision FROM observation_episodes WHERE user_id=? AND execution_mode=? AND episode_id=?',
        args:[context.userId,context.executionMode,episodeId]})).rows[0];
      if(row)episodes.set(episodeId,row.revision);
    }
    const attach=async(table,where,args)=>{
      const generation=(await client.execute(`PRAGMA table_info(${table})`)).rows.some(column=>column.name==='input_generation');
      const rows=(await client.execute({sql:`SELECT * FROM ${table} WHERE user_id=? AND execution_mode=? ${generation?'AND input_generation=?':''} AND ${where} LIMIT 1001`,
        args:[context.userId,context.executionMode,...(generation?[context.inputGeneration]:[]),...args]})).rows;
      if(rows.length>1000)fail('PHASE4_OPERATION_RESULT_BOUNDS_UNAVAILABLE');
      for(const row of rows)if(readableRow(row))await visit(core.reference(context,table,row.privacy_artifact_id,context.executionMode,row));
    };
    for(const [id,revision] of episodes) {
      if(!Number.isSafeInteger(revision))invalid();
      await attach('observation_episodes','episode_id=?',[id]);
      await attach('phase4_episode_revisions','episode_id=? AND revision=?',[id,revision]);
      for(const table of ['episode_events','episode_semantic_events'])await attach(table,'episode_id=? AND resulting_revision=?',[id,revision]);
      await attach('episode_evidence','episode_id=? AND episode_revision=?',[id,revision]);
      if(request.currentSource) {
        const source=core.validateReferences(context,[request.currentSource])[0];
        await attach('episode_observations','episode_id=? AND source_type=? AND source_id=?',[id,source.type,source.id]);
      }
    }
    for(const [id,revision] of insights)await attach('insight_revisions','insight_id=? AND revision=?',[id,revision]);
    for(const target of [...related].filter(target=>target.type==='evidence_items'))await attach('phase4_evidence_result_authorities',
      'evidence_item_id=?',[target.row.evidence_item_id]);
    const encoded={result:tree,contracts,related:ordered(related),refs,includeDependencies:async dependencies=>{
      projectionRole='DEPENDENCY';
      for(const source of core.validateReferences(context,dependencies))if(['evidence_items','body_energy_results'].includes(source.type)) {
        await visit(core.reference(context,source.type,source.id,source.mode,source.row));
        if(source.type==='evidence_items')await visit((await core.artifact(context,'evidence_runs',{run_id:source.row.run_id})).ref);
      }
      encoded.related=ordered(related);
    }};
    return encoded;
  }
  async function dependencyRefs(context,refs,request) {
    const selected=[],evidenceIds=new Set();
    const addRequest=value=>{
      if(!value||typeof value!=='object'||core.isReference(value))return;
      for(const [key,entry] of Object.entries(value)) {
        if(key==='evidenceItemId'&&typeof entry==='string')evidenceIds.add(entry);
        else if(['supportingEvidenceIds','contradictingEvidenceIds'].includes(key)&&Array.isArray(entry))for(const id of entry)evidenceIds.add(id);
        else addRequest(entry);
      }
    };
    addRequest(request);
    for(const [index,source] of core.validateReferences(context,refs).entries()) {
      if(source.mode==='SHARED'||['evidence_items','body_energy_results'].includes(source.type))selected.push(refs[index]);
      if(source.type==='observation_episodes') {
        selected.push(...await authorities.episodeDependencies(context,source.row));
      } else if(source.type==='health_insights'||source.type==='insight_revisions') {
        const revisions=source.type==='insight_revisions'?[source.row]:(await client.execute({sql:`SELECT * FROM insight_revisions
          WHERE user_id=? AND execution_mode=? AND insight_id=? AND revision<=? AND input_generation=?`,
          args:[context.userId,context.executionMode,source.row.id,source.row.current_revision,context.inputGeneration]})).rows;
        for(const revision of revisions)for(const field of ['supporting_evidence_ids_json','contradicting_evidence_ids_json'])
          for(const id of parse(revision[field]))evidenceIds.add(id);
      } else if(source.type==='episode_events') {
        for(const [type,id] of parse(source.row.evidence_references_json)) {
          if(type==='evidence_items')evidenceIds.add(id);
          else selected.push((await core.root(context,type,id)).ref);
        }
      }
    }
    for(const id of evidenceIds)selected.push((await core.artifact(context,'evidence_items',{evidence_item_id:id})).ref);
    if(!selected.length)selected.push((await core.root(context,'USER',context.userId)).ref);
    return selected;
  }
  function authenticate(context,row) {
    if(!readableRow(row))fail('CONTENT_REDACTED');
    if(row.user_id!==context.userId||row.execution_mode!==context.executionMode||row.execution_mode!=='SHADOW'
      ||row.receipt_version!==VERSION||row.privacy_artifact_id!==identity(context,row.operation_kind,row.operation_key)
      ||seal(row)!==row.receipt_hmac)invalid();
    const decoded={};for(const field of ['request_json','result_json','related_results_json','required_roots_json','schema_contract_json']) {
      decoded[field]=parse(row[field]);if(canonicalJson(decoded[field])!==row[field])invalid();
    }
    const request=decoded.request_json;
    if(request.version!=='stage5-semantic-request-v1'||request.operation_kind!==row.operation_kind
      ||request.scope?.user_id!==row.user_id||request.scope?.execution_mode!==row.execution_mode
      ||!same(request.scope.generations,[row.input_generation,row.lifecycle_generation,row.auth_generation,row.purge_generation])
      ||keyForEnvelope(request)!==row.operation_key)invalid();
    return decoded;
  }
  async function read(context,row,{retainedBody=false}={}) {
    const decoded=authenticate(context,row);
    if(retainedBody&&!row.operation_kind.startsWith('BODY_ENERGY_'))invalid();
    if(!retainedBody&&decoded.request_json.scope.timezone!==context.timezone)fail('PHASE4_TIMEZONE_FENCED');
    if(!retainedBody&&decoded.request_json.scope.algorithm_set_version!==context.algorithmSetVersion)fail('PHASE4_INPUT_FENCED');
    for(const [field,value] of [['input_generation',context.inputGeneration],['lifecycle_generation',context.lifecycleGeneration],
      ['auth_generation',context.authGeneration],['purge_generation',context.purgeGeneration]])if(!retainedBody&&row[field]!==value)fail('PHASE4_PARENT_STALE');
    for(const [table,contract] of Object.entries(decoded.schema_contract_json)) {
      if(!DERIVED_TABLES.includes(table))invalid();
      const info=(await client.execute(`PRAGMA table_info(${table})`)).rows
        .map(column=>({name:column.name,type:column.type,notnull:column.notnull,pk:column.pk}));
      if(!same(info,contract))unavailable();
    }
    if(retainedBody) {
      // Retained Body manifests own historical measurements. Current root
      // existence/privacy remains mandatory, but corrections may change values.
      for(const root of decoded.required_roots_json.roots) {
        if(root.type==='body_energy_results'&&decoded.related_results_json.some(target=>target.type===root.type&&target.id===root.id))continue;
        if(!['sleep','recovery','cycle','workout','USER'].includes(root.type))invalid();
        await core.root(context,root.type,root.id);
      }
    } else await authorities.validateRoots(context,row,decoded.required_roots_json);
    for(const root of decoded.required_roots_json.roots)if(root.type==='evidence_items') {
      const item=(await client.execute({sql:'SELECT evidence_item_id,run_id FROM evidence_items WHERE user_id=? AND execution_mode=? AND privacy_artifact_id=?',
        args:[context.userId,context.executionMode,root.id]})).rows[0];
      if(!item)unavailable();
      const run=(await client.execute({sql:'SELECT * FROM evidence_runs WHERE user_id=? AND execution_mode=? AND run_id=?',
        args:[context.userId,context.executionMode,item.run_id]})).rows[0];
      if(!run)unavailable();
      await authorities.descriptorsForRun(context,run);
      await authorities.validateExisting(context,item.evidence_item_id,{required:parse(run.input_manifest_json).manifest_version.endsWith('-v2')});
    }
    for(const target of decoded.related_results_json) {
      const contract=decoded.schema_contract_json[target.type];
      if(!contract||!same(Object.keys(target.key).sort(),contract.filter(c=>c.pk&&!['user_id','execution_mode'].includes(c.name)).map(c=>c.name).sort()))invalid();
      const names=Object.keys(target.key),current=(await client.execute({sql:`SELECT * FROM ${target.type} WHERE user_id=? AND execution_mode=?
        AND ${names.map(name=>`${name}=?`).join(' AND ')}`,args:[context.userId,context.executionMode,...names.map(name=>target.key[name])]})).rows[0];
      if(!readableRow(current))fail(current?'CONTENT_REDACTED':'PHASE4_OPERATION_RESULT_UNAVAILABLE');
      if(current.privacy_artifact_id!==target.id)invalid();
      for(const field of ['input_generation','lifecycle_generation','auth_generation'])if(Object.hasOwn(current,field)&&current[field]!==target.row[field])
        fail('PHASE4_PARENT_STALE');
      const projection=value=>retainedBody&&target.type==='body_energy_results'
        ?Object.fromEntries(Object.entries(value).filter(([key])=>!['invalidated_at','invalidation_reason'].includes(key))):{...value};
      if(!['health_insights','observation_episodes'].includes(target.type)&&!same(projection(current),projection(target.row)))invalid();
      if(target.type==='phase4_episode_revisions') {
        const snapshot=parse(target.row.snapshot_json),bindings=[
          ['phase4_episode_revisions',target.id,'episode_events',snapshot.event.privacy_artifact_id,context.executionMode],
          ['phase4_episode_revisions',target.id,'observation_episodes',snapshot.episode.privacy_artifact_id,context.executionMode]];
        for(const [type,id] of parse(snapshot.event.evidence_references_json)) {
          let parent=id;
          if(type==='evidence_items') {
            const evidence=(await client.execute({sql:'SELECT privacy_artifact_id FROM evidence_items WHERE user_id=? AND execution_mode=? AND evidence_item_id=?',
              args:[context.userId,context.executionMode,id]})).rows[0];
            if(!evidence)unavailable();parent=evidence.privacy_artifact_id;
          }
          bindings.push(['episode_events',snapshot.event.privacy_artifact_id,type,parent,DERIVED_TABLES.includes(type)?context.executionMode:'SHARED']);
        }
        for(const [type,id,parentType,parentId,parentMode] of bindings) {
          const links=(await client.execute({sql:`SELECT 1 FROM phase4_source_links WHERE user_id=? AND artifact_execution_mode=?
            AND artifact_type=? AND artifact_id=? AND source_execution_mode=? AND source_type=? AND source_id=? AND unlinked_at IS NULL`,
            args:[context.userId,context.executionMode,type,id,parentMode,parentType,parentId]})).rows;
          if(links.length!==1)unavailable();
        }
      }
    }
    async function restore(value) {
      if(value===null||typeof value!=='object')return value;
      if(value.$operation_reference) {
        const ref=value.$operation_reference;
        if(!decoded.related_results_json.some(target=>target.type===ref.type&&target.id===ref.id&&same(target.key,ref.key)))invalid();
        return core.reference(context,ref.type,ref.id,ref.mode,ref.row);
      }
      if(Array.isArray(value)){const list=[];for(const entry of value)list.push(await restore(entry));return list;}
      const operational=operationResult(value),entries=[];
      for(const [key,entry] of Object.entries(value))entries.push([key,operational&&key==='created'?false:operational&&key==='replayed'?true:await restore(entry)]);
      return Object.fromEntries(entries);
    }
    return restore(decoded.result_json);
  }
  async function forArtifact(context,table,key,{episodeId=null,revision=null,expectedRevision=null,verifyOnly=false,retainedBody=false}={}) {
    return core.run(context,async()=>{
      if(episodeId===null&&!retainedBody)await core.artifact(context,table,key);
      const rows=(await client.execute({sql:`SELECT * FROM ${TABLE} WHERE user_id=? AND execution_mode=? ${retainedBody?"AND operation_kind LIKE 'BODY_ENERGY_%'":'AND input_generation=?'}
        ORDER BY created_at DESC,operation_key LIMIT 1001`,args:[context.userId,context.executionMode,...(retainedBody?[]:[context.inputGeneration])]})).rows;
      if(rows.length>1000)fail('PHASE4_OPERATION_RESULT_BOUNDS_UNAVAILABLE');
      for(const row of rows) {
        if(!readableRow(row))continue;
        const decoded=authenticate(context,row);
        const matches=value=>value&&typeof value==='object'&&value.$operation_reference
          &&(episodeId!==null?['observation_episodes','episode_events'].includes(value.$operation_reference.type)
            &&value.$operation_reference.row.episode_id===episodeId
            &&(value.$operation_reference.row.revision??value.$operation_reference.row.resulting_revision)===revision
            :value.$operation_reference.type===table&&same(value.$operation_reference.key,key)
            &&(expectedRevision===null||value.$operation_reference.row.current_revision===expectedRevision));
        function find(value) {
          if(value===null||typeof value!=='object')return null;
          if(matches(value.ref))return value;
          for(const entry of Object.values(value)){const found=find(entry);if(found)return found;}
          return null;
        }
        let candidate=find(decoded.result_json);
        if(!candidate&&episodeId===null) {
          const target=decoded.related_results_json.find(target=>target.projection_role!=='DEPENDENCY'&&target.type===table&&same(target.key,key)
            &&(expectedRevision===null||target.row.current_revision===expectedRevision));
          if(target)candidate={row:target.row,ref:{$operation_reference:{...target}}};
        }
        if(!candidate)continue;
        await read(context,row,{retainedBody});
        if(verifyOnly)return Object.freeze({operationKind:row.operation_kind});
        // Restore only the sealed artifact, never current semantic columns.
        const ref=candidate.ref.$operation_reference;
        return {...structuredClone(candidate),ref:core.reference(context,ref.type,ref.id,ref.mode,ref.row)};
      }
      fail('PHASE4_OPERATION_RESULT_UNAVAILABLE_MISSING_RECEIPT');
    });
  }
  async function predecessor(context,table,id,expectedRevision) {
    const episode=table==='observation_episodes',column=episode?'episode_id':'id';
    const row=(await client.execute({sql:`SELECT * FROM ${table} WHERE user_id=? AND execution_mode=? AND ${column}=?`,
      args:[context.userId,context.executionMode,id]})).rows[0];
    if(!row)fail('PHASE4_PARENT_NOT_FOUND');if(!readableRow(row))fail('CONTENT_REDACTED');
    if((episode?row.revision:row.current_revision)!==expectedRevision)return; // The operation's CAS supplies the public error.
    if(episode) {
      const snapshot=(await client.execute({sql:`SELECT * FROM phase4_episode_revisions WHERE user_id=? AND execution_mode=?
        AND episode_id=? AND revision=?`,args:[context.userId,context.executionMode,id,expectedRevision]})).rows[0];
      if(!snapshot)unavailable();if(!readableRow(snapshot))fail('CONTENT_REDACTED');
      const value=parse(snapshot.snapshot_json);
      if(keys.digest(snapshot.content_digest_salt,snapshot.snapshot_json)!==snapshot.snapshot_hash
        ||!same(value.episode,episodeSemanticProjection(row)))invalid();
      return;
    }
    const receipts=(await client.execute({sql:`SELECT * FROM ${TABLE} WHERE user_id=? AND execution_mode=?
      AND content_state='PRESENT' ORDER BY operation_key LIMIT 1001`,args:[context.userId,context.executionMode]})).rows;
    if(receipts.length>1000)fail('PHASE4_OPERATION_RESULT_BOUNDS_UNAVAILABLE');
    const operational=new Set(['created_at','updated_at','content_digest_salt','content_state','source_linkage_state',
      'health_content_redacted_at','health_content_redaction_reason','source_subject_deleted_at']);
    const semantic=value=>Object.fromEntries(Object.entries(value).filter(([key])=>!operational.has(key)));
    for(const receipt of receipts) {
      const decoded=authenticate(context,receipt);
      const prior=decoded.related_results_json.find(target=>target.type===table&&target.row.id===id&&target.row.current_revision===expectedRevision);
      if(prior) {
        if(!same(semantic(prior.row),semantic(row)))invalid();
        // A producer may still be assembling the parent v26 origin. Validate
        // its complete sealed dependency chain at the same commit boundary.
        if(producerScope.getStore()?.context===context)
          await core.transaction(async()=>{}, {after:()=>read(context,receipt)});
        else await read(context,receipt);
        return;
      }
    }
    unavailable();
  }
  // This callback is wired only to the internal deterministic producers. A
  // request cannot mint a ticket, and an existing/replayed row never gets one.
  function producedEvidence(context,{run,item}) {
    const scope=producerScope.getStore();
    if(!scope||scope.context!==context||!core.processing.active()||!item.created)invalid();
    scope.evidence.set(item.row.evidence_item_id,{item:canonicalJson(item.row),run:canonicalJson(run.row),checked:false});
  }
  async function admitInputs(context,request,refs) {
    const ids=new Set(),derived=[];
    function collect(value) {
      if(!value||typeof value!=='object'||core.isReference(value))return;
      for(const [key,entry] of Object.entries(value)) {
        if(['evidenceItemId','latest_evidence_item_id','explanation_evidence_item_id'].includes(key)&&entry!==null)ids.add(entry);
        else if(['supportingEvidenceIds','contradictingEvidenceIds'].includes(key)&&Array.isArray(entry))entry.forEach(id=>ids.add(id));
        else collect(entry);
      }
    }
    collect(request);
    for(const source of core.validateReferences(context,refs)) {
      if(source.type==='evidence_items')ids.add(source.row.evidence_item_id);
      else if(source.mode!=='SHARED')derived.push(source);
    }
    for(const id of ids) {
      const ticket=producerScope.getStore()?.context===context?producerScope.getStore().evidence.get(id):null;
      if(!ticket) {await forArtifact(context,'evidence_items',{evidence_item_id:id});continue;}
      const intact=async()=>{
        const item=await core.artifact(context,'evidence_items',{evidence_item_id:id});
        const run=await core.artifact(context,'evidence_runs',{run_id:item.row.run_id});
        if(canonicalJson(item.row)!==ticket.item||canonicalJson(run.row)!==ticket.run)invalid();
      };
      await intact();
      if(!ticket.checked) {
        ticket.checked=true;
        await core.transaction(async()=>{}, {after:async()=>{
          await intact();await forArtifact(context,'evidence_items',{evidence_item_id:id});
        }});
      }
    }
    for(const source of derived) {
      const columns=(await client.execute(`PRAGMA table_info(${source.type})`)).rows;
      const key=Object.fromEntries(columns.filter(column=>column.pk&&!['user_id','execution_mode'].includes(column.name))
        .map(column=>[column.name,source.row[column.name]]));
      const options=source.type==='health_insights'?{expectedRevision:source.row.current_revision}
        :source.type==='observation_episodes'?{episodeId:source.row.episode_id,revision:source.row.revision,verifyOnly:true}:{};
      await forArtifact(context,source.type,key,options);
    }
  }
  async function execute(context,kind,request,perform,{discover=null}={}) {
    return core.run(context,async()=>{
      if(context.executionMode!=='SHADOW')fail('PHASE4_INTELLIGENCE_SHADOW_ONLY');
      const {normalized,refs,semanticRequest}=await prepare(context,request,kind);
      const epoch=normalized.asOfEpochMs??(Number.isSafeInteger(normalized.bucketStart)?normalized.bucketStart+15*60000:null);
      if(epoch!==null&&epoch!==undefined&&!Number.isSafeInteger(epoch))fail('PHASE4_SEMANTIC_TIME_INVALID');
      const at=requireChronology(semanticTime(normalized.asOfUtc??normalized.semanticAt??(epoch==null?null:new Date(epoch).toISOString())),null,core.now());
      const requestAuthority=requestEnvelope(context,kind,normalized),key=keyForEnvelope(requestAuthority);
      const prior=(await client.execute({sql:`SELECT * FROM ${TABLE} WHERE user_id=? AND execution_mode=? AND operation_kind=? AND operation_key=?`,
        args:[context.userId,context.executionMode,kind,key]})).rows[0];
      if(prior)return read(context,prior);
      if(discover)await discover(context,kind,normalized);
      await admitInputs(context,semanticRequest,refs);
      if(kind==='INSIGHT_CREATE') {
        const id=keys.lookup(['insight-creation-v1',context.userId,context.executionMode,request.creationKey]);
        if((await client.execute({sql:'SELECT 1 FROM health_insights WHERE user_id=? AND execution_mode=? AND privacy_artifact_id=?',
          args:[context.userId,context.executionMode,id]})).rows.length)unavailable();
      }
      if(kind==='INSIGHT_TRANSITION')await predecessor(context,'health_insights',request.insightId,request.expectedRevision);
      if(kind==='EPISODE_OPEN')for(const id of [request.reopensEpisodeId,request.reversesEpisodeId].filter(Boolean)) {
        const prior=await core.artifact(context,'observation_episodes',{episode_id:id});
        await predecessor(context,'observation_episodes',id,prior.row.revision);
      }
      if(['EPISODE_REVISE','EPISODE_REFRESH'].includes(kind))await predecessor(context,'observation_episodes',request.episodeId,request.expectedRevision);
      if(kind==='EPISODE_REVERSE')await predecessor(context,'observation_episodes',request.prior.episodeId,request.prior.expectedRevision);
      const result=['analyzeMetric','analyzeAssociationFamily'].includes(kind)
        ?await producerScope.run({context,evidence:new Map()},()=>perform(semanticRequest)):await perform(semanticRequest);
      const encoded=await encode(context,result,semanticRequest);
      const envelope=core.envelope(context,TABLE,[kind,key]);
      const dependencies=await dependencyRefs(context,[...refs,...encoded.refs],semanticRequest);
      await encoded.includeDependencies(dependencies);
      const roots=await authorities.captureRoots(context,dependencies,envelope.content_digest_salt);
      const row={...envelope,operation_kind:kind,operation_key:key,receipt_version:VERSION,semantic_at:at,
        request_json:canonicalJson(requestAuthority),result_json:canonicalJson(encoded.result),related_results_json:canonicalJson(encoded.related),
        required_roots_json:canonicalJson(roots),schema_contract_json:canonicalJson(encoded.contracts),
        input_generation:context.inputGeneration,lifecycle_generation:context.lifecycleGeneration,auth_generation:context.authGeneration,
        created_at:core.timestamp()};
      for(const field of ['request_json','result_json','related_results_json','required_roots_json','schema_contract_json'])
        if(Buffer.byteLength(row[field])>4194304)fail('PHASE4_OPERATION_RESULT_BOUNDS_UNAVAILABLE');
      row.receipt_hmac=seal(row);
      const fields=Object.keys(row);
      await client.execute({sql:`INSERT INTO ${TABLE}(${fields.join(',')}) VALUES (${fields.map(()=>'?').join(',')})`,args:fields.map(field=>row[field])});
      for(const root of roots.roots)await addPrivacyLink(client,{userId:context.userId,mode:context.executionMode,table:TABLE,
        artifactId:row.privacy_artifact_id,sourceMode:root.mode,sourceType:root.type,sourceId:root.id,
        relationship:root.as_of?`DEPENDS_ON_AS_OF:${root.as_of}`:'DEPENDS_ON',at:core.timestamp()});
      return result;
    });
  }
  const api=Object.freeze({execute,read,prepare,authenticate,forArtifact,producedEvidence});instances.set(core,api);return api;
}
