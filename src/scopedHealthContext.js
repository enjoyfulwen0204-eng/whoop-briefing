import {canonicalJson} from './phase4EntityStore.js';
import {randomUUID} from 'node:crypto';
import {requireRuntimeAdmission,followRuntimeRenewal} from './runtimeAdmission.js';
import {resolvePerspective,PERSPECTIVE,intentIsInherentlyPersonal} from './bot/perspective.js';
import {localDate,addDays,localMidnightUtc} from './time.js';
import {assertRegisteredJournalProvenance} from './stage7JournalProvenance.js';
const SOURCE_SPECS=Object.freeze({sleep:['whoop_sleeps','id','health_date'],recovery:['whoop_recoveries','sleep_id','health_date'],cycle:['whoop_cycles','id','start_at'],workout:['whoop_workouts','id','start_at']});
const fail=code=>{throw Object.assign(Error(code),{code});};
export function selfQueryPerspective({text,intent=null,signals=null}){
 const resolved=resolvePerspective({text,signals});
 if([PERSPECTIVE.THIRD_PARTY,PERSPECTIVE.GENERAL].includes(resolved.perspective))return resolved;
 if(signals?.aboutSelf===false)return {...resolved,perspective:PERSPECTIVE.AMBIGUOUS,usePersonalData:false};
 const bare=/^(?:(?:今天|今日|昨天|昨晚|本週|最近(?:\s*\d+\s*天)?)的?)?(?:HRV|RHR|恢復(?:分數|狀況)?|睡眠(?:品質|時長)?)(?:是多少|多少|如何|怎麼樣|趨勢)?[?？。]?$/iu.test(String(text).trim())
  ||/^(?:(?:what is|how is|how was|show)(?: the)? )?(?:(?:today|yesterday)'?s? )?(?:HRV|RHR|recovery(?: score)?|sleep(?: quality)?)(?: (?:today|yesterday|over the (?:last|past) \d+ days))?[?.]?$/iu.test(String(text).trim());
 const registeredLive=/^\/(?:(?:insights|evidence)(?:@[A-Za-z0-9_]+)?\s+live(?:\s+history)?|episodes(?:@[A-Za-z0-9_]+)?(?:\s+live)?(?:\s+history)?)$/i.test(String(text).trim());
 if(resolved.usePersonalData||intentIsInherentlyPersonal(intent)&&bare||registeredLive||/^\/(?:now|energy|evidence|insights|journal|healthdata|status|predictions|healthspan)(?:@[A-Za-z0-9_]+)?$/i.test(String(text).trim()))return {...resolved,perspective:PERSPECTIVE.SELF,usePersonalData:true};
 return resolved;
}
/** The only public constructor accepts an authenticated private actor. No
 * caller-selected subject, SQL, execution mode, provider or scheduler exists. */
export async function createScopedHealthContext({db,keys,admission,now=()=>new Date(),derivedReader=null}){
 admission??=await db.admitRuntime();
 if(![34,35].includes(requireRuntimeAdmission(db.raw,admission,keys,db.transaction)))fail('SCOPED_V34_REQUIRED');
 const scopes=new WeakMap(),client=db.raw;
 followRuntimeRenewal(client,admission,keys,db.transaction,next=>{admission=next;});
 async function state(uid){
  const row=(await client.execute({sql:`SELECT u.id,u.status,u.timezone,u.lifecycle_generation,COALESCE(t.auth_generation,0) auth_generation,
   p.source_generation,p.purge_generation,p.pending_purge_count
   FROM users u LEFT JOIN user_whoop_tokens t ON t.user_id=u.id JOIN phase4_user_state p ON p.user_id=u.id
   WHERE u.id=?`,args:[uid]})).rows[0];
  if(!row||row.status!=='ACTIVE'||row.pending_purge_count!==0||row.auth_generation<1)fail('SCOPED_PRINCIPAL_FENCED');
  const computation=(await client.execute({sql:"SELECT input_generation,last_completed_generation,source_generation_seen,algorithm_set_version,revision FROM phase4_computation_state WHERE user_id=? AND execution_mode='LIVE'",args:[uid]})).rows[0]??null;
  const invalidation=(await client.execute({sql:"SELECT requested_generation,scope_kind,scope_revision FROM phase4_invalidations WHERE user_id=? AND execution_mode='LIVE'",args:[uid]})).rows[0]??null;
  return {...row,profileRevision:await db.getProfileRevision(uid),locale:await db.getLocale(uid),computation,invalidation};
 }
 async function assert(scope){
  const captured=scopes.get(scope);if(!captured)fail('SCOPED_CAPABILITY_REQUIRED');
  requireRuntimeAdmission(client,admission,keys,db.transaction);
  const current=(await db.resolveUserByChatId(captured.chatId))?.user;
  if(current?.id!==scope.userId||JSON.stringify(await state(scope.userId))!==JSON.stringify(captured.state))fail('SCOPED_CURRENTNESS_FENCED');
  if(now().getTime()-scope.asOfEpochMs>120000||now().getTime()<scope.asOfEpochMs)fail('SCOPED_ASOF_EXPIRED');
  await db.assertRuntimeFences?.();return captured;
 }
 async function open({user,chatId,text,intent=null,signals=null,asOf=now(),maxHealthDays=120,...extra}){
  if(Object.keys(extra).length||!Number.isSafeInteger(maxHealthDays)||maxHealthDays<1||maxHealthDays>120||!(asOf instanceof Date)||!Number.isFinite(asOf.getTime())||Math.abs(now()-asOf)>30000)fail('SCOPED_REQUEST_INVALID');
  const perspective=selfQueryPerspective({text,intent,signals});
  if(!perspective.usePersonalData)return Object.freeze({permitted:false,perspective:perspective.perspective});
  if(!/^\d+$/.test(String(chatId)))fail('SCOPED_PRIVATE_ACTOR_REQUIRED');
  const current=(await db.resolveUserByChatId(chatId))?.user;
  if(!current||current.id!==user?.id||current.lifecycleGeneration!==user.lifecycleGeneration)fail('SCOPED_ACTOR_FENCED');
  const captured=await state(current.id),to=localDate(asOf,captured.timezone);
  const scope=Object.freeze({permitted:true,userId:current.id,executionMode:'LIVE',purpose:'SELF_QA',perspective:PERSPECTIVE.SELF,
   asOfEpochMs:asOf.getTime(),asOfUtc:asOf.toISOString(),fromDate:addDays(to,1-maxHealthDays),toDate:to,maxHealthDays,timezone:captured.timezone,locale:captured.locale});
  scopes.set(scope,{state:captured,chatId:String(chatId),derivedReads:new Map()});await assert(scope);
  await client.execute({sql:"INSERT INTO stage8_scoped_read_audit(user_id,read_id,purpose,execution_mode,scope_hmac,as_of_utc,created_at) VALUES(?,?,'SELF_QA','LIVE',?,?,?)",args:[scope.userId,randomUUID(),keys.lookup(['scoped-health-v1',scope,captured]),scope.asOfUtc,now().toISOString()]});
  return scope;
 }
 async function facts(scope,type){
  const captured=await assert(scope),spec=SOURCE_SPECS[type];if(!spec)fail('SCOPED_SOURCE_NOT_ALLOWED');
  const access=(await client.execute({sql:'SELECT status FROM whoop_resource_access WHERE user_id=? AND resource=? AND auth_generation=? AND lifecycle_generation=?',args:[scope.userId,type,captured.state.auth_generation,captured.state.lifecycle_generation]})).rows[0];
  const unsupported=(await client.execute({sql:"SELECT 1 FROM whoop_capabilities WHERE user_id=? AND key=? AND lifecycle_generation=? AND status IN ('UNSUPPORTED','UNAVAILABLE')",args:[scope.userId,type,captured.state.lifecycle_generation]})).rows.length;
  if(unsupported)return {status:'UNAVAILABLE_FOR_ACCOUNT',rows:[]};
  if(access?.status!=='ACCESSIBLE')return {status:'RESOURCE_NOT_AUTHORIZED',rows:[]};
  const [table,id,date]=spec;
  const from=date==='start_at'?localMidnightUtc(addDays(scope.fromDate,-2),scope.timezone).toISOString():scope.fromDate,
   to=date==='start_at'?scope.asOfUtc:scope.toDate;
  const rows=(await client.execute({sql:`SELECT r.* FROM ${table} r WHERE r.user_id=? AND r.${date}>=? AND r.${date}<=?
   AND NOT EXISTS(SELECT 1 FROM whoop_resource_tombstones t WHERE t.user_id=r.user_id AND t.resource_type=? AND t.resource_id=CAST(r.${id} AS TEXT) AND t.state='ACTIVE')
   ORDER BY r.${date},r.${id} LIMIT 1001`,args:[scope.userId,from,to,type]})).rows;
  if(rows.length>1000)fail('SCOPED_SOURCE_LIMIT');await assert(scope);
  return {status:rows.length?'CURRENT_SOURCE_FACTS':'NO_SOURCE_RECORDS',rows,asOfUtc:scope.asOfUtc};
 }
 async function journal(scope){
  await assert(scope);
  const rows=(await client.execute({sql:"SELECT * FROM journal_events WHERE user_id=? AND health_date>=? AND health_date<=? AND fact_status='ACTIVE' AND content_state='PRESENT' AND source_linkage_state='COMPLETE' AND health_content_redacted_at IS NULL ORDER BY health_date,logical_fact_id LIMIT 501",args:[scope.userId,scope.fromDate,scope.toDate]})).rows;
  if(rows.length>500)fail('SCOPED_JOURNAL_LIMIT');for(const row of rows)assertRegisteredJournalProvenance(row);await assert(scope);return rows;
 }
 async function derived(scope,kind){
  await assert(scope);if(!['BODY_ENERGY','INSIGHTS','EPISODES','EVIDENCE'].includes(kind))fail('SCOPED_DERIVED_KIND');
  const row=(await client.execute({sql:"SELECT c.* FROM phase4_computation_state c WHERE c.user_id=? AND c.execution_mode='LIVE' AND c.last_completed_generation=c.input_generation AND c.source_generation_seen=? AND NOT EXISTS(SELECT 1 FROM phase4_invalidations i WHERE i.user_id=c.user_id AND i.execution_mode='LIVE' AND i.scope_kind<>'NONE')",args:[scope.userId,scopes.get(scope).state.source_generation]})).rows[0];
  const remember=result=>{scopes.get(scope).derivedReads.set(kind,{kind,fingerprint:derivedFingerprint(result),...(result.status==='CURRENT'?{validUntil:result.validUntil}:{})});return result;};
  if(!row||!derivedReader)return remember({status:'ANALYSIS_UPDATING',kind,asOfUtc:scope.asOfUtc,items:[]});
  // Reader is owned by server composition and uses registered producer/parent
  // checks. A model-provided row or a SHADOW result is never an alternative.
  const result=await derivedReader({scope,kind,inputGeneration:row.input_generation});await assert(scope);return remember(result);
 }
 const derivedFingerprint=result=>keys.lookup(['stage8-self-derived-projection-v1',result.status,result.kind,result.historyScope??null,result.items]);
 async function sealReply(scope,reply){
  const captured=await assert(scope),derivedReads=[...captured.derivedReads.values()],expiresAt=Math.min(scope.asOfEpochMs+120000,...derivedReads.filter(value=>value.validUntil!==undefined).map(value=>value.validUntil));
  if(!Number.isFinite(expiresAt)||expiresAt<=now().getTime())fail('SCOPED_DERIVED_EXPIRED');
  const guard={userId:scope.userId,chatId:captured.chatId,state:captured.state,asOfEpochMs:scope.asOfEpochMs,expiresAt,derivedReads};
  return {...reply,stage8ReplyGuard:{...guard,signature:keys.lookup(['stage8-self-reply-v1',guard,canonicalJson(reply)])}};
 }
 async function verifyReply({userId,chatId,reply}){
  try{return await db.transaction(async()=>{
   const {stage8ReplyGuard,...projection}=reply??{};const {signature,...guard}=stage8ReplyGuard??{};
   if(signature!==keys.lookup(['stage8-self-reply-v1',guard,canonicalJson(projection)])||guard.userId!==userId||guard.chatId!==String(chatId)
    ||now().getTime()<guard.asOfEpochMs||now().getTime()-guard.asOfEpochMs>120000||!Number.isFinite(guard.expiresAt)||now().getTime()>=guard.expiresAt
    ||!Array.isArray(guard.derivedReads)||guard.derivedReads.length>4)return false;
   requireRuntimeAdmission(client,admission,keys,db.transaction);
   if((await db.resolveUserByChatId(chatId))?.user?.id!==userId)return false;
   if(JSON.stringify(await state(userId))!==JSON.stringify(guard.state))return false;
   for(const read of guard.derivedReads){
    if(!['BODY_ENERGY','INSIGHTS','EPISODES','EVIDENCE'].includes(read.kind))return false;
    const at=now(),scope={permitted:true,userId,executionMode:'LIVE',purpose:'SELF_QA',asOfUtc:at.toISOString(),asOfEpochMs:at.getTime()},computation=guard.state.computation;
    const result=!computation||computation.last_completed_generation!==computation.input_generation||!derivedReader
     ?{status:'ANALYSIS_UPDATING',kind:read.kind,items:[]}
     :await derivedReader({scope,kind:read.kind,inputGeneration:computation.input_generation});
    if(derivedFingerprint(result)!==read.fingerprint)return false;
   }
   await db.assertRuntimeFences?.();return JSON.stringify(await state(userId))===JSON.stringify(guard.state);
  });}catch{return false;}
 }
 return Object.freeze({open,assert,facts,journal,derived,sealReply,verifyReply});
}
