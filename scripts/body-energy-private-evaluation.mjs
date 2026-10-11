/** Pure bounded evaluation. Root operator supplies already authorized in-memory
 * inputs; this module has no DB/provider, credentials, transport or file input. */
import {calculateBodyEnergy,robustBaseline} from '../src/bodyEnergy.js';
import {selectBodyEnergyInputs} from '../src/bodyEnergyInputs.js';
import {BODY_ENERGY as C} from '../src/bodyEnergyRegistry.js';
import {BODY_ENERGY_RELEASE_CRITERIA as CRITERIA} from '../src/bodyEnergyReleaseCriteria.js';

const fail=code=>{throw Object.assign(new Error(code),{code});};
const fields=['sleepPerformance','hrv','rhr','autonomic','loadDepletion','value'];
const add=(object,key)=>{object[key]=(object[key]??0)+1;};
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const q=x=>x===null?null:Number(x.toFixed(9));
const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&[Object.prototype,null].includes(Object.getPrototypeOf(x));
function shape(value,allowed,required=allowed){
  if(!plain(value)||Object.keys(value).some(key=>!allowed.includes(key))||required.some(key=>!Object.hasOwn(value,key)))
    fail('CAPTURE_MANIFEST_SHAPE_INVALID');
}
const snapshotFields={sleep:['id','health_date','start_at','end_at','nap','score_state','sleep_performance_percentage','updated_at','synced_at'],
  recovery:['sleep_id','health_date','score_state','user_calibrating','hrv_rmssd_milli','resting_heart_rate','updated_at','synced_at'],
  load:['id','start_at','end_at','strain','updated_at','synced_at']};
