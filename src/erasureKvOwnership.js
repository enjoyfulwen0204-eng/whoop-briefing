import {createHash} from 'node:crypto';
import {requirePhase4Keys} from './phase4Keys.js';
import {classifyErasureKey} from './erasureCatalog.js';
import {addDays,localDate} from './time.js';

const fail=code=>{throw Object.assign(Error(code),{code});};
const parse=raw=>{try{return JSON.parse(raw);}catch{return null;}};
const sha=value=>createHash('sha256').update(value).digest('hex');
/** No connection, environment fallback, or writes. All identity material stays
 * in the caller's memory. Every stored key must resolve, or erasure is refused.
 * Date markers are derived from their original semantic date; a later timezone
 * change must not strand an earlier generation's key. */
export function resolveErasureKv({keys,users,entries,claims=[],tokens=[],phases=[],familyIds=[],morningOwners=new Map()}){
 requirePhase4Keys(keys);
 const stored=new Map(entries.map(r=>[r.key,r])),owners=new Map(),shared=new Set(),system=new Set();
 if(stored.size!==entries.length)fail('ERASURE_KV_AMBIGUOUS');
 for(const r of entries)classifyErasureKey(r.key);
 const own=(key,...ids)=>{if(!stored.has(key))return;const held=owners.get(key)??new Set();for(const id of ids)held.add(id);owners.set(key,held);};
 for(const [key,id] of morningOwners)own(key,id);
 const beta=(kind,id)=>'beta:v1:'+keys.lookup(['beta-state-key-v1',kind,id]);
 const familyGroup=keys.lookup(['family-group-v1',[...familyIds].sort()]);
 const family=(kind,id='')=>'family:v1:'+keys.lookup([kind==='delivery'?'family-delivery-barrier-v1':familyGroup,kind,id]);
 let familyState=null;
 const familyEntry=stored.get(family('consent'));
 if(familyEntry){const envelope=parse(familyEntry.value);familyState=envelope?.body;
  if(!familyState||envelope.signature!==keys.lookup(['family-state-v1',familyGroup,'consent','',familyState]))fail('ERASURE_FAMILY_STATE_INVALID');
  // This one row is a projection, never a blanket delete for one member.
  for(const collection of ['grants','invites'])for(const v of Object.values(familyState[collection]??{})){
   for(const field of ['source','recipient','requester','target'])if(Array.isArray(v[field]))own(family('consent'),v[field][0]);
  }
  for(const a of familyIds)for(const b of familyIds)if(familyState.mutes?.[keys.lookup(['family-pair-v1',a,b])])own(family('consent'),a,b);
  if(!owners.has(family('consent')))shared.add(family('consent'));
 }
 for(const user of users){
  const id=user.id,life=user.lifecycle_generation;
  if(typeof id!=='string'||!Number.isSafeInteger(life)||life<1||life>10000)fail('ERASURE_GENERATION_UNPROVEN');
  own('canonical-profile-revision:v1:'+sha(id),id);own('settings:v1:'+sha(id),id);
  own('account-self:v1:'+keys.lookup(['account-self',id]),id);
  own('body-energy:notification-control:'+keys.lookup(['body-energy-control-v1',id]),id);
  own('body-energy:alert-pointer:'+keys.lookup(['body-energy-alert-pointer-v1',id]),id);
  own(beta('member',id),id);own(family('ui',id),id);
  for(const entry of entries){const body=parse(entry.value),marker=body?.body??body;
   if(entry.key.startsWith('association-check-v1:')&&/^\d{4}-\d{2}-\d{2}$/.test(marker?.date??''))own('association-check-v1:'+keys.lookup(['association-check-v1',id,marker.date,'on-demand-association-v1']),id);
   if(entry.key.startsWith('night-analysis:')&&/^\d{4}-\d{2}-\d{2}$/.test(marker?.date??''))for(let gen=1;gen<=life;gen++)for(const step of ['LIGHT','HEAVY','MEMORY'])own('night-analysis:'+keys.lookup(['night-analysis-v1',id,gen,marker.date,step]),id);
   if(entry.key.startsWith('body-low-discard:')){
    const utcDay=String(entry.updated_at).slice(0,10);if(!/^\d{4}-\d{2}-\d{2}$/.test(utcDay))fail('ERASURE_KV_DATE_INVALID');
    for(let gen=1;gen<=life;gen++)for(const offset of [-2,-1,0,1,2])own('body-low-discard:'+keys.lookup([id,gen,addDays(utcDay,offset)]),id);
   }
   if(entry.key.startsWith('beta:v1:')&&marker?.month&&[80,100].includes(marker.threshold))for(const recipient of users){
    const stamp=keys.lookup([id,marker.month,marker.threshold,recipient.id]);own(beta('cost-notice',stamp),id,recipient.id);
   }
   if(entry.key.startsWith('family:v1:')&&marker?.at&&marker?.status){
    const date=localDate(new Date(marker.at),'Asia/Taipei');
    for(let n=0;n<=7;n++){const period=addDays(date,-n);
     for(const category of ['daily','weekly'])own(family('delivery',keys.lookup(['family-delivery-v1',category,id,period])),id);
     for(const source of familyIds)own(family('delivery',keys.lookup(['family-delivery-v1','alert',id,period,source])),id,source);
    }
   }
  }
 }
 // Invite keys are derived from a stored *hash*, never from a bearer code.
 // New invitations carry signed owner/recipient metadata; pre-E1a invitations
 // did not exist at the erasure baseline. Unknown old envelopes fail closed.
 for(const user of users){const member=parse(stored.get(beta('member',user.id))?.value)?.body;
  if(member?.inviteHash)own(beta('invite',member.inviteHash),user.id,member.invitedBy);
 }
 for(const entry of entries.filter(e=>e.key.startsWith('beta:v1:'))){const e=parse(entry.value),b=e?.body;
  if(b?.inviteHash&&e.signature===keys.lookup(['beta-state-v1','invite',b.inviteHash,b]))own(beta('invite',b.inviteHash),...[b.issuedBy,b.usedBy].filter(Boolean));
 }
 for(const entry of entries.filter(e=>e.key.startsWith('family:v1:'))){const e=parse(entry.value),b=e?.body;
  if(b?.deliveryIdentity!==undefined){
   if(!/^[a-f0-9]{64}$/.test(b.deliveryIdentity)||!Array.isArray(b.subjects)||!b.subjects.length||b.subjects.some(id=>typeof id!=='string'||!id)
    ||entry.key!==family('delivery',b.deliveryIdentity)||e.signature!==keys.lookup(['family-state-v1','family-delivery-barrier-v1','delivery',b.deliveryIdentity,b]))fail('ERASURE_FAMILY_STATE_INVALID');
   own(entry.key,...b.subjects);
  }
 }
 for(const request of Object.values(familyState?.invites??{})){
  const a=request.requester?.[0],b=request.target?.[0];if(a&&b)own(family('delivery',keys.lookup(['family-delivery-v1','invite',b,request.at,a])),a,b);
 }
 for(const claim of claims){
  if(claim.report_type!=='daily'||!claim.owner)continue;
  const auth=tokens.find(t=>t.user_id===claim.user_id)?.auth_generation??0,purge=phases.find(p=>p.user_id===claim.user_id)?.purge_generation??0;
  if(!Number.isSafeInteger(auth)||auth<0||auth>10000||!Number.isSafeInteger(purge)||purge<0||purge>10000)fail('ERASURE_GENERATION_UNPROVEN');
  for(let a=1;a<=auth;a++)for(let p=0;p<=purge;p++)own('morning-snapshot:'+keys.lookup(['morning-snapshot-v1',claim.user_id,claim.local_date,claim.lifecycle_generation,claim.owner,a,p]),claim.user_id);
 }
 const unresolved=[];
 for(const entry of entries){
  if(entry.key==='telegram_offset')system.add(entry.key);
  if(entry.key==='canonical-profile-revision:v1:supervisor:boot-generation:v1'){
   // Frozen productionEpochManifest / productionEpochBootstrap contract.
   // This global boot counter has no cohort, user, provider or chat fields.
   const wire=parse(entry.value),b=wire?.body,domain='production-supervisor-monotonic-boot-v1';
   if(Object.keys(wire??{}).sort().join(',')!=='body,digest,signature'
    ||Object.keys(b??{}).sort().join(',')!=='contract,generation,issuedAtMs,nonce,releaseSha'
    ||b.contract!==domain||!Number.isSafeInteger(b.generation)||b.generation<1
    ||!Number.isSafeInteger(b.issuedAtMs)||b.issuedAtMs<=0
    ||!/^[a-f0-9]{64}$/.test(b.nonce)||!/^[a-f0-9]{40}$/.test(b.releaseSha)
    ||wire.signature!==keys.digest(keys.lookup([domain]),[domain,b])
    ||wire.digest!==keys.lookup([domain,b,wire.signature]))fail('ERASURE_SYSTEM_BOOT_INVALID');
   system.add(entry.key);
  }
  if(entry.key.startsWith('e1b:retention:'))shared.add(entry.key);
  if(!owners.has(entry.key)&&!shared.has(entry.key)&&!system.has(entry.key))unresolved.push(entry.key.split(':')[0]);
 }
 if(unresolved.length)throw Object.assign(Error('ERASURE_KV_OWNERSHIP_UNPROVEN'),{code:'ERASURE_KV_OWNERSHIP_UNPROVEN',unresolvedPrefixes:unresolved.reduce((out,p)=>(out[p]=(out[p]??0)+1,out),{})});
 return {owners,shared,system,familyConsentKey:family('consent'),familyState,familyGroup};
}

