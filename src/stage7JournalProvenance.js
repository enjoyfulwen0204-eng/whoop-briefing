import {TOPICS,registryQuestion,JOURNAL_REGISTRY_VERSION,DETAILS} from './stage7Registry.js';
export function assertRegisteredJournalProvenance(row){
 if(row.provenance_mode!=='TRUSTED_REGISTRY')return;
 if(row.source_kind!=='quick_action'||row.registry_version!==JOURNAL_REGISTRY_VERSION||!TOPICS.includes(row.category)
  ||row.registry_id!==registryQuestion(row.category)||row.question_identity!==row.registry_id||row.target_health_date!==row.health_date
  ||!['YES','NO'].includes(row.answer_polarity)||row.registered_choice!==row.answer_polarity
  ||row.exposure_state!==(row.answer_polarity==='YES'?'EXPOSED':'CONFIRMED_UNEXPOSED')
  ||typeof row.interaction_id!=='string'||typeof row.callback_receipt!=='string'||!row.answered_at
  ||row.raw_answer_excerpt!==row.note||row.subtype!==null&&(!DETAILS[row.category]?.some(d=>row.subtype===`last_intake_${d}`)||row.answer_polarity!=='YES'))throw Error('STAGE7_JOURNAL_PROVENANCE_INVALID');
}
