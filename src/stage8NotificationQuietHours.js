import {COMPANION_DEFAULTS,inCompanionQuietHours} from './companionTimingPolicy.js';
import {SEND_OUTCOME} from './sendOutcome.js';

/** Recipient policy only. Read canonical preferences without initializing a
 * Journal preference, enabling notifications, or changing analysis authority. */
export async function readStage8RecipientQuietHours(db,userId){
 const row=(await db.raw.execute({sql:`SELECT u.timezone,p.quiet_start,p.quiet_end FROM users u
  LEFT JOIN journal_tracking_preferences p ON p.user_id=u.id WHERE u.id=?`,args:[userId]})).rows[0];
 if(!row)throw Error('STAGE8_NOTIFICATION_RECIPIENT_MISSING');
 return Object.freeze({timezone:row.timezone,start:row.quiet_start??COMPANION_DEFAULTS.quietStart,end:row.quiet_end??COMPANION_DEFAULTS.quietEnd});
}
export function stage8RecipientIsQuiet(policy,at){
 if(!(at instanceof Date)||!Number.isFinite(at.getTime()))throw Error('STAGE8_NOTIFICATION_CLOCK_INVALID');
 return inCompanionQuietHours(at,policy.timezone,policy.start,policy.end);
}
/** Keep final source/consent validation and the latest recipient policy in one
 * consistent DB snapshot. Re-evaluate the clock synchronously at provider I/O:
 * a slow validation crossing quiet-start must not send. There is no deferred
 * alert, retry authority or provider capability in this helper. */
export async function sendStage8RecipientNotification({db,userId,now,verify,send}){
 const policy=await db.transaction(async()=>{await verify();return readStage8RecipientQuietHours(db,userId);},{readOnly:true});
 if(stage8RecipientIsQuiet(policy,now()))throw Object.assign(Error('STAGE8_NOTIFICATION_QUIET_HOURS'),{sendOutcome:SEND_OUTCOME.DEFINITE_FAILURE});
 return send();
}
