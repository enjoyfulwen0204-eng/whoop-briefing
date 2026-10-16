/** A claim alone is not a confirmed delivery. Seed the independently linked
 * report receipt as well, using synthetic privacy provenance. */
export async function confirmedLegacyBrief(f,{day='2026-09-19',messageId=11}={}){
 const companion=f.companion,actor=await companion.interactions.authenticate({user:f.user,chatId:'123'});
 const row={user_id:f.user.id,report_type:'daily',local_date:day,health_date:day,telegram_message_id:messageId,status:'SENT',sent_at:f.core.timestamp(),...companion.interactions.privacyFields(actor.state)};
 await companion.interactions.insert('report_runs',row);await companion.interactions.link('report_runs',row);
}
