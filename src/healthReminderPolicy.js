import {inStage7QuietHours} from './companionTimingPolicy.js';
export async function healthReminderTiming(db,userId,timezone,now){
 const rows=await db.raw.execute({sql:`SELECT n.notifications_paused,p.quiet_start,p.quiet_end
  FROM users u LEFT JOIN user_notification_preferences n ON n.user_id=u.id
  LEFT JOIN journal_tracking_preferences p ON p.user_id=u.id WHERE u.id=?`,args:[userId]});
 if(rows.rows.length!==1)throw Error('HEALTH_REMINDER_PREFERENCES_UNAVAILABLE');
 const row=rows.rows[0];
 return {paused:row.notifications_paused===1,quiet:inStage7QuietHours(now,timezone,row.quiet_start??'22:00',row.quiet_end??'08:00')};
}