function normalizedCapture(manifest){
  const required=['manifest_version','algorithm_version','constants_version','baseline_version','constants_hash','metric_registry_version',
    'as_of_epoch_ms','as_of_utc','timezone','health_date','day_assignment','wake_at_utc','main_sleep','recovery','baseline','load','naps','sync',
    'access_evidence','capability_evidence','eligibility','warnings','reasons','exclusions'];
  shape(manifest,required.concat('input_generation','lifecycle_generation','auth_generation','source_generation'),required);
  const snap=(row,kind)=>{
    if(row===null)return;
    shape(row,snapshotFields[kind]);
    for(const field of ['updated_at','synced_at'])if(row[field]!==null
      &&(!Number.isFinite(Date.parse(row[field]))||Date.parse(row[field])>manifest.as_of_epoch_ms))fail('CAPTURE_SOURCE_AFTER_ASOF');
  };
  snap(manifest.main_sleep,'sleep');snap(manifest.recovery,'recovery');
  shape(manifest.baseline,['hrv','rhr']);
  for(const component of ['hrv','rhr']){
    const rows=manifest.baseline[component];if(!Array.isArray(rows)||rows.length>C.baselineTarget)fail('EVALUATION_BASELINE_LIMIT');
    for(const row of rows){shape(row,['health_date','value','sleep','recovery']);snap(row.sleep,'sleep');snap(row.recovery,'recovery');
      if(typeof row.health_date!=='string'||row.health_date>=manifest.health_date)fail('CAPTURE_BASELINE_NOT_EARLIER');}
  }
  shape(manifest.load,['kind','rows','sync']);
  if(!['NONE','CYCLE','WORKOUT'].includes(manifest.load.kind)||!Array.isArray(manifest.load.rows)
    ||manifest.load.rows.length>C.baselineLookback+1||manifest.load.kind==='CYCLE'&&manifest.load.rows.length!==1
    ||manifest.load.kind==='NONE'&&manifest.load.rows.length!==0)fail('CAPTURE_MANIFEST_SHAPE_INVALID');
  for(const row of manifest.load.rows)snap(row,'load');
  if(!Array.isArray(manifest.naps)||manifest.naps.length>C.baselineLookback+1)fail('CAPTURE_MANIFEST_SHAPE_INVALID');
  for(const nap of manifest.naps){shape(nap,['source','duration_minutes']);snap(nap.source,'sleep');}
  shape(manifest.sync,['sleep','recovery']);
  for(const row of [manifest.sync.sleep,manifest.sync.recovery,manifest.load.sync].filter(x=>x!==null)){
    shape(row,['resource','last_success_at','updated_at','age_ms']);
    for(const field of ['last_success_at','updated_at'])if(row[field]!==null
      &&(!Number.isFinite(Date.parse(row[field]))||Date.parse(row[field])>manifest.as_of_epoch_ms))fail('CAPTURE_SOURCE_AFTER_ASOF');
  }
  shape(manifest.eligibility,['unavailable','failed_required','matched_scored_recovery','required_sync_valid']);
  for(const name of ['warnings','reasons','exclusions','access_evidence','capability_evidence'])
    if(!Array.isArray(manifest[name]))fail('CAPTURE_MANIFEST_SHAPE_INVALID');
  if([...manifest.warnings,...manifest.reasons].some(x=>typeof x!=='string'||!/^[A-Z0-9_]+$/.test(x)))fail('CAPTURE_MANIFEST_SHAPE_INVALID');
  for(const row of manifest.exclusions)shape(row,['resource','id','reason']);
  for(const row of manifest.access_evidence)shape(row,['resource','status','auth_generation','lifecycle_generation']);
  for(const row of manifest.capability_evidence)shape(row,['key','status','lifecycle_generation']);
  return manifest;
}
function matrix(rows) {
  const out={};for(const x of fields){out[x]={};for(const y of fields){
    const pairs=rows.filter(r=>finite(r[x])&&finite(r[y])),n=pairs.length;
    if(n<2){out[x][y]={n,pearson:null,reason:'INSUFFICIENT_PAIRED_VARIATION'};continue;}
    const mx=pairs.reduce((s,r)=>s+r[x],0)/n,my=pairs.reduce((s,r)=>s+r[y],0)/n;let xx=0,yy=0,xy=0;
    for(const r of pairs){const dx=r[x]-mx,dy=r[y]-my;xx+=dx*dx;yy+=dy*dy;xy+=dx*dy;}
    out[x][y]={n,pearson:xx>0&&yy>0?q(xy/Math.sqrt(xx*yy)):null,
      reason:xx>0&&yy>0?null:'INSUFFICIENT_PAIRED_VARIATION'};
  }}return out;
}
function boundedManifest(entry,authorizedUsers,{genuine,evaluationEpochMs}) {
  if(!entry||!['CURRENT_CANONICAL','CAPTURED_MANIFEST'].includes(entry.kind))fail('EVALUATION_CAPTURE_KIND_REQUIRED');
  if(typeof entry.userId!=='string'||!authorizedUsers.has(entry.userId))fail('EVALUATION_USER_NOT_AUTHORIZED');
  if(Buffer.byteLength(JSON.stringify(entry),'utf8')>262144)fail('EVALUATION_CASE_SIZE_LIMIT');
  if(entry.kind==='CAPTURED_MANIFEST'){
    if(entry.provenance?.receiptVerified!==true||entry.provenance?.retainedContent!==true
      ||entry.provenance?.originalCapturedManifest!==true)fail('AUTHENTICATED_RETAINED_CAPTURE_REQUIRED');
    const manifest=entry.manifest;
    if(!manifest||manifest.baseline?.hrv?.length>C.baselineTarget||manifest.baseline?.rhr?.length>C.baselineTarget)
      fail('EVALUATION_BASELINE_LIMIT');
    normalizedCapture(manifest);
    if(genuine&&manifest.as_of_epoch_ms>evaluationEpochMs)fail('EVALUATION_FUTURE_CAPTURE');
    return manifest;
  }
  const input=entry.input;
  if(!input||input.userId!==entry.userId||entry.provenance?.currentCanonicalCapture!==true)
    fail('CURRENT_CANONICAL_CAPTURE_REQUIRED');
  if(!finite(entry.provenance.captureEpochMs)||entry.provenance.captureEpochMs!==input.asOfEpochMs)
    fail('CANONICAL_CAPTURE_ASOF_MISMATCH');
  if(genuine&&input.asOfEpochMs>evaluationEpochMs)fail('EVALUATION_FUTURE_CAPTURE');
  for(const rows of Object.values(input.sources??{})){
    if(!Array.isArray(rows)||rows.length>C.baselineLookback+1)fail('EVALUATION_CANONICAL_WINDOW_LIMIT');
    if(rows.some(r=>r.user_id!==entry.userId||Object.hasOwn(r,'raw_json')))fail('EVALUATION_SOURCE_SCOPE_REQUIRED');
  }
  for(const name of ['access','sync','capabilities','tombstones']){
    const rows=input[name]??[];
    if(!Array.isArray(rows)||rows.length>4*(C.baselineLookback+1)||rows.some(r=>r.user_id!==entry.userId))
      fail('EVALUATION_SOURCE_SCOPE_REQUIRED');
  }
  const selection=selectBodyEnergyInputs(input);
  if(selection.notReproducible)fail('NOT_REPRODUCIBLE_FROM_RETAINED_INPUTS');
  return selection.manifest;
}
function ablate(manifest) {
  const outputs={};
  for(const component of ['sleep','hrv','rhr','autonomic','load','nap']){
    const copy=structuredClone(manifest);
    if(component==='sleep'&&copy.main_sleep)copy.main_sleep.sleep_performance_percentage=null;
    if(['hrv','autonomic'].includes(component)&&copy.recovery)copy.recovery.hrv_rmssd_milli=null;
    if(['rhr','autonomic'].includes(component)&&copy.recovery)copy.recovery.resting_heart_rate=null;
    if(component==='load'){copy.load={kind:'NONE',rows:[],sync:null};copy.warnings=[...copy.warnings,'LOAD_UNAVAILABLE'];}
    if(component==='nap')copy.naps=[];
    const result=calculateBodyEnergy(copy);outputs[component]={value:result.value,quality:result.quality_state};
  }return outputs;
}
function analyticSensitivity(manifest,result) {
  const d=result.drivers,load=manifest.load;const points={
    initialSleepPercentage:C.initialGain*C.sleepWeight,initialAutonomic:C.initialGain*C.autonomicWeight,
    initialGain:d.domain_mean,sleepWeightWithSumFixed:d.sleep_domain===null||d.autonomic_domain===null?null:C.initialGain*(d.sleep_domain-d.autonomic_domain),
    earlyDepletion:-Math.min(d.wake_hours,C.firstWakeHours),lateDepletion:-Math.max(d.wake_hours-C.firstWakeHours,0),
  };
  if(load.kind==='CYCLE'){
    const strain=load.rows[0].strain;points.cycleMultiplier=-Math.pow(strain,C.cycleExponent);
    points.cycleExponent=strain===0?0:-C.cycleMultiplier*Math.pow(strain,C.cycleExponent)*Math.log(strain);
  }
  return points;
}

