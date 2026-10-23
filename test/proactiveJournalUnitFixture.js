/** Local policy/settlement unit double only. Real Stage7 keyboards, authority,
 * callbacks and persistence are tested by stage7-proactive-journal.test.js.
 * This adapter deliberately creates no legacy pending-question mirror. */
import {createOwnedFileDb} from '../src/db.js';
import {fixtureKeys} from './localDb.js';
export function createDb(options){
 if(typeof options?.url!=='string'||!options.url.startsWith('file:'))throw Error('SYNTHETIC_LOCAL_POLICY_FIXTURE_REQUIRED');
 return createOwnedFileDb({...options,phase4Keys:fixtureKeys});
}
import {checkAndAct as runAgent} from '../src/proactiveAgent.js';
import {isSuppressedDelivery} from '../src/accountLifecycle.js';
import {addDays} from '../src/time.js';
import {PROACTIVE_QUESTION_INTENT} from '../src/schema.js';
export function checkAndAct(options){
 if(options.db?.raw?.protocol!=='file')throw Error('SYNTHETIC_LOCAL_POLICY_FIXTURE_REQUIRED');
 const proactiveJournal=options.proactiveJournal??(async({eventId})=>{
  await options.db.assertAccountActive(options.userId,options.expectedLifecycleGeneration);
  const event=(await options.db.raw.execute({sql:'SELECT message_text FROM proactive_events WHERE user_id=? AND id=?',args:[options.userId,eventId]})).rows[0];
  const result=await options.telegram.send(event.message_text);
  return {status:isSuppressedDelivery(result)?'FAILED_DEFINITE':'DELIVERED'};
 });
 return runAgent({...options,proactiveJournal});
}
/** Seed an explicit pre-upgrade unanswered legacy question. This is never a
 * new current-runtime delivery and grants no Stage7 trusted fact authority. */
export async function seedRetainedLegacyQuestion({db,userId,chatId,now,healthDate,signals=[]}){
 if(db.raw.protocol!=='file')throw Error('SYNTHETIC_LOCAL_POLICY_FIXTURE_REQUIRED');
 const at=new Date(new Date(now).getTime()+1),lifecycle=(await db.getUser(userId)).lifecycleGeneration;
 const claim=await db.claimProactiveEvent(userId,{healthDate,idempotencyKey:`synthetic-retained-legacy:${healthDate}`,signals,decision:'ASK_CONTEXT',reason:{question_category:'alcohol'},policyVersion:'synthetic-retained-legacy-v1',messageText:'Synthetic existing legacy question'},{now:at,expectedLifecycleGeneration:lifecycle});
 if(!claim.claimed)throw Error('SYNTHETIC_LEGACY_FIXTURE_ALREADY_SEEDED');
 const pending=await db.openPendingQuestion(userId,{chatId,question:'Synthetic existing legacy question',intent:PROACTIVE_QUESTION_INTENT,contextJson:{health_date:healthDate,question_target_date:addDays(healthDate,-1),signal:signals[0]??null,category:'alcohol',proactive_event_id:claim.id,lifecycle_generation:lifecycle},ttlMs:48*3600000},{now:at});
 await db.markProactiveEventSent(userId,claim.id,{pendingQuestionId:pending},{now:at});return {eventId:claim.id,pendingId:pending};
}
