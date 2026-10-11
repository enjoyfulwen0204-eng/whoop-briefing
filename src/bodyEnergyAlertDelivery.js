import {assertBodyEnergyFinalizedDrain} from './bodyEnergyDrainAuthority.js';
import {requireUserId} from './userContext.js';
import {requirePhase4Keys} from './phase4Keys.js';
import {workStepOptions} from './phase4WorkStep.js';
import {assertBodyEnergyPublication} from './bodyEnergyQualificationAuthority.js';
import {createBodyEnergyNotificationControl} from './bodyEnergyNotificationControl.js';
import {BODY_ENERGY_NOTIFICATION_POLICY as POLICY} from './bodyEnergyNotificationPolicy.js';
import {bodyHealthDate} from './bodyEnergyInputs.js';
import {renderBodyEnergy} from './bodyEnergyPresentation.js';
import {REPORT_CLAIM} from './config.js';
import {deliverReport,DELIVERY_RESULT} from './reportDelivery.js';
import {createTelegram,TelegramError} from './telegram.js';
import {SEND_OUTCOME} from './sendOutcome.js';
import {withDeliveryAuthorization} from './accountLifecycle.js';

const fixtures=new WeakSet();
/** Fixed in-memory transport only; callers cannot inject a callback/provider.
 * It is accepted exclusively with the isolated-memory publication grant. */
export function createBodyEnergyFixtureTransport({outcome='DELIVERED'}={}){
  if(!['DELIVERED','AMBIGUOUS','DEFINITE_FAILURE','DRY_RUN','INVALID_ACK'].includes(outcome))throw Error('BODY_ENERGY_FIXTURE_OUTCOME_INVALID');
  const messages=[],transport=Object.freeze({messages,
    async send(text,{authorize}={}){
      await authorize?.();
      if(outcome==='DEFINITE_FAILURE')throw new TelegramError('SYNTHETIC_DEFINITE_FAILURE',{sendOutcome:SEND_OUTCOME.DEFINITE_FAILURE,sendStage:'pre_send'});
      messages.push(text);
      if(outcome==='AMBIGUOUS')throw new TelegramError('SYNTHETIC_AMBIGUOUS',{sendOutcome:SEND_OUTCOME.AMBIGUOUS,sendStage:'response'});
      return outcome==='DRY_RUN'?{dryRun:true}:outcome==='INVALID_ACK'?{messageId:null}:{messageId:messages.length};
    }});fixtures.add(transport);return transport;
}
const fail=code=>{throw Error(code);};
const pointerParse=raw=>{try{const value=JSON.parse(raw);return value?.version===1&&typeof value.resultId==='string'
  &&value.resultId.length<=256&&Number.isSafeInteger(value.lifecycleGeneration)&&Number.isSafeInteger(value.authGeneration)?value:null;}catch{return null;}};

/** Narrow post-finalized-drain publisher, without Stage 7 slots/UI or LIVE
 * worker activation. Calculation never sends. Root composition owns cadence. */
