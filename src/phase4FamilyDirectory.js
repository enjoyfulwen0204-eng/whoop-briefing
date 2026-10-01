import { canonicalJson } from './phase4EntityStore.js';
import { phase4Metric,INTELLIGENCE_VERSIONS,PHASE4_METRICS } from './phase4IntelligenceRegistry.js';
import { createReceiptRouting } from './phase4ReceiptRouting.js';
import { FAMILY_DIRECTORY_VERSION as VERSION,FAMILY_DIRECTORY_ENTRIES as ENTRIES,
  FAMILY_DIRECTORY_MANIFESTS as MANIFESTS,FAMILY_WORK_TIPS as TIPS } from './phase4V30Schema.js';

const ZERO='0'.repeat(64);
const fail=code=>{const error=new Error(code);error.code=code;throw error;};
const invalid=()=>fail('PHASE4_FAMILY_DIRECTORY_AUTHORITY_INVALID');
const unknown=()=>fail('PHASE4_FAMILY_DIRECTORY_LEGACY_UNKNOWN');
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const parse=value=>{try{const decoded=JSON.parse(value);if(canonicalJson(decoded)!==value)invalid();return decoded;}catch{invalid();}};

/** V30's non-lifecycle directory. Identity fields are the frozen Stage 5
 * metric/episode dimensions; arbitrary source IDs are deliberately excluded
 * because a later current source must find existing custom window families. */
