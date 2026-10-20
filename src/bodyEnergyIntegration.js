import {registerBodyEnergyTelegramReplyBoundary} from './bodyEnergyTelegramReplyBoundary.js';
import {requireUserId} from './userContext.js';
import {bodyHealthDate} from './bodyEnergyInputs.js';
import {assertBodyEnergyPublication} from './bodyEnergyQualificationAuthority.js';
import {renderBodyEnergy,isBodyEnergyQuery,bodyEnergyQueryPage} from './bodyEnergyPresentation.js';
import {createBodyEnergyNotificationControl} from './bodyEnergyNotificationControl.js';
import {createBodyEnergyMorningReadiness} from './bodyEnergyMorningReadiness.js';
import {currentDurableExecution} from './phase4ExecutionContext.js';
import {profileRevision as readProfileRevision} from './profileRevision.js';

/** Root composition supplies the existing admitted stores and reviewed grant.
 * Keep context/health objects scoped through rendering and pre-send recheck. */
export function createBodyEnergyIntegration({db,stores,keys,publicationCapability,environment={},publicationEnabled=()=>true,now=()=>new Date()}={}){
  if(typeof db?.getUser!=='function'||typeof db?.getLocale!=='function'
    ||typeof db?.getOnboarding!=='function'
    ||typeof stores?.withContext!=='function'||typeof stores?.bodyEnergy?.readForPublication!=='function')
    throw Error('BODY_ENERGY_INTEGRATION_DEPENDENCIES_REQUIRED');
  const at=()=>new Date(now());
  // Server composition keeps the grant private. LIVE presentation may ask for
  // its existing read policy, but cannot receive or manufacture the capability.
  const assertReadPolicy=async userId=>{
    if(!publicationEnabled())throw Error('BODY_ENERGY_PUBLICATION_NOT_QUALIFIED');
    return assertBodyEnergyPublication(publicationCapability,db,userId);
  };
  // Body consumes existing Settings authority inside owned report execution;
  // optional rendering must not initialize a profile or mint a work identity.
  // Ordinary Telegram/Settings call contracts remain unchanged.
  const revisionFor=id=>currentDurableExecution()?db.transaction(()=>readProfileRevision(db.raw,id,{initialize:false}),{readOnly:true})
    :typeof db.getProfileRevision==='function'?db.getProfileRevision(id):null;
  const notificationControl=createBodyEnergyNotificationControl({db,keys,now});
  const morningReadiness=createBodyEnergyMorningReadiness({db,stores,keys,publicationCapability,environment});
  async function withCurrentSection({userId,healthDate,requestedAt=at(),details=false,sourcePage=1},work){
    const id=requireUserId(userId,'bodyEnergySection');
    if(typeof work!=='function'||!Number.isFinite(requestedAt.getTime()))throw Error('BODY_ENERGY_SECTION_REQUEST_REQUIRED');
    const user=await db.getUser(id),locale=await db.getLocale(id);
    if(!user||user.id!==id||user.status!=='ACTIVE'||!locale)return null;
    const profileRevision=await revisionFor(id);
    const profileVerify=async()=>{
      const current=await db.getUser(id);
      if(!current||current.status!=='ACTIVE'||current.lifecycleGeneration!==user.lifecycleGeneration
        ||(current.displayName??'')!==(user.displayName??'')||await db.getLocale(id)!==locale
        ||profileRevision!==null&&await revisionFor(id)!==profileRevision)throw Error('BODY_ENERGY_RECIPIENT_FENCED');
    };
    let grant;try{grant=await assertReadPolicy(id);}catch{
      return work(renderBodyEnergy({status:'QUALIFICATION_PENDING'},{locale,displayName:user.displayName}),profileVerify,
        {status:'QUALIFICATION_PENDING',userId:id});
    }
    if(!grant.fixture&&profileRevision===null)throw Error('BODY_ENERGY_PROFILE_AUTHORITY_REQUIRED');
    if((await db.getOnboarding(id))?.state!=='READY')return work(renderBodyEnergy({status:'UNAVAILABLE'},{locale,displayName:user.displayName}),profileVerify,{status:'UNAVAILABLE',userId:id});
    return stores.withContext(id,{executionMode:'SHADOW',providerRequired:true},async context=>{
      const date=healthDate??bodyHealthDate(requestedAt.getTime(),context.timezone);
      const view=await stores.bodyEnergy.readForPublication(context,{healthDate:date,asOfEpochMs:requestedAt.getTime(),presentationPolicy:grant.presentationPolicy});
      const snapshot=JSON.stringify(view),name=user.displayName??'';
      const verify=async()=>{
        await profileVerify();await assertReadPolicy(id);await stores.assertCurrent(context);
        if((await db.getOnboarding(id))?.state!=='READY')throw Error('BODY_ENERGY_RECIPIENT_FENCED');
        const currentUser=await db.getUser(id),currentLocale=await db.getLocale(id);
        if(!currentUser||currentUser.status!=='ACTIVE'||currentUser.lifecycleGeneration!==context.lifecycleGeneration
          ||(currentUser.displayName??'')!==name||currentLocale!==locale
          ||profileRevision!==null&&await revisionFor(id)!==profileRevision)throw Error('BODY_ENERGY_RECIPIENT_FENCED');
        const fresh=await stores.bodyEnergy.readForPublication(context,{healthDate:date,asOfEpochMs:at().getTime(),presentationPolicy:grant.presentationPolicy});
        if(JSON.stringify(fresh)!==snapshot)throw Error('BODY_ENERGY_CURRENTNESS_FENCED');
      };
      await verify();return work(renderBodyEnergy(view,{locale,displayName:name,details,sourcePage}),verify,view);
    });
  }
  async function currentSection({userId,healthDate,requestedAt,details=false,sourcePage=1}){
    const id=requireUserId(userId,'bodyEnergyQuery'),locale=await db.getLocale(id),
      profileRevision=await revisionFor(id),user=await db.getUser(id);
    const result=await withCurrentSection({userId:id,healthDate,requestedAt,details,sourcePage},(message,_,view)=>({message,
      status:view.status,presentationPolicy:view.presentationPolicy??null,proof:view.publicationProof??null,healthDate:view.healthDate??null}));
    if(!result)return null;
    const recipe=Object.freeze({version:result.presentationPolicy?'body-energy-reply-v2':'body-energy-reply-v1',
      ...(result.presentationPolicy?{presentationPolicy:result.presentationPolicy}:{}),status:result.status,publicationProof:result.proof,
      healthDate:result.healthDate,locale,profileRevision,lifecycleGeneration:user.lifecycleGeneration});
    return {message:result.message,status:result.status,replyGuard:recipe,
      verifyCurrent:()=>verifyReplyGuard(recipe,id)};
  }
  async function verifyReplyGuard(recipe,userId){
    const id=requireUserId(userId,'bodyEnergyReplyGuard');
    if(recipe?.version==='body-energy-control-reply-v1')return notificationControl.verifyReplyGuard(recipe,id);
    if(!recipe||!['body-energy-reply-v1','body-energy-reply-v2'].includes(recipe.version)||Object.keys(recipe).sort().join(',')!==
      ['version','status','publicationProof','healthDate','locale','profileRevision','lifecycleGeneration',
        ...(recipe.version==='body-energy-reply-v2'?['presentationPolicy']:[])].sort().join(','))
      throw Error('BODY_ENERGY_REPLY_GUARD_INVALID');
    const user=await db.getUser(id);
    if(!user||user.status!=='ACTIVE'||user.lifecycleGeneration!==recipe.lifecycleGeneration||await db.getLocale(id)!==recipe.locale
      ||(recipe.profileRevision!==null&&await revisionFor(id)!==recipe.profileRevision))throw Error('BODY_ENERGY_RECIPIENT_FENCED');
    const verified=await withCurrentSection({userId:id,healthDate:recipe.healthDate??undefined},async(_,verify,view)=>{
      if(view.status!==recipe.status||(view.publicationProof??null)!==recipe.publicationProof
        ||(view.presentationPolicy??null)!==(recipe.presentationPolicy??null))throw Error('BODY_ENERGY_CURRENTNESS_FENCED');
      await verify();return true;
    });
    if(verified!==true)throw Error('BODY_ENERGY_RECIPIENT_FENCED');return true;
  }
  async function query(request){return isBodyEnergyQuery(request?.text)?currentSection({...request,details:true,sourcePage:bodyEnergyQueryPage(request.text)??1}):null;}
  async function beforeMorning(request){
    // Optional Body must not defer ordinary Morning after its server
    // publication configuration was disabled or changed during inspection.
    if(!publicationEnabled())return {action:'ORDINARY'};
    const result=await morningReadiness.inspect(request);
    return publicationEnabled()?result:{action:'ORDINARY'};
  }
  registerBodyEnergyTelegramReplyBoundary(db,verifyReplyGuard);

  return Object.freeze({withCurrentSection,currentSection,verifyReplyGuard,assertReadPolicy,isQuery:isBodyEnergyQuery,query,notificationControl,
    beforeMorning});
}
