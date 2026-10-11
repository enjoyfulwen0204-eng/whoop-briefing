/** Pure bounded evaluation. Root operator supplies already authorized in-memory
 * inputs; this module has no DB/provider, credentials, transport or file input. */
import {calculateBodyEnergy,robustBaseline} from '../src/bodyEnergy.js';
import {selectBodyEnergyInputs,validHealthDate,exactBodyInstant} from '../src/bodyEnergyInputs.js';
import {canonicalJson} from '../src/phase4EntityStore.js';
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
const nullable=(value,predicate)=>value===null||predicate(value);
const scalarId=value=>nullable(value,x=>typeof x==='string'||finite(x));
const text=value=>typeof value==='string';
const generation=value=>Number.isSafeInteger(value)&&value>=0;
const dateParts=value=>value.match(/^(.+)-(\d{2})-(\d{2})$/).slice(1).map(Number);
const earlierDay=(value,anchor)=>{const a=dateParts(value),b=dateParts(anchor);return a[0]<b[0]||a[0]===b[0]&&(a[1]<b[1]||a[1]===b[1]&&a[2]<b[2]);};
function normalizedCapture(manifest){
  const required=['manifest_version','algorithm_version','constants_version','baseline_version','constants_hash','metric_registry_version',
    'as_of_epoch_ms','as_of_utc','timezone','health_date','day_assignment','wake_at_utc','main_sleep','recovery','baseline','load','naps','sync',
    'access_evidence','capability_evidence','eligibility','warnings','reasons','exclusions'];
  shape(manifest,required.concat('input_generation','lifecycle_generation','auth_generation','source_generation','notification_workouts'),required);
  const invalid=()=>fail('CAPTURE_MANIFEST_SHAPE_INVALID');
  for(const field of ['manifest_version','algorithm_version','constants_version','baseline_version','constants_hash','metric_registry_version','timezone'])
    if(!text(manifest[field]))invalid();
  exactBodyInstant(manifest.as_of_epoch_ms,manifest.as_of_utc);
  if(!validHealthDate(manifest.health_date)||!['MAIN_SLEEP_END','REQUESTED_UNANCHORED','AS_OF_UNANCHORED'].includes(manifest.day_assignment))invalid();
  try{new Intl.DateTimeFormat('en-US',{timeZone:manifest.timezone});}catch{invalid();}
  for(const key of ['input_generation','lifecycle_generation','auth_generation','source_generation'])
    if(Object.hasOwn(manifest,key)&&!generation(manifest[key]))invalid();
  const timestamp=value=>{
    if(value===null)return;
    if(!text(value)||!Number.isFinite(Date.parse(value)))invalid();
    if(Date.parse(value)>manifest.as_of_epoch_ms)fail('CAPTURE_SOURCE_AFTER_ASOF');
  };
  timestamp(manifest.wake_at_utc);
  const snap=(row,kind)=>{
    if(row===null)return;
    shape(row,snapshotFields[kind]);
    if(!scalarId(row[kind==='recovery'?'sleep_id':'id']))invalid();
    for(const field of ['start_at','end_at','updated_at','synced_at'].filter(x=>Object.hasOwn(row,x)))timestamp(row[field]);
    if(kind!=='load'){
      if(!nullable(row.health_date,validHealthDate)||!nullable(row.score_state,text))invalid();
      if(kind==='sleep'){
        if(!nullable(row.nap,x=>x===0||x===1)||!nullable(row.sleep_performance_percentage,finite))invalid();
      }else if(!nullable(row.user_calibrating,x=>x===0||x===1)
        ||!nullable(row.hrv_rmssd_milli,finite)||!nullable(row.resting_heart_rate,finite))invalid();
    }else if(!nullable(row.strain,finite))invalid();
  };
  snap(manifest.main_sleep,'sleep');snap(manifest.recovery,'recovery');
  shape(manifest.baseline,['hrv','rhr']);
  for(const component of ['hrv','rhr']){
    const rows=manifest.baseline[component];if(!Array.isArray(rows)||rows.length>C.baselineTarget)fail('EVALUATION_BASELINE_LIMIT');
    const days=new Set();
    for(const row of rows){shape(row,['health_date','value','sleep','recovery']);snap(row.sleep,'sleep');snap(row.recovery,'recovery');
      if(!validHealthDate(row.health_date)||!earlierDay(row.health_date,manifest.health_date))fail('CAPTURE_BASELINE_NOT_EARLIER');
      if(days.has(row.health_date))fail('CAPTURE_BASELINE_DUPLICATE_DAY');days.add(row.health_date);
      const field=component==='hrv'?'hrv_rmssd_milli':'resting_heart_rate';
      if(!finite(row.value)||row.value<=0||!row.sleep||!row.recovery||row.value!==row.recovery[field]
        ||String(row.sleep.id)!==String(row.recovery.sleep_id))invalid();
    }
  }
  shape(manifest.load,['kind','rows','sync']);
  if(!['NONE','CYCLE','WORKOUT'].includes(manifest.load.kind)||!Array.isArray(manifest.load.rows)
    ||manifest.load.rows.length>C.baselineLookback+1||manifest.load.kind==='CYCLE'&&manifest.load.rows.length!==1
    ||manifest.load.kind==='NONE'&&manifest.load.rows.length!==0)invalid();
  for(const row of manifest.load.rows)snap(row,'load');
  if(!Array.isArray(manifest.naps)||manifest.naps.length>C.baselineLookback+1)invalid();
  for(const nap of manifest.naps){shape(nap,['source','duration_minutes']);snap(nap.source,'sleep');
    if(!nap.source||!finite(nap.duration_minutes)||nap.duration_minutes<=0)invalid();}
  shape(manifest.sync,['sleep','recovery']);
  for(const [expected,row] of [['sleep',manifest.sync.sleep],['recovery',manifest.sync.recovery],
    [manifest.load.kind==='CYCLE'?'cycle':'workout',manifest.load.sync]]){
    if(row===null){if(expected==='sleep'||expected==='recovery'||manifest.load.kind!=='NONE')invalid();continue;}
    shape(row,['resource','last_success_at','updated_at','age_ms']);
    if(row.resource!==expected||!nullable(row.age_ms,x=>finite(x)&&x>=0))invalid();
    timestamp(row.last_success_at);timestamp(row.updated_at);
    if(row.last_success_at===null?row.age_ms!==null:row.age_ms!==manifest.as_of_epoch_ms-Date.parse(row.last_success_at))invalid();
  }
  if(manifest.load.kind==='NONE'&&manifest.load.sync!==null)invalid();
  shape(manifest.eligibility,['unavailable','failed_required','matched_scored_recovery','required_sync_valid']);
  if(Object.values(manifest.eligibility).some(x=>typeof x!=='boolean'))invalid();
  for(const name of ['warnings','reasons','exclusions','access_evidence','capability_evidence'])
    if(!Array.isArray(manifest[name]))invalid();
  if([...manifest.warnings,...manifest.reasons].some(x=>typeof x!=='string'||!/^[A-Z0-9_]{1,96}$/.test(x)))invalid();
  for(const row of manifest.exclusions){shape(row,['resource','id','reason','source_version'],['resource','id','reason']);if(!text(row.resource)||!scalarId(row.id)||!text(row.reason))invalid();
    if(row.source_version!=null){shape(row.source_version,['updated_at','synced_at']);timestamp(row.source_version.updated_at);timestamp(row.source_version.synced_at);}}
  for(const row of manifest.access_evidence){shape(row,['resource','status','auth_generation','lifecycle_generation']);
    if(!text(row.resource)||!text(row.status)||!generation(row.auth_generation)||!generation(row.lifecycle_generation))invalid();}
  for(const row of manifest.capability_evidence){shape(row,['key','status','lifecycle_generation']);
    if(!text(row.key)||!text(row.status)||!generation(row.lifecycle_generation))invalid();}
  if(Object.hasOwn(manifest,'notification_workouts')){
    const events=manifest.notification_workouts;shape(events,['version','rows','sync']);
    if(events.version!=='body-energy-workout-event-v1'||!Array.isArray(events.rows)||events.rows.length>128)invalid();
    const seen=new Set();for(const row of events.rows){
      shape(row,['id','start_at','end_at','strain','created_at','updated_at','synced_at']);
      if(!text(row.id)||!row.id||row.id.length>256||seen.has(row.id)||!nullable(row.strain,finite))invalid();seen.add(row.id);
      for(const field of ['start_at','end_at','created_at','updated_at','synced_at'])timestamp(row[field]);
      if(!text(row.start_at)||!text(row.updated_at)||!text(row.synced_at)||!text(manifest.wake_at_utc)
        ||Date.parse(row.start_at)<Date.parse(manifest.wake_at_utc)||row.end_at!==null&&Date.parse(row.end_at)<=Date.parse(row.start_at))invalid();
    }
    if(events.sync!==null){shape(events.sync,['resource','last_success_at','updated_at','age_ms']);
      timestamp(events.sync.last_success_at);timestamp(events.sync.updated_at);
      if(events.sync.resource!=='workout'||!text(events.sync.last_success_at)||!text(events.sync.updated_at)
        ||!finite(events.sync.age_ms)||events.sync.age_ms<0
        ||events.sync.age_ms!==manifest.as_of_epoch_ms-Date.parse(events.sync.last_success_at))invalid();
    }else if(events.rows.length)invalid();
  }
  return manifest;
}
function matrix(rows,columns=fields) {
  const out={};for(const x of columns){out[x]={};for(const y of columns){
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
  return normalizedCapture(selection.manifest);
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

// These earlier-only observed input pairs are NOT historical Body Energy
// scores. Repeated captures of the same tenant/day/source do not add samples;
// conflicting retained source revisions omit that pair from the correlation.
function earlierInputPairs(userId,manifest){
  const rhr=new Map(manifest.baseline.rhr.map(row=>[JSON.stringify([row.health_date,String(row.sleep.id)]),row]));
  return manifest.baseline.hrv.flatMap(row=>{
    const pair=rhr.get(JSON.stringify([row.health_date,String(row.sleep.id)]));
    if(!pair||canonicalJson(row.sleep)!==canonicalJson(pair.sleep)||canonicalJson(row.recovery)!==canonicalJson(pair.recovery))return [];
    const sleep=row.sleep.sleep_performance_percentage;
    if(!finite(sleep)||sleep<0||sleep>100)return [];
    return [{identity:JSON.stringify([userId,row.health_date,String(row.sleep.id)]),
      revision:canonicalJson([row.sleep,row.recovery]),values:{sleepPerformance:sleep,hrv:row.value,rhr:pair.value}}];
  });
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
  const users=new Set(request.authorizedUserIds),rows=[],qualities={},rejections={},range={},ablation={},sensitivity={},identities=new Set(),days=new Set(),earlierPairs=new Map();
  const evaluationEpochMs=Date.now(),genuine=request.dataDeclaration==='GENUINE_AUTHORIZED_RETAINED_INPUTS';
  let reproduced=0,eligible=0,requiredDomainAblationsNull=true,earlierPairConflicts=0;
  for(const entry of request.cases){
    try{
      const manifest=boundedManifest(entry,users,{genuine,evaluationEpochMs});
      const identity=JSON.stringify([entry.userId,manifest.health_date,manifest.as_of_epoch_ms,manifest.algorithm_version,manifest.input_generation??null]);
      if(identities.has(identity))fail('DUPLICATE_EVALUATION_CAPTURE');
      const result=calculateBodyEnergy(manifest);
      if(entry.kind==='CAPTURED_MANIFEST'){
        if(entry.savedValue!==result.value||entry.savedQuality!==result.quality_state)fail('CAPTURE_REPRODUCTION_MISMATCH');
      }
      // Stage ALL potentially throwing derived work before any successful-case
      // mutation. A rejected capture cannot advance rows, quality or counters.
      const caseAblation=ablate(manifest),caseSensitivity=analyticSensitivity(manifest,result);
      const freshAge=Math.max(manifest.sync.sleep.age_ms??Infinity,manifest.sync.recovery.age_ms??Infinity,manifest.load.sync?.age_ms??Infinity);
      const caseEligible=result.quality_state===CRITERIA.publicationQuality&&result.confidence>=CRITERIA.confidenceMinimum
        &&freshAge<=CRITERIA.freshMaximumMs&&result.value!==null;
      const d=result.drivers,caseRow={sleepPerformance:d.sleep_domain,hrv:manifest.recovery?.hrv_rmssd_milli??null,
        rhr:manifest.recovery?.resting_heart_rate??null,autonomic:d.autonomic_domain,loadDepletion:d.load_depletion,value:result.value};
      const dayIdentity=JSON.stringify([entry.userId,manifest.health_date]);
      const rangeKey=result.value===null?null:result.value===100?'100':`${Math.floor(result.value/10)*10}-${Math.floor(result.value/10)*10+9}`;
      const casePairs=earlierInputPairs(entry.userId,manifest);
      // The following commit uses only validated primitive values and staged
      // plain structures; it performs no calculator, timestamp or coercion work.
      if(entry.kind==='CAPTURED_MANIFEST')reproduced++;
      add(qualities,result.quality_state);if(caseEligible)eligible++;
      identities.add(identity);days.add(dayIdentity);rows.push(caseRow);
      if(rangeKey!==null)add(range,rangeKey);
      for(const pair of casePairs){
        const previous=earlierPairs.get(pair.identity);
        if(previous===undefined)earlierPairs.set(pair.identity,pair);
        else if(previous!==null&&previous.revision!==pair.revision){earlierPairs.set(pair.identity,null);earlierPairConflicts++;}
      }
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
      correlation:matrix(rows),
      earlierBaselineInputCorrelation:{method:'EARLIER_ONLY_MATCHED_OBSERVED_INPUT_PAIRS_NOT_HISTORICAL_BODY_ENERGY_SCORES',
        pairedTenantDays:[...earlierPairs.values()].filter(Boolean).length,conflictingSourceRevisionsOmitted:earlierPairConflicts,
        matrix:matrix([...earlierPairs.values()].filter(Boolean).map(pair=>pair.values),['sleepPerformance','hrv','rhr'])},
      scoreDistribution:range,inputAndDomainAblation:ablation,
      coefficientSensitivity:{method:'ANALYTIC_ORIGINAL_UNROUNDED_FORMULA_PARTIALS',ranges:sensitivity,
        caveat:'Clamps and rounding create piecewise-flat/boundary behavior. These are local analytic sensitivities, not alternate coefficient outputs or physiological calibration.'},
      boundaryAndDuplicateEvidence:'Reuse exact d0391/e1e10 independently PASS synthetic conformance evidence; empirical limitations require reviewer assessment.',
      temporalIntegrity:'Captured manifests only reproduce their original retained inputs. Current canonical capture uses its exact capture instant; future-ingested/versioned rows reject.'},
  };
}
