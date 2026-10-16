/** v33's confirmed legacy delivery authority. A claim alone does not prove a
 * readable report was acknowledged by Telegram. No source calculation occurs. */
export async function confirmedLegacyMorningReceipt({core,actor,day}){
 const row=(await core.client.execute({sql:`SELECT r.sleep_id,r.sent_at,r.privacy_artifact_id report_source,c.telegram_message_id
  FROM report_claims c JOIN report_runs r ON r.user_id=c.user_id AND r.report_type=c.report_type
  AND r.local_date=c.local_date AND r.status='SENT' AND r.telegram_message_id=c.telegram_message_id
  WHERE c.user_id=? AND c.report_type='daily' AND c.local_date=? AND c.delivery_state='DELIVERED'
  AND c.lifecycle_generation=? AND c.telegram_message_id IS NOT NULL AND r.content_state='PRESENT'
  AND r.source_linkage_state='COMPLETE' AND r.health_content_redacted_at IS NULL LIMIT 1`,
  args:[actor.control.userId,day,actor.state.lifecycle_generation]})).rows[0];
 if(!row||!row.report_source||!Number.isSafeInteger(Date.parse(row.sent_at))||Date.parse(row.sent_at)>core.now().getTime())return null;
 return row;
}
