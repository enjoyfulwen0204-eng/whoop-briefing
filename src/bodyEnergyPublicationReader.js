import {BODY_ENERGY_PROVISIONAL_POLICY,baselineOnlyProvisional} from './bodyEnergyProvisionalPolicy.js';
import {createBodyEnergySourceUnitAuthority} from './bodyEnergySourceUnitAuthority.js';
import {BODY_ENERGY as C} from './bodyEnergyRegistry.js';
import {BODY_ENERGY_RELEASE_CRITERIA as CRITERIA} from './bodyEnergyReleaseCriteria.js';
import {meetsConfidenceThreshold} from './bodyEnergy.js';
import {exactBodyInstant,validHealthDate} from './bodyEnergyInputs.js';
import {canonicalJson} from './phase4EntityStore.js';
import {PHASE4_METRICS} from './phase4IntelligenceRegistry.js';

/** Typed, current-generation, finalized-producer projection. No publication
 * capability is issued here, and no historical manifest becomes a current UI. */
export function createBodyEnergyPublicationReader(core,{body,receipts,readArtifact}){
  const {client,keys}=core;
  const sourceUnits=createBodyEnergySourceUnitAuthority(core,{body,receipts});
  async function current(context,{healthDate,asOfEpochMs,presentationPolicy=null},returnCapture=false){
      if(presentationPolicy!==null&&presentationPolicy!==BODY_ENERGY_PROVISIONAL_POLICY.version)throw Error('BODY_ENERGY_PRESENTATION_POLICY_INVALID');
      if(!validHealthDate(healthDate))throw Error('BODY_ENERGY_INVALID_HEALTH_DATE');exactBodyInstant(asOfEpochMs);
      const clock=core.now().getTime();
      if(!Number.isSafeInteger(clock)||clock>Date.now()||asOfEpochMs>clock)throw Error('BODY_ENERGY_FUTURE_REQUEST');
      return core.run(context,async()=>{
        const {computation}=await core.assertContext(context);
        if(context.executionMode!=='SHADOW'||![32,33,34,35].includes(Number((await client.execute('SELECT MAX(version) v FROM schema_version')).rows[0]?.v)))
          return {status:'PROCESSING',userId:context.userId};
        const stored=await body.readLatestPublicationCandidate(context,{healthDate,asOfEpochMs});
        if(!stored)return {status:computation.last_completed_generation===context.inputGeneration?'NO_DATA':'PROCESSING',userId:context.userId};
        const sourceUnit=await sourceUnits.verify(context,stored);
        if(!sourceUnit)return {status:'PROCESSING',userId:context.userId};
        const {row,manifest,calculation}=stored;
        const elapsed=asOfEpochMs-row.as_of_epoch_ms;
        const ages=[manifest.sync.sleep.age_ms,manifest.sync.recovery.age_ms,manifest.load.sync?.age_ms];
        const fresh=elapsed>=0&&elapsed<=CRITERIA.freshMaximumMs&&ages.every(age=>typeof age==='number'
          &&Number.isFinite(age)&&age>=0&&age+elapsed<=CRITERIA.freshMaximumMs);
        if(!fresh)return {status:'STALE',userId:context.userId};
        const provisional=presentationPolicy===BODY_ENERGY_PROVISIONAL_POLICY.version&&baselineOnlyProvisional(stored);
        if(presentationPolicy&&!provisional)return {status:row.quality_state==='AVAILABLE'?'QUALIFICATION_PENDING':row.quality_state??'NO_DATA',userId:context.userId};
        if(!provisional&&(row.quality_state!==CRITERIA.publicationQuality||!Number.isInteger(row.value)||row.value<0||row.value>100
          ||!meetsConfidenceThreshold(row.confidence,CRITERIA.confidenceMinimum)))
          return {status:row.quality_state??'NO_DATA',userId:context.userId};
        await core.assertContext(context);
        const sources=new Map(),include=(type,row,role)=>{if(!row)return;const id=String(row[type==='recovery'?'sleep_id':'id']),key=canonicalJson([type,id]);
          const old=sources.get(key);if(old){old.roles.push(role);if(role==='NOTIFICATION_EVENT_ONLY')old.providerCreatedAt=row.created_at??null;return;}
          sources.set(key,{type,id,updatedAt:row.updated_at??null,ingestedAt:row.synced_at,roles:[role],...(role==='NOTIFICATION_EVENT_ONLY'?{providerCreatedAt:row.created_at??null}:{})});};
        include('sleep',manifest.main_sleep,'MAIN_SLEEP');include('recovery',manifest.recovery,'MATCHED_RECOVERY');
        for(const metric of ['hrv','rhr'])for(const row of manifest.baseline[metric]){include('sleep',row.sleep,`BASELINE_${metric.toUpperCase()}`);include('recovery',row.recovery,`BASELINE_${metric.toUpperCase()}`);}
        for(const row of manifest.load.rows)include(manifest.load.kind==='CYCLE'?'cycle':'workout',row,'LOAD');
        for(const row of manifest.naps)include('sleep',row.source,'NAP');
        for(const row of manifest.notification_workouts?.rows??[])include('workout',row,'NOTIFICATION_EVENT_ONLY');
        const view=Object.freeze({status:provisional?'PROVISIONAL':'AVAILABLE',presentationPolicy:provisional?BODY_ENERGY_PROVISIONAL_POLICY.version:null,userId:context.userId,resultId:row.result_id,executionMode:'SHADOW',
          healthDate:row.health_date,asOfUtc:row.as_of_utc,asOfEpochMs:row.as_of_epoch_ms,timezone:context.timezone,
          wakeAtUtc:manifest.wake_at_utc,
          value:row.value,quality:row.quality_state,confidence:row.confidence,confidenceLabel:row.confidence_label,
          algorithm:row.algorithm_version,constantsHash:calculation.constants_hash,inputGeneration:context.inputGeneration,
          lifecycleGeneration:context.lifecycleGeneration,authGeneration:context.authGeneration,purgeGeneration:context.purgeGeneration,
          drivers:Object.freeze({initialCharge:calculation.drivers.initial_charge,timeDepletion:calculation.drivers.time_depletion,
            loadDepletion:calculation.drivers.load_depletion,napRecharge:calculation.drivers.nap_recharge}),
          provenance:Object.freeze({included:Object.freeze({mainSleepId:manifest.main_sleep.id,recoverySleepId:manifest.recovery.sleep_id,
            hrvBaselineCount:manifest.baseline.hrv.length,rhrBaselineCount:manifest.baseline.rhr.length,
            loadKind:manifest.load.kind,loadIds:Object.freeze(manifest.load.rows.map(r=>String(r.id))),napIds:Object.freeze(manifest.naps.map(r=>String(r.source.id)))}),
            sources:Object.freeze([...sources.values()].map(s=>Object.freeze({...s,roles:Object.freeze([...new Set(s.roles)].sort())}))),
            excluded:Object.freeze(manifest.exclusions.map(e=>Object.freeze({...e}))),
            reasons:Object.freeze([...calculation.reasons]),confidenceMeaning:'DATA_QUALITY_NOT_PHYSIOLOGICAL_ACCURACY'}),
          publicationProof:keys.lookup(['body-energy-publication-proof-v1',context.userId,row.result_id,row.result_hash,
            context.inputGeneration,context.lifecycleGeneration,context.authGeneration,context.purgeGeneration,
            sourceUnit.purpose,sourceUnit.executionId,sourceUnit.sourceReceiptKey,
            sourceUnit.domainOperationKey,sourceUnit.domainReceiptHmac,sourceUnit.parentResultDigest,
            ...(provisional?[BODY_ENERGY_PROVISIONAL_POLICY.version]:[])]),
          interpretation:'KELVIN_HEALTH_OS_ENGINEERING_ESTIMATE_NOT_MEDICAL_OR_REALTIME'});
        return returnCapture?{view,capture:stored}:view;
      });
  }
  const required=m=>canonicalJson({wake:m.wake_at_utc,
    main:m.main_sleep&&[m.main_sleep.id,m.main_sleep.start_at,m.main_sleep.end_at,m.main_sleep.sleep_performance_percentage,m.main_sleep.updated_at],
    recovery:m.recovery&&[m.recovery.sleep_id,m.recovery.user_calibrating,m.recovery.hrv_rmssd_milli,m.recovery.resting_heart_rate,m.recovery.updated_at],
    baseline:Object.fromEntries(['hrv','rhr'].map(component=>[component,m.baseline[component].map(r=>[r.health_date,r.value,
      r.sleep.id,r.sleep.updated_at,r.recovery.sleep_id,r.recovery.updated_at])]))});
  return Object.freeze({readCurrent:current,
    async readDropCandidate(context,{previousResultId,healthDate,asOfEpochMs}){
      return core.run(context,async()=>{
        const currentCapture=await current(context,{healthDate,asOfEpochMs},true);
        if(!currentCapture?.capture)return {view:currentCapture,eligible:false,reason:'CURRENT_DATA_NOT_ELIGIBLE'};
        const {view,capture}=currentCapture;
        if(!previousResultId||previousResultId===view.resultId)return {view,eligible:false,reason:'NO_NEW_RESULT'};
        let prior;try{
          prior=await body.audit(context,previousResultId);
          await receipts.forArtifact(context,'body_energy_results',{result_id:previousResultId},{verifyOnly:true,retainedBody:true});
        }catch{return {view,eligible:false,reason:'PREVIOUS_CAPTURE_UNAVAILABLE'};}
        const old=prior.row,elapsed=view.asOfEpochMs-old.as_of_epoch_ms;
        if(old.lifecycle_generation!==context.lifecycleGeneration||old.auth_generation!==context.authGeneration
          ||old.execution_mode!=='SHADOW'||old.health_date!==healthDate||old.quality_state!=='AVAILABLE'
          ||!meetsConfidenceThreshold(old.confidence,CRITERIA.confidenceMinimum)||elapsed<=0||elapsed>CRITERIA.freshMaximumMs)
          return {view,eligible:false,reason:'PREVIOUS_CAPTURE_NOT_FRESH'};
        if([prior.manifest.sync.sleep.age_ms,prior.manifest.sync.recovery.age_ms,prior.manifest.load.sync?.age_ms]
          .some(age=>typeof age!=='number'||!Number.isFinite(age)||age<0||age+elapsed>CRITERIA.freshMaximumMs))
          return {view,eligible:false,reason:'PREVIOUS_SOURCE_NOT_FRESH'};
        // Compare only in this authenticated transient context. No unsalted
        // health-value digest or copied manifest enters operational state.
        if(required(prior.manifest)!==required(capture.manifest))return {view,eligible:false,reason:'REQUIRED_SOURCE_CORRECTION_OR_WAKE_CHANGE'};
        const load=capture.manifest.load,oldLoad=prior.manifest.load;
        if(load.kind!==oldLoad.kind)return {view,eligible:false,reason:'LOAD_REPRESENTATION_CHANGED'};
        const stableLoad=row=>canonicalJson([row.id,row.start_at,row.end_at,row.strain,row.updated_at]);
        if(load.kind==='WORKOUT'&&oldLoad.rows.some(oldRow=>!load.rows.some(row=>stableLoad(row)===stableLoad(oldRow)))
          ||load.kind==='CYCLE'&&(load.rows[0].id!==oldLoad.rows[0].id||load.rows[0].start_at!==oldLoad.rows[0].start_at)
          ||prior.manifest.naps.some(oldNap=>!capture.manifest.naps.some(nap=>canonicalJson([nap.source.id,nap.source.start_at,
            nap.source.end_at,nap.source.updated_at,nap.duration_minutes])===canonicalJson([oldNap.source.id,oldNap.source.start_at,
            oldNap.source.end_at,oldNap.source.updated_at,oldNap.duration_minutes]))))
          return {view,eligible:false,reason:'HISTORICAL_LOAD_OR_NAP_CORRECTION'};
        const events=capture.manifest.notification_workouts,oldEvents=prior.manifest.notification_workouts;
        if(events?.version!=='body-energy-workout-event-v1'||oldEvents?.version!==events.version
          ||[events.sync,oldEvents.sync].some((s,index)=>!s||!Number.isFinite(s.age_ms)||s.age_ms<0
            ||s.age_ms+(index?elapsed:0)>CRITERIA.freshMaximumMs))return {view,eligible:false,reason:'NO_RECEIPT_BACKED_LOAD_EVENT'};
        const stableEvent=r=>canonicalJson([r.id,r.start_at,r.end_at,r.strain,r.created_at,r.updated_at]);
        if(oldEvents.rows.filter(r=>r.end_at!==null).some(oldRow=>!events.rows.some(r=>stableEvent(r)===stableEvent(oldRow))))
          return {view,eligible:false,reason:'HISTORICAL_WORKOUT_CORRECTION'};
        // updated_at or a provider "updated" webhook cannot prove new load.
        // Require the same ongoing workout seen in the prior retained receipt
        // to become completed after that capture, within the same wake episode.
        const completed=events.rows.filter(r=>{
          const end=Date.parse(r.end_at),created=Date.parse(r.created_at),updated=Date.parse(r.updated_at);
          const progression=oldEvents.rows.some(previous=>previous.id===r.id&&previous.start_at===r.start_at&&previous.end_at===null
            &&previous.created_at===r.created_at);
          // WHOOP's documented provider created_at is resource creation,
          // not our discovery/ingestion clock. A newly created, completed
          // workout whose actual end also follows the previous capture may
          // support the signal; an existing id or old end never does.
          const firstCreation=!oldEvents.rows.some(previous=>previous.id===r.id)&&Number.isFinite(created)
            &&created>old.as_of_epoch_ms&&created<=updated&&created<=capture.row.as_of_epoch_ms;
          return r.end_at!==null&&Number.isFinite(end)&&end>old.as_of_epoch_ms&&end<=capture.row.as_of_epoch_ms
            &&Number.isFinite(updated)&&updated>old.as_of_epoch_ms&&updated<=capture.row.as_of_epoch_ms&&(progression||firstCreation);
        });
        if(!completed.length)return {view,eligible:false,reason:'NO_RECEIPT_BACKED_LOAD_EVENT'};
        if(load.kind==='CYCLE'&&(load.rows[0].end_at!==null||Date.parse(load.rows[0].updated_at)<=old.as_of_epoch_ms)
          ||load.kind==='WORKOUT'&&!completed.some(event=>load.rows.some(row=>row.id===event.id)))
          return {view,eligible:false,reason:'LOAD_EVENT_NOT_IN_CURRENT_SIGNAL'};
        const drop=old.value-view.value,expectedTime=view.drivers.timeDepletion-prior.calculation.drivers.time_depletion;
        const unexpectedDrop=drop-Math.max(0,expectedTime),contract=PHASE4_METRICS.body_energy;
        if(unexpectedDrop<=0||!(unexpectedDrop>=contract.absoluteFloor
          ||old.value>=contract.denominatorFloor&&unexpectedDrop/old.value>=contract.relativeFloor))
          return {view,eligible:false,reason:'EXPECTED_TIME_DECAY_OR_SMALL_CHANGE'};
        await core.assertContext(context);
        return {view,eligible:true,reason:'QUALIFIED_FRESH_LOAD_DROP',
          episodeId:keys.lookup(['body-energy-fresh-load-episode-v1',context.userId,capture.manifest.main_sleep.id,
            capture.manifest.wake_at_utc,'WORKOUT_COMPLETED',completed.map(r=>r.id).sort()[0]])};
      });
    }
  });
}
