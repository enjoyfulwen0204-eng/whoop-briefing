import { compareExact } from './phase4CanonicalOrder.js';
import { isRequestSet, isRequestTime, isJournalRequestSet, normalizeRequestAliases, requestEvidenceIds } from './phase4RequestContract.js';
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
import { insightIdentityKey } from './phase4InsightStore.js';
import { RESULT_AUTHORITY_TABLE } from './phase4V26Schema.js';
import { OPERATION_RECEIPT_TABLE as TABLE, OPERATION_RECEIPT_VERSION as VERSION } from './phase4V27Schema.js';

const instances=new WeakMap();
const invalid=()=>fail('PHASE4_OPERATION_RECEIPT_INTEGRITY');
const unavailable=()=>fail('PHASE4_OPERATION_RESULT_UNAVAILABLE');
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const parse=value=>{try{return JSON.parse(value);}catch{invalid();}};
const INSIGHT_NORMALIZATION='domain-insight-identity-once-v1';
// Literal property names cannot impersonate a nested field or array wildcard.
const requestPath=(path,name)=>(path?`${path}/`:'')+name.replaceAll('~','~0').replaceAll('/','~1').replaceAll('*','~2');
const episodeDelivery=new Set(['last_question_id','last_delivered_notification_id','last_ambiguous_attempt_id']);
const operationResult=value=>Boolean(value.row?.privacy_artifact_id||value.run?.row?.run_id
  ||value.episode?.row?.episode_id||value.result?.row?.result_id||value.eventId
  ||value.item?.row?.evidence_item_id&&value.analysis||Array.isArray(value.items)&&Array.isArray(value.runs));
const fences=context=>[context.inputGeneration,context.lifecycleGeneration,context.authGeneration,context.purgeGeneration];
const ordered=values=>[...new Map(values.map(value=>[canonicalJson(value),value])).values()]
  .sort((a,b)=>compareExact(canonicalJson(a),canonicalJson(b)));
