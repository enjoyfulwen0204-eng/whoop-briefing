import {analysisTable} from './stage8LiveAllocation.js';
import {assertFreshContextAndWorkOwner} from './phase4ReadControls.js';
import { compareExact } from './phase4CanonicalOrder.js';
import { healthSourceVersion, canonicalSourceVersion, canonicalSourceTime } from './phase4SourceVersion.js';
import {fail,readableRow,RAW_SOURCE_READ_BATCH} from './phase4Core.js';
import { canonicalJson } from './phase4EntityStore.js';
import {addPrivacyLinks} from './phase4V22Backfill.js';
import { RESULT_AUTHORITY_TABLE as SHADOW_TABLE, RESULT_AUTHORITY_VERSION as VERSION, RESULT_ROOT_VERSION } from './phase4V26Schema.js';
import { createBodyEnergyStore,requireNewBodySourceCapture } from './bodyEnergyStore.js';
import {reservePilotMutation} from './betaPilotPermit.js';
import {pilotResultAuthorityFrom} from './betaPilotBoundedReads.js';
import {requireMetricUnitProof} from './phase4MetricUnitReceipt.js';
import {requireBodyMetricPreparationCapture,requireOwnedBodyMetricPurpose,currentOwnedBodyMetricObservation} from './phase4IntelligenceStore.js';
import {processingReadObservationEpoch} from './processingTransaction.js';
import {currentDurableExecution,assertExecutionWorkOwner,requireSettledOperation} from './phase4ExecutionContext.js';


const invalid=()=>fail('PHASE4_DURABLE_REPLAY_BINDING_INVALID');
const incomplete=()=>fail('PHASE4_REQUIRED_ROOT_AUTHORITY_INCOMPLETE');
const parse=value=>{try{return JSON.parse(value);}catch{invalid();}};
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const ordered=values=>[...new Map(values.map(v=>[canonicalJson(v),v])).values()]
  .sort((a,b)=>compareExact(canonicalJson(a),canonicalJson(b)));
const operational=new Set(['created_at','updated_at','completed_at','content_state','source_linkage_state',
  'health_content_redacted_at','health_content_redaction_reason','source_subject_deleted_at','purge_generation',
  'content_digest_salt','invalidated_at','fact_status','status','superseded_at','invalidation_reason','raw_json']);
const projection=row=>Object.fromEntries(Object.entries(row).filter(([k])=>!operational.has(k)));
const legacyHealthVersion=row=>canonicalJson([row.updated_at??null,row.synced_at??null,row.as_of_utc??null,row.score_state??null]);
const healthVersion=healthSourceVersion;
const NORMALIZED_ROOT_VERSION='stage5-required-roots-v2';
const BOUNDED_ROOT_VERSION='stage5-required-roots-v3';
export const REQUIRED_ROOT_BUDGET=Object.freeze({count:10000,bytes:1048576});
const NULL_PROJECTION_VERSION='stage5-null-metric-result-v2';
const PREPARATION_VERSION='stage6-metric-refresh-preparation-v1';
const rootProjection=(row,type,version)=>[NORMALIZED_ROOT_VERSION,BOUNDED_ROOT_VERSION].includes(version)&&['sleep','recovery','cycle','workout','body_energy_results'].includes(type)
  ?Object.fromEntries(Object.entries(projection(row)).map(([k,v])=>[k,k.endsWith('_at')||k==='as_of_utc'?canonicalSourceTime(v):v])):projection(row);

/** Only registered calculation inputs define completeness. source_links are
 * secondary indexes, never consulted to enumerate required semantic roots.
 * Derived inputs are flattened from their versioned calculation manifests. */