export function createFamilyDirectory(client,keys) {
  const routing=createReceiptRouting(client,keys);
  const mac=value=>keys.digest(ZERO,canonicalJson([VERSION,value]));
  const source=(context,metricKey)=>{
    const contract=phase4Metric(metricKey);
    const identity={metric:metricKey,domain:contract.domain,algorithmMajor:INTELLIGENCE_VERSIONS.algorithm,
      subject:metricKey};
    return {identity,token:keys.lookup(['stage6-family-source-v1',context.userId,context.executionMode,identity])};
  };
  const family=(context,identity)=>{
    const key=keys.lookup(['episode-family-v1',context.userId,identity.domain,identity.metric,
      identity.algorithmMajor,identity.subject,identity.windowFamily]);
    return {key,token:routing.token(context.userId,context.executionMode,'EPISODE_FAMILY',key)};
  };
  const entryValues=row=>[row.user_id,row.execution_mode,row.source_token,row.sequence,row.family_token,
    row.family_key,row.descriptor_json,row.entry_state];
  const manifestValues=row=>[row.user_id,row.execution_mode,row.source_token,row.entry_count,row.chain_digest,
    row.route_tip_json,row.directory_state];
  const tipValues=row=>[row.user_id,row.execution_mode,row.source_token,row.family_token,row.requested_json,
    row.completed_json,row.family_manifest_json];
  const verifyEntry=row=>{
    if(row.directory_version!==VERSION||row.entry_hmac!==mac(['ENTRY',...entryValues(row)]))invalid();
    if(row.entry_state==='KNOWN') {
      const descriptor=parse(row.descriptor_json);
      if(!same(Object.keys(descriptor),['identityToken'])||!/^[a-f0-9]{64}$/.test(descriptor.identityToken)
        ||routing.token(row.user_id,row.execution_mode,'EPISODE_FAMILY',row.family_key)!==row.family_token)invalid();
    } else if(row.entry_state!=='LEGACY_FAMILY_UNKNOWN'||row.descriptor_json!==null)invalid();
  };
  const verifyManifest=row=>{
    if(row.directory_version!==VERSION||row.manifest_hmac!==mac(['MANIFEST',...manifestValues(row)]))invalid();
    const tip=parse(row.route_tip_json);
    if(tip!==null&&(Object.keys(tip).sort().join(',')!=='chainDigest,entryCount'
      ||!/^[a-f0-9]{64}$/.test(tip.chainDigest)||!Number.isSafeInteger(tip.entryCount)||tip.entryCount<0))invalid();
  };
  const verifyTip=row=>{
    if(row.work_version!==VERSION||row.tip_hmac!==mac(['TIP',...tipValues(row)]))invalid();
    parse(row.requested_json);
    if(row.completed_json!==null)parse(row.completed_json);
    if(row.family_manifest_json!==null)parse(row.family_manifest_json);
  };
  const nextChain=(digest,entry)=>mac(['CHAIN',digest,entry.entry_hmac]);
  async function routeTip(context,metricKey) {
    return routing.tip(context,'EPISODE',[metricKey,phase4Metric(metricKey).domain]);
  }
  async function ensureManifest(context,sourceToken,state='COMPLETE',metricKey=null) {
    const found=(await client.execute({sql:`SELECT * FROM ${MANIFESTS} WHERE user_id=? AND execution_mode=? AND source_token=?`,
      args:[context.userId,context.executionMode,sourceToken]})).rows[0];
    if(found){verifyManifest(found);return found;}
    const row={user_id:context.userId,execution_mode:context.executionMode,source_token:sourceToken,
      entry_count:0,chain_digest:ZERO,route_tip_json:canonicalJson(metricKey?await routeTip(context,metricKey):null),
      directory_state:state,directory_version:VERSION};
    row.manifest_hmac=mac(['MANIFEST',...manifestValues(row)]);
    await client.execute({sql:`INSERT INTO ${MANIFESTS} VALUES (?,?,?,?,?,?,?,?,?)`,args:Object.values(row)});
    return row;
  }
  async function touchSource(context,metricKey) {
    const {token}=source(context,metricKey),prior=(await client.execute({sql:`SELECT * FROM ${MANIFESTS}
      WHERE user_id=? AND execution_mode=? AND source_token=?`,args:[context.userId,context.executionMode,token]})).rows[0];
    if(!prior&&(await routeTip(context,metricKey))?.entryCount>1)invalid();
    const current=prior??await ensureManifest(context,token,'COMPLETE',metricKey),
      nextTip=canonicalJson(await routeTip(context,metricKey));
    verifyManifest(current);
    if(current.route_tip_json===nextTip)return;
    const next={...current,route_tip_json:nextTip};
    next.manifest_hmac=mac(['MANIFEST',...manifestValues(next)]);
    await client.execute({sql:`UPDATE ${MANIFESTS} SET route_tip_json=?,manifest_hmac=?
      WHERE user_id=? AND execution_mode=? AND source_token=?`,
    args:[next.route_tip_json,next.manifest_hmac,context.userId,context.executionMode,token]});
  }
  async function markUnknown(context,metricKey) {
    const {token}=source(context,metricKey),old=await ensureManifest(context,token,'COMPLETE',metricKey);
    if(old.directory_state==='LEGACY_DIRECTORY_UNKNOWN')return;
    const next={...old,directory_state:'LEGACY_DIRECTORY_UNKNOWN'};
    next.manifest_hmac=mac(['MANIFEST',...manifestValues(next)]);
    await client.execute({sql:`UPDATE ${MANIFESTS} SET directory_state=?,manifest_hmac=?
      WHERE user_id=? AND execution_mode=? AND source_token=?`,
    args:[next.directory_state,next.manifest_hmac,context.userId,context.executionMode,token]});
  }
  async function requested(context) {
    const jobs=(await client.execute({sql:`SELECT MAX(requested_generation) generation,MAX(scope_revision) scope_revision
      FROM phase4_jobs WHERE user_id=? AND execution_mode=?`,args:[context.userId,context.executionMode]})).rows[0];
    return {inputGeneration:Math.max(context.inputGeneration??0,jobs?.generation??0),
      sourceGeneration:context.sourceGeneration??0,scopeRevision:jobs?.scope_revision??0,
      authGeneration:context.authGeneration??0,lifecycleGeneration:context.lifecycleGeneration??0,
      purgeGeneration:context.purgeGeneration??0,algorithmSetVersion:context.algorithmSetVersion??null};
  }
  async function putTip(row) {
    row.tip_hmac=mac(['TIP',...tipValues(row)]);
    await client.execute({sql:`INSERT INTO ${TIPS} VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(user_id,execution_mode,source_token,family_token) DO UPDATE SET
      requested_json=excluded.requested_json,completed_json=excluded.completed_json,
      family_manifest_json=excluded.family_manifest_json,tip_hmac=excluded.tip_hmac`,args:[
      row.user_id,row.execution_mode,row.source_token,row.family_token,row.requested_json,row.completed_json,
      row.family_manifest_json,row.work_version,row.tip_hmac]});
  }
  async function reconcileInterrupted(context,sourceToken,manifest) {
    const rows=(await client.execute({sql:`SELECT * FROM ${ENTRIES} WHERE user_id=? AND execution_mode=?
      AND source_token=? ORDER BY sequence`,args:[context.userId,context.executionMode,sourceToken]})).rows;
    if(manifest.entry_count>rows.length)invalid();
    let digest=ZERO;
    for(let i=0;i<rows.length;i++) {
      const entry=rows[i];verifyEntry(entry);if(entry.sequence!==i+1)invalid();digest=nextChain(digest,entry);
      if(i+1===manifest.entry_count&&digest!==manifest.chain_digest)invalid();
      if(i+1>manifest.entry_count) {
        const next={...manifest,entry_count:i+1,chain_digest:digest};
        next.manifest_hmac=mac(['MANIFEST',...manifestValues(next)]);
        await client.execute({sql:`UPDATE ${MANIFESTS} SET entry_count=?,chain_digest=?,manifest_hmac=?
          WHERE user_id=? AND execution_mode=? AND source_token=?`,args:[next.entry_count,next.chain_digest,
          next.manifest_hmac,context.userId,context.executionMode,sourceToken]});
        manifest=next;
      }
    }
    return manifest;
  }
  async function register(context,identity,{legacyToken=null,repairInterrupted=false}={}) {
    const {token:sourceToken,identity:metricIdentity}=source(context,identity.metric),
      resolved=legacyToken?{key:null,token:legacyToken}:family(context,identity);
    if(!legacyToken&&!same({...metricIdentity,windowFamily:identity.windowFamily},identity))invalid();
    let prior=await ensureManifest(context,sourceToken,'COMPLETE',identity.metric);
    if(repairInterrupted)prior=await reconcileInterrupted(context,sourceToken,prior);
    const found=(await client.execute({sql:`SELECT * FROM ${ENTRIES}
      WHERE user_id=? AND execution_mode=? AND source_token=? AND family_token=?`,
      args:[context.userId,context.executionMode,sourceToken,resolved.token]})).rows[0];
    if(found){
      verifyEntry(found);if(!legacyToken&&found.descriptor_json!==canonicalJson({identityToken:keys.lookup(
        ['stage6-family-descriptor-v1',context.userId,context.executionMode,identity])}))invalid();
      if(repairInterrupted) {
        const tip=(await client.execute({sql:`SELECT * FROM ${TIPS} WHERE user_id=? AND execution_mode=?
          AND source_token=? AND family_token=?`,args:[context.userId,context.executionMode,sourceToken,resolved.token]})).rows[0];
        if(!tip)await putTip({user_id:context.userId,execution_mode:context.executionMode,source_token:sourceToken,
          family_token:resolved.token,requested_json:canonicalJson(await requested(context)),completed_json:null,
          family_manifest_json:null,work_version:VERSION});
        else verifyTip(tip);
      }
      return {...found,newlyRegistered:false};
    }
    const row={user_id:context.userId,execution_mode:context.executionMode,source_token:sourceToken,
      sequence:prior.entry_count+1,family_token:resolved.token,family_key:resolved.key,
      descriptor_json:legacyToken?null:canonicalJson({identityToken:keys.lookup(
        ['stage6-family-descriptor-v1',context.userId,context.executionMode,identity])}),
      entry_state:legacyToken?'LEGACY_FAMILY_UNKNOWN':'KNOWN',
      directory_version:VERSION};
    row.entry_hmac=mac(['ENTRY',...entryValues(row)]);
    await client.execute({sql:`INSERT INTO ${ENTRIES} VALUES (?,?,?,?,?,?,?,?,?,?)`,args:[
      row.user_id,row.execution_mode,row.source_token,row.sequence,row.family_token,row.family_key,row.descriptor_json,
      row.entry_state,row.directory_version,row.entry_hmac]});
    const next={...prior,entry_count:row.sequence,chain_digest:nextChain(prior.chain_digest,row)};
    next.manifest_hmac=mac(['MANIFEST',...manifestValues(next)]);
    await client.execute({sql:`UPDATE ${MANIFESTS} SET entry_count=?,chain_digest=?,manifest_hmac=?
      WHERE user_id=? AND execution_mode=? AND source_token=?`,args:[next.entry_count,next.chain_digest,
      next.manifest_hmac,context.userId,context.executionMode,sourceToken]});
    const tip={user_id:context.userId,execution_mode:context.executionMode,source_token:sourceToken,
      family_token:row.family_token,requested_json:canonicalJson(await requested(context)),completed_json:null,
      family_manifest_json:null,work_version:VERSION};
    await putTip(tip);return {...row,newlyRegistered:true};
  }
  async function inventory(context,metricKey) {
    const {token:sourceToken}=source(context,metricKey);
    let manifest=(await client.execute({sql:`SELECT * FROM ${MANIFESTS} WHERE user_id=?
      AND execution_mode=? AND source_token=?`,args:[context.userId,context.executionMode,sourceToken]})).rows[0];
    if(!manifest) {
      // A new tenant with no routed history can initialize an empty signed
      // directory. Existing v29 activity may never be reclassified as empty.
      if(await routeTip(context,metricKey))invalid();
      manifest=await ensureManifest(context,sourceToken,'COMPLETE',metricKey);
    }
    verifyManifest(manifest);
    const rows=(await client.execute({sql:`SELECT * FROM ${ENTRIES} WHERE user_id=? AND execution_mode=?
      AND source_token=? ORDER BY sequence`,args:[context.userId,context.executionMode,sourceToken]})).rows;
    if(rows.length!==manifest.entry_count)invalid();
    let digest=ZERO;
    for(let i=0;i<rows.length;i++) {
      const row=rows[i];verifyEntry(row);if(row.sequence!==i+1)invalid();digest=nextChain(digest,row);
    }
    if(digest!==manifest.chain_digest)invalid();
    // The independently sealed v29 metric tip is a constant-size rollback
    // fence. Registration advances this tip in the same receipt transaction.
    // Family enumeration never opens or authenticates a broad receipt set.
    if(!same(parse(manifest.route_tip_json),await routeTip(context,metricKey)))invalid();
    const unknownEntries=rows.filter(row=>row.entry_state!=='KNOWN');
    if(manifest.directory_state!=='COMPLETE'&&!unknownEntries.length)unknown();
    return {sourceToken,manifest,entries:rows.filter(row=>row.entry_state==='KNOWN'),unknownEntries};
  }
  async function manifestTip(context,familyKey) {
    const proof=await routing.inventory(context,'EPISODE_FAMILY',familyKey,false,{metadataOnly:true});
    if(proof.unknown)unknown();
    return proof.manifest;
  }
  function resolveIdentity(context,entry,history) {
    verifyEntry(entry);
    for(const revisions of history.histories.values())for(const value of revisions.values()) {
      const receipt=value.receipt;
      if(!receipt)continue;
      const decoded=(receipt.request_json&&parse(receipt.request_json).request)||null;
      const candidate=receipt.operation_kind==='analyzeMetric'&&decoded?.metricKey?{
        metric:decoded.metricKey,domain:phase4Metric(decoded.metricKey).domain,
        algorithmMajor:INTELLIGENCE_VERSIONS.algorithm,subject:decoded.metricKey,windowFamily:decoded.windowFamily
      }:decoded?.identity;
      if(!candidate?.windowFamily)continue;
      const identity={metric:candidate.metric,domain:candidate.domain,algorithmMajor:candidate.algorithmMajor,
        subject:candidate.subject,windowFamily:candidate.windowFamily};
      if(family(context,identity).key!==entry.family_key
        ||entry.descriptor_json!==canonicalJson({identityToken:keys.lookup(
          ['stage6-family-descriptor-v1',context.userId,context.executionMode,identity])}))invalid();
      return identity;
    }
    fail('PHASE4_FAMILY_DIRECTORY_DESCRIPTOR_UNAVAILABLE');
  }
  async function work(context,entry) {
    const row=(await client.execute({sql:`SELECT * FROM ${TIPS} WHERE user_id=? AND execution_mode=?
      AND source_token=? AND family_token=?`,args:[context.userId,context.executionMode,
        entry.source_token,entry.family_token]})).rows[0];
    if(!row)invalid();verifyTip(row);
    const wanted=await requested(context),saved=parse(row.requested_json),currentTip=await manifestTip(context,entry.family_key);
    const due=!same(saved,wanted)||row.completed_json===null||!same(parse(row.completed_json),wanted)
      ||!same(row.family_manifest_json===null?null:parse(row.family_manifest_json),currentTip);
    return {row,wanted,currentTip,due};
  }
  async function complete(context,entry) {
    const state=await work(context,entry),row={...state.row,requested_json:canonicalJson(state.wanted),
      completed_json:canonicalJson(state.wanted),family_manifest_json:canonicalJson(state.currentTip)};
    await putTip(row);
  }
  async function allComplete(context,metricKey) {
    const directory=await inventory(context,metricKey);
    if(directory.unknownEntries.length)unknown();
    for(const entry of directory.entries)if((await work(context,entry)).due)return false;
    return true;
  }
  async function requestAll(context) {
    const rows=(await client.execute({sql:`SELECT * FROM ${TIPS} WHERE user_id=? AND execution_mode=?`,
      args:[context.userId,context.executionMode]})).rows;
    const wanted=canonicalJson(await requested(context));
    for(const row of rows) {
      verifyTip(row);
      if(row.requested_json!==wanted)await putTip({...row,requested_json:wanted});
    }
  }
  return {source,family,register,markUnknown,ensureManifest,touchSource,inventory,manifestTip,resolveIdentity,work,complete,allComplete,requestAll,
    verifyEntry,verifyManifest,verifyTip};
}
