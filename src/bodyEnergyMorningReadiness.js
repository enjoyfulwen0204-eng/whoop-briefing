import {assertBodyEnergyPublication} from './bodyEnergyQualificationAuthority.js';
import {BODY_ENERGY_RELEASE_CRITERIA as C} from './bodyEnergyReleaseCriteria.js';
import {BODY_ENERGY as B} from './bodyEnergyRegistry.js';
import {robustBaseline} from './bodyEnergy.js';
import {bodyHealthDate,validHealthDate,instant as bodyInstant,bodyCycleMatchesSleep} from './bodyEnergyInputs.js';
import {currentDurableExecution,assertExecutionWorkOwner,databaseNowMs} from './phase4ExecutionContext.js';
import {currentSyncOwnership} from './syncOwnership.js';
import {resourceSyncDue} from './sync.js';
import {publicBetaConfiguration} from './publicBetaConfig.js';
import {betaPilotConfiguration,reviewedPilotAdmission,createBetaPilotPermit} from './betaPilotPermit.js';
import {pilotStopRequested} from './betaPilotAllowance.js';
import {schedulerWindow} from './schedulerPolicy.js';
import {SYNC_YIELD_RESERVE_MS} from './syncContinuation.js';
import {workStepOptions} from './phase4WorkStep.js';
import {readOnlyProcessingCheck} from './processingTransaction.js';
import {profileRevision} from './profileRevision.js';
import {addPrivacyLink} from './phase4V22Backfill.js';

export const BODY_MORNING_MARKER_TYPE='daily_body_readiness';
// New bounded ordering repair derived from the deployed every-10-minute
// cadence. This is not a new notification clock or a publication approval.
export const BODY_MORNING_CADENCE_MS=10*60_000;
const proceed=()=>({action:'ORDINARY'}),finite=value=>typeof value==='number'&&Number.isFinite(value);
const instant=value=>typeof value==='string'?Date.parse(value):NaN;
const fields=['v','h','w','q','e','f','d','l','a','p','t','r','g','s'];
export function bodyMorningNextTick(firstObservedAt){return (Math.floor(firstObservedAt/BODY_MORNING_CADENCE_MS)+1)*BODY_MORNING_CADENCE_MS;}

/** Body-qualified pre-report ordering only. No calculation, ingestion, job
 * completion, handoff, permit reservation or Telegram capability is issued. */