export function createResultAuthority(core) {
  const TABLE=analysisTable(core,SHADOW_TABLE);
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
      const raw=core.ownedBodyMetricRootData(context,entry.type,entry.id);
      return raw?{row:raw.row,ref:null}:core.root(context,entry.type,entry.id);
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
    if(['phase4-metric-evidence-input-v1','phase4-metric-evidence-input-v2'].includes(input?.manifest_version)) {
      if(!Array.isArray(input.quality?.provenance)||!input.quality.provenance.length)incomplete();
      for(const ref of input.quality.provenance) {
        if(!Array.isArray(ref)||ref.length!==3)incomplete();
        add(...ref);
      }
    } else if(['phase4-association-family-input-v1','phase4-association-family-input-v2'].includes(input?.manifest_version)) {
      if(!Array.isArray(input.hypotheses)||!input.hypotheses.length)incomplete();
      for(const hypothesis of input.hypotheses) {
        if(!Array.isArray(hypothesis.days)||!Array.isArray(hypothesis.journal_authority))incomplete();
        for(const day of hypothesis.days)if(day.outcomeSource)add(...day.outcomeSource);
        for(const ref of hypothesis.journal_authority)add(ref.type,ref.id,ref.revision,ref.asOfUtc);
      }
    } else incomplete();
    const metric=input.manifest_version.startsWith('phase4-metric-'),version=input.manifest_version.endsWith('-v2')?'v2':'v1';
    const inputHash=keys.lookup([metric?`phase4-evidence-input-${version}`:`phase4-association-input-${version}`,
      context.userId,context.executionMode,run.input_generation,canonicalJson(input)]);
    const runKey=keys.lookup([`phase4-evidence-run-${version}`,context.userId,context.executionMode,
      metric?'PERSONAL_BASELINE_DEVIATION':'JOURNAL_ASSOCIATION',
      ...(metric?[input.metric_key]:[input.multiple_testing_family,input.focus_key]),input.as_of_utc,run.input_generation,inputHash]);
    if(run.input_manifest_hash!==inputHash||run.deterministic_run_key!==runKey)invalid();
    if(!descriptors.length&&!metric&&version==='v2')add('USER',context.userId);
    return ordered(descriptors);
  }
  async function captureRoots(context,refs,salt,{parallelDerived=false}={}) {
    const inputs=await core.revalidateSources(context,refs),pending=inputs.map(source=>({type:source.type,id:source.id,
      mode:source.mode,as_of:source.historicalAsOf??null,version:null})),entries=new Map(),seen=new Set();
    const identityFor=descriptor=>canonicalJson([descriptor.mode,descriptor.type,descriptor.id,descriptor.as_of]);
    const captureOne=async descriptor=>{
      const identity=identityFor(descriptor);
      if(seen.has(identity)) {
        if(descriptor.version!==null&&canonicalSourceVersion(descriptor.version)!==entries.get(identity).version)
          fail('PHASE4_REQUIRED_ROOT_VERSION_MISMATCH');
        if(!descriptor.expected)return;
      }
      seen.add(identity);if(seen.size>REQUIRED_ROOT_BUDGET.count)fail('PHASE4_REQUIRED_ROOT_BOUNDS_UNAVAILABLE');
      const {row}=await resolve(context,descriptor);
      if(descriptor.expected)for(const [field,value] of Object.entries(descriptor.expected)) {
        const temporal=field.endsWith('_at')||field==='as_of_utc';
        if((temporal?canonicalSourceTime(row[field]??null):row[field]??null)
          !==(temporal?canonicalSourceTime(value):value))fail('PHASE4_REQUIRED_ROOT_VERSION_MISMATCH');
      }
      if(descriptor.version!==null) {
        const version=descriptor.as_of!==null?row.revision:healthVersion(row);
        if(version!==canonicalSourceVersion(descriptor.version))fail('PHASE4_REQUIRED_ROOT_VERSION_MISMATCH');
      }
      const {expected,...stable}=descriptor;
      entries.set(identity,{...stable,version:descriptor.as_of!==null?row.revision
        :['sleep','recovery','cycle','workout','body_energy_results'].includes(descriptor.type)?healthVersion(row):null,
      content_hash:hash(salt,'required-root-content-v1',rootProjection(row,descriptor.type,BOUNDED_ROOT_VERSION))});
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
        // These admitted workout rows are notification provenance only. They
        // never enter the calculator, but a Body source receipt must retain
        // the same complete closure that its audit/privacy projection names.
        for(const value of m.notification_workouts?.rows??[])add('workout',value);
        for(const value of m.exclusions)if(value.id!==null)pending.push({type:value.resource==='baseline'?'sleep':value.resource,
          id:value.id,mode:'SHARED',as_of:null,version:null});
      } else if(!['sleep','recovery','cycle','workout','JOURNAL_FACT','JOURNAL_COVERAGE','USER'].includes(descriptor.type))incomplete();
    };
    while(pending.length) {
      const first=pending.shift(),group=[first],identities=new Set([identityFor(first)]);
      if(core.processing.active?.()&&(rawRoot(first)||parallelDerived))while(group.length<RAW_SOURCE_READ_BATCH&&pending.length&&(rawRoot(pending[0])||parallelDerived)
        &&!identities.has(identityFor(pending[0]))) {
        const next=pending.shift();group.push(next);identities.add(identityFor(next));
      }
      await observeGroup(context,group,captureOne);
    }
    if(!entries.size)incomplete();
    const roots=ordered([...entries.values()]),bytes=Buffer.byteLength(canonicalJson(roots));
    if(roots.length>REQUIRED_ROOT_BUDGET.count||bytes>REQUIRED_ROOT_BUDGET.bytes)fail('PHASE4_REQUIRED_ROOT_BOUNDS_UNAVAILABLE');
    return {version:BOUNDED_ROOT_VERSION,model:'FLATTENED_CALCULATION_INPUTS',roots,root_count:roots.length,serialized_bytes:bytes};
  }
  function bodyMetricRawComparators(context,observed){
    const nodeKey=(table,id)=>canonicalJson([table,String(id)]),node=(table,id)=>observed.nodes.get(nodeKey(table,id)),
        rawValue=entry=>{if(observed.sourceData){
          requireOwnedBodyMetricPurpose(core,context,observed.ownedPurpose);
          const data=observed.sourceData.rawRoots.get(nodeKey(entry.type,entry.id));if(!data)fail('PHASE4_SOURCE_NOT_FOUND');
          return {row:core.compareRootObservation(context,entry.type,String(entry.id),data.values)};
        }const value=observed.values.get(nodeKey(entry.type,entry.id));if(!value)fail('PHASE4_SOURCE_NOT_FOUND');
          if(value.status==='rejected')throw value.reason;return value.value;};
      const graph=(table,id,path=new Set(),verified=new Set())=>{
        const key=nodeKey(table,id);if(path.has(key)||path.size>128||verified.size>10000)fail('PHASE4_PROVENANCE_CYCLE');
        if(verified.has(key))return;path.add(key);const current=node(table,id);
        if(current?.error)throw current.error;if(!current?.links.length)fail('PHASE4_INCOMPLETE_PROVENANCE');
        for(const link of current.links){
          if(link.source_execution_mode==='SHARED'){
            const identity=nodeKey(link.source_type,link.source_id);if(verified.has(identity))continue;
            rawValue({type:link.source_type,id:link.source_id});verified.add(identity);
          }else{
            const parentNode=node(link.source_type,link.source_id);if(parentNode?.error)throw parentNode.error;
            const parent=parentNode?.row;
            if(!readableRow(parent)||parent.invalidated_at)fail('PHASE4_PARENT_STALE');
            for(const column of ['input_generation','lifecycle_generation','auth_generation'])
              if(Object.hasOwn(parent,column)&&parent[column]!==context[{input_generation:'inputGeneration',lifecycle_generation:'lifecycleGeneration',auth_generation:'authGeneration'}[column]])
                fail('PHASE4_PARENT_STALE');
            graph(link.source_type,link.source_id,path,verified);
          }
        }
        path.delete(key);verified.add(key);
      };
      const artifact=(table,id)=>{
        const row=node(table,id)?.row;if(!row)fail('PHASE4_PARENT_NOT_FOUND');
        if(Object.hasOwn(row,'content_state')&&!readableRow(row))fail('CONTENT_REDACTED');
        for(const [column,value] of [['input_generation',context.inputGeneration],['lifecycle_generation',context.lifecycleGeneration],['auth_generation',context.authGeneration]])
          if(Object.hasOwn(row,column)&&row[column]!==value)fail('PHASE4_PARENT_STALE');
        if(row.invalidated_at)fail('PHASE4_PARENT_STALE');if(!row.privacy_artifact_id)fail('PHASE4_HEALTH_PARENT_REQUIRED');
        graph(table,id);return row;
      };
    return {nodeKey,node,rawValue,graph,artifact};
  }
  /** Only an actual owned REFRESH_PREPARED Body calculation selects this
   * transport. No comparison is reused as authority: source revalidation,
   * derived artifacts, Body audit, existing result authority and flattened
   * capture execute their original pure checks against one fresh raw union. */
  async function captureBodyMetricPreparationRoots(context,refs,salt,token){
    if(!token)return null;
    const brand=requireBodyMetricPreparationCapture(core,context,token,refs);
    return core.run(context,async()=>{
      await assertExecutionWorkOwner(client);
      const inputs=core.validateReferences(context,refs),bodySource=inputs.find(source=>source.type==='body_energy_results'),
        itemSource=inputs.find(source=>source.type==='evidence_items');
      if(!bodySource||!itemSource)return null;
      const body=createBodyEnergyStore(core);let audit;
      try{audit=body.auditPlan(bodySource.row);}catch{}
      let existing=[],authorityError;
      try{
        const authorityFrom=await pilotResultAuthorityFrom(client,context,itemSource.row.evidence_item_id);
        existing=(await client.execute({sql:`SELECT * FROM ${authorityFrom} WHERE user_id=? AND execution_mode=? AND evidence_item_id=?`,
          args:[context.userId,context.executionMode,itemSource.row.evidence_item_id]})).rows;
      }catch(error){authorityError=error;}
      if(existing.some(row=>row.result_scope!=='METRIC'))return null;
      const raw=entry=>entry&&entry.mode==='SHARED'&&entry.as_of===null&&['sleep','recovery','cycle','workout','USER'].includes(entry.type);
      const bodyRoot=entry=>entry&&entry.type==='body_energy_results'&&entry.mode===context.executionMode&&entry.as_of===null&&entry.id===bodySource.id;
      const manifests=existing.map(row=>{try{return parse(row.required_roots_json);}catch{return null;}});
      if(manifests.some(manifest=>!Array.isArray(manifest?.roots)||manifest.roots.some(entry=>!raw(entry)&&!bodyRoot(entry))))return null;
      const expected=[...(audit?.unique??[]),...manifests.flatMap(manifest=>manifest.roots.filter(raw))];
      const observed=await core.bodyMetricPreparationRawUnion(context,refs,expected,brand.ownedPurpose);if(observed.fallback)return null;
      const current=()=>processingReadObservationEpoch(client)===observed.observationEpoch;
      if(!current())return null;
      const {nodeKey,node,rawValue,graph,artifact}=bodyMetricRawComparators(context,observed);
      // Original revalidateSources precedes every capture/expansion. Even
      // repeated references retain each original row-generation comparison.
      for(const source of inputs){
        const value=observed.inputRows.get(nodeKey(source.type,source.id));if(value?.error)throw value.error;
        const row=value?.row;if(!readableRow(row)||row.invalidated_at)fail('PHASE4_PARENT_STALE');
        for(const column of ['input_generation','lifecycle_generation','auth_generation'])
          if(Object.hasOwn(row,column)&&row[column]!==source.row[column])fail('PHASE4_PARENT_STALE');
        graph(source.type,source.id);
      }
      const pending=inputs.map(source=>({type:source.type,id:source.id,mode:source.mode,as_of:null,version:null})),entries=new Map(),seen=new Set(),
        identityFor=descriptor=>canonicalJson([descriptor.mode,descriptor.type,descriptor.id,descriptor.as_of]);
      while(pending.length){
        if(!current())return null;
        const descriptor=pending.shift(),identity=identityFor(descriptor);
        if(seen.has(identity)){
          if(descriptor.version!==null&&canonicalSourceVersion(descriptor.version)!==entries.get(identity).version)
            fail('PHASE4_REQUIRED_ROOT_VERSION_MISMATCH');if(!descriptor.expected)continue;
        }
        seen.add(identity);if(seen.size>REQUIRED_ROOT_BUDGET.count)fail('PHASE4_REQUIRED_ROOT_BOUNDS_UNAVAILABLE');
        let row;
        if(descriptor.mode==='SHARED')row=rawValue(descriptor).row;
        else{
          if(!['evidence_items','body_energy_results'].includes(descriptor.type)||descriptor.mode!==context.executionMode)invalid();
          const info=await core.tableInfo(descriptor.type),key=descriptor.type==='evidence_items'?'evidence_item_id':'result_id';
          if(!current())return null;
          if(info.filter(column=>column.pk&&!['user_id','execution_mode'].includes(column.name)).map(column=>column.name).join(',')!==key)
            fail('PHASE4_ENTITY_KEY_REQUIRED');
          if(!node(descriptor.type,descriptor.id)?.row)fail('PHASE4_SOURCE_NOT_FOUND');row=artifact(descriptor.type,descriptor.id);
        }
        if(descriptor.expected)for(const [field,value] of Object.entries(descriptor.expected)){
          const temporal=field.endsWith('_at')||field==='as_of_utc';
          if((temporal?canonicalSourceTime(row[field]??null):row[field]??null)!==(temporal?canonicalSourceTime(value):value))
            fail('PHASE4_REQUIRED_ROOT_VERSION_MISMATCH');
        }
        if(descriptor.version!==null&&healthVersion(row)!==canonicalSourceVersion(descriptor.version))fail('PHASE4_REQUIRED_ROOT_VERSION_MISMATCH');
        const {expected,...stable}=descriptor;
        entries.set(identity,{...stable,version:['sleep','recovery','cycle','workout','body_energy_results'].includes(descriptor.type)?healthVersion(row):null,
          content_hash:hash(salt,'required-root-content-v1',rootProjection(row,descriptor.type,BOUNDED_ROOT_VERSION))});
        if(descriptor.type==='evidence_items'){
          if(observed.runObservation.error)throw observed.runObservation.error;
          const runRow=observed.runObservation.row;
          if(!runRow||runRow.run_id!==row.run_id)fail('PHASE4_PARENT_NOT_FOUND');const run=artifact('evidence_runs',runRow.privacy_artifact_id);
          if(run.run_id!==brand.runId)invalid();const descriptors=await descriptorsForRun(context,run);
          if(!current())return null;pending.push(...descriptors);
          if(authorityError)throw authorityError;
          for(const authority of existing){
            verifyEnvelope(context,authority);
            const currentItem=artifact('evidence_items',descriptor.id),currentRun=artifact('evidence_runs',run.privacy_artifact_id),
              verified=authenticate(context,authority,currentItem,currentRun);
            for(const [column,value] of [['input_generation',context.inputGeneration],['lifecycle_generation',context.lifecycleGeneration],['auth_generation',context.authGeneration]])
              if(authority[column]!==value)fail('PHASE4_PARENT_STALE');
            validateManifest(verified.manifest,context.executionMode);
            for(const entry of verified.manifest.roots)compareRootRow(authority,verified.manifest,entry,
              entry.mode==='SHARED'?rawValue(entry).row:artifact(entry.type,entry.id));
            pending.push(...verified.manifest.roots.map(({content_hash,...root})=>root));
          }
        }else if(descriptor.type==='body_energy_results'){
          // reproduceAudit's original linked-presence check precedes plan and
          // its expected comparisons; actual graph validation occurred above.
          if(!node('body_energy_results',descriptor.id)?.links.length)fail('BODY_ENERGY_REPRODUCTION_CONFLICT');
          audit=body.auditPlan(row);
          if(audit.unique.some(source=>!(observed.sourceData?observed.sourceData.rawRoots:observed.values).has(nodeKey(source.type,source.id))))return null;
          for(const source of audit.unique)body.compareAuditSource(context,row,source,rawValue(source));
          if(audit.result.manifest.manifest_version!=='body-energy-inputs-v1')incomplete();
          for(const source of audit.unique)pending.push({type:source.type,id:String(source.id),mode:'SHARED',as_of:null,version:null,
            ...(source.expected?{expected:source.expected}:{})});
        }else if(!raw(descriptor))incomplete();
      }
      if(!entries.size)incomplete();const roots=ordered([...entries.values()]),bytes=Buffer.byteLength(canonicalJson(roots));
      if(roots.length>REQUIRED_ROOT_BUDGET.count||bytes>REQUIRED_ROOT_BUDGET.bytes)fail('PHASE4_REQUIRED_ROOT_BOUNDS_UNAVAILABLE');
      await assertFreshContextAndWorkOwner(core,context);requireSettledOperation();
      if(!current())return null;
      return {version:BOUNDED_ROOT_VERSION,model:'FLATTENED_CALCULATION_INPUTS',roots,root_count:roots.length,serialized_bytes:bytes};
    });
  }
  /** Closed post-effect NEW_BODY_SOURCE data observation. The original source
   * transaction already owns the newly produced Body row; this does not use
   * an existing source receipt/producer as acceptance authority. Actual graph,
   * artifact, audit and flattened input comparisons share one fresh raw union
   * inside this call. Complex graphs keep the original complete capture. */
  async function captureNewBodySourceRoots(context,refs,salt,producer){
    if(![32,33,34,35].includes(core.schemaVersion)||!core.analysisModeAllowed(context)||!core.processing.active?.()||!core.jobAuthority()
      ||currentDurableExecution()?.claim?.request?.phase!=='STAGE6_DRAIN'||currentDurableExecution().receipts===false)return null;
    const sources=core.validateReferences(context,refs);
    if(sources.length!==1||sources[0].type!=='body_energy_results'||sources[0].mode!==context.executionMode||sources[0].historicalAsOf)return null;
    const source=sources[0];requireNewBodySourceCapture(core,context,producer,source);requireSettledOperation();
    return core.run(context,async()=>{
      await assertExecutionWorkOwner(client);
      const row=(await client.execute({sql:'SELECT * FROM body_energy_results WHERE user_id=? AND execution_mode=? AND privacy_artifact_id=?',
        args:[context.userId,context.executionMode,source.id]})).rows[0];
      // Original revalidateSources row/generation order precedes its graph.
      if(!readableRow(row)||row.invalidated_at)fail('PHASE4_PARENT_STALE');
      for(const column of ['input_generation','lifecycle_generation','auth_generation'])
        if(Object.hasOwn(row,column)&&row[column]!==source.row[column])fail('PHASE4_PARENT_STALE');
      const body=createBodyEnergyStore(core);let audit,error;
      try{audit=body.auditPlan(row);}catch(caught){error=caught;}
      if(audit?.unique.some(value=>typeof value.id!=='string'))return null;
      const graph=await core.currentBodyRawUnion(context,row,audit?.unique??[]);if(graph.fallback)return null;
      const current=value=>{
        const observed=graph.values.get(JSON.stringify([value.type,String(value.id)]));if(!observed)fail('PHASE4_SOURCE_NOT_FOUND');
        if(observed.status==='rejected')throw observed.reason;return observed.value;
      };
      for(const value of graph.actual)current(value);
      // Original resolved artifact envelope and Body content root come before
      // audit/expected source comparisons. No current semantic field is merged
      // into a historical projection and no raw observer mints this manifest.
      for(const [column,value] of [['input_generation',context.inputGeneration],['lifecycle_generation',context.lifecycleGeneration],['auth_generation',context.authGeneration]])
        if(Object.hasOwn(row,column)&&row[column]!==value)fail('PHASE4_PARENT_STALE');
      if(!row.privacy_artifact_id)fail('PHASE4_HEALTH_PARENT_REQUIRED');
      const entries=new Map(),put=(descriptor,value)=>{
        const identity=canonicalJson([descriptor.mode,descriptor.type,descriptor.id,descriptor.as_of]);
        if(!entries.has(identity))entries.set(identity,{...descriptor,
          version:['sleep','recovery','cycle','workout','body_energy_results'].includes(descriptor.type)?healthVersion(value):null,
          content_hash:hash(salt,'required-root-content-v1',rootProjection(value,descriptor.type,BOUNDED_ROOT_VERSION))});
      };
      put({type:'body_energy_results',id:source.id,mode:context.executionMode,as_of:null},row);
      if(error)throw error;
      for(const value of audit.unique)body.compareAuditSource(context,row,value,current(value));
      if(audit.result.manifest.manifest_version!=='body-energy-inputs-v1')incomplete();
      for(const value of audit.unique){
        const observed=current(value);body.compareAuditSource(context,row,value,observed);
        put({type:value.type,id:String(value.id),mode:'SHARED',as_of:null},observed.row);
      }
      if(!entries.size)incomplete();
      const roots=ordered([...entries.values()]),bytes=Buffer.byteLength(canonicalJson(roots));
      if(roots.length>REQUIRED_ROOT_BUDGET.count||bytes>REQUIRED_ROOT_BUDGET.bytes)fail('PHASE4_REQUIRED_ROOT_BOUNDS_UNAVAILABLE');
      await assertFreshContextAndWorkOwner(core,context);requireSettledOperation();
      return {version:BOUNDED_ROOT_VERSION,model:'FLATTENED_CALCULATION_INPUTS',roots,root_count:roots.length,serialized_bytes:bytes};
    });
  }
  // Flattening and historical/derived expansion retain their original queue
  // order. Only a finite set of independent raw observations can overlap in
  // the same already-owned transaction; every comparison settles before the
  // next queue expansion or write and the first original failure wins.
  const rawRoot=entry=>entry.mode==='SHARED'&&entry.as_of===null
    &&['sleep','recovery','cycle','workout','USER'].includes(entry.type);
  async function observeGroup(context,entries,observe) {
    if(entries.length===1||!core.processing.active?.()) {
      for(const entry of entries)await observe(entry);return;
    }
    const results=await Promise.allSettled(entries.map(entry=>Promise.resolve().then(()=>observe(entry))));
    const failure=results.find(result=>result.status==='rejected');if(failure)throw failure.reason;
  }
  function validateManifest(manifest,mode) {
    // Historical signed manifests retain their original array order. HMACs
    // authenticate those exact bytes; uniqueness is independent of locale.
    if(!manifest||![RESULT_ROOT_VERSION,NORMALIZED_ROOT_VERSION,BOUNDED_ROOT_VERSION].includes(manifest.version)||manifest.model!=='FLATTENED_CALCULATION_INPUTS'
      ||!Array.isArray(manifest.roots)||!manifest.roots.length||manifest.roots.length>10000
      ||new Set(manifest.roots.map(canonicalJson)).size!==manifest.roots.length)invalid();
    if(manifest.version===BOUNDED_ROOT_VERSION&&(manifest.root_count!==manifest.roots.length
      ||manifest.serialized_bytes!==Buffer.byteLength(canonicalJson(manifest.roots))||manifest.serialized_bytes>REQUIRED_ROOT_BUDGET.bytes))invalid();
    for(const entry of manifest.roots) {
      if(!same(Object.keys(entry).sort(),['as_of','content_hash','id','mode','type','version'])
        ||typeof entry.id!=='string'||!entry.id||typeof entry.content_hash!=='string'
        ||!['SHARED',mode].includes(entry.mode)
        ||!['sleep','recovery','cycle','workout','body_energy_results','evidence_items','JOURNAL_FACT','JOURNAL_COVERAGE','USER'].includes(entry.type))invalid();
    }
  }
  async function validateRoots(context,row,manifest) {
    validateManifest(manifest,context.executionMode);
    const validateOne=async entry=>{
      const source=await resolve(context,entry);
      compareRootRow(row,manifest,entry,source.row);
    };
    for(let index=0;index<manifest.roots.length;index++) {
      const first=manifest.roots[index],group=[first];
      if(rawRoot(first))while(group.length<RAW_SOURCE_READ_BATCH&&index+1<manifest.roots.length&&rawRoot(manifest.roots[index+1]))
        group.push(manifest.roots[++index]);
      await observeGroup(context,group,validateOne);
    }
  }
  function compareRootRow(row,manifest,entry,sourceRow){
      const legacy=manifest.version===RESULT_ROOT_VERSION;
      if(entry.version!==null&&(entry.as_of!==null?sourceRow.revision:healthVersion(sourceRow))
        !==(entry.as_of!==null?entry.version:canonicalSourceVersion(entry.version)))
        fail('PHASE4_REQUIRED_ROOT_VERSION_MISMATCH');
      // v1 signed the original adapter tuple spelling. Its authenticated tuple
      // can restore only those owned timestamp fields for the old hash check.
      // The semantic equality check above forbids substituting another instant.
      let historical=sourceRow;
      if(legacy&&typeof entry.version==='string') {
        const tuple=parse(entry.version);
        if(!Array.isArray(tuple)||tuple.length!==4)invalid();
        historical={...sourceRow};
        for(const [index,field] of ['updated_at','synced_at','as_of_utc'].entries())
          if(Object.hasOwn(historical,field))historical[field]=tuple[index];
      }
      if(hash(row.content_digest_salt,'required-root-content-v1',rootProjection(historical,entry.type,manifest.version))!==entry.content_hash)
        fail('PHASE4_REQUIRED_ROOT_VERSION_MISMATCH');
  }
  // This exact verifier is shared by authorized reads and redaction discovery.
  // Redaction does not require roots to remain readable or old generations to
  // equal the newly admitted purge generation; identity and HMAC never relax.
  function verifyEnvelope(context,row) {
    if(!readableRow(row))fail('CONTENT_REDACTED');
    try {
      if(row.user_id!==context.userId||row.execution_mode!==context.executionMode||row.execution_mode!==(core.liveAllocation?'LIVE':'SHADOW')
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
      const preparation=payload.version===PREPARATION_VERSION&&parse(run.input_manifest_json).refresh_preparation===true;
      if(row.result_scope!=='METRIC'||(!preparation&&payload.version!==NULL_PROJECTION_VERSION)||payload.origin!==null
        ||!same(Object.keys(payload).sort(),['calculation','origin','version'])||!payload.calculation
        ||(!preparation&&payload.calculation.targetEpisodeState!==null)||typeof payload.calculation.classification!=='string')invalid();
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
    if(required) {
      const row=(await client.execute({sql:`SELECT r.input_manifest_json FROM evidence_items i JOIN evidence_runs r
        ON r.user_id=i.user_id AND r.execution_mode=i.execution_mode AND r.run_id=i.run_id
        WHERE i.user_id=? AND i.execution_mode=? AND i.evidence_item_id=?`,args:[context.userId,context.executionMode,itemId]})).rows[0];
      const input=parse(row?.input_manifest_json),expected=input?.manifest_version?.startsWith('phase4-metric-')
        ?['METRIC']:input?.manifest_version?.startsWith('phase4-association-')?['INSIGHT_CONTRADICTION','INSIGHT_CURRENT']:null;
      if(!expected||!same(scopes.map(row=>row.result_scope).sort(),expected))fail('PHASE4_EVIDENCE_RESULT_AUTHORITY_UNAVAILABLE');
    }
    for(const {result_scope:scope} of scopes)await read(context,itemId,scope);
  }
  async function read(context,evidenceItemId,scope) {
    return core.run(context,async()=>{
      const from=await pilotResultAuthorityFrom(client,context,evidenceItemId,scope);
      const row=(await client.execute({sql:`SELECT * FROM ${from} WHERE user_id=? AND execution_mode=? AND evidence_item_id=? AND result_scope=?`,
        args:[context.userId,context.executionMode,evidenceItemId,scope]})).rows[0];
      if(!row)fail('PHASE4_EVIDENCE_RESULT_AUTHORITY_UNAVAILABLE');
      verifyEnvelope(context,row);
      const artifacts=await Promise.allSettled([
        Promise.resolve().then(()=>core.artifact(context,'evidence_items',{evidence_item_id:evidenceItemId})),
        Promise.resolve().then(()=>core.artifact(context,'evidence_runs',{run_id:row.run_id})),
      ]);
      for(const value of artifacts)if(value.status==='rejected')throw value.reason;
      const item=artifacts[0].value,run=artifacts[1].value;
      const verified=authenticate(context,row,item.row,run.row),{origin,manifest}=verified;
      for(const [column,value] of [['input_generation',context.inputGeneration],['lifecycle_generation',context.lifecycleGeneration],
        ['auth_generation',context.authGeneration]])if(row[column]!==value)fail('PHASE4_PARENT_STALE');
      await validateRoots(context,row,manifest);
      if(currentOwnedBodyMetricObservation(core,context)){
        await assertFreshContextAndWorkOwner(core,context);requireSettledOperation();
        currentOwnedBodyMetricObservation(core,context);
      }
      return {row,...verified};
    });
  }
  // A complete readonly DOMAIN closure. Raw ITEM data from the immediately
  // preceding discovery only selects the actual graph; it is never returned
  // or trusted as a current row. The fresh union supplies every real row/link,
  // and every original artifact, item, manifest, hash and root comparator runs.
  async function readOwnedMetricDomainEvidence(context,purpose,{plan,itemData,discovered}){
    const selected=requireOwnedBodyMetricPurpose(core,context,purpose);
    if(selected.purposeKind!=='DOMAIN'||canonicalJson(plan)!==selected.planJson)invalid();
    requireMetricUnitProof(core,context,discovered?.itemProof,plan,'ITEM');
    requireMetricUnitProof(core,context,discovered?.authorityProof,plan,'AUTHORITY');
    const oldItem=discovered?.itemRow;
    if(oldItem?.evidence_item_id!==selected.itemId||oldItem.run_id!==selected.runId||oldItem.item_key!==selected.itemKey)invalid();
    return core.run(context,async()=>{
      await assertFreshContextAndWorkOwner(core,context);requireSettledOperation();
      const from=await pilotResultAuthorityFrom(client,context,selected.itemId,'METRIC');
      const row=(await client.execute({sql:`SELECT * FROM ${from} WHERE user_id=? AND execution_mode=? AND evidence_item_id=? AND result_scope='METRIC'`,
        args:[context.userId,context.executionMode,selected.itemId]})).rows[0];
      if(!row)fail('PHASE4_EVIDENCE_RESULT_AUTHORITY_UNAVAILABLE');verifyEnvelope(context,row);
      const manifest=parse(row.required_roots_json);
      validateManifest(manifest,context.executionMode);
      const raw=entry=>entry.mode==='SHARED'&&entry.as_of===null&&['sleep','recovery','cycle','workout','USER'].includes(entry.type);
      if(manifest.roots.some(entry=>!raw(entry)&&!(entry.type==='body_energy_results'&&entry.mode===context.executionMode
        &&entry.as_of===null&&entry.id===selected.request.currentSource.id)))return null;
      const itemRef=core.reference(context,'evidence_items',oldItem.privacy_artifact_id,context.executionMode,oldItem),
        observed=await core.bodyMetricPreparationRawUnion(context,[selected.request.currentSource,itemRef],manifest.roots.filter(raw),purpose);
      if(observed.fallback)return null;
      const {artifact,rawValue}=bodyMetricRawComparators(context,observed),
        item=artifact('evidence_items',oldItem.privacy_artifact_id),runRow=observed.runObservation.row;
      if(observed.runObservation.error)throw observed.runObservation.error;
      if(!runRow)fail('PHASE4_PARENT_NOT_FOUND');
      const run=artifact('evidence_runs',runRow.privacy_artifact_id);
      if(run.run_id!==selected.runId||run.deterministic_run_key!==plan.runKey||run.state!=='COMPLETED'
        ||run.input_manifest_hash!==plan.inputHash||run.input_manifest_json!==canonicalJson(plan.input))fail('PHASE4_EVIDENCE_REPLAY_CONFLICT');
      // artifact() above repeats the original conditional generation checks:
      // v32 evidence_items gets its input generation through its RUN, rather
      // than an input_generation column of its own.
      for(const [key,value] of Object.entries({...itemData,run_id:run.run_id})){
        const expected=key.endsWith('_json')&&value!==null?canonicalJson(value):value;
        if(key.endsWith('_json')&&expected!==null&&Buffer.byteLength(expected)>262144)fail('PHASE4_JSON_TOO_LARGE');
        if(item[key]!==expected)fail('PHASE4_IDENTITY_CONTENT_CONFLICT');
      }
      const verified=authenticate(context,row,item,run);
      for(const [column,value] of [['input_generation',context.inputGeneration],['lifecycle_generation',context.lifecycleGeneration],
        ['auth_generation',context.authGeneration]])if(row[column]!==value)fail('PHASE4_PARENT_STALE');
      for(const entry of verified.manifest.roots)compareRootRow(row,verified.manifest,entry,
        entry.mode==='SHARED'?rawValue(entry).row:artifact(entry.type,entry.id));
      await assertFreshContextAndWorkOwner(core,context);requireSettledOperation();
      requireOwnedBodyMetricPurpose(core,context,purpose);
      if(processingReadObservationEpoch(client)!==observed.observationEpoch)fail('PHASE4_METRIC_PREPARATION_CAPTURE_REQUIRED');
      return {run:{row:{...run},ref:core.reference(context,'evidence_runs',run.privacy_artifact_id,context.executionMode,run),created:false},
        item:{row:{...item},ref:core.reference(context,'evidence_items',item.privacy_artifact_id,context.executionMode,item),created:false},
        authority:{row,...verified}};
    });
  }
  async function persist(context,{item,run,scope,origin,calculation,sourceRefs,continuation=null}) {
    if(!core.processing.active())fail('PHASE4_TRANSACTION_REQUIRED');
    core.assertAnalysisWrite(context);
    // This method is internal to the deterministic calculation transaction.
    // Existing/legacy items may never acquire an origin on later reuse.
    if(!item.created){
      if(scope!=='METRIC'||origin!==null||parse(run.row.input_manifest_json).refresh_preparation!==true||!continuation)
        fail('PHASE4_EVIDENCE_RESULT_AUTHORITY_UNAVAILABLE');
      requireMetricUnitProof(core,context,continuation.proof,continuation.plan,'ITEM');
    }
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
        ?{version:parse(run.row.input_manifest_json).refresh_preparation===true?PREPARATION_VERSION:NULL_PROJECTION_VERSION,
          origin:null,calculation}:origin),required_roots_json:canonicalJson(roots),
      input_manifest_hash:hash(envelope.content_digest_salt,'result-input-v1',run.row.input_manifest_json),
      item_hash:hash(envelope.content_digest_salt,'result-item-v1',projection(item.row)),
      input_generation:context.inputGeneration,lifecycle_generation:context.lifecycleGeneration,auth_generation:context.authGeneration,
      created_at:core.timestamp()};
    for(const field of ['original_result_json','required_roots_json'])if(Buffer.byteLength(record[field])>1048576)incomplete();
    record.authority_hmac=seal(record);
    const fields=Object.keys(record);
    reservePilotMutation(context,client,fields.map(k=>record[k]));
    await pilotResultAuthorityFrom(client,context,item.row.evidence_item_id,scope);
    await client.execute({sql:`INSERT INTO ${TABLE}(${fields.join(',')}) VALUES (${fields.map(()=>'?').join(',')})`,args:fields.map(k=>record[k])});
    await addPrivacyLinks(client,[...roots.roots,{type:'evidence_items',id:item.row.privacy_artifact_id,mode:context.executionMode,as_of:null}]
      .map(source=>({userId:context.userId,mode:context.executionMode,table:TABLE,artifactId:envelope.privacy_artifact_id,
        sourceMode:source.mode,sourceType:source.type,sourceId:source.id,
        relationship:source.as_of?`DEPENDS_ON_AS_OF:${source.as_of}`:'DEPENDS_ON',at:core.timestamp()})));
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
    if(row.user_id!==userId||row.execution_mode!==(core.liveAllocation?'LIVE':'SHADOW')||!item||!run||item.run_id!==run.run_id
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
        if(table==='insight_revisions') {
          let refs;try {refs=[...JSON.parse(value.supporting_evidence_ids_json??'[]'),...JSON.parse(value.contradicting_evidence_ids_json??'[]')];}
          catch {fail('PHASE4_PURGE_AUTHORITY_INVALID');}
          for(const evidenceId of refs)await addEvidenceRoot(evidenceId);
        }
      }
    }
    for(const id of episodeIds)for(const table of ['observation_episodes','phase4_episode_revisions','episode_events','episode_evidence','episode_observations','episode_semantic_events'])
      for(const value of (await client.execute({sql:`SELECT * FROM ${table} WHERE user_id=? AND execution_mode=? AND episode_id=?`,args:[...scope,id]})).rows) {
        add(table,value);
        if(table==='phase4_episode_revisions'&&value.content_state==='PRESENT') {
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
  return Object.freeze({read,readOwnedMetricDomainEvidence,persist,metricOrigin,episodeDependencies,validateExisting,privacyDependencies,
    captureRoots,captureBodyMetricPreparationRoots,captureNewBodySourceRoots,validateRoots,validateManifest,compareRootRow,descriptorsForRun,authenticate});
}