/** Page private KV payloads instead of materializing the state table. Only
 * derived key->owner associations survive a page; one signed consent envelope
 * and one beta membership per bounded control user are needed for joins. */
export async function resolveErasureKvReadOnly({client,keys,users,familyIds=[]}){
 if(users.length>100)fail('ERASURE_USER_BOUND');
 const q=(sql,args=[])=>({sql,args}),rows=async(sql,args=[])=>(await client.execute(q(sql,args))).rows;
 const tokens=await rows('SELECT user_id,auth_generation FROM user_whoop_tokens LIMIT 101'),phases=await rows('SELECT user_id,purge_generation FROM phase4_user_state LIMIT 101');
 if(tokens.length>100||phases.length>100)fail('ERASURE_USER_BOUND');
 const morningOwners=new Map();let cursor=0;
 for(;;){
  const page=await rows("SELECT rowid scan_id,user_id,local_date,lifecycle_generation,owner FROM report_claims WHERE rowid>? AND report_type='daily' ORDER BY rowid LIMIT 64",[cursor]);
  for(const c of page){cursor=c.scan_id;if(!c.owner)continue;
   const auth=tokens.find(t=>t.user_id===c.user_id)?.auth_generation??0,purge=phases.find(p=>p.user_id===c.user_id)?.purge_generation??0;
   if(!Number.isSafeInteger(auth)||auth<0||auth>10000||!Number.isSafeInteger(purge)||purge<0||purge>10000)fail('ERASURE_GENERATION_UNPROVEN');
   for(let a=1;a<=auth;a++)for(let p=0;p<=purge;p++)morningOwners.set('morning-snapshot:'+keys.lookup(['morning-snapshot-v1',c.user_id,c.local_date,c.lifecycle_generation,c.owner,a,p]),c.user_id);
   if(morningOwners.size>100000)fail('ERASURE_KV_BOUND');
  }
  if(page.length<64)break;
 }
 const group=keys.lookup(['family-group-v1',[...familyIds].sort()]),familyKey='family:v1:'+keys.lookup([group,'consent','']);
 const baseKeys=[familyKey,...users.map(u=>'beta:v1:'+keys.lookup(['beta-state-key-v1','member',u.id]))],base=[];
 for(const key of baseKeys)base.push(...await rows('SELECT key,value,updated_at FROM telegram_state WHERE key=?',[key]));
 let result=resolveErasureKv({keys,users,entries:base,familyIds,morningOwners}),after='',count=0;
 const merge=part=>{for(const [key,ids] of part.owners){const set=result.owners.get(key)??new Set();for(const id of ids)set.add(id);result.owners.set(key,set);}for(const key of part.shared)result.shared.add(key);for(const key of part.system)result.system.add(key);};
 for(;;){const page=await rows('SELECT key,value,updated_at FROM telegram_state WHERE key>? ORDER BY key LIMIT 32',[after]);
  for(const entry of page){after=entry.key;if(++count>100000)fail('ERASURE_KV_BOUND');if(entry.key.startsWith('e1b:pending:')||baseKeys.includes(entry.key))continue;
   if(Buffer.byteLength(entry.value??'')>1024*1024)fail('ERASURE_KV_VALUE_BOUND');
   merge(resolveErasureKv({keys,users,entries:[...base,entry],familyIds,morningOwners}));
  }if(page.length<32)break;
 }
 return {...result,familyEntry:base.find(e=>e.key===familyKey)??null};
}

/** Remove only the target's edges, with the existing signed family contract.
 * No revision churn at all for a subject absent from the group. */
export function eraseFamilyProjection({keys,resolution,subject,familyIds}){
 const before=resolution.familyState;if(!before)return null;
 const body=structuredClone(before);let changed=false;
 for(const kind of ['grants','mutes','invites'])for(const peer of familyIds)for(const pair of [[subject,peer],[peer,subject]]){
  const key=keys.lookup(['family-pair-v1',...pair]);if(Object.hasOwn(body[kind]??{},key)){delete body[kind][key];changed=true;}
 }
 if(!changed)return null;
 body.revision++;
 return {key:resolution.familyConsentKey,value:JSON.stringify({body,signature:keys.lookup(['family-state-v1',resolution.familyGroup,'consent','',body])})};
}
