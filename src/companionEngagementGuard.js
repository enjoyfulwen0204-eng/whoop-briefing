import {settingsKey} from './bot/settings.js';
/** Bounded canonical occupancy. A new day never cancels a live old question. */
export async function companionEngagementBusy({core,db,actor,excludeInteractionId=null,includeConversation=true}){
 const uid=actor.control.userId,at=core.timestamp();
 const occupied=(await core.client.execute({sql:`SELECT 1 FROM pending_questions WHERE user_id=? AND status='OPEN' AND expires_at>?
 UNION ALL SELECT 1 FROM phase4_question_interaction_slots WHERE user_id=? AND state IN ('RESERVED','DELIVERY_STARTED','AMBIGUOUS_WAIT','AWAITING_ANSWER')
 UNION ALL SELECT 1 FROM quick_action_interactions q WHERE user_id=? AND interaction_id IS NOT ? AND kind IN ('DAILY','QUICK')
 AND NOT EXISTS(SELECT 1 FROM journal_prompt_deliveries d WHERE d.user_id=q.user_id AND d.interaction_id=q.interaction_id AND d.state='SUPPRESSED')
 AND state IN ('ISSUED','AWAITING_DETAIL','CONFIRM','EDITING','NOTE') AND expires_at>? AND content_state='PRESENT' LIMIT 1`,args:[uid,at,uid,uid,excludeInteractionId,at]})).rows.length;
 if(occupied)return true;
 if(!includeConversation)return false;
 const lane=(await core.client.execute({sql:'SELECT 1 FROM resource_locks WHERE name=? AND expires_at>? LIMIT 1',args:[`telegram_lane:tg:${actor.chat}`,at]})).rows.length;
 if(lane)return true;
 const raw=await db.getState(settingsKey(uid));let input;try{input=JSON.parse(raw);}catch{}
 return Boolean(input&&input.uid===uid&&input.lifecycle===actor.state.lifecycle_generation&&input.expiresAt>core.now().getTime()&&['name_edit','name_confirm','language_confirm'].includes(input.mode));
}
