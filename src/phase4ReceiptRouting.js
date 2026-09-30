import { canonicalJson } from './phase4EntityStore.js';
import { phase4Metric,INTELLIGENCE_VERSIONS } from './phase4IntelligenceRegistry.js';
import { ROUTE_VERSION,ROUTE_RECEIPTS,ROUTE_ENTRIES,ROUTE_MANIFESTS } from './phase4V29Schema.js';
import { OPERATION_RECEIPT_VERSION } from './phase4V27Schema.js';

const ZERO='0'.repeat(64);
const invalid=()=>{const error=new Error('PHASE4_RECEIPT_ROUTE_AUTHORITY_INVALID');error.code='PHASE4_RECEIPT_ROUTE_AUTHORITY_INVALID';throw error;};
const bounds=()=>{const error=new Error('PHASE4_OPERATION_RESULT_BOUNDS_UNAVAILABLE');error.code='PHASE4_OPERATION_RESULT_BOUNDS_UNAVAILABLE';throw error;};
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const compare=(a,b)=>a<b?-1:a>b?1:0;
const parse=value=>{try{const decoded=JSON.parse(value);if(canonicalJson(decoded)!==value)invalid();return decoded;}catch{invalid();}};

/** This verifier uses the frozen v27 seal; migration never infers a family from
 * materialized names or from a receipt whose HMAC has already been erased. */
export function verifyV27RouteSource(keys,row) {
  if(row.content_state!=='PRESENT'||row.execution_mode!=='SHADOW'||row.receipt_version!==OPERATION_RECEIPT_VERSION
    ||row.privacy_artifact_id!==keys.lookup(['privacy-artifact-v1','phase4_operation_receipts',row.user_id,row.execution_mode,
      [row.operation_kind,row.operation_key]]))invalid();
  const sealed=keys.digest(row.content_digest_salt,canonicalJson([OPERATION_RECEIPT_VERSION,
    Object.fromEntries(Object.entries(row).filter(([key])=>!['receipt_hmac','health_content_redacted_at',
      'health_content_redaction_reason','source_subject_deleted_at'].includes(key)))]));
  if(sealed!==row.receipt_hmac)invalid();
  const request=parse(row.request_json),related=parse(row.related_results_json);
  for(const field of ['result_json','required_roots_json','schema_contract_json'])parse(row[field]);
  if(request.version!=='stage5-semantic-request-v1'||request.operation_kind!==row.operation_kind
    ||request.scope?.user_id!==row.user_id||request.scope?.execution_mode!==row.execution_mode
    ||!same(request.scope.generations,[row.input_generation,row.lifecycle_generation,row.auth_generation,row.purge_generation])
    ||keys.lookup(['stage5-operation-key-v1',canonicalJson(request)])!==row.operation_key)invalid();
  return {request,related};
}