export function createBodyEnergyMorningReadiness({db,stores,keys,publicationCapability,environment={}}){
 const seal=state=>keys.lookup(['body-morning-first-observation-v1',state]);
 async function inspect({userId,healthDate,wakeSleepId,pollSleeps,pollRecoveries,expectedLifecycleGeneration}){
  const execution=currentDurableExecution(),sync=currentSyncOwnership();
  try{
   await assertBodyEnergyPublication(publicationCapability,db,userId);
   if(!execution||execution.claim.request.phase!=='SYNC'||execution.claim.request.triggerSource!=='cloudflare'
     ||!sync||sync.db!==db||sync.userId!==userId)return proceed();
   execution.authority.assert();await sync.assertCurrent();
   if(sync.budget.remainingMs()<SYNC_YIELD_RESERVE_MS)return proceed();
   return await stores.withContext(userId,{executionMode:'SHADOW',providerRequired:true},async context=>{
    if(context.lifecycleGeneration!==expectedLifecycleGeneration)throw Error('BODY_MORNING_RECIPIENT_FENCED');
    const at=Date.now(),date=new Date(at),next=bodyMorningNextTick(at);
    if(!schedulerWindow(date).cloudflareExpected||!schedulerWindow(new Date(next)).cloudflareExpected)return proceed();
    const current=await stores.bodyEnergy.readForPublication(context,{healthDate,asOfEpochMs:at});
    if(current.status==='AVAILABLE')return {action:'READY'};
    if(!['PROCESSING','NO_DATA'].includes(current.status))return proceed();
    const config=publicBetaConfiguration(environment),pilot=betaPilotConfiguration(environment);
    if(config.runtime!=='on'||pilotStopRequested(environment)||pilot?.userId!==userId)return proceed();
    const reservation=reviewedPilotAdmission(pilot);if(!reservation)return proceed();
    const availability=await createBetaPilotPermit({db,keys,config:pilot,reservation}).availability();
    if(!availability.possible||availability.endAt<=next||availability.observedAt>Date.now())return proceed();
    const owner=await assertExecutionWorkOwner(db.raw);if(owner.phase!=='SYNC'||owner.execution_id!==execution.claim.executionId)return proceed();
    const user=await db.getUser(userId);
    let revision;try{revision=await db.transaction(()=>profileRevision(db.raw,userId,{initialize:false}),{readOnly:true});}catch(error){
     if(error?.message==='PROFILE_REVISION_INVALID')return proceed();throw error;
    }
    if(!user||user.status!=='ACTIVE'||user.lifecycleGeneration!==context.lifecycleGeneration)throw Error('BODY_MORNING_RECIPIENT_FENCED');
    if((await db.getOnboarding(userId))?.state!=='READY')return proceed();
    const token=(await db.raw.execute({sql:'SELECT whoop_user_id,auth_generation FROM user_whoop_tokens WHERE user_id=?',args:[userId]})).rows[0];
    if(!token||token.auth_generation!==context.authGeneration)throw Error('BODY_MORNING_RECIPIENT_FENCED');
    if(token.whoop_user_id===null)return proceed();
    const sleeps=(pollSleeps??[]).filter(row=>String(row.id)===String(wakeSleepId)),
      recoveries=(pollRecoveries??[]).filter(row=>String(row.sleep_id)===String(wakeSleepId));
    if(sleeps.length!==1||recoveries.length!==1)return proceed();
    const sleep=sleeps[0],recovery=recoveries[0],start=bodyInstant(sleep.start),wake=bodyInstant(sleep.end),
      performance=sleep.score?.sleep_performance_percentage,hrv=recovery.score?.hrv_rmssd_milli,rhr=recovery.score?.resting_heart_rate;
    if([sleep,recovery].some(row=>String(row.user_id)!==String(token.whoop_user_id)||row.score_state!=='SCORED'
       ||!Number.isFinite(instant(row.updated_at))||instant(row.updated_at)>at)
      ||sleep.nap!==false||start===null||wake===null||start>=wake||wake>at||bodyHealthDate(wake,context.timezone)!==healthDate
      ||!finite(performance)||performance<0||performance>100||!finite(hrv)||hrv<=0||!finite(rhr)||rhr<=0
      ||recovery.score?.user_calibrating!==false)return proceed();
    const w=keys.lookup(['body-morning-owned-wake-v1',userId,String(wakeSleepId),wake]);
    const q=keys.lookup(['body-morning-owned-sleep-identity-v1',userId,String(wakeSleepId)]);
    const metadata=(await db.raw.execute({sql:`SELECT ${databaseNowMs} observed_at,
      (SELECT count(*) FROM whoop_resource_access WHERE user_id=? AND resource IN ('sleep','recovery','cycle')
        AND status='ACCESSIBLE' AND auth_generation=? AND lifecycle_generation=?) access_count,
      (SELECT count(*) FROM whoop_capabilities WHERE user_id=? AND key IN ('sleep_performance','hrv','rhr')
        AND status='SUPPORTED' AND lifecycle_generation=?) capability_count,
      (SELECT count(*) FROM whoop_resource_tombstones WHERE user_id=? AND resource_type='sleep' AND resource_id=? AND state='ACTIVE') deleted,
      (SELECT count(*) FROM phase4_jobs WHERE user_id=? AND execution_mode='SHADOW'
        AND (state IN ('RETRY_WAIT','REPAIR_REQUIRED') OR next_attempt_at>? OR lease_expires_at>?)) blocked`,
      args:[userId,context.authGeneration,context.lifecycleGeneration,userId,context.lifecycleGeneration,userId,String(wakeSleepId),userId,date.toISOString(),date.toISOString()]})).rows[0];
    if(!metadata||metadata.observed_at>Date.now()||metadata.access_count!==3||metadata.capability_count!==3||metadata.deleted||metadata.blocked)return proceed();
    const from=new Date(wake-C.baselineLookbackDays*86400000).toISOString();
    const baseline=(await db.raw.execute({sql:`SELECT s.id,s.start_at,s.end_at,s.updated_at,s.synced_at,r.updated_at recovery_updated_at,
      r.synced_at recovery_synced_at,r.hrv_rmssd_milli hrv,r.resting_heart_rate rhr
      FROM whoop_sleeps s JOIN whoop_recoveries r ON r.user_id=s.user_id AND r.sleep_id=s.id
      WHERE s.user_id=? AND s.nap=0 AND s.score_state='SCORED' AND r.score_state='SCORED' AND r.user_calibrating=0
        AND s.end_at>=? AND s.end_at<?
        AND NOT EXISTS(SELECT 1 FROM whoop_resource_tombstones t WHERE t.user_id=s.user_id AND t.resource_id=s.id
          AND t.resource_type IN ('sleep','recovery') AND t.state='ACTIVE') ORDER BY s.end_at DESC,s.id LIMIT 129`,args:[userId,from,sleep.end]})).rows;
    if(baseline.length>128)return proceed();
    const days=new Map();
    for(const row of baseline){
     // Match the original Body selector before admitting a baseline day.
     // Canonical ingestion can retain a scored zero/reversed interval; it
     // cannot provide a mature numerical baseline or optional Morning wait.
     const start=bodyInstant(row.start_at),end=bodyInstant(row.end_at);
     if(start===null||end===null||start>=end)continue;
     const day=bodyHealthDate(end,context.timezone);if(day>=healthDate||days.has(day))continue;
     if([row.updated_at,row.synced_at,row.recovery_updated_at,row.recovery_synced_at].some(time=>!Number.isFinite(instant(time))||instant(time)>at))return proceed();
     days.set(day,row);
    }
    const mature=[...days.values()].slice(0,C.baselineTarget);
    if(mature.length<C.baselineTarget||['hrv','rhr'].some(metric=>{
      if(mature.some(row=>!finite(row[metric])||row[metric]<=0))return true;
      const quality=robustBaseline(mature.map(row=>row[metric]));return !quality.usable||quality.readiness!=='BASELINE_MATURE';
    }))return proceed();
    const states=await db.getAllSyncState(userId);
    if(!Array.isArray(states)||states.some(row=>row.user_id!==userId||row.last_error&&row.last_error!=='scope_missing'
      ||Number(row.backfill_complete)!==1))return proceed();
    const byResource=new Map(states.map(row=>[row.resource,row]));
    if(['sleep','recovery','cycle','workout','body_measurement'].some(resource=>!byResource.has(resource)))return proceed();
    const canonical=(await db.raw.execute({sql:'SELECT s.updated_at sleep_version,r.updated_at recovery_version FROM whoop_sleeps s LEFT JOIN whoop_recoveries r ON r.user_id=s.user_id AND r.sleep_id=s.id WHERE s.user_id=? AND s.id=?',args:[userId,String(wakeSleepId)]})).rows[0];
    const changed=!canonical||instant(canonical.sleep_version)!==instant(sleep.updated_at)||instant(canonical.recovery_version)!==instant(recovery.updated_at);
    const due=resource=>{const row=byResource.get(resource);return resourceSyncDue({lastSuccessAt:row.last_success_at,backfillComplete:Number(row.backfill_complete)===1},{now:date});};
    const queued=(await db.raw.execute({sql:`SELECT 1 FROM phase4_jobs WHERE user_id=? AND execution_mode='SHADOW'
      AND requested_generation=? AND completed_generation<requested_generation AND full_scan_cursor IS NULL
      AND scope_kind='FULL_TENANT_RECOMPUTE' AND (next_attempt_at IS NULL OR next_attempt_at<=?)
      AND (lease_owner IS NULL OR lease_expires_at<=?) LIMIT 1`,args:[userId,context.inputGeneration,date.toISOString(),date.toISOString()]})).rows.length;
    // New provider-only polling may support the ORIGINAL forthcoming sync,
    // never a fabricated queue entry or a bypass of its one-hour throttle.
    const futureSync=changed&&['sleep','recovery','cycle'].every(due)&&recovery.cycle_id!=null;
    if(!futureSync&&!(queued&&!changed))return proceed();
    const cycleId=recovery.cycle_id==null?null:String(recovery.cycle_id);
    const cycles=(await db.raw.execute({sql:`SELECT id,score_state,start_at,end_at,strain,updated_at,synced_at FROM whoop_cycles WHERE user_id=?
      AND (? IS NULL OR id=?) AND start_at<=? AND (end_at IS NULL OR end_at>=?) ORDER BY start_at DESC LIMIT 2`,args:[userId,cycleId,cycleId,sleep.end,sleep.end]})).rows;
    const load=cycles.find(row=>finite(row.strain)&&row.strain>=0&&row.strain<=B.strainMax
      &&bodyCycleMatchesSleep(row,{start_at:sleep.start,end_at:sleep.end},recovery,at)
      &&[row.updated_at,row.synced_at].every(time=>Number.isFinite(instant(time))&&instant(time)<=at));
    // A fresh owned recovery names its Cycle, and original admitted normal
    // Cycle SYNC is due. That is a supported future fetch prerequisite, not
    // a current load value, score or fabricated source receipt. Without that
    // future fetch route, the actually queued source needs retained load.
    if(!load&&!futureSync)return proceed();
    const cycleSync=instant(byResource.get('cycle').last_success_at);
    if(!Number.isFinite(cycleSync)||cycleSync>at||!futureSync&&at-cycleSync>C.freshMaximumMs)return proceed();
    const proposed={v:1,h:healthDate,w,q,e:wake,f:at,d:next,l:context.lifecycleGeneration,a:context.authGeneration,
      p:context.purgeGeneration,t:context.timezone,r:revision,g:context.inputGeneration,s:context.sourceGeneration};
    let decision=proceed();
    const artifactId=keys.lookup(['privacy-artifact-v1','briefing_evaluations',userId,'SHARED',[userId,BODY_MORNING_MARKER_TYPE]]);
    const check=readOnlyProcessingCheck(async()=>{execution.authority.assert();await sync.assertCurrent();await stores.assertCurrent(context);
     await assertBodyEnergyPublication(publicationCapability,db,userId);
     if(Date.now()>=next||!schedulerWindow(new Date()).cloudflareExpected
       ||sync.budget.remainingMs()<SYNC_YIELD_RESERVE_MS
       ||await profileRevision(db.raw,userId,{initialize:false})!==revision||pilotStopRequested(environment)
       ||!(await createBetaPilotPermit({db,keys,config:pilot,reservation}).availability()).possible)throw Error('BODY_MORNING_READINESS_CHANGED');});
    await db.transaction(async()=>{
     const row=(await db.raw.execute({sql:'SELECT * FROM briefing_evaluations WHERE user_id=? AND report_type=?',args:[userId,BODY_MORNING_MARKER_TYPE]})).rows[0];
     let original;
     if(row){try{const {signature,...state}=JSON.parse(row.detail);
       if(row.content_state!=='PRESENT'||row.source_linkage_state!=='COMPLETE'||row.health_content_redacted_at
         ||row.privacy_artifact_id!==artifactId||row.purge_generation!==context.purgeGeneration
         ||Object.keys(state).sort().join(',')!==fields.slice().sort().join(',')||state.v!==1||seal([userId,state])!==signature
         ||!validHealthDate(state.h)||!/^[a-f0-9]{64}$/.test(state.w)||!/^[a-f0-9]{64}$/.test(state.q)
         ||['e','f','d','l','a','p','r','g','s'].some(key=>!Number.isSafeInteger(state[key])||state[key]<0)
         ||state.e>state.f||state.l<1||state.a<1||typeof state.t!=='string'
         ||state.h!==row.target_health_date||state.f!==Date.parse(row.evaluated_at)||state.d!==bodyMorningNextTick(state.f)
         ||state.d-state.f>BODY_MORNING_CADENCE_MS||state.f>at)throw Error();original=state;
      }catch{return;}
      if(original.h===healthDate||original.w===w||original.q===q){
       if(fields.filter(key=>!['f','d'].includes(key)).some(key=>original[key]!==proposed[key])||at>=original.d)return;
       decision={action:'DEFER',firstObservedAt:original.f,deadline:original.d};return;
      }
      if(healthDate<=original.h||wake<=original.e||at<=original.f)return;
     }
     const detail=JSON.stringify({...proposed,signature:seal([userId,proposed])});if(Buffer.byteLength(detail)>500)return;
     const iso=new Date(at).toISOString(),changed=row?await db.raw.execute({sql:`UPDATE briefing_evaluations SET evaluated_at=?,local_date=?,target_health_date=?,
       outcome='READY',reason='BODY_SOURCE_FIRST_OBSERVATION',retryable=1,detail=?,updated_at=? WHERE user_id=? AND report_type=? AND detail=?`,
       args:[iso,healthDate,healthDate,detail,iso,userId,BODY_MORNING_MARKER_TYPE,row.detail]}):await db.raw.execute({sql:`INSERT INTO briefing_evaluations
       (user_id,report_type,evaluated_at,local_date,target_health_date,outcome,reason,retryable,detail,created_at,updated_at)
       VALUES(?,?,?,?,?,'READY','BODY_SOURCE_FIRST_OBSERVATION',1,?,?,?) ON CONFLICT(user_id,report_type) DO NOTHING`,args:[userId,BODY_MORNING_MARKER_TYPE,iso,healthDate,healthDate,detail,iso,iso]});
     if(changed.rowsAffected===1){
      await db.raw.execute({sql:`UPDATE briefing_evaluations SET privacy_artifact_id=?,content_state='PRESENT',
        source_linkage_state='COMPLETE',purge_generation=? WHERE user_id=? AND report_type=? AND health_content_redacted_at IS NULL`,
        args:[artifactId,context.purgeGeneration,userId,BODY_MORNING_MARKER_TYPE]});
      await addPrivacyLink(db.raw,{userId,table:'briefing_evaluations',artifactId,sourceType:'TENANT_LEGACY',sourceId:userId,at:iso});
      decision={action:'DEFER',firstObservedAt:at,deadline:next};
     }
    },{...workStepOptions('body.morning-readiness-marker',[userId,healthDate,w,context.inputGeneration],{discardResult:true}),before:check,beforeCommit:check,after:check});
    execution.authority.assert();return decision;
   });
  }catch(error){execution?.authority.assert();
   if(error?.code==='BODY_ENERGY_PUBLICATION_NOT_QUALIFIED'||error?.code==='BETA_PILOT_DENIED'
     ||error?.message==='BODY_MORNING_READINESS_CHANGED')return proceed();
   throw error;
  }
 }
 return Object.freeze({inspect});
}
