import {timingSafeEqual} from 'node:crypto';
import {requirePhase4Keys} from './phase4Keys.js';
import {workStepOptions} from './phase4WorkStep.js';

export const FAMILY_CLASSES=Object.freeze(['daily','alert','weekly']);
export const familyFail=code=>{throw Object.assign(Error(code),{code});};
export function familyConfiguration(env={}){
 const enabled=env.FAMILY_SHARING??'off',raw=env.FAMILY_GROUP_USER_IDS??'';
 if(!['on','off'].includes(enabled)||typeof raw!=='string')familyFail('FAMILY_CONFIG_INVALID');
 const ids=raw?raw.split(',').map(s=>s.trim()).sort():[];
 if(ids.length>8||ids.some(id=>!id||id.length>128)||new Set(ids).size!==ids.length||enabled==='on'&&ids.length<2)familyFail('FAMILY_CONFIG_INVALID');
 return Object.freeze({enabled:enabled==='on',ids:Object.freeze(ids)});
}
export const familyIdentity=row=>row&&[row.id,row.lifecycle_generation,row.auth_generation,row.purge_generation,row.telegram_chat_id];
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function createFamilyStore({db,keys,environment,now=()=>new Date()}){
 requirePhase4Keys(keys);
 const config=familyConfiguration(environment),group=keys.lookup(['family-group-v1',config.ids]);
 // Delivery barriers are independent of the configurable group. Editing the
 // allowlist must never resurrect a previously uncertain Telegram send.
 const namespace=kind=>kind==='delivery'?'family-delivery-barrier-v1':group;
 const key=(kind,id='')=>'family:v1:'+keys.lookup([namespace(kind),kind,id]);
 const seal=(kind,id,body)=>JSON.stringify({body,signature:keys.lookup(['family-state-v1',namespace(kind),kind,id,body])});
 function open(kind,id,raw){
  if(raw==null)return null;
  try{const v=JSON.parse(raw),expected=keys.lookup(['family-state-v1',namespace(kind),kind,id,v.body]);
   if(Object.keys(v).sort().join(',')!=='body,signature'||typeof v.signature!=='string'||!/^[a-f0-9]{64}$/.test(v.signature)
    ||!timingSafeEqual(Buffer.from(v.signature,'hex'),Buffer.from(expected,'hex')))familyFail('FAMILY_STATE_INVALID');
   return v.body;
  }catch{familyFail('FAMILY_STATE_INVALID');}
 }
 function assertConfig(){if(!config.enabled||!same(familyConfiguration(environment),config))familyFail('FAMILY_CONFIG_FENCED');}
 const read=async(kind,id='')=>{assertConfig();return open(kind,id,await db.getState(key(kind,id)));};
 const write=(kind,id,body)=>{assertConfig();return db.setState(key(kind,id),seal(kind,id,body),{now:now()});};
 // Only control metadata; no token value, health payload or Journal content.
 async function members(){
  assertConfig();
  const rows=(await db.raw.execute({sql:`SELECT u.id,u.display_name,u.timezone,u.lifecycle_generation,
   t.auth_generation,p.purge_generation,p.source_generation,g.telegram_chat_id,
   COALESCE(n.notifications_paused,0) paused,COALESCE(j.quiet_start,'22:00') quiet_start,
   COALESCE(j.quiet_end,'08:00') quiet_end
   FROM users u JOIN user_whoop_tokens t ON t.user_id=u.id
   JOIN phase4_user_state p ON p.user_id=u.id
   JOIN user_telegram g ON g.user_id=u.id AND g.status='ACTIVE'
   LEFT JOIN user_notification_preferences n ON n.user_id=u.id
   LEFT JOIN journal_tracking_preferences j ON j.user_id=u.id AND j.lifecycle_generation=u.lifecycle_generation
   WHERE u.id IN (${config.ids.map(()=>'?').join(',')}) AND u.status='ACTIVE'
    AND t.access_token IS NOT NULL AND p.pending_purge_count=0 ORDER BY u.id LIMIT 9`,args:config.ids})).rows;
  // Multiple active chat bindings never create multiple recipients.
  if(new Set(rows.map(r=>r.id)).size!==rows.length)familyFail('FAMILY_BINDING_AMBIGUOUS');
  return rows.map(r=>({...r}));
 }
 const empty=()=>({version:1,revision:0,grants:{},mutes:{},invites:{}});
 async function state(){const s=await read('consent');if(s===null)return empty();
  if(s.version!==1||!Number.isSafeInteger(s.revision)||s.revision<0||!s.grants||!s.mutes||!s.invites)familyFail('FAMILY_STATE_INVALID');return s;}
 const pair=(source,recipient)=>keys.lookup(['family-pair-v1',source,recipient]);
 function allowed(s,rows,source,recipient,category){
  if(!FAMILY_CLASSES.includes(category)||source===recipient)return false;
  const a=rows.find(r=>r.id===source),b=rows.find(r=>r.id===recipient),g=s.grants[pair(source,recipient)];
  return Boolean(a&&b&&g&&same(g.source,familyIdentity(a))&&same(g.recipient,familyIdentity(b))&&g[category]===true
   &&s.mutes[pair(source,recipient)]?.all!==true&&s.mutes[pair(source,recipient)]?.[category]!==true);
 }
 const grantVisible=(s,rows,a,b,c)=>{const clean={...s,mutes:{}};return allowed(clean,rows,a,b,c);};
 async function authenticate(user,chatId,rows){
  rows??=await members();
  const actor=rows.find(r=>r.id===user?.id);
  if(!actor||actor.telegram_chat_id!==String(chatId)||actor.lifecycle_generation!==user.lifecycleGeneration)familyFail('FAMILY_ACTOR_FENCED');return actor;
 }
 async function change({actor,peer,category,value,kind}){
  if(actor.id===peer.id||!config.ids.includes(actor.id)||!config.ids.includes(peer.id)
   ||!['grant','mute','invite','decline'].includes(kind)||kind==='grant'&&!FAMILY_CLASSES.includes(category)
   ||kind==='mute'&&!['all',...FAMILY_CLASSES].includes(category))familyFail('FAMILY_ACTION_INVALID');
  const s=await state(),rows=await members(),a=rows.find(r=>r.id===actor.id),b=rows.find(r=>r.id===peer.id);
  if(!same(familyIdentity(a),familyIdentity(actor))||!same(familyIdentity(b),familyIdentity(peer)))familyFail('FAMILY_ACTOR_FENCED');
  if(kind==='grant'||kind==='decline'){
   const k=pair(a.id,b.id),old=s.grants[k];
   const g=old&&same(old.source,familyIdentity(a))&&same(old.recipient,familyIdentity(b))?old:{source:familyIdentity(a),recipient:familyIdentity(b),daily:false,alert:false,weekly:false};
   if(kind==='decline')for(const c of FAMILY_CLASSES)g[c]=false;else g[category]=Boolean(value);
   s.grants[k]=g;delete s.invites[pair(b.id,a.id)];
  }else if(kind==='mute'){const k=pair(b.id,a.id);s.mutes[k]={...s.mutes[k],[category]:Boolean(value)};}
  else{
   const k=pair(a.id,b.id),old=s.invites[k];
   if(!old||Date.parse(old.at)+86400000<=now().getTime())s.invites[k]={requester:familyIdentity(a),target:familyIdentity(b),at:now().toISOString()};
  }
  s.revision++;await write('consent','',s);return s;
 }
 const transaction=(kind,facts,run)=>db.transaction(run,workStepOptions('family.'+kind,facts,{discardResult:true,replay:()=>familyFail('FAMILY_OPERATION_REPLAY_FENCED')}));
 return Object.freeze({config,group,key,read,write,state,members,allowed,grantVisible,pair,authenticate,change,transaction,assertConfig});
}