export const INSIGHT_DISCOVERY_BUDGET=Object.freeze({insights:1000,revisions:1000,receipts:1000,authorities:1000,bytes:64*1024*1024});

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
      ...(kind==='INSIGHT_CREATE'?{insight_identity:INSIGHT_NORMALIZATION}:{}),
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
    const domainIdentity=kind==='INSIGHT_CREATE'?{...request.identity}:null;
    if(domainIdentity)request={...request,identity:domainIdentity};
    request=normalizeRequestAliases(kind,request);
    const refs=[],referenceIdentities=new WeakMap(),asOf=request?.asOfUtc??request?.semanticAt;
    async function visit(value,path='') {
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
      if(value===null||typeof value!=='object')return isRequestTime(kind,path)&&value!==null&&value!==undefined?canonicalInstant(value):value;
      if(Array.isArray(value)) {
        let values=[];for(const entry of value)values.push(await visit(entry,`${path}/*`));
        if(isJournalRequestSet(kind,path))values=values.filter(entry=>!entry?.absent_as_of);
        if(isRequestSet(kind,path)) {
          const unique=ordered(values);
          if(unique.length!==values.length)fail('PHASE4_SEMANTIC_SOURCE_DUPLICATE');
          return unique;
        }
        return values;
      }
      const entries=[];for(const [name,entry] of Object.entries(value))entries.push([name,await visit(entry,requestPath(path,name))]);
      return Object.fromEntries(entries);
    }
    const normalized=await visit(request);
    // Current and baseline cannot be separately branded aliases of one source.
    if(normalized.currentSource&&normalized.baselineSources?.some(value=>same(value,normalized.currentSource)))
      fail('PHASE4_SEMANTIC_SOURCE_DUPLICATE');
    function argumentsFor(value,path='') {
      if(core.isReference(value))return {argument:value,identity:referenceIdentities.get(value)??{source_type:value.type,source_id:value.id}};
      if(value===null||typeof value!=='object') {
        const result=isRequestTime(kind,path)&&value!==null&&value!==undefined?canonicalInstant(value):value;
        return {argument:result,identity:result};
      }
      if(Array.isArray(value)) {
        let entries=value.map(entry=>argumentsFor(entry,`${path}/*`));
        if(isJournalRequestSet(kind,path))entries=entries.filter(entry=>!entry.identity?.absent_as_of);
        if(isRequestSet(kind,path))entries.sort((a,b)=>compareExact(canonicalJson(a.identity),canonicalJson(b.identity)));
        return {argument:entries.map(entry=>entry.argument),identity:entries.map(entry=>entry.identity)};
      }
      const entries=Object.entries(value).map(([key,entry])=>[key,argumentsFor(entry,requestPath(path,key))]);
      return {argument:Object.fromEntries(entries.map(([key,entry])=>[key,entry.argument])),
        identity:Object.fromEntries(entries.map(([key,entry])=>[key,entry.identity]))};
    }
    const semanticRequest=argumentsFor(request).argument;
    // The domain and receipt each apply the same identity normalizer once to
    // captured input. NFC followed by lowercase is not always idempotent;
    // feeding its output through the domain again would change legacy keys.
    if(domainIdentity)semanticRequest.identity=domainIdentity;
    return {normalized,refs,semanticRequest};
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
  async function dependencyRefs(context,refs,request,kind) {
    const selected=[],evidenceIds=new Set(requestEvidenceIds(kind,request));
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
  async function forArtifact(context,table,key,{episodeId=null,revision=null,expectedRevision=null,verifyOnly=false,retainedBody=false,deferValidation=false}={}) {
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
        if(deferValidation&&producerScope.getStore()?.context===context)
          await core.transaction(async()=>{}, {after:()=>read(context,row,{retainedBody})});
        else await read(context,row,{retainedBody});
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
    if(!episode)await resolveInsightLifecycle(context,{insightId:id});
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
  // Incarnation chronology is historical authority, not a current-row hint.
  // The typed receipt reader authenticates the complete sealed projection,
  // immutable revision and dependency/privacy chain before exposing its time.
  async function terminalInsightPredecessor(context,id,insightKey,at) {
    const sealed=await resolveInsightLifecycle(context,{insightId:id});
    validateTerminal(sealed.row,sealed.revision,insightKey,at);
  }
  function validateTerminal(row,revision,insightKey,at) {
    const id=row.id;
    if(row.status!=='RETIRED'||!row.lifecycle_disposition||row.insight_key!==insightKey
      ||row.legacy_classification!=='PHASE4'||!revision||revision.insight_id!==id
      ||revision.revision!==row.current_revision||revision.status!==row.status
      ||revision.lifecycle_disposition!==row.lifecycle_disposition)fail('PHASE4_INSIGHT_INCARNATION_INVALID');
    const retired=semanticTime(row.retired_at);
    if(retired!==semanticTime(row.last_recalculated_at))invalid();
    requireChronology(retired,semanticTime(row.first_detected_at),core.now());
    requireChronology(at,retired,core.now());
  }
  // Absence is established by a complete bounded inventory, never by a
  // materialized logical-key/status/generation selector. Signed projections
  // identify incarnations; signed linkage distinguishes ancestors from tips.
  async function resolveInsightLifecycle(context,{insightKey=null,insightId=null,matchLookup=false}={}) {
    return core.run(context,async()=>{
      const scope=[context.userId,context.executionMode];
      const parents=(await client.execute({sql:`SELECT id FROM health_insights WHERE user_id=? AND execution_mode=?
      ORDER BY id LIMIT ?`,args:[...scope,INSIGHT_DISCOVERY_BUDGET.insights+1]})).rows;
      const receipts=(await client.execute({sql:`SELECT * FROM ${TABLE} WHERE user_id=? AND execution_mode=?
      ORDER BY operation_kind,operation_key LIMIT ?`,args:[...scope,INSIGHT_DISCOVERY_BUDGET.receipts+1]})).rows;
      const revisionInventory=(await client.execute({sql:`SELECT insight_id,revision FROM insight_revisions WHERE user_id=? AND execution_mode=?
      ORDER BY insight_id,revision LIMIT ?`,args:[...scope,INSIGHT_DISCOVERY_BUDGET.revisions+1]})).rows;
      const origins=(await client.execute({sql:`SELECT * FROM ${RESULT_AUTHORITY_TABLE} WHERE user_id=? AND execution_mode=?
      ORDER BY evidence_item_id,result_scope LIMIT ?`,args:[...scope,INSIGHT_DISCOVERY_BUDGET.authorities+1]})).rows;
      if(parents.length>INSIGHT_DISCOVERY_BUDGET.insights||receipts.length>INSIGHT_DISCOVERY_BUDGET.receipts
        ||revisionInventory.length>INSIGHT_DISCOVERY_BUDGET.revisions||origins.length>INSIGHT_DISCOVERY_BUDGET.authorities)
        fail('PHASE4_INSIGHT_DISCOVERY_BOUNDS_UNAVAILABLE');
      const histories=new Map(),revisionAuthorities=new Map();let bytes=0;
      for(const receipt of receipts) {
        bytes+=['request_json','result_json','related_results_json','required_roots_json','schema_contract_json']
          .reduce((sum,key)=>sum+Buffer.byteLength(receipt[key]??''),0);
        if(bytes>INSIGHT_DISCOVERY_BUDGET.bytes)fail('PHASE4_INSIGHT_DISCOVERY_BOUNDS_UNAVAILABLE');
        const decoded=authenticate(context,receipt);
        for(const target of decoded.related_results_json)if(target.type==='insight_revisions') {
          const key=canonicalJson([target.row.insight_id,target.row.revision]),prior=revisionAuthorities.get(key);
          if(prior&&!same(prior,target.row))invalid();
          revisionAuthorities.set(key,target.row);
        }
        for(const target of decoded.related_results_json)if(target.type==='health_insights') {
          const row=target.row;
          if(!Number.isSafeInteger(row?.id)||!Number.isSafeInteger(row.current_revision)||row.current_revision<1
            ||typeof row.insight_key!=='string'||!same(target.key,{id:row.id})||target.id!==row.privacy_artifact_id)invalid();
          let history=histories.get(row.id);
          if(!history){history=new Map();histories.set(row.id,history);}
          if(histories.size>INSIGHT_DISCOVERY_BUDGET.insights)fail('PHASE4_INSIGHT_DISCOVERY_BOUNDS_UNAVAILABLE');
          const prior=history.get(row.current_revision);
          if(prior&&!same(prior.row,row))invalid();
          history.set(row.current_revision,{row,receipt});
        }
      }
      // A retained parent without signed identity could belong to the requested
      // family. Missing/legacy/redacted history cannot certify its absence.
      for(const parent of parents)if(!histories.has(parent.id))unavailable();
      for(const revision of revisionInventory)if(!histories.has(revision.insight_id)
        ||!revisionAuthorities.has(canonicalJson([revision.insight_id,revision.revision])))unavailable();
      // A v26 origin can survive missing parent/v27 records. Authenticate it
      // before deciding whether it names an insight; a missing projection is
      // unavailable, never a new incarnation with an invented absence proof.
      for(const origin of origins) {
        bytes+=Buffer.byteLength(origin.original_result_json??'')+Buffer.byteLength(origin.required_roots_json??'');
        if(bytes>INSIGHT_DISCOVERY_BUDGET.bytes)fail('PHASE4_INSIGHT_DISCOVERY_BOUNDS_UNAVAILABLE');
        const item=(await client.execute({sql:'SELECT * FROM evidence_items WHERE user_id=? AND execution_mode=? AND evidence_item_id=?',
          args:[...scope,origin.evidence_item_id]})).rows[0];
        const run=(await client.execute({sql:'SELECT * FROM evidence_runs WHERE user_id=? AND execution_mode=? AND run_id=?',
          args:[...scope,origin.run_id]})).rows[0];
        const verified=authorities.authenticate(context,origin,item,run).origin;
        if(origin.result_scope!=='METRIC'&&verified!==null) {
          const revision=revisionAuthorities.get(canonicalJson([verified.insight_id,verified.revision]));
          if(!histories.has(verified.insight_id)||!revision)unavailable();
          if(canonicalJson(revision)!==verified.revision_json)invalid();
        }
      }
      if(insightId!==null) {
        if(!histories.has(insightId))unavailable();
        insightKey=[...histories.get(insightId).values()][0].row.insight_key;
      }
      // A wrong-family materialized hint remains an identity error (M008), but
      // only after its own latest authority/privacy chain has been validated.
      if(matchLookup) {
        const hints=(await client.execute({sql:`SELECT id FROM health_insights WHERE user_id=? AND execution_mode=? AND insight_key=?
          AND status<>'RETIRED' AND legacy_classification='PHASE4' LIMIT ?`,args:[...scope,insightKey,INSIGHT_DISCOVERY_BUDGET.insights+1]})).rows;
        for(const hint of hints) {
          const selected=await resolveInsightLifecycle(context,{insightId:hint.id});
          if(selected.row.insight_key!==insightKey)fail('PHASE4_INSIGHT_IDENTITY_MISMATCH');
        }
      }
      const candidates=new Map(),sealedCandidates=new Map();
      for(const [id,history] of histories) {
        const revisions=[...history.keys()].sort((a,b)=>a-b),latest=history.get(revisions.at(-1)),identity=latest.row;
        for(const {row} of history.values())if(row.insight_key!==identity.insight_key
          ||row.supersedes_id!==identity.supersedes_id||row.first_detected_at!==identity.first_detected_at)invalid();
        if(identity.insight_key!==insightKey)continue;
        // Every revision must have retained authority. The materialized pointer
        // cannot hide a later authenticated transition or a missing revision.
        if(revisions.length!==identity.current_revision||revisions.some((revision,index)=>revision!==index+1))unavailable();
        const current=await core.artifact(context,'health_insights',{id});
        if(['current_revision','status','lifecycle_disposition'].some(field=>current.row[field]!==identity[field]))invalid();
        const retained=(await client.execute({sql:`SELECT * FROM insight_revisions WHERE user_id=? AND execution_mode=?
          AND insight_id=? ORDER BY revision LIMIT ?`,args:[...scope,id,INSIGHT_DISCOVERY_BUDGET.receipts+1]})).rows;
        if(retained.length!==revisions.length)unavailable();
        for(const revision of retained) {
          if(!readableRow(revision))fail('CONTENT_REDACTED');
          if(!same(revisionAuthorities.get(canonicalJson([id,revision.revision])),revision))invalid();
        }
        const sealed=await forArtifact(context,'health_insights',{id},{expectedRevision:identity.current_revision,deferValidation:true});
        if(!same(sealed.row,identity))invalid();
        candidates.set(id,identity);sealedCandidates.set(id,sealed);
      }
      const consumed=new Set();
      for(const row of candidates.values())if(row.supersedes_id!==null) {
        const parent=candidates.get(row.supersedes_id);
        if(!parent||consumed.has(parent.id))fail('PHASE4_INSIGHT_PREDECESSOR_AMBIGUOUS');
        consumed.add(parent.id);
        validateTerminal(parent,sealedCandidates.get(parent.id).revision,insightKey,row.first_detected_at);
        const visited=new Set([row.id]);let ancestor=parent;
        while(ancestor) {
          if(visited.has(ancestor.id))invalid();visited.add(ancestor.id);
          ancestor=candidates.get(ancestor.supersedes_id);
        }
      }
      const tips=[...candidates.values()].filter(row=>!consumed.has(row.id));
      if(tips.length>1)fail('PHASE4_INSIGHT_PREDECESSOR_AMBIGUOUS');
      return sealedCandidates.get(insightId??tips[0]?.id)??null;
    });
  }
  async function discoverInsightPredecessor(context,insightKey,at,suppliedId=null) {
    const sealed=await resolveInsightLifecycle(context,{insightKey}),predecessor=sealed?.row;
    if(suppliedId!==null&&suppliedId!==predecessor?.id)fail('PHASE4_INSIGHT_INCARNATION_INVALID');
    if(predecessor)validateTerminal(predecessor,sealed.revision,insightKey,at);
    return predecessor?.id??null;
  }
  // This callback is wired only to the internal deterministic producers. A
  // request cannot mint a ticket, and an existing/replayed row never gets one.
  function producedEvidence(context,{run,item}) {
    const scope=producerScope.getStore();
    if(!scope||scope.context!==context||!core.processing.active()||!item.created)invalid();
    scope.evidence.set(item.row.evidence_item_id,{item:canonicalJson(item.row),run:canonicalJson(run.row),checked:false});
  }
  async function admitInputs(context,request,refs,kind) {
    const ids=new Set(requestEvidenceIds(kind,request)),derived=[];
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
      if(source.type==='health_insights') {
        const sealed=await resolveInsightLifecycle(context,{insightId:source.row.id});
        if(!same(sealed.row,source.row))invalid();
      } else await forArtifact(context,source.type,key,options);
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
      const historical=(await client.execute({sql:`SELECT * FROM ${TABLE} WHERE user_id=? AND execution_mode=?
        AND operation_kind=? AND input_generation=? ORDER BY operation_key LIMIT 1001`,
        args:[context.userId,context.executionMode,kind,context.inputGeneration]})).rows;
      if(historical.length>1000)fail('PHASE4_OPERATION_RESULT_BOUNDS_UNAVAILABLE');
      const equivalents=[];let historicalBytes=0;
      for(const receipt of historical) {
        historicalBytes+=Buffer.byteLength(receipt.request_json??'');
        if(historicalBytes>64*1024*1024)fail('PHASE4_OPERATION_RESULT_BOUNDS_UNAVAILABLE');
        const decoded=authenticate(context,receipt),old=decoded.request_json;
        const identityProfile=old.profiles?.insight_identity;
        if(kind==='INSIGHT_CREATE'&&identityProfile!==undefined&&identityProfile!==INSIGHT_NORMALIZATION)unavailable();
        const canonical=kind==='INSIGHT_CREATE'&&identityProfile===INSIGHT_NORMALIZATION
          ?old.request:(await prepare(context,old.request,kind)).normalized;
        const profiles={...old.profiles,...(kind==='INSIGHT_CREATE'?{insight_identity:INSIGHT_NORMALIZATION}:{})};
        if(same({...old,profiles,request:canonical},requestAuthority))equivalents.push(receipt);
      }
      if(equivalents.length>1)unavailable();
      if(equivalents.length)return read(context,equivalents[0]);
      if(discover)await discover(context,kind,normalized);
      await admitInputs(context,semanticRequest,refs,kind);
      if(kind==='INSIGHT_CREATE') {
        const id=keys.lookup(['insight-creation-v1',context.userId,context.executionMode,request.creationKey]);
        if((await client.execute({sql:'SELECT 1 FROM health_insights WHERE user_id=? AND execution_mode=? AND privacy_artifact_id=?',
          args:[context.userId,context.executionMode,id]})).rows.length)unavailable();
        semanticRequest.supersedesId=await discoverInsightPredecessor(context,
          insightIdentityKey(keys,context,semanticRequest.identity),at,semanticRequest.supersedesId);
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
      const dependencies=await dependencyRefs(context,[...refs,...encoded.refs],semanticRequest,kind);
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
  const api=Object.freeze({execute,read,prepare,authenticate,forArtifact,producedEvidence,terminalInsightPredecessor,discoverInsightPredecessor,resolveInsightLifecycle});instances.set(core,api);return api;
}