export function createBodyEnergyAlertDelivery({db,stores,keys,publicationCapability,env,now=()=>new Date(),fixtureTransport}={}){
  requirePhase4Keys(keys);
  for(const method of ['getUser','getLocale','getOnboarding','getActiveChatIdForUser','getState','setState','transaction',
    'isProactiveEnabled','claimProactiveEvent','markProactiveEventSent','claimReport','getClaim','releaseSuppressedProactiveEvent'])
    if(typeof db?.[method]!=='function')fail('BODY_ENERGY_ALERT_DEPENDENCIES_REQUIRED');
  if(typeof stores?.bodyEnergy?.readDropCandidate!=='function'||typeof stores?.withContext!=='function')fail('BODY_ENERGY_ALERT_DEPENDENCIES_REQUIRED');
  const controls=createBodyEnergyNotificationControl({db,keys,now}),at=()=>new Date(now());
  const pointerKey=id=>'body-energy:alert-pointer:'+keys.lookup(['body-energy-alert-pointer-v1',id]);
  async function preferences(id){return (await db.raw.execute({sql:'SELECT notifications_paused,preference_version FROM user_notification_preferences WHERE user_id=?',args:[id]})).rows[0]
    ??{notifications_paused:0,preference_version:0};}
  async function deliver({userId,drainAuthority}={}){
    const id=requireUserId(userId,'bodyEnergyDropAlert');
    let grant;try{grant=await assertBodyEnergyPublication(publicationCapability,db,id,{purpose:'alerts'});}catch{return {status:'publication_not_qualified'};}
    if(grant.fixture&&!fixtures.has(fixtureTransport)||!grant.fixture&&fixtureTransport)fail('BODY_ENERGY_FIXTURE_TRANSPORT_REQUIRED');
    try{await assertBodyEnergyFinalizedDrain(drainAuthority,db,id,grant);}catch{return {status:'trigger_not_admitted'};}
    const user=await db.getUser(id),locale=await db.getLocale(id),consent=await controls.read(id),prefs=await preferences(id);
    if(!user||user.status!=='ACTIVE'||!locale||(await db.getOnboarding(id))?.state!=='READY')return {status:'recipient_not_ready'};
    if(!consent.alertsEnabled||!await db.isProactiveEnabled(id)||prefs.notifications_paused)return {status:'notifications_disabled'};
    if(!grant.fixture&&typeof db.getProfileRevision!=='function')return {status:'profile_authority_unavailable'};
    const profileRevision=typeof db.getProfileRevision==='function'?await db.getProfileRevision(id):null;
    const life=user.lifecycleGeneration,chatId=await db.getActiveChatIdForUser(id,{expectedLifecycleGeneration:life});
    if(!chatId)return {status:'no_active_chat'};
    return stores.withContext(id,{executionMode:'SHADOW',providerRequired:true},async context=>{
      const prior=pointerParse(await db.getState(pointerKey(id))),previousResultId=prior?.lifecycleGeneration===life&&prior.authGeneration===context.authGeneration?prior.resultId:null;
      const request={previousResultId,healthDate:bodyHealthDate(at().getTime(),context.timezone),asOfEpochMs:at().getTime()};
      const candidate=await stores.bodyEnergy.readDropCandidate(context,request),view=candidate.view;
      if(view?.status!=='AVAILABLE')return {status:'no_current_eligible_result'};
      const advance=()=>db.transaction(async()=>{
        await stores.assertCurrent(context);await db.assertAccountActive(id,life);
        await db.setState(pointerKey(id),JSON.stringify({version:1,resultId:view.resultId,lifecycleGeneration:life,authGeneration:context.authGeneration}),{now:at()});
      },workStepOptions('body-energy.alert-pointer',[id,life,context.authGeneration,view.resultId]));
      if(!candidate.eligible){await advance();return {status:'no_eligible_drop',reason:candidate.reason};}
      const snapshot=view.publicationProof,controlRevision=consent.revision,preferenceVersion=prefs.preference_version;
      const verify=async()=>{
        await assertBodyEnergyFinalizedDrain(drainAuthority,db,id,grant);await assertBodyEnergyPublication(publicationCapability,db,id,{purpose:'alerts'});await stores.assertCurrent(context);
        const currentUser=await db.getUser(id),currentConsent=await controls.read(id),currentPrefs=await preferences(id);
        if(!currentUser||currentUser.status!=='ACTIVE'||currentUser.lifecycleGeneration!==life||(currentUser.displayName??'')!==(user.displayName??'')
          ||await db.getLocale(id)!==locale||(profileRevision!==null&&await db.getProfileRevision(id)!==profileRevision)
          ||(await db.getOnboarding(id))?.state!=='READY'||!currentConsent.alertsEnabled||currentConsent.revision!==controlRevision
          ||!await db.isProactiveEnabled(id)||currentPrefs.notifications_paused||currentPrefs.preference_version!==preferenceVersion
          ||String(await db.getActiveChatIdForUser(id,{expectedLifecycleGeneration:life}))!==String(chatId))fail('BODY_ENERGY_ALERT_RECIPIENT_FENCED');
        const fresh=await stores.bodyEnergy.readDropCandidate(context,{...request,asOfEpochMs:at().getTime()});
        if(!fresh.eligible||fresh.episodeId!==candidate.episodeId||fresh.semanticEventId!==candidate.semanticEventId
          ||fresh.view.publicationProof!==snapshot)fail('BODY_ENERGY_ALERT_CURRENTNESS_FENCED');
      };
      await verify();
      // Atomic common admission protects rolling cap across legacy + Body;
      // the Body policy guard also serializes this topic's 24h cooldown.
      const event=await db.claimProactiveEvent(id,{healthDate:view.healthDate,
        idempotencyKey:keys.lookup(['body-energy-drop-episode-v1',candidate.episodeId]),
        signals:[{code:POLICY.signalCode,metric:'body_energy'}],decision:'NOTIFY',
        reason:{code:'QUALIFIED_FRESH_LOAD_DROP',episodeId:candidate.episodeId,resultId:view.resultId},
        policyVersion:POLICY.version,messageText:null},{now:at(),expectedLifecycleGeneration:life});
      if(!event.claimed){await advance();return {status:'episode_or_policy_suppressed'};}
      // The existing local_date slot holds an opaque episode ID for this
      // report family: an episode extending across midnight still sends once.
      const claimKey={userId:id,reportType:POLICY.reportType,localDateKey:candidate.episodeId};
      const claim=await db.claimReport({...claimKey,ttlMs:REPORT_CLAIM.TTL_MS,expectedLifecycleGeneration:life,now:at()});
      if(!claim.granted){await advance();return {status:claim.alreadySent?'already_delivered':claim.ambiguous?'delivery_ambiguous':'claim_busy'};}
      const sender=withDeliveryAuthorization(grant.fixture?fixtureTransport:createTelegram({botToken:env?.telegramBotToken,
        chatId,dryRun:env?.dryRun,db,errorScope:`user:${id}`}),async()=>String(await db.getActiveChatIdForUser(id,
          {expectedLifecycleGeneration:life}).catch(()=>null))===String(chatId),{userId:id,expectedLifecycleGeneration:life});
      // Final authority is checked inside the actual transport, in addition to
      // the report's durable DELIVERY_STARTED fence and lifecycle destination.
      const transport={send:async(text,{authorize}={})=>{
        try{await verify();await authorize?.();}catch{throw new TelegramError('BODY_ENERGY_ALERT_FENCED',
          {sendOutcome:SEND_OUTCOME.DEFINITE_FAILURE,sendStage:'pre_send'});}
        return sender.send(text,{authorize:verify});
      }};
      const delivery=await deliverReport({db,claimKey,claim,telegram:transport,
        text:renderBodyEnergy(view,{locale,displayName:user.displayName,alert:true}),now:at,authorizeContent:verify});
      // A single attempt per episode is deliberately conservative. Definite
      // failure remains durable at the semantic claim and never retry-loops;
      // ambiguity keeps the existing terminal report state without resets.
      if(delivery.result===DELIVERY_RESULT.DELIVERED)await db.markProactiveEventSent(id,event.id,{}, {now:at()});
      await advance();return {status:delivery.result,messageId:delivery.messageId??null};
    });
  }
  return Object.freeze({deliver,controls,pointerKey});
}