export function createReceiptRouting(client,keys) {
  const mac=value=>keys.digest(ZERO,canonicalJson([ROUTE_VERSION,value]));
  const token=(userId,mode,kind,identity)=>keys.lookup(['stage6-route-subject-v1',ROUTE_VERSION,userId,mode,kind,identity]);
  const metric=(userId,mode,key)=>{
    const contract=phase4Metric(key);
    return ['EPISODE',token(userId,mode,'EPISODE',[key,contract.domain])];
  };
  const family=(userId,mode,key)=>['EPISODE_FAMILY',token(userId,mode,'EPISODE_FAMILY',key)];
  const insight=(userId,mode,key)=>['INSIGHT',token(userId,mode,'INSIGHT',key)];
  const artifact=(userId,mode,id)=>['ARTIFACT',token(userId,mode,'ARTIFACT',id)];
  const episodeId=(userId,mode,id)=>['EPISODE_ID',token(userId,mode,'EPISODE_ID',id)];
  const insightId=(userId,mode,id)=>['INSIGHT_ID',token(userId,mode,'INSIGHT_ID',id)];
  async function subjects(row,decoded) {
    const userId=row.user_id,mode=row.execution_mode,result=[],add=value=>{
      if(value&&!result.some(old=>same(old,value)))result.push(value);
    },request=decoded.request.request;
    if(row.operation_kind==='analyzeMetric') {
      add(metric(userId,mode,request.metricKey));
      const domain=phase4Metric(request.metricKey).domain;
      add(family(userId,mode,keys.lookup(['episode-family-v1',userId,domain,request.metricKey,
        INTELLIGENCE_VERSIONS.algorithm,request.metricKey,request.windowFamily])));
    }
    if(row.operation_kind.startsWith('EPISODE_')) {
      if(request.identity?.metric)add(metric(userId,mode,request.identity.metric));
      if(request.identity) add(family(userId,mode,keys.lookup(['episode-family-v1',userId,
        request.identity.domain,request.identity.metric,request.identity.algorithmMajor,
        request.identity.subject,request.identity.windowFamily])));
      if(request.episodeId)add(episodeId(userId,mode,request.episodeId));
      if(request.prior?.episodeId)add(episodeId(userId,mode,request.prior.episodeId));
      if(request.reopensEpisodeId)add(episodeId(userId,mode,request.reopensEpisodeId));
      for(const target of decoded.related)if(target.type==='observation_episodes'&&target.row?.subject_key) {
        add(metric(userId,mode,target.row.subject_key));
        if(target.row.episode_family_key)add(family(userId,mode,target.row.episode_family_key));
      }
    }
    if(row.operation_kind==='analyzeAssociationFamily') {
      const {insightIdentityKey}=await import('./phase4InsightStore.js');
      add(['ASSOCIATION',token(userId,mode,'ASSOCIATION',request.multipleTestingFamily)]);
      for(const hypothesis of request.hypotheses??[]) {
      for(const direction of ['LOWER','HIGHER']) {
        const key=insightIdentityKey(keys,{userId},{subject:`journal:${hypothesis.factor}`,
          outcome:hypothesis.outcomeMetric,direction,exposureCategory:hypothesis.factor,
          algorithmFamily:'journal-association',evidenceContractMajor:'1'});
        add(insight(userId,mode,key));
      }
      }
    }
    if(row.operation_kind==='INSIGHT_CREATE') {
      const {insightIdentityKey}=await import('./phase4InsightStore.js');
      add(insight(userId,mode,insightIdentityKey(keys,{userId},request.identity)));
    }
    if(row.operation_kind==='INSIGHT_TRANSITION'&&request.insightId)add(insightId(userId,mode,request.insightId));
    if(row.operation_kind==='expireInsight'&&request.insightId)add(insightId(userId,mode,request.insightId));
    if(row.operation_kind==='expireEpisode'&&request.episodeId)add(episodeId(userId,mode,request.episodeId));
    for(const target of decoded.related) {
      if(target.type==='health_insights') {
        if(target.row?.insight_key)add(insight(userId,mode,target.row.insight_key));
        if(target.row?.id)add(insightId(userId,mode,target.row.id));
      }
      if(target.type==='observation_episodes') {
        if(target.row?.subject_key)add(metric(userId,mode,target.row.subject_key));
        if(target.row?.episode_family_key)add(family(userId,mode,target.row.episode_family_key));
        if(target.row?.episode_id)add(episodeId(userId,mode,target.row.episode_id));
      }
      if(typeof target.id==='string')add(artifact(userId,mode,target.id));
    }
    return result.sort((a,b)=>compare(canonicalJson(a),canonicalJson(b)));
  }
  const receiptValues=row=>[row.user_id,row.execution_mode,row.operation_kind,row.operation_key,row.route_state,row.subjects_json];
  const entryValues=row=>[row.user_id,row.execution_mode,row.subject_kind,row.subject_token,row.sequence,row.operation_kind,row.operation_key];
  const manifestValues=row=>[row.user_id,row.execution_mode,row.subject_kind,row.subject_token,row.entry_count,row.chain_digest];
  const verifyReceipt=row=>{
    if(row.route_version!==ROUTE_VERSION||row.route_hmac!==mac(['RECEIPT',...receiptValues(row)]))invalid();
    const values=parse(row.subjects_json);
    if(!Array.isArray(values)||row.route_state==='LEGACY_ROUTE_UNKNOWN'&&values.length
      ||row.route_state==='KNOWN'&&values.some(value=>!Array.isArray(value)||value.length!==2
        ||!['EPISODE','EPISODE_FAMILY','INSIGHT','ASSOCIATION','ARTIFACT','EPISODE_ID','INSIGHT_ID'].includes(value[0])||!hex(value[1]))
      ||!same(values,[...values].sort((a,b)=>compare(canonicalJson(a),canonicalJson(b)))))invalid();
    return values;
  };
  const verifyEntry=row=>{if(row.route_version!==ROUTE_VERSION||row.binding_hmac!==mac(['ENTRY',...entryValues(row)]))invalid();};
  const verifyManifest=row=>{if(row.route_version!==ROUTE_VERSION||row.manifest_hmac!==mac(['MANIFEST',...manifestValues(row)]))invalid();};
  const chain=(prior,entry)=>mac(['CHAIN',prior,entry.binding_hmac]);
  async function register(row,decoded=null,{legacyUnknown=false}={}) {
    const values=legacyUnknown?[]:await subjects(row,decoded),state=legacyUnknown?'LEGACY_ROUTE_UNKNOWN':'KNOWN',json=canonicalJson(values);
    if(!legacyUnknown&&(row.operation_kind.startsWith('EPISODE_')||row.operation_kind==='analyzeMetric'
      ||row.operation_kind==='expireEpisode')&&!values.some(([kind])=>kind==='EPISODE'))invalid();
    if(!legacyUnknown&&(row.operation_kind.startsWith('INSIGHT_')||row.operation_kind==='analyzeAssociationFamily'
      ||row.operation_kind==='expireInsight')&&!values.some(([kind])=>kind==='INSIGHT'))invalid();
    const record={user_id:row.user_id,execution_mode:row.execution_mode,operation_kind:row.operation_kind,
      operation_key:row.operation_key,route_version:ROUTE_VERSION,route_state:state,subjects_json:json,
      created_at:new Date().toISOString()};
    record.route_hmac=mac(['RECEIPT',...receiptValues(record)]);
    const existing=(await client.execute({sql:`SELECT * FROM ${ROUTE_RECEIPTS} WHERE user_id=? AND execution_mode=? AND operation_kind=? AND operation_key=?`,
      args:[row.user_id,row.execution_mode,row.operation_kind,row.operation_key]})).rows[0];
    if(existing){if(!same(existing,record)&&(!same(values,verifyReceipt(existing))||existing.route_state!==state))invalid();}
    else await client.execute({sql:`INSERT INTO ${ROUTE_RECEIPTS}
      (user_id,execution_mode,operation_kind,operation_key,route_version,route_state,subjects_json,route_hmac,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`,args:[record.user_id,record.execution_mode,record.operation_kind,record.operation_key,
        record.route_version,record.route_state,record.subjects_json,record.route_hmac,record.created_at]});
    for(const [subject_kind,subject_token] of values) {
      const scope=[row.user_id,row.execution_mode,subject_kind,subject_token];
      const prior=(await client.execute({sql:`SELECT * FROM ${ROUTE_MANIFESTS} WHERE user_id=? AND execution_mode=?
        AND subject_kind=? AND subject_token=?`,args:scope})).rows[0];
      if(prior)verifyManifest(prior);
      const found=(await client.execute({sql:`SELECT * FROM ${ROUTE_ENTRIES} WHERE user_id=? AND execution_mode=?
        AND operation_kind=? AND operation_key=? AND subject_kind=? AND subject_token=?`,
        args:[row.user_id,row.execution_mode,row.operation_kind,row.operation_key,subject_kind,subject_token]})).rows[0];
      if(found) {
        verifyEntry(found);
        const all=(await client.execute({sql:`SELECT * FROM ${ROUTE_ENTRIES} WHERE user_id=? AND execution_mode=?
          AND subject_kind=? AND subject_token=? ORDER BY sequence`,args:scope})).rows;
        let digest=ZERO;
        for(let i=0;i<all.length;i++){verifyEntry(all[i]);if(all[i].sequence!==i+1)invalid();digest=chain(digest,all[i]);}
        if(prior) {
          if(prior.entry_count===all.length&&prior.chain_digest===digest)continue;
          if(prior.entry_count!==all.length-1)invalid();
        } else if(all.length!==1)invalid();
        const repaired={user_id:row.user_id,execution_mode:row.execution_mode,subject_kind,subject_token,
          entry_count:all.length,chain_digest:digest};
        repaired.manifest_hmac=mac(['MANIFEST',...manifestValues(repaired)]);
        if(prior)await client.execute({sql:`UPDATE ${ROUTE_MANIFESTS} SET entry_count=?,chain_digest=?,manifest_hmac=?
          WHERE user_id=? AND execution_mode=? AND subject_kind=? AND subject_token=?`,
          args:[repaired.entry_count,repaired.chain_digest,repaired.manifest_hmac,...scope]});
        else await client.execute({sql:`INSERT INTO ${ROUTE_MANIFESTS}
          (user_id,execution_mode,subject_kind,subject_token,route_version,entry_count,chain_digest,manifest_hmac)
          VALUES (?,?,?,?,?,?,?,?)`,args:[...scope,ROUTE_VERSION,repaired.entry_count,repaired.chain_digest,repaired.manifest_hmac]});
        continue;
      }
      const entry={user_id:row.user_id,execution_mode:row.execution_mode,subject_kind,subject_token,
        sequence:(prior?.entry_count??0)+1,operation_kind:row.operation_kind,operation_key:row.operation_key};
      entry.binding_hmac=mac(['ENTRY',...entryValues(entry)]);
      await client.execute({sql:`INSERT INTO ${ROUTE_ENTRIES}
        (user_id,execution_mode,subject_kind,subject_token,sequence,operation_kind,operation_key,route_version,binding_hmac)
        VALUES (?,?,?,?,?,?,?,?,?)`,args:[...entryValues(entry).slice(0,4),entry.sequence,entry.operation_kind,
          entry.operation_key,ROUTE_VERSION,entry.binding_hmac]});
      const manifest={user_id:row.user_id,execution_mode:row.execution_mode,subject_kind,subject_token,
        entry_count:entry.sequence,chain_digest:chain(prior?.chain_digest??ZERO,entry)};
      manifest.manifest_hmac=mac(['MANIFEST',...manifestValues(manifest)]);
      if(prior)await client.execute({sql:`UPDATE ${ROUTE_MANIFESTS} SET entry_count=?,chain_digest=?,manifest_hmac=?
        WHERE user_id=? AND execution_mode=? AND subject_kind=? AND subject_token=?`,
        args:[manifest.entry_count,manifest.chain_digest,manifest.manifest_hmac,...scope]});
      else await client.execute({sql:`INSERT INTO ${ROUTE_MANIFESTS}
        (user_id,execution_mode,subject_kind,subject_token,route_version,entry_count,chain_digest,manifest_hmac)
        VALUES (?,?,?,?,?,?,?,?)`,args:[...scope,ROUTE_VERSION,manifest.entry_count,manifest.chain_digest,manifest.manifest_hmac]});
    }
  }
  async function inventory(context,kind,identity,alreadyToken=false) {
    const userId=context.userId,mode=context.executionMode,
      subjectToken=alreadyToken?identity:token(userId,mode,kind,identity);
    // The global small routing layer is authenticated without opening any
    // unrelated receipt. It proves that no v27 row was left without a route.
    const routes=(await client.execute({sql:`SELECT * FROM ${ROUTE_RECEIPTS} WHERE user_id=? AND execution_mode=?
      ORDER BY operation_kind,operation_key`,args:[userId,mode]})).rows;
    const actual=(await client.execute({sql:`SELECT operation_kind,operation_key FROM phase4_operation_receipts
      WHERE user_id=? AND execution_mode=? ORDER BY operation_kind,operation_key`,args:[userId,mode]})).rows;
    if(routes.length!==actual.length)invalid();
    let unknown=0;const expected=[];
    for(let i=0;i<routes.length;i++) {
      const route=routes[i],receipt=actual[i];
      if(route.operation_kind!==receipt.operation_kind||route.operation_key!==receipt.operation_key)invalid();
      const subjects=verifyReceipt(route);
      if(route.route_state==='LEGACY_ROUTE_UNKNOWN'){unknown++;continue;}
      if(subjects.some(([k,t])=>k===kind&&t===subjectToken))expected.push(route);
    }
    const scope=[userId,mode,kind,subjectToken];
    const manifest=(await client.execute({sql:`SELECT * FROM ${ROUTE_MANIFESTS} WHERE user_id=? AND execution_mode=?
      AND subject_kind=? AND subject_token=?`,args:scope})).rows[0];
    const entries=(await client.execute({sql:`SELECT * FROM ${ROUTE_ENTRIES} WHERE user_id=? AND execution_mode=?
      AND subject_kind=? AND subject_token=? ORDER BY sequence`,args:scope})).rows;
    if(!manifest){if(expected.length||entries.length)invalid();return {receipts:[],unknown};}
    verifyManifest(manifest);
    if(entries.length!==manifest.entry_count||expected.length!==entries.length)invalid();
    let digest=ZERO;
    const expectedKeys=new Set(expected.map(route=>canonicalJson([route.operation_kind,route.operation_key])));
    for(let i=0;i<entries.length;i++) {
      const entry=entries[i];verifyEntry(entry);
      const key=canonicalJson([entry.operation_kind,entry.operation_key]);
      if(entry.sequence!==i+1||!expectedKeys.delete(key))invalid();
      digest=chain(digest,entry);
    }
    if(expectedKeys.size||digest!==manifest.chain_digest)invalid();
    if(entries.length>1000)bounds();
    const receipts=[];
    for(const entry of entries) {
      const receipt=(await client.execute({sql:`SELECT * FROM phase4_operation_receipts WHERE user_id=? AND execution_mode=?
        AND operation_kind=? AND operation_key=?`,args:[userId,mode,entry.operation_kind,entry.operation_key]})).rows[0];
      if(!receipt)invalid();receipts.push(receipt);
    }
    return {receipts,unknown};
  }
  return {token,subjects,register,inventory,verifyReceipt,verifyEntry,verifyManifest};
}