/** Entry attestations are operator evidence declarations, never runtime
 * authorization. The result ALWAYS requires actual independent qualification. */
export function evaluateBodyEnergyPrivate(request) {
  if(!request||request.contractVersion!=='body-energy-private-evaluation-input-v1'
    ||request.executionEnvironment!=='NON_PRODUCTION')fail('OFFLINE_EVALUATION_CONTRACT_REQUIRED');
  if(!['SYNTHETIC','GENUINE_AUTHORIZED_RETAINED_INPUTS'].includes(request.dataDeclaration))fail('EVALUATION_DATA_DECLARATION_REQUIRED');
  if(!Array.isArray(request.authorizedUserIds)||request.authorizedUserIds.length<1||request.authorizedUserIds.length>2
    ||request.authorizedUserIds.some(x=>typeof x!=='string'||!x))fail('EVALUATION_COHORT_LIMIT');
  if(!Array.isArray(request.cases)||request.cases.length<1||request.cases.length>C.baselineLookback)
    fail('EVALUATION_CASE_LIMIT');
  if(Buffer.byteLength(JSON.stringify(request),'utf8')>1048576)fail('EVALUATION_PAYLOAD_LIMIT');
  const users=new Set(request.authorizedUserIds),rows=[],qualities={},rejections={},range={},ablation={},sensitivity={},identities=new Set(),days=new Set();
  const evaluationEpochMs=Date.now(),genuine=request.dataDeclaration==='GENUINE_AUTHORIZED_RETAINED_INPUTS';
  let reproduced=0,eligible=0,requiredDomainAblationsNull=true;
  for(const entry of request.cases){
    try{
      const manifest=boundedManifest(entry,users,{genuine,evaluationEpochMs});
      const identity=JSON.stringify([entry.userId,manifest.health_date,manifest.as_of_epoch_ms,manifest.algorithm_version,manifest.input_generation??null]);
      if(identities.has(identity))fail('DUPLICATE_EVALUATION_CAPTURE');
      const result=calculateBodyEnergy(manifest);
      if(entry.kind==='CAPTURED_MANIFEST'){
        if(entry.savedValue!==result.value||entry.savedQuality!==result.quality_state)fail('CAPTURE_REPRODUCTION_MISMATCH');
      }
      // Stage every derived analysis before committing any successful-case
      // counter or row. Malformed captures cannot be accepted and rejected.
      const caseAblation=ablate(manifest),caseSensitivity=analyticSensitivity(manifest,result);
      if(entry.kind==='CAPTURED_MANIFEST')reproduced++;
      add(qualities,result.quality_state);
      const freshAge=Math.max(manifest.sync.sleep.age_ms??Infinity,manifest.sync.recovery.age_ms??Infinity,manifest.load.sync?.age_ms??Infinity);
      if(result.quality_state===CRITERIA.publicationQuality&&result.confidence>=CRITERIA.confidenceMinimum
        &&freshAge<=CRITERIA.freshMaximumMs&&result.value!==null)eligible++;
      const d=result.drivers;
      identities.add(identity);days.add(JSON.stringify([entry.userId,manifest.health_date]));
      rows.push({sleepPerformance:d.sleep_domain,hrv:manifest.recovery?.hrv_rmssd_milli??null,
        rhr:manifest.recovery?.resting_heart_rate??null,autonomic:d.autonomic_domain,loadDepletion:d.load_depletion,value:result.value});
      if(result.value!==null)add(range,result.value===100?'100':`${Math.floor(result.value/10)*10}-${Math.floor(result.value/10)*10+9}`);
      for(const [component,value] of Object.entries(caseAblation)){
        const slot=ablation[component]??={cases:0,null:0,quality:{},totalNumericDelta:0,pairedNumeric:0};slot.cases++;add(slot.quality,value.quality);
        if(value.value===null)slot.null++;
        if(['sleep','hrv','rhr','autonomic'].includes(component)&&value.value!==null)requiredDomainAblationsNull=false;
        if(value.value!==null&&result.value!==null){slot.totalNumericDelta+=value.value-result.value;slot.pairedNumeric++;}
      }
      for(const [coefficient,value] of Object.entries(caseSensitivity))if(finite(value)){
        const slot=sensitivity[coefficient]??={n:0,min:Infinity,max:-Infinity};slot.n++;slot.min=Math.min(slot.min,value);slot.max=Math.max(slot.max,value);
      }
    }catch(error){add(rejections,/^[A-Z0-9_]{1,96}$/.test(error?.code??'')?error.code:'EVALUATION_INPUT_INVALID');}
  }
  for(const slot of Object.values(ablation))slot.meanNumericDelta=slot.pairedNumeric?q(slot.totalNumericDelta/slot.pairedNumeric):null;
  return {
    summary:{reportVersion:'body-energy-private-evaluation-v1',criteriaVersion:CRITERIA.version,
      declaredData:request.dataDeclaration,executionEnvironment:'NON_PRODUCTION',casesRequested:request.cases.length,
      casesEvaluated:rows.length,distinctTenantHealthDays:days.size,eligibleAtCapturedInstant:eligible,capturedResultsReproduced:reproduced,qualityCounts:qualities,rejectionCounts:rejections,
      requiredDomainAblationInvariant:requiredDomainAblationsNull,publicationQualified:false,
      verdict:rows.length?'ANALYSIS_PREPARED_FOR_INDEPENDENT_QUALIFICATION':'NO_REPRODUCIBLE_EVALUATION_CASE',
      independentQualificationRequired:true,noMedicalOrOfficialWhoopAccuracyClaim:true,
      limitations:['Eligibility at captured instant is not current live eligibility.',
        'Operator declarations require independent evidence verification; software completion is not Final Gate approval.',
        'Constant or insufficient real paired inputs give undefined correlations; no empirical cutoff is invented.',
        'Multiple as-of captures from one tenant health day are not independent physiological samples; distinct day count is disclosed.',
        'No clinical truth, official WHOOP score agreement, or population capacity is measured.']},
    privateAnalysis:{handling:'PRIVATE_HEALTH_DERIVED_AGGREGATES_KEEP_OUTSIDE_GIT_LOGS_AND_RELEASE_ARTIFACTS',
      correlation:matrix(rows),scoreDistribution:range,inputAndDomainAblation:ablation,
      coefficientSensitivity:{method:'ANALYTIC_ORIGINAL_UNROUNDED_FORMULA_PARTIALS',ranges:sensitivity,
        caveat:'Clamps and rounding create piecewise-flat/boundary behavior. These are local analytic sensitivities, not alternate coefficient outputs or physiological calibration.'},
      boundaryAndDuplicateEvidence:'Reuse exact d0391/e1e10 independently PASS synthetic conformance evidence; empirical limitations require reviewer assessment.',
      temporalIntegrity:'Captured manifests only reproduce their original retained inputs. Current canonical capture uses its exact capture instant; future-ingested/versioned rows reject.'},
  };
}
