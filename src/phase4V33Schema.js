import {R_SQL} from './phase4V22Schema.js';
import {privacyChecks} from './phase4V23Schema.js';

export const V33_JOURNAL_FIELDS=['registry_id','registry_version','registered_choice','interaction_id','callback_receipt','question_identity','target_health_date','answer_polarity','answered_at'];
export const V33_HEALTH_FIELDS={
 quick_action_interactions:['registry_id','question_identity','category','target_date','timezone','window_start','window_end','selection_reason','diagnostics_json','selected_choice','detail_choice','note'],
 journal_tracking_preferences:['topics_json','excluded_topics_json','coach_topics_json','quiet_start','quiet_end'],
 journal_prompt_deliveries:['payload_json','schedule_json','due_at'],
};
export const V33_TABLES=[...Object.keys(V33_HEALTH_FIELDS),'journal_callback_tokens','journal_delivery_attempts'];
const count=n=>`${n} INTEGER NOT NULL DEFAULT 0 CHECK(typeof(${n})='integer' AND ${n}>=0)`;
export function buildV33(){
 const columns=[
  {table:'journal_events',column:'source_kind',definition:"TEXT NOT NULL DEFAULT 'legacy_unverified' CHECK(source_kind IN ('quick_action','bot_question','free_text','manual','legacy_unverified'))"},
  {table:'journal_events',column:'provenance_mode',definition:"TEXT NOT NULL DEFAULT 'LEGACY_UNVERIFIED' CHECK(provenance_mode IN ('USER_TEXT','TRUSTED_REGISTRY','LEGACY_UNVERIFIED'))"},
  ...V33_JOURNAL_FIELDS.map(column=>({table:'journal_events',column,definition:'TEXT NULL'})),
 ];
 const ddl=[
 `CREATE TABLE IF NOT EXISTS quick_action_interactions(
  user_id TEXT NOT NULL, interaction_id TEXT NOT NULL, execution_mode TEXT NOT NULL CHECK(execution_mode='SHADOW'),
  semantic_key TEXT NOT NULL, day_key TEXT NULL, kind TEXT NOT NULL CHECK(kind IN ('DAILY','QUICK','PREFERENCES','COACH')),
  registry_id TEXT NULL, registry_version TEXT NOT NULL, question_identity TEXT NULL, category TEXT NULL,
  target_date TEXT NULL, timezone TEXT NULL, window_start TEXT NULL, window_end TEXT NULL,
  selection_reason TEXT NULL, diagnostics_json TEXT NULL, selected_choice TEXT NULL, detail_choice TEXT NULL, note TEXT NULL,
  state TEXT NOT NULL CHECK(state IN ('ISSUED','AWAITING_DETAIL','CONFIRM','COMPLETED','SKIPPED','NOT_SURE','CANCELLED','UNDONE','EXPIRED','EDITING','NOTE')),
  ${count('revision')}, lifecycle_generation INTEGER NOT NULL, auth_generation INTEGER NOT NULL, chat_id TEXT NOT NULL,
  message_id TEXT NULL, logical_fact_id TEXT NULL, fact_revision INTEGER NULL, correction_key TEXT NULL,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL, answered_at TEXT NULL, ${R_SQL},
  PRIMARY KEY(user_id,interaction_id), UNIQUE(user_id,semantic_key), UNIQUE(user_id,day_key), ${privacyChecks}, FOREIGN KEY(user_id) REFERENCES users(id))`,
 `CREATE TABLE IF NOT EXISTS journal_tracking_preferences(
  user_id TEXT NOT NULL PRIMARY KEY, daily_enabled INTEGER NOT NULL DEFAULT 0 CHECK(daily_enabled IN (0,1)),
  weekly_enabled INTEGER NOT NULL DEFAULT 0 CHECK(weekly_enabled IN (0,1)),
  topics_json TEXT NULL DEFAULT '[]', excluded_topics_json TEXT NULL DEFAULT '[]',
  coach_enabled INTEGER NOT NULL DEFAULT 0 CHECK(coach_enabled IN (0,1)),
  coach_topics_json TEXT NULL DEFAULT '[]', quiet_start TEXT NULL DEFAULT '22:00', quiet_end TEXT NULL DEFAULT '08:00', ${count('revision')},
  lifecycle_generation INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, ${R_SQL},
  ${privacyChecks}, FOREIGN KEY(user_id) REFERENCES users(id))`,
 `CREATE TABLE IF NOT EXISTS journal_callback_tokens(
  user_id TEXT NOT NULL, token_hash TEXT NOT NULL, interaction_id TEXT NOT NULL, revision INTEGER NOT NULL,
  action TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
  PRIMARY KEY(user_id,token_hash), FOREIGN KEY(user_id,interaction_id) REFERENCES quick_action_interactions(user_id,interaction_id))`,
 `CREATE TABLE IF NOT EXISTS journal_prompt_deliveries(
  user_id TEXT NOT NULL, delivery_id TEXT NOT NULL, interaction_id TEXT NULL, semantic_key TEXT NOT NULL,
  occasion_key TEXT NULL, kind TEXT NOT NULL CHECK(kind IN ('DAILY','WEEKLY','COACH')), execution_mode TEXT NOT NULL CHECK(execution_mode='SHADOW'),
  state TEXT NOT NULL CHECK(state IN ('PROPOSED','DELIVERY_STARTED','DELIVERED','AMBIGUOUS','FAILED_DEFINITE','SUPPRESSED')),
  payload_json TEXT NULL, schedule_json TEXT NULL, due_at TEXT NULL, lifecycle_generation INTEGER NOT NULL, auth_generation INTEGER NOT NULL,
  chat_id TEXT NOT NULL, preference_revision INTEGER NOT NULL, ${count('revision')}, ${count('attempt_count')},
  message_id TEXT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, updated_at TEXT NOT NULL, ${R_SQL},
  PRIMARY KEY(user_id,delivery_id), UNIQUE(user_id,semantic_key), UNIQUE(user_id,occasion_key), ${privacyChecks}, FOREIGN KEY(user_id) REFERENCES users(id))`,
 `CREATE TABLE IF NOT EXISTS journal_delivery_attempts(
  user_id TEXT NOT NULL, delivery_id TEXT NOT NULL, attempt_id TEXT NOT NULL, attempt_number INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('DELIVERY_STARTED','DELIVERED','AMBIGUOUS','FAILED_DEFINITE')),
  started_at TEXT NOT NULL, settled_at TEXT NULL, message_id TEXT NULL,
  PRIMARY KEY(user_id,attempt_id), UNIQUE(user_id,delivery_id,attempt_number),
  FOREIGN KEY(user_id,delivery_id) REFERENCES journal_prompt_deliveries(user_id,delivery_id))`,
 ];
 const indexes=[
 `CREATE UNIQUE INDEX IF NOT EXISTS p4_journal_callback_receipt ON journal_events(user_id,callback_receipt) WHERE callback_receipt IS NOT NULL`,
 `CREATE INDEX IF NOT EXISTS p4_quick_action_day ON quick_action_interactions(user_id,kind,target_date,created_at)`,
 ...Object.keys(V33_HEALTH_FIELDS).map(table=>`CREATE UNIQUE INDEX IF NOT EXISTS p4_${table}_privacy_id ON ${table}(user_id,privacy_artifact_id)`),
 `CREATE INDEX IF NOT EXISTS p4_journal_registry ON journal_events(user_id,registry_version,question_identity)`,
 ];
 const triggers=[
 `CREATE TRIGGER IF NOT EXISTS p4_coach_schedule_once BEFORE UPDATE ON journal_prompt_deliveries
 WHEN OLD.kind='COACH' AND NEW.content_state<>'REDACTED' AND (NEW.schedule_json IS NOT OLD.schedule_json OR NEW.due_at IS NOT OLD.due_at OR NEW.expires_at IS NOT OLD.expires_at)
 BEGIN SELECT RAISE(ABORT,'coach_schedule_immutable'); END`,
 `CREATE TRIGGER IF NOT EXISTS p4_journal_trust_insert BEFORE INSERT ON journal_events
 WHEN NEW.provenance_mode='TRUSTED_REGISTRY' AND (NEW.source_kind<>'quick_action' OR NEW.registry_id IS NULL OR NEW.registry_version IS NULL
 OR NEW.registered_choice IS NULL OR NEW.interaction_id IS NULL OR NEW.callback_receipt IS NULL OR NEW.question_identity IS NULL
 OR NEW.target_health_date IS NULL OR NEW.answer_polarity IS NULL OR NEW.registered_choice NOT IN ('YES','NO') OR NEW.registered_choice IS NOT NEW.answer_polarity OR NEW.answer_polarity NOT IN ('YES','NO') OR NEW.answered_at IS NULL)
 BEGIN SELECT RAISE(ABORT,'journal_registry_provenance_required'); END`,
 `CREATE TRIGGER IF NOT EXISTS p4_daily_barrier_no_delete BEFORE DELETE ON quick_action_interactions
 BEGIN SELECT RAISE(ABORT,'journal_interaction_barrier_permanent'); END`,
 `CREATE TRIGGER IF NOT EXISTS p4_daily_identity_immutable BEFORE UPDATE ON quick_action_interactions
 WHEN NEW.user_id IS NOT OLD.user_id OR NEW.interaction_id IS NOT OLD.interaction_id OR NEW.semantic_key IS NOT OLD.semantic_key
 OR NEW.execution_mode IS NOT OLD.execution_mode OR NEW.created_at IS NOT OLD.created_at OR NEW.kind IS NOT OLD.kind OR NEW.day_key IS NOT OLD.day_key
 BEGIN SELECT RAISE(ABORT,'journal_interaction_identity_immutable'); END`,
 `CREATE TRIGGER IF NOT EXISTS p4_daily_delivery_no_delete BEFORE DELETE ON journal_prompt_deliveries
 BEGIN SELECT RAISE(ABORT,'journal_delivery_barrier_permanent'); END`,
 `CREATE TRIGGER IF NOT EXISTS p4_daily_delivery_identity BEFORE UPDATE ON journal_prompt_deliveries
 WHEN NEW.user_id IS NOT OLD.user_id OR NEW.delivery_id IS NOT OLD.delivery_id OR NEW.semantic_key IS NOT OLD.semantic_key
 OR NEW.occasion_key IS NOT OLD.occasion_key OR NEW.kind IS NOT OLD.kind
 OR (OLD.state IN ('DELIVERED','AMBIGUOUS','SUPPRESSED') AND NEW.state IS NOT OLD.state)
 BEGIN SELECT RAISE(ABORT,'journal_delivery_barrier_permanent'); END`,
 ];
 return Object.freeze({version:33,ddl,columns,indexes,triggers});
}
