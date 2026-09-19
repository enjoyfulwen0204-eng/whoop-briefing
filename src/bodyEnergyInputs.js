import { localDate } from './time.js';
import { BODY_ENERGY as C, BODY_ENERGY_CONSTANTS_HASH } from './bodyEnergyRegistry.js';
import { fail } from './phase4Core.js';
import { canonicalJson } from './phase4EntityStore.js';

export const binaryCompare=(a,b)=>a<b?-1:a>b?1:0;
export const instant=value=>typeof value==='string'&&value.trim()!==''&&Number.isFinite(Date.parse(value))?Date.parse(value):null;
export function exactBodyInstant(ms,iso) {
  if(!Number.isSafeInteger(ms)||Math.abs(ms)>8640000000000000)fail('PHASE4_INVALID_EXACT_AS_OF');
  const canonical=new Date(ms).toISOString();
  if(iso!==undefined&&canonical!==iso)fail('PHASE4_INVALID_EXACT_AS_OF');
  return canonical;
}
// src/time.js is authoritative for ordinary calendar years. Its formatting
// predates expanded ISO years; preserve the full JS Date identity at the edges.
export function bodyHealthDate(ms,timezone) {
  const parts=new Intl.DateTimeFormat('en-US',{timeZone:timezone,era:'short',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(ms));
  const p=Object.fromEntries(parts.map(x=>[x.type,x.value])),year=p.era==='BC'?1-Number(p.year):Number(p.year);
  if(year>=1000&&year<=9999)return localDate(new Date(ms),timezone);
  const y=year>=0&&year<=9999?String(year).padStart(4,'0'):`${year<0?'-':'+'}${String(Math.abs(year)).padStart(6,'0')}`;
  return `${y}-${p.month}-${p.day}`;
}
export function validHealthDate(value) {
  if(typeof value!=='string'||!/^([0-9]{4}|[+-][0-9]{6})-\d{2}-\d{2}$/.test(value))return false;
  const [,year,month,day]=value.match(/^(.+)-(\d{2})-(\d{2})$/),y=Number(year),m=Number(month),d=Number(day);
  if(year.startsWith('+')&&y<=9999||year==='-000000')return false;
  const leap=y%4===0&&(y%100!==0||y%400===0);
  return m>=1&&m<=12&&d>=1&&d<=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31][m-1];
}
// Proleptic Gregorian day ordinal, including local dates just outside the UTC
// Date endpoints. Calendar lookback is not elapsed-time depletion arithmetic.
const dayOrdinal=value=>{
  const [,year,month,day]=value.match(/^(.+)-(\d{2})-(\d{2})$/);let y=Number(year);const m=Number(month),d=Number(day);
  y-=m<=2?1:0;const era=Math.floor(y/400),yoe=y-era*400;
  return era*146097+yoe*365+Math.floor(yoe/4)-Math.floor(yoe/100)+Math.floor((153*(m+(m>2?-3:9))+2)/5)+d-1;
};
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const normalized=value=>value==null?null:finite(value)?(Object.is(value,-0)?0:value):typeof value==='number'?null:value;
const project=(row,fields)=>row?Object.fromEntries(fields.map(k=>[k,normalized(row[k])])):null;
const common=['updated_at','synced_at'];
const fields={
  sleep:['id','health_date','start_at','end_at','nap','score_state','sleep_performance_percentage',...common],
  recovery:['sleep_id','health_date','score_state','user_calibrating','hrv_rmssd_milli','resting_heart_rate',...common],
  cycle:['id','start_at','end_at','strain',...common],workout:['id','start_at','end_at','strain',...common],
};
const sleepOrder=(a,b)=>instant(b.end_at)-instant(a.end_at)
  ||(instant(b.updated_at)??-Infinity)-(instant(a.updated_at)??-Infinity)||binaryCompare(String(a.id),String(b.id));

/** Pure adapter over explicitly supplied canonical rows. Database authority is
 * supplied by bodyEnergyStore, never by these testable data-only selectors.
 * Only score-relevant columns are captured; raw_json/Recovery score/free text
 * cannot enter the manifest, confidence, drivers or hashes. */
