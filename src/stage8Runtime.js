import {createStage8SubjectAlertProvider} from './stage8SubjectAlerts.js';
import {createStage8PostSync} from './stage8PostSync.js';
import {createStage8LiveProducer} from './stage8LiveProducer.js';
import {currentDurableExecution} from './phase4ExecutionContext.js';
import {createStage8DerivedReader} from './stage8DerivedReader.js';
import {assertStage8Recovery,stage8ConfigurationFence} from './stage8Policy.js';
import {createRecipientIdentity} from './recipientIdentity.js';
import {createScopedHealthContext} from './scopedHealthContext.js';
import {createStage8SelfQa} from './stage8SelfQa.js';
import {requireRuntimeAdmission,followRuntimeRenewal} from './runtimeAdmission.js';
import {buildPhase4Core} from './phase4Core.js';
import {composePhase4Stores} from './phase4Repositories.js';
import {createOwnerMonitoring} from './stage8OwnerMonitoring.js';
import {createStage8SourceConsent} from './stage8SourceConsent.js';
import {createStage8OwnerDispatcher} from './stage8OwnerDispatcher.js';
import {isApprovedStage7Three} from './stage7Cohort.js';
import {createBodyEnergyLivePresentation} from './bodyEnergyLivePresentation.js';
export function stage8Configuration(environment={}){
 assertStage8Recovery(environment);
 for(const name of ['PHASE4_STAGE8_RUNTIME','PHASE4_STAGE8_OWNER_MONITORING','STAGE8_MORNING_BRIEF','STAGE8_LIVE_ANALYSIS','STAGE8_POST_SYNC','STAGE8_SUBJECT_ALERTS'])if(!['off','on'].includes(environment[name]??'off'))throw Error('STAGE8_CONFIG_INVALID');
 const enabled=environment.PHASE4_STAGE8_RUNTIME==='on';
 const owner=String(environment.PHASE4_BETA_PILOT_USER_ID??'').trim();
 const users=String(environment.STAGE8_USER_IDS??'').split(',').map(s=>s.trim()).filter(Boolean);
 if(enabled&&(!owner||!users.includes(owner)||!(users.length===1&&users[0]===owner||isApprovedStage7Three(users))))throw Error('STAGE8_OWNER_COHORT_REQUIRED');
 return Object.freeze({enabled,ownerId:enabled?owner:null,userIds:Object.freeze(enabled?users:[])});
}
export async function createStage8Runtime({db,keys,environment={},env={},bodyEnergy,stage7=null,now=()=>new Date()}){
 const config=stage8Configuration(environment);if(!config.enabled)return null;
 const fence=stage8ConfigurationFence(environment);
 let admission=await db.admitRuntime();if(![34,35].includes(requireRuntimeAdmission(db.raw,admission,keys,db.transaction)))throw Error('STAGE8_V34_REQUIRED');
 followRuntimeRenewal(db.raw,admission,keys,db.transaction,next=>{admission=next;});
 const rawIdentity=await createRecipientIdentity({db,keys,now});
 const identity=Object.freeze(Object.fromEntries(Object.entries(rawIdentity).map(([name,operation])=>[name,async(...args)=>{fence();return operation(...args);}]))) ;
 const eligible=uid=>{try{fence();return stage8Configuration(environment).userIds.includes(uid);}catch{return false;}};
 const subjectAlertProvider=createStage8SubjectAlertProvider({db,keys,admission,environment,env,eligible});
 const analysis=environment.STAGE8_LIVE_ANALYSIS==='on'?await createStage8LiveProducer({db,keys,admission,userIds:config.userIds,environment,subjectAlertProvider,enabled:()=>{try{fence();return environment.STAGE8_LIVE_ANALYSIS==='on';}catch{return false;}},eligible}):null;
 const postSync=analysis?createStage8PostSync({db,keys,producer:analysis,userIds:config.userIds,eligible,enabled:()=>environment.STAGE8_POST_SYNC==='on'&&config.userIds.some(eligible),environment}):null;
 const liveAnalysis=analysis?Object.freeze({afterSync:request=>postSync.run(request),resume:()=>postSync.resume(),run:async request=>{fence();if(currentDurableExecution())throw Error('STAGE8_LIVE_SEPARATE_EXECUTION_REQUIRED');return analysis.run(request);}}):null;
 const derivedReader=createStage8DerivedReader({db,keys,admission,eligible,now});
 const scopes=await createScopedHealthContext({db,keys,admission,now,derivedReader});
 const bodyScopes=await createScopedHealthContext({db,keys,admission,now,
  derivedReader:createStage8DerivedReader({db,keys,admission,eligible,now,bodyEnergyPresentation:true})});
 const bodyEnergyLive=createBodyEnergyLivePresentation({db,scopes:bodyScopes,bodyEnergy,now}),
  qa=createStage8SelfQa({scopes,db,bodyEnergy,bodyEnergyLive,decorate:stage7?.decorate,now});
 const core=await buildPhase4Core({keys,admission,now,processing:{client:db.raw,transaction:db.transaction,active:db.processingTransactionActive,assertFences:db.assertRuntimeFences,afterCommit:db.afterProcessingCommit,afterCompletion:db.afterProcessingCompletion},
  authorizeMode(mode){if(mode!=='SHADOW')throw Error('PHASE4_LIVE_NOT_AUTHORIZED');}});
 const stores=composePhase4Stores(core);
 async function actor(input){
  requireRuntimeAdmission(db.raw,admission,keys,db.transaction);
  const current=(await db.resolveUserByChatId(input.chatId))?.user;
  if(!/^\d+$/.test(String(input.chatId))||!eligible(input.user?.id)||current?.id!==input.user.id||current.status!=='ACTIVE'||current.lifecycleGeneration!==input.user.lifecycleGeneration)throw Error('STAGE8_SETTINGS_ACTOR_FENCED');
  return current;
 }
 const preferences=Object.freeze({
  read:input=>db.transaction(async()=>{const user=await actor(input);return stores.preferences.read(await core.captureControl(user.id));}),
  update:(input,version,patch)=>db.transaction(async()=>{const user=await actor(input);return stores.preferences.update(await core.captureControl(user.id),version,patch);}),
 });
 const ownerEnabled=()=>environment.PHASE4_STAGE8_OWNER_MONITORING==='on'&&eligible(config.ownerId);
 // Source users retain the settings path to revoke a saved grant while owner
 // monitoring is disabled. New grants still require its active authority.
 const sourceConsent=await createStage8SourceConsent({db,keys,ownerId:config.ownerId,enabled:ownerEnabled,now});
 const monitoring=ownerEnabled()?await createOwnerMonitoring({db,keys,ownerId:config.ownerId,enabled:ownerEnabled,sourceConsent,now}):null;
 const dispatcher=monitoring?createStage8OwnerDispatcher({db,monitoring,env,enabled:ownerEnabled,now}):null;
 const owner=monitoring?Object.freeze({
  enrolled:async input=>monitoring.enrolled(await monitoring.authenticate(input)),
  read:async(input,subjectId)=>Object.fromEntries((await monitoring.subscriptions(await monitoring.authenticate(input))).filter(row=>row.subjectId===subjectId).map(row=>[row.notificationClass,row])),
  configure:async(input,request)=>monitoring.configure(await monitoring.authenticate(input),request),
  dispatch:(input,request)=>dispatcher.dispatch(input,request),
  tick:async input=>{
   const actor=await monitoring.authenticate(input),selected=await monitoring.schedule(actor),results=[];
   for(const row of selected){fence();try{
    const pending=await monitoring.pending(actor,row.subjectId,row.notificationClass);
    if(!pending&&row.notificationClass==='DAILY_SUMMARY'){const prepared=await monitoring.prepareDaily(actor,row.subjectId);if(prepared.status!=='CURRENT_PLAN'){results.push({...row,status:prepared.status});continue;}}
    results.push({...row,...await dispatcher.dispatch(input,row)});
   }catch(error){results.push({subjectId:row.subjectId,notificationClass:row.notificationClass,status:'FENCED'});}}
   fence();return {checked:selected.length,results};
  },
 }):null;
 async function handle(input){fence();return eligible(input.user?.id)?qa.handle(input):null;}
 async function sendReply(send,input){
  const bodyGuarded=Boolean(input.reply?.stage8BodyEnergyGuard),guarded=Boolean(input.reply?.stage8ReplyGuard)||bodyGuarded,previous=input.beforeSend;
  const beforeSend=async()=> (!previous||await previous())&&(!guarded||eligible(input.userId)
   &&await (bodyGuarded?bodyEnergyLive.verifyReply(input):scopes.verifyReply(input)));
  if(!await beforeSend())return {sent:false,messageId:null,reason:'stage8_reply_changed'};
  return send({...input,beforeSend});
 }
 async function captureIdentity(input){fence();return identity.recordTelegram(input);}
 return Object.freeze({config,eligible,captureIdentity,handle,sendReply,scopes,identity,preferences,sourceConsent,owner,analysis:liveAnalysis});
}
