import {localDate,localMidnightUtc,addDays} from './time.js';

export const DAILY_PROACTIVE_MAXIMUM=2;
export const DAILY_HEALTH_MAXIMUM=1;
export const isHealthKind=kind=>kind==='HEALTH'||kind==='ASK_CONTEXT';
/** Count durable reservations, including unknown sends. An ASK_CONTEXT card
 * and its legacy event are one message, not two independent quotas. Call this
 * inside the same write transaction that reserves the next delivery. */
export async function proactiveQuota(client,{userId,timezone,now=new Date(),excludeDeliveryId=null,excludeEventId=null}){
 const day=localDate(now,timezone),start=localMidnightUtc(day,timezone).toISOString(),end=localMidnightUtc(addDays(day,1),timezone).toISOString();
 const result=await client.execute({sql:`WITH counted AS (
  SELECT 'p:'||id identity,1 health,decision='ASK_CONTEXT' ask FROM proactive_events
   WHERE user_id=? AND decision IN ('ASK_CONTEXT','NOTIFY') AND id IS NOT ? AND created_at>=? AND created_at<?
  UNION ALL
  SELECT 'j:'||d.delivery_id,COALESCE(json_extract(d.schedule_json,'$.source'),'')='legacy-proactive-journal-v1',COALESCE(json_extract(d.schedule_json,'$.source'),'')='legacy-proactive-journal-v1' FROM journal_prompt_deliveries d
   WHERE d.user_id=? AND d.delivery_id IS NOT ?
   AND EXISTS(SELECT 1 FROM journal_delivery_attempts a WHERE a.user_id=d.user_id AND a.delivery_id=d.delivery_id
    AND a.state IN ('DELIVERY_STARTED','DELIVERED','AMBIGUOUS') AND a.started_at>=? AND a.started_at<?)
   AND NOT (COALESCE(json_extract(d.schedule_json,'$.source'),'')='legacy-proactive-journal-v1'
    AND EXISTS(SELECT 1 FROM proactive_events p WHERE p.user_id=d.user_id AND p.id=json_extract(d.schedule_json,'$.eventId')
     AND p.created_at>=? AND p.created_at<?))
 ) SELECT count(*) total,COALESCE(sum(health),0) health,COALESCE(sum(ask),0) ask FROM counted`,
 args:[userId,excludeEventId,start,end,userId,excludeDeliveryId,start,end,start,end]});
 const row=result.rows[0];
 if(!row||!['total','health','ask'].every(k=>Number.isSafeInteger(Number(row[k]))&&Number(row[k])>=0))throw Error('PROACTIVE_QUOTA_UNAVAILABLE');
 return Object.fromEntries(['total','health','ask'].map(k=>[k,Number(row[k])]));
}
export function proactiveSlotAllowed(counts,kind){
 if(isHealthKind(kind))return counts.health<DAILY_HEALTH_MAXIMUM;
 return counts.total<DAILY_PROACTIVE_MAXIMUM&&!(kind==='COACH'&&counts.health>0)&&!(kind==='DAILY'&&counts.ask>0);
}