export function selectBodyEnergyInputs(input) {
  const {userId,timezone,asOfEpochMs:asOf,authGeneration,lifecycleGeneration,targetHealthDate=null}=input;
  exactBodyInstant(asOf);
  if(targetHealthDate!==null&&!validHealthDate(targetHealthDate))fail('BODY_ENERGY_INVALID_HEALTH_DATE');
  const reasons=new Set(),exclusions=[],references=new Map(),warnings=new Set();
  let failedRequired=false,notReproducible=false,matchedScoredRecovery=false;
  const owned=rows=>(rows||[]).filter(r=>r.user_id===userId);
  const sources=Object.fromEntries(Object.keys(fields).map(type=>[type,owned(input.sources?.[type])]));
  const access=owned(input.access),syncRows=owned(input.sync),caps=owned(input.capabilities),tombstones=owned(input.tombstones);
  const accessible=type=>authGeneration>0&&access.some(r=>r.resource===type&&r.status==='ACCESSIBLE'
    &&r.auth_generation===authGeneration&&r.lifecycle_generation===lifecycleGeneration);
  const unsupported=caps.some(r=>r.lifecycle_generation===lifecycleGeneration&&['sleep_performance','hrv','rhr'].includes(r.key)
    &&['UNSUPPORTED','UNAVAILABLE','UNAUTHORIZED','APP_ONLY_UNAVAILABLE_TO_API'].includes(r.status));
  const unavailable=authGeneration<1||input.lifecycleValid===false||unsupported||!accessible('sleep')||!accessible('recovery');
  // V20 has no revision archive. Even an overwritten row whose corrected end
  // moved beyond as-of cannot be treated as proof that the earlier row did not
  // exist. A saved manifest can still replay; uncaptured history fails closed.
  notReproducible=Object.entries(sources).some(([type,rows])=>accessible(type)&&rows.some(row=>
    (instant(row.synced_at)??-Infinity)>asOf||(instant(row.updated_at)??-Infinity)>asOf));
  if(unavailable)reasons.add(unsupported?'REQUIRED_CAPABILITY_UNAVAILABLE':'REQUIRED_RESOURCE_FENCED');
  const idOf=(type,row)=>String(row[type==='recovery'?'sleep_id':'id']);
  const deleted=(type,row)=>tombstones.some(t=>t.resource_type===type&&String(t.resource_id)===idOf(type,row)&&t.state==='ACTIVE');
  const reference=(type,row)=>references.set(canonicalJson([type,idOf(type,row)]),{type,id:idOf(type,row)});
  function exclude(type,row,reason) {
    // Tombstoned/inaccessible source metadata is not copied into a new result.
    const retain=accessible(type)&&!deleted(type,row);
    exclusions.push({resource:type,id:retain?idOf(type,row):null,reason});
    if(retain)reference(type,row);
  }
  function version(type,row) {
    if(!accessible(type)){exclude(type,row,'RESOURCE_FENCED');return false;}
    if(deleted(type,row)){exclude(type,row,'SOURCE_DELETED');return false;}
    const synced=instant(row.synced_at),updated=instant(row.updated_at);
    if(synced===null||row.updated_at!=null&&updated===null){exclude(type,row,'INVALID_VERSION_EVIDENCE');return false;}
    if(synced>asOf||updated!==null&&updated>asOf){exclude(type,row,'SOURCE_AFTER_AS_OF');notReproducible=true;return false;}
    return true;
  }
  function observe(type,row,day=null) {
    reference(type,row);
    if(row.updated_at==null)warnings.add('SOURCE_VERSION_UNKNOWN');
    if(day!==null&&row.health_date!==day)warnings.add('HEALTH_DATE_REALIGNMENT');
    return project(row,fields[type]);
  }
  function synchronization(type) {
    const rows=syncRows.filter(r=>r.resource===type);
    if(rows.length>1)fail('BODY_ENERGY_DUPLICATE_SYNC');
    const row=rows[0],success=instant(row?.last_success_at),updated=instant(row?.updated_at);
    if(success!==null&&updated!==null&&(success>asOf||updated>asOf))notReproducible=true;
    const valid=accessible(type)&&success!==null&&updated!==null&&success<=asOf&&updated<=asOf;
    return {resource:type,last_success_at:valid?row.last_success_at:null,updated_at:valid?row.updated_at:null,
      age_ms:valid?asOf-success:null};
  }
  const sync={sleep:synchronization('sleep'),recovery:synchronization('recovery')};
  for(const type of ['sleep','recovery']) {
    const age=sync[type].age_ms;
    if(age===null||age>C.requiredSyncMaxHours*3600000){reasons.add(`${type.toUpperCase()}_SYNC_${age===null?'MISSING':'EXPIRED'}`);failedRequired=true;}
    else if(age>C.freshMinutes*60000)warnings.add(`${type.toUpperCase()}_STALE`);
  }
  const candidates=[];
  for(const row of sources.sleep) {
    if(row.nap!==0)continue;
    const start=instant(row.start_at),end=instant(row.end_at);
    if(start===null||end===null||start>=end){exclude('sleep',row,'INVALID_SLEEP_INTERVAL');continue;}
    // Future physiological events cannot affect this earlier calculation.
    if(end>asOf)continue;
    const day=bodyHealthDate(end,timezone);
    const anchorDay=targetHealthDate??bodyHealthDate(asOf,timezone);
    const distance=dayOrdinal(anchorDay)-dayOrdinal(day);
    if(distance>C.baselineLookback+2)continue;
    if(row.score_state!=='SCORED'){exclude('sleep',row,'MAIN_SLEEP_UNSCORED');continue;}
    if(version('sleep',row))candidates.push({...row,computed_day:day});
  }
  candidates.sort(sleepOrder);
  const main=candidates.find(r=>asOf-instant(r.end_at)<=C.wakeMaxHours*3600000&&(targetHealthDate===null||r.computed_day===targetHealthDate))??null;
  const healthDate=main?.computed_day??targetHealthDate??bodyHealthDate(asOf,timezone);
  const dayAssignment=main?'MAIN_SLEEP_END':targetHealthDate?'REQUESTED_UNANCHORED':'AS_OF_UNANCHORED';
  const wake=main?instant(main.end_at):null;
  function recoveryFor(sleep,current) {
    const matches=sources.recovery.filter(r=>String(r.sleep_id)===String(sleep.id));
    if(matches.length>1)fail('BODY_ENERGY_DUPLICATE_MATCHED_RECOVERY');
    const row=matches[0];
    if(!row||row.score_state!=='SCORED'){if(row)exclude('recovery',row,'RECOVERY_UNSCORED');return null;}
    if(current)matchedScoredRecovery=!deleted('recovery',row)&&accessible('recovery');
    if(!version('recovery',row)){if(current){warnings.add('RECOVERY_VERSION_INVALID');failedRequired=true;}return null;}
    if(row.user_calibrating!==0){exclude('recovery',row,'RECOVERY_CALIBRATION_UNVERIFIED');if(current)warnings.add('RECOVERY_CALIBRATION_UNVERIFIED');}
    return row;
  }
  const recovery=main?recoveryFor(main,true):null;
  if(!main)reasons.add('MAIN_SLEEP_MISSING');
  if(main&&!recovery)reasons.add('MATCHED_RECOVERY_MISSING');
  const mainSnapshot=main?observe('sleep',main,healthDate):null;
  const recoverySnapshot=recovery?observe('recovery',recovery,healthDate):null;
  for(const [raw,name,valid] of [[main?.sleep_performance_percentage,'SLEEP_PERFORMANCE',x=>x>=0&&x<=100],
    [recovery?.hrv_rmssd_milli,'HRV',x=>x>0],[recovery?.resting_heart_rate,'RHR',x=>x>0]])
    if(raw!=null&&(!finite(raw)||!valid(raw))){warnings.add(`${name}_INVALID`);failedRequired=true;}
  const baseline={hrv:[],rhr:[]},daily=new Map();
  const targetDay=dayOrdinal(healthDate);
  for(const row of candidates) {
    const distance=targetDay-dayOrdinal(row.computed_day);
    if(distance>=1&&distance<=C.baselineLookback&&!daily.has(row.computed_day))daily.set(row.computed_day,row);
  }
  for(const [day,sleep] of [...daily].sort(([a],[b])=>dayOrdinal(b)-dayOrdinal(a))) {
    const recovery=recoveryFor(sleep,false);
    if(!recovery||recovery.user_calibrating!==0){exclusions.push({resource:'baseline',id:String(sleep.id),reason:'BASELINE_RECOVERY_UNAVAILABLE'});reference('sleep',sleep);continue;}
    for(const [component,field] of [['hrv','hrv_rmssd_milli'],['rhr','resting_heart_rate']]) {
      if(baseline[component].length>=C.baselineTarget)continue;
      if(!finite(recovery[field])||recovery[field]<=0){exclude('recovery',recovery,`BASELINE_${component.toUpperCase()}_INVALID`);continue;}
      baseline[component].push({health_date:day,value:recovery[field],sleep:observe('sleep',sleep,day),recovery:observe('recovery',recovery,day)});
    }
  }
  let load={kind:'NONE',rows:[],sync:null},naps=[];
  if(wake!==null) {
    const cycleSync=synchronization('cycle'),workoutSync=()=>synchronization('workout');
    const cycles=[];
    if(cycleSync.age_ms!==null&&cycleSync.age_ms<=C.loadSyncMaxHours*3600000)for(const row of sources.cycle) {
      const start=instant(row.start_at),end=row.end_at===null?asOf:instant(row.end_at);
      if(start===null||end===null||start>asOf||end>asOf||start>wake||end<wake||end<start||Math.abs(start-wake)>C.cycleWakeToleranceHours*3600000)continue;
      if(!version('cycle',row))continue;
      if(!finite(row.strain)||row.strain<0||row.strain>C.strainMax){exclude('cycle',row,'CYCLE_STRAIN_INVALID');continue;}
      cycles.push(row);
    }
    cycles.sort((a,b)=>instant(b.start_at)-instant(a.start_at)||binaryCompare(String(a.id),String(b.id)));
    if(cycles.length)load={kind:'CYCLE',rows:[observe('cycle',cycles[0])],sync:cycleSync};
    else {
      const currentSync=workoutSync(),workouts=[];
      if(currentSync.age_ms!==null&&currentSync.age_ms<=C.loadSyncMaxHours*3600000)for(const row of sources.workout) {
        const start=instant(row.start_at),end=instant(row.end_at);
        if(start===null||start>asOf)continue;
        if(row.end_at==null){exclude('workout',row,'ONGOING_WORKOUT_EXCLUDED');continue;}
        if(end===null||end<=start||end>asOf)continue;
        if(start<wake){if(end>wake)exclude('workout',row,'CROSSING_WAKE_WORKOUT_EXCLUDED');continue;}
        if(!version('workout',row))continue;
        if(!finite(row.strain)||row.strain<0||row.strain>C.strainMax){exclude('workout',row,'WORKOUT_STRAIN_INVALID');continue;}
        workouts.push(row);
      }
      workouts.sort((a,b)=>binaryCompare(String(a.id),String(b.id)));
      if(workouts.length)load={kind:'WORKOUT',rows:workouts.map(r=>observe('workout',r)),sync:currentSync};
    }
    const seen=new Map();
    for(const row of sources.sleep.filter(r=>r.nap===1).sort((a,b)=>binaryCompare(String(a.id),String(b.id)))) {
      const start=instant(row.start_at),end=instant(row.end_at),minutes=(end-start)/60000;
      if(row.id==null||row.id==='')continue;
      const normalized=canonicalJson(project(row,fields.sleep));
      if(seen.has(String(row.id))) {
        if(seen.get(String(row.id))!==normalized)fail('BODY_ENERGY_DUPLICATE_NAP_CONFLICT');
        continue;
      }
      seen.set(String(row.id),normalized);
      if(row.score_state!=='SCORED'||start===null||end===null||end<=wake||end>asOf||start>=end
        ||minutes<C.napMinMinutes||minutes>C.napMaxMinutes||asOf-end<C.napWaitMinutes*60000)continue;
      if(version('sleep',row))naps.push({source:observe('sleep',row),duration_minutes:minutes});
    }
  }
  if(load.kind==='NONE')warnings.add('LOAD_UNAVAILABLE');
  else if(load.sync.age_ms>C.freshMinutes*60000)warnings.add(`${load.kind==='CYCLE'?'CYCLE':'WORKOUT'}_STALE`);
  for(const code of warnings)reasons.add(code);
  const manifest={manifest_version:C.manifest,algorithm_version:C.algorithm,constants_version:C.constants,baseline_version:C.baseline,
    constants_hash:BODY_ENERGY_CONSTANTS_HASH,
    metric_registry_version:C.metrics,as_of_epoch_ms:asOf,as_of_utc:exactBodyInstant(asOf),timezone,health_date:healthDate,
    day_assignment:dayAssignment,wake_at_utc:wake===null?null:exactBodyInstant(wake),
    main_sleep:mainSnapshot,recovery:recoverySnapshot,baseline,load,naps,sync,
    access_evidence:access.filter(r=>r.auth_generation===authGeneration&&r.lifecycle_generation===lifecycleGeneration)
      .map(r=>project(r,['resource','status','auth_generation','lifecycle_generation'])).sort((a,b)=>binaryCompare(canonicalJson(a),canonicalJson(b))),
    capability_evidence:caps.filter(r=>r.lifecycle_generation===lifecycleGeneration&&['sleep_performance','hrv','rhr'].includes(r.key))
      .map(r=>project(r,['key','status','lifecycle_generation'])).sort((a,b)=>binaryCompare(canonicalJson(a),canonicalJson(b))),
    eligibility:{unavailable,failed_required:failedRequired,matched_scored_recovery:matchedScoredRecovery,
      required_sync_valid:Object.values(sync).every(r=>r.age_ms!==null&&r.age_ms<=C.requiredSyncMaxHours*3600000)},
    warnings:[...warnings].sort(),reasons:[...reasons].sort(),
    exclusions:exclusions.sort((a,b)=>binaryCompare(canonicalJson(a),canonicalJson(b)))};
  return {manifest,notReproducible,references:[...references.values()].sort((a,b)=>binaryCompare(canonicalJson(a),canonicalJson(b)))};
}
