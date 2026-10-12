import {fail,readableRow} from './phase4Core.js';
import {JOURNAL_VERSIONS} from './journalFoundationValidation.js';
import {TOPICS,DETAILS,JOURNAL_REGISTRY_VERSION,registryQuestion,normalizeJournalNote} from './stage7Registry.js';
import {localMidnightUtc,addDays} from './time.js';

/** Called inside the authenticated source-controller transaction. The request
 * contains no category, value, date, polarity, note or destination. */
export async function trustedJournalFact(core,control,{interactionId,expectedRevision,callbackReceipt},{staged=false}={}){
 if(core.schemaVersion!==33||!core.processing.active())fail('STAGE7_TRUSTED_TRANSACTION_REQUIRED');
 const state=await core.assertControl(control);
 const row=(await core.client.execute({sql:'SELECT * FROM quick_action_interactions WHERE user_id=? AND interaction_id=?',args:[control.userId,interactionId]})).rows[0];
 if(!readableRow(row)||row.revision!==expectedRevision||row.state!=='CONFIRM'||row.registry_version!==JOURNAL_REGISTRY_VERSION
  ||!TOPICS.includes(row.category)||row.registry_id!==registryQuestion(row.category)||row.question_identity!==registryQuestion(row.category)
  ||row.lifecycle_generation!==state.lifecycle_generation||row.auth_generation!==state.auth_generation||row.timezone!==state.timezone
  ||!staged&&row.expires_at<=core.timestamp()||!['YES','NO'].includes(row.selected_choice)||typeof callbackReceipt!=='string'||callbackReceipt.length<16)fail('STAGE7_REGISTRY_AUTHORITY_INVALID');
 const start=localMidnightUtc(row.target_date,row.timezone).toISOString(),end=localMidnightUtc(addDays(row.target_date,1),row.timezone).toISOString();
 if(start!==row.window_start||end!==row.window_end||Date.parse(end)>core.now().getTime())fail('STAGE7_TARGET_WINDOW_INVALID');
 if(row.detail_choice!==null&&(!DETAILS[row.category]?.includes(row.detail_choice)||row.selected_choice!=='YES'))fail('STAGE7_UNREGISTERED_CHOICE');
 const note=row.note===null?null:normalizeJournalNote(row.note);
 return {category:row.category,subtype:row.detail_choice===null?null:`last_intake_${row.detail_choice}`,numeric_value:null,text_value:null,unit:null,severity:null,note,
  event_at:start,event_end_at:end,time_scope:'HEALTH_DAY',health_date:row.target_date,health_date_alignment:'PROVISIONAL',recorded_timezone:row.timezone,
  exposure_state:row.selected_choice==='YES'?'EXPOSED':'CONFIRMED_UNEXPOSED',extraction_confidence:1,raw_answer_excerpt:note,
  parser_version:'trusted-registry-v1',normalizer_version:JOURNAL_VERSIONS.normalizer,alignment_version:'registered-target-v1',
  source_kind:'quick_action',provenance_mode:'TRUSTED_REGISTRY',registry_id:row.registry_id,registry_version:row.registry_version,
  registered_choice:row.selected_choice,interaction_id:row.interaction_id,callback_receipt:callbackReceipt,question_identity:row.question_identity,
  target_health_date:row.target_date,answer_polarity:row.selected_choice,answered_at:row.answered_at??core.timestamp()};
}
