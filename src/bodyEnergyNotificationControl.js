import {requireUserId} from './userContext.js';
import {requirePhase4Keys} from './phase4Keys.js';
import {workStepOptions} from './phase4WorkStep.js';
import {bodyEnergyControlReply} from './bodyEnergyPresentation.js';
export const bodyEnergyControlCommand=text=>typeof text==='string'?/^\/energy(?:@[a-z0-9_]+)?\s+alerts\s+(on|off)\s*$/iu.exec(text.trim())?.[1]?.toLowerCase()??null:null;
/** Non-health metadata only. This user control never alters Morning Brief or
 * existing global proactive preferences and grants no numeric publication. */
export function createBodyEnergyNotificationControl({db,keys,now=()=>new Date()}={}){
  requirePhase4Keys(keys);
  for(const method of ['getState','setState','transaction','resolveUserByChatId','assertAccountActive','getUser','getLocale'])
    if(typeof db?.[method]!=='function')throw Error('BODY_ENERGY_CONTROL_DEPENDENCIES_REQUIRED');
  const key=id=>'body-energy:notification-control:'+keys.lookup(['body-energy-control-v1',id]);
  const parse=raw=>{try{const value=JSON.parse(raw);return value?.version===1&&typeof value.alertsEnabled==='boolean'
    &&Number.isSafeInteger(value.revision)&&value.revision>=1
    &&Number.isSafeInteger(value.lifecycleGeneration)&&value.lifecycleGeneration>=1?value:null;}catch{return null;}};
  return Object.freeze({
    async read(userId){const id=requireUserId(userId,'bodyEnergyAlertPreference'),user=await db.getUser(id),value=parse(await db.getState(key(id)));
      return user?.status==='ACTIVE'&&value?.lifecycleGeneration===user.lifecycleGeneration?value:
        {version:1,alertsEnabled:false,revision:0,lifecycleGeneration:user?.lifecycleGeneration??null};},
    async handle({text,user,chatId}){
      const action=bodyEnergyControlCommand(text);if(!action)return null;
      const id=requireUserId(user?.id,'bodyEnergyAlertControl');
      return db.transaction(async()=>{
        const resolved=await db.resolveUserByChatId(String(chatId)),current=resolved?.user??resolved;
        if(!current||current.id!==id||current.status!=='ACTIVE'||!Number.isSafeInteger(user.lifecycleGeneration)
          ||current.lifecycleGeneration!==user.lifecycleGeneration)throw Error('BODY_ENERGY_CONTROL_ACTOR_FENCED');
        const locale=await db.getLocale(id);if(!locale)throw Error('BODY_ENERGY_LOCALE_REQUIRED');
        const prior=parse(await db.getState(key(id))),enabled=action==='on';
        if(!prior||prior.alertsEnabled!==enabled||prior.lifecycleGeneration!==current.lifecycleGeneration){
          const revision=(prior?.revision??0)+1;if(!Number.isSafeInteger(revision))throw Error('BODY_ENERGY_CONTROL_REVISION_EXHAUSTED');
          await db.setState(key(id),JSON.stringify({version:1,alertsEnabled:enabled,revision,lifecycleGeneration:current.lifecycleGeneration}),{now:now()});
        }
        await db.assertAccountActive(id,user.lifecycleGeneration);
        const control=parse(await db.getState(key(id)));
        if(control?.alertsEnabled!==enabled||control.lifecycleGeneration!==current.lifecycleGeneration)throw Error('BODY_ENERGY_CONTROL_REPLY_FENCED');
        const profileRevision=typeof db.getProfileRevision==='function'?await db.getProfileRevision(id):null;
        return {message:bodyEnergyControlReply(locale,enabled),replyGuard:Object.freeze({version:'body-energy-control-reply-v1',
          alertsEnabled:enabled,consentRevision:control.revision,lifecycleGeneration:current.lifecycleGeneration,locale,profileRevision})};
      },workStepOptions('body-energy.notification-control',[id,user.lifecycleGeneration,action]));
    },
    async verifyReplyGuard(recipe,userId){
      const id=requireUserId(userId,'bodyEnergyControlReply');
      if(!recipe||recipe.version!=='body-energy-control-reply-v1'||Object.keys(recipe).sort().join(',')!==
        ['version','alertsEnabled','consentRevision','lifecycleGeneration','locale','profileRevision'].sort().join(','))throw Error('BODY_ENERGY_CONTROL_REPLY_FENCED');
      const user=await db.getUser(id),control=parse(await db.getState(key(id)));
      if(!user||user.status!=='ACTIVE'||user.lifecycleGeneration!==recipe.lifecycleGeneration||!control
        ||control.lifecycleGeneration!==recipe.lifecycleGeneration||control.revision!==recipe.consentRevision||control.alertsEnabled!==recipe.alertsEnabled
        ||await db.getLocale(id)!==recipe.locale||(recipe.profileRevision!==null&&await db.getProfileRevision(id)!==recipe.profileRevision))
        throw Error('BODY_ENERGY_CONTROL_REPLY_FENCED');return true;
    },
    key,
  });
}
