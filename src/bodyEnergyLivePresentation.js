import {BODY_ENERGY_PROVISIONAL_POLICY} from './bodyEnergyProvisionalPolicy.js';
import {bodyEnergyQueryPage,isBodyEnergyQuery,renderBodyEnergy} from './bodyEnergyPresentation.js';
import {bodyHealthDate} from './bodyEnergyInputs.js';

/** Server-only bridge over the canonical LIVE reader and the independent Body
 * publication grant. No calculation, source writer, notification or grant is
 * created here. The dedicated scopes keep source provenance out of the general
 * Coach/derived projection; both authorities are rechecked before transport. */
export function createBodyEnergyLivePresentation({db,scopes,bodyEnergy,now=()=>new Date()}={}){
  if(typeof db?.getOnboarding!=='function'||typeof scopes?.open!=='function'
    ||typeof scopes?.derived!=='function'||typeof scopes?.sealReply!=='function')
    throw Error('BODY_ENERGY_LIVE_PRESENTATION_DEPENDENCIES_REQUIRED');
  const policy=async userId=>{
    if(!bodyEnergy?.assertReadPolicy)return null;
    try{return await bodyEnergy.assertReadPolicy(userId);}
    catch(error){if((error.code??error.message)==='BODY_ENERGY_PUBLICATION_NOT_QUALIFIED')return null;throw error;}
  };
  const state=async userId=>{
    const grant=await policy(userId),user=await db.getUser(userId);
    return {version:'stage8-body-energy-reply-v1',qualified:Boolean(grant),
      presentationPolicy:grant?.presentationPolicy??null,ready:(await db.getOnboarding(userId))?.state==='READY',
      healthDate:bodyHealthDate(now().getTime(),user.timezone)};
  };
  async function query({user,chatId,text}){
    if(!isBodyEnergyQuery(text))return null;
    const scope=await scopes.open({user,chatId,text,asOf:now(),maxHealthDays:1});
    if(!scope.permitted)return null;
    const captured=await state(scope.userId);
    if(captured.healthDate!==scope.toDate)throw Error('BODY_ENERGY_LIVE_DATE_CHANGED');
    let view={status:captured.qualified?'UNAVAILABLE':'QUALIFICATION_PENDING'};
    if(captured.qualified&&captured.ready){
      const result=await scopes.derived(scope,'BODY_ENERGY');
      if(result.status==='CURRENT'){
        const item=result.items.find(item=>item.presentation?.healthDate===scope.toDate
          &&item.presentation?.timezone===scope.timezone);
        const candidate=item?.presentation,provisional=captured.presentationPolicy===BODY_ENERGY_PROVISIONAL_POLICY.version;
        // The owner-only baseline policy never authorizes mature AVAILABLE
        // scores; mature qualification never upgrades a LIMITED source.
        if(candidate&&(provisional?candidate.status==='PROVISIONAL'
          &&candidate.presentationPolicy===captured.presentationPolicy
          :captured.presentationPolicy===null&&candidate.status==='AVAILABLE'))view=candidate;
      }else view={status:'PROCESSING'};
    }
    const userNow=await db.getUser(scope.userId);
    if(JSON.stringify(await state(scope.userId))!==JSON.stringify(captured))throw Error('BODY_ENERGY_LIVE_POLICY_CHANGED');
    await scopes.assert(scope);
    return scopes.sealReply(scope,{text:renderBodyEnergy(view,{locale:scope.locale,displayName:userNow?.displayName,
      details:true,sourcePage:bodyEnergyQueryPage(text)??1}),stage8BodyEnergyGuard:captured});
  }
  async function verifyReply(input){
    try{
      const guard=input.reply?.stage8BodyEnergyGuard;
      if(!guard||Object.keys(guard).sort().join(',')!=='healthDate,presentationPolicy,qualified,ready,version'
        ||guard.version!=='stage8-body-energy-reply-v1'||typeof guard.qualified!=='boolean'||typeof guard.ready!=='boolean'
        ||!await scopes.verifyReply(input))return false;
      return JSON.stringify(await state(input.userId))===JSON.stringify(guard);
    }catch{return false;}
  }
  return Object.freeze({isQuery:isBodyEnergyQuery,query,verifyReply});
}
