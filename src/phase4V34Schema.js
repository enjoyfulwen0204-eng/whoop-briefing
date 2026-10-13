import {R_SQL} from './phase4V22Schema.js';
import {privacyChecks} from './phase4V23Schema.js';
import {buildV24} from './phase4V24Schema.js';
export const OWNER_NOTIFICATION_CLASSES=Object.freeze(['DAILY_SUMMARY','IMPORTANT_ALERT','WEEKLY_SUMMARY']);
export const V34_HEALTH_FIELDS=Object.freeze({
 morning_brief_plans:['plan_json','health_date','as_of_utc'],
 owner_monitoring_authorizations:['claims_json','scope_json','as_of_utc'],
 owner_monitoring_outbox:['payload_json'],
 recipient_identity_sources:['explicit_display_name','telegram_first_name','whoop_first_name'],
});
const classes="CHECK(notification_class IN ('DAILY_SUMMARY','IMPORTANT_ALERT','WEEKLY_SUMMARY'))";
const n=name=>`${name} INTEGER NOT NULL CHECK(typeof(${name})='integer' AND ${name}>=0)`;
export function buildV34(){
 const ddl=[
 `CREATE TABLE IF NOT EXISTS morning_readiness_refreshes(user_id TEXT NOT NULL,resource TEXT NOT NULL CHECK(resource IN ('sleep','recovery')),captured_at TEXT NOT NULL,auth_generation INTEGER NOT NULL,lifecycle_generation INTEGER NOT NULL,PRIMARY KEY(user_id,resource),FOREIGN KEY(user_id) REFERENCES users(id))`,
 `CREATE TABLE IF NOT EXISTS owner_monitoring_subscriptions(
 user_id TEXT NOT NULL,owner_id TEXT NOT NULL,notification_class TEXT NOT NULL ${classes},
 enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),${n('revision')},${n('owner_lifecycle')},${n('owner_auth')},${n('subject_lifecycle')},${n('subject_auth')},${n('enrollment_revision')},
 changed_at TEXT NOT NULL,operation_key TEXT NOT NULL,
 PRIMARY KEY(user_id,owner_id,notification_class),CHECK(user_id<>owner_id),FOREIGN KEY(user_id) REFERENCES users(id),FOREIGN KEY(owner_id) REFERENCES users(id))`,
 `CREATE TABLE IF NOT EXISTS owner_monitoring_subscription_events(
 user_id TEXT NOT NULL,owner_id TEXT NOT NULL,notification_class TEXT NOT NULL ${classes},${n('revision')},
 enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),${n('owner_lifecycle')},${n('owner_auth')},${n('subject_lifecycle')},${n('subject_auth')},${n('enrollment_revision')},
 effective_at TEXT NOT NULL,operation_key TEXT NOT NULL,audit_hmac TEXT NOT NULL,
 PRIMARY KEY(user_id,owner_id,notification_class,revision),UNIQUE(owner_id,operation_key),FOREIGN KEY(user_id,owner_id,notification_class) REFERENCES owner_monitoring_subscriptions(user_id,owner_id,notification_class))`,
 `CREATE TABLE IF NOT EXISTS morning_brief_plans(
 user_id TEXT NOT NULL,execution_mode TEXT NOT NULL CHECK(execution_mode IN ('LIVE','SHADOW')),plan_id TEXT NOT NULL,
 health_date TEXT NULL,as_of_utc TEXT NULL,plan_version TEXT NOT NULL,plan_json TEXT NULL,plan_hmac TEXT NOT NULL,
 ${n('preference_version')},${n('profile_revision')},${n('source_generation')},${n('input_generation')},${n('lifecycle_generation')},${n('auth_generation')},
 created_at TEXT NOT NULL,expires_at TEXT NOT NULL,${R_SQL},PRIMARY KEY(user_id,execution_mode,plan_id),${privacyChecks},FOREIGN KEY(user_id) REFERENCES users(id))`,
 `CREATE TABLE IF NOT EXISTS owner_monitoring_authorizations(
 user_id TEXT NOT NULL,owner_id TEXT NOT NULL,execution_mode TEXT NOT NULL DEFAULT 'LIVE' CHECK(execution_mode='LIVE'),authorization_id TEXT NOT NULL,notification_class TEXT NOT NULL ${classes},
 subscription_revision INTEGER NOT NULL,plan_version TEXT NOT NULL,as_of_utc TEXT NULL,scope_json TEXT NULL,claims_json TEXT NULL,
 reason_code TEXT NOT NULL CHECK(reason_code='APPROVED_CURRENT_SYNTHESIS'),destination_binding_id TEXT NOT NULL,authorization_hmac TEXT NOT NULL,
 created_at TEXT NOT NULL,expires_at TEXT NOT NULL,${R_SQL},PRIMARY KEY(user_id,authorization_id),UNIQUE(user_id,owner_id,notification_class,authorization_id),${privacyChecks},
 FOREIGN KEY(user_id,owner_id,notification_class) REFERENCES owner_monitoring_subscriptions(user_id,owner_id,notification_class),FOREIGN KEY(owner_id) REFERENCES users(id))`,
 `CREATE TABLE IF NOT EXISTS owner_monitoring_outbox(
 user_id TEXT NOT NULL,owner_id TEXT NOT NULL,execution_mode TEXT NOT NULL DEFAULT 'LIVE' CHECK(execution_mode='LIVE'),message_id TEXT NOT NULL,authorization_id TEXT NOT NULL,notification_class TEXT NOT NULL ${classes},
 semantic_key TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('PROPOSED','DELIVERY_STARTED','DELIVERED','AMBIGUOUS','FAILED_DEFINITE','SUPPRESSED')),
 payload_json TEXT NULL,attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 3),revision INTEGER NOT NULL DEFAULT 0,
 provider_message_id TEXT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,expires_at TEXT NOT NULL,${R_SQL},
 PRIMARY KEY(user_id,message_id),UNIQUE(user_id,owner_id,notification_class,semantic_key),${privacyChecks},
 FOREIGN KEY(user_id,owner_id,notification_class,authorization_id) REFERENCES owner_monitoring_authorizations(user_id,owner_id,notification_class,authorization_id),FOREIGN KEY(owner_id) REFERENCES users(id))`,
 `CREATE TABLE IF NOT EXISTS morning_projection_refreshes(
 user_id TEXT NOT NULL,message_id TEXT NOT NULL,from_revision INTEGER NOT NULL,to_revision INTEGER NOT NULL,
 old_payload_hash TEXT NOT NULL,new_payload_hash TEXT NOT NULL,old_input_generation INTEGER NOT NULL,new_input_generation INTEGER NOT NULL,
 plan_id TEXT NOT NULL,reservation_id TEXT NOT NULL,purge_generation INTEGER NOT NULL,plan_hmac TEXT NOT NULL,permit_hmac TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(user_id,message_id,from_revision),
 CHECK(to_revision=from_revision+1),CHECK(new_input_generation>=old_input_generation))`,
 `CREATE TABLE IF NOT EXISTS morning_projection_consumptions(user_id TEXT NOT NULL,message_id TEXT NOT NULL,from_revision INTEGER NOT NULL,consumed_at TEXT NOT NULL,PRIMARY KEY(user_id,message_id,from_revision),FOREIGN KEY(user_id,message_id,from_revision) REFERENCES morning_projection_refreshes(user_id,message_id,from_revision))`,
 `CREATE TABLE IF NOT EXISTS morning_expiry_audit(user_id TEXT NOT NULL,message_id TEXT NOT NULL,reason TEXT NOT NULL CHECK(reason='EXPIRED_SYSTEM_OUTAGE'),expired_at TEXT NOT NULL,PRIMARY KEY(user_id,message_id))`,
 `CREATE TABLE IF NOT EXISTS owner_monitoring_attempts(
 user_id TEXT NOT NULL,message_id TEXT NOT NULL,attempt_id TEXT NOT NULL,attempt_number INTEGER NOT NULL CHECK(attempt_number BETWEEN 1 AND 3),
 state TEXT NOT NULL CHECK(state IN ('DELIVERY_STARTED','DELIVERED','AMBIGUOUS','FAILED_DEFINITE')),
 started_at TEXT NOT NULL,settled_at TEXT NULL,provider_message_id TEXT NULL,
 PRIMARY KEY(user_id,attempt_id),UNIQUE(user_id,message_id,attempt_number),FOREIGN KEY(user_id,message_id) REFERENCES owner_monitoring_outbox(user_id,message_id))`,
 `CREATE TABLE IF NOT EXISTS recipient_identity_sources(
 user_id TEXT NOT NULL,explicit_name_revision INTEGER NULL,explicit_display_name TEXT NULL,telegram_first_name TEXT NULL,telegram_binding TEXT NULL,
 whoop_first_name TEXT NULL,whoop_auth INTEGER NULL,${n('revision')},updated_at TEXT NOT NULL,${R_SQL},PRIMARY KEY(user_id,revision),${privacyChecks},FOREIGN KEY(user_id) REFERENCES users(id))`,
 `CREATE TABLE IF NOT EXISTS stage8_scoped_read_audit(
 user_id TEXT NOT NULL,read_id TEXT NOT NULL,purpose TEXT NOT NULL CHECK(purpose IN ('SELF_QA','MORNING_BRIEF_V1','OWNER_MONITORING')),
 execution_mode TEXT NOT NULL CHECK(execution_mode='LIVE'),scope_hmac TEXT NOT NULL,as_of_utc TEXT NOT NULL,created_at TEXT NOT NULL,
 PRIMARY KEY(user_id,read_id),FOREIGN KEY(user_id) REFERENCES users(id))`,
 ];
 const indexes=Object.keys(V34_HEALTH_FIELDS).map(t=>`CREATE UNIQUE INDEX IF NOT EXISTS p4_${t}_privacy_id ON ${t}(user_id,privacy_artifact_id)`);
 const triggers=[
 `CREATE TRIGGER IF NOT EXISTS p4_enrollment_revision AFTER UPDATE OF state ON user_onboarding WHEN NEW.state IS NOT OLD.state BEGIN UPDATE user_onboarding SET enrollment_revision=OLD.enrollment_revision+1 WHERE user_id=NEW.user_id; END`,
 ...['owner_monitoring_subscription_events','stage8_scoped_read_audit','morning_projection_refreshes','morning_projection_consumptions','morning_expiry_audit'].flatMap(t=>['UPDATE','DELETE'].map(action=>`CREATE TRIGGER IF NOT EXISTS ${t}_${action.toLowerCase()}_immutable BEFORE ${action} ON ${t} BEGIN SELECT RAISE(ABORT,'stage8_audit_immutable'); END`)),
 `CREATE TRIGGER IF NOT EXISTS p4_owner_outbox_identity BEFORE UPDATE ON owner_monitoring_outbox
 WHEN NEW.user_id IS NOT OLD.user_id OR NEW.owner_id IS NOT OLD.owner_id OR NEW.message_id IS NOT OLD.message_id OR NEW.semantic_key IS NOT OLD.semantic_key
 OR NEW.notification_class IS NOT OLD.notification_class OR NEW.authorization_id IS NOT OLD.authorization_id
 OR OLD.state IN ('DELIVERED','AMBIGUOUS','SUPPRESSED') AND NEW.state IS NOT OLD.state
 BEGIN SELECT RAISE(ABORT,'owner_outbox_identity_immutable'); END`,
 `CREATE TRIGGER IF NOT EXISTS p4_owner_outbox_no_delete BEFORE DELETE ON owner_monitoring_outbox BEGIN SELECT RAISE(ABORT,'owner_outbox_barrier_permanent'); END`,
 // Legacy binaries are excluded by exact-schema admission. These guards also
 // prevent an admitted compatible legacy path claiming after family cutover.
 `CREATE TRIGGER IF NOT EXISTS p4_morning_legacy_insert BEFORE INSERT ON report_claims
 WHEN NEW.report_type='daily' AND EXISTS(SELECT 1 FROM tenant_delivery_modes m WHERE m.user_id=NEW.user_id AND m.execution_mode='LIVE' AND m.message_family='MORNING_BRIEF_V1' AND m.mode='PHASE4' AND m.cutover_health_date IS NOT NULL AND NEW.local_date>=m.cutover_health_date)
 BEGIN SELECT RAISE(ABORT,'morning_phase4_delivery_owner'); END`,
 `CREATE TRIGGER IF NOT EXISTS p4_morning_legacy_reclaim BEFORE UPDATE ON report_claims
 WHEN NEW.report_type='daily' AND NEW.delivery_state='CLAIMED' AND (NEW.owner IS NOT OLD.owner OR NEW.claimed_at IS NOT OLD.claimed_at)
 AND EXISTS(SELECT 1 FROM tenant_delivery_modes m WHERE m.user_id=NEW.user_id AND m.execution_mode='LIVE' AND m.message_family='MORNING_BRIEF_V1' AND m.mode='PHASE4' AND m.cutover_health_date IS NOT NULL AND NEW.local_date>=m.cutover_health_date)
 BEGIN SELECT RAISE(ABORT,'morning_phase4_delivery_owner'); END`,
 ];

 // These replace only the two prior outbox payload rules. Identity, semantic
 // reservation, lifecycle/auth/destination and all other families stay frozen.
 const old=buildV24('execution_mode TEXT',()=>''),permit=`OLD.message_class='MORNING_BRIEF_V1' AND OLD.execution_mode='LIVE'
 AND OLD.state IN ('PROPOSED','ELIGIBLE') AND OLD.attempt_count=0 AND NEW.state=OLD.state
 AND OLD.content_state='PRESENT' AND NEW.content_state='PRESENT' AND NEW.revision=OLD.revision+1
 AND OLD.lease_owner IS NULL AND OLD.lease_expires_at IS NULL AND NEW.lease_owner IS NULL AND NEW.lease_expires_at IS NULL
 AND NEW.purge_generation=OLD.purge_generation
 AND EXISTS(SELECT 1 FROM outbound_semantic_reservations r WHERE r.user_id=OLD.user_id AND r.execution_mode='LIVE' AND r.reservation_id=OLD.reservation_id AND r.message_id=OLD.message_id AND r.state='RESERVED'
 AND r.local_health_date=json_extract(NEW.payload_json,'$.healthDate') AND r.local_health_date=json_extract(OLD.payload_json,'$.healthDate'))
 AND json_extract(NEW.payload_json,'$.timezone')=json_extract(OLD.payload_json,'$.timezone')
 AND NOT EXISTS(SELECT 1 FROM morning_projection_consumptions x WHERE x.user_id=OLD.user_id AND x.message_id=OLD.message_id AND x.from_revision=OLD.revision)
 AND NOT EXISTS(SELECT 1 FROM outbound_delivery_attempts a WHERE a.user_id=OLD.user_id AND a.execution_mode=OLD.execution_mode AND a.message_id=OLD.message_id)
 AND EXISTS(SELECT 1 FROM morning_projection_refreshes f WHERE f.user_id=OLD.user_id AND f.message_id=OLD.message_id
 AND f.from_revision=OLD.revision AND f.to_revision=NEW.revision AND f.old_payload_hash=OLD.payload_hash AND f.new_payload_hash=NEW.payload_hash
 AND f.old_input_generation=OLD.input_generation AND f.new_input_generation=NEW.input_generation AND f.reservation_id=OLD.reservation_id AND f.purge_generation=OLD.purge_generation
 AND f.plan_id=json_extract(NEW.payload_json,'$.morningPlanId')
 AND EXISTS(SELECT 1 FROM morning_brief_plans p WHERE p.user_id=OLD.user_id AND p.execution_mode='LIVE' AND p.plan_id=f.plan_id AND p.plan_hmac=f.plan_hmac
 AND p.content_state='PRESENT' AND p.source_linkage_state='COMPLETE' AND p.input_generation=NEW.input_generation AND p.purge_generation=NEW.purge_generation
 AND p.lifecycle_generation=OLD.lifecycle_generation AND p.auth_generation=OLD.auth_generation AND p.health_date=json_extract(NEW.payload_json,'$.healthDate')))`;
 const immutable=old.triggers.find(v=>v.startsWith('CREATE TRIGGER IF NOT EXISTS p4_outbound_messages_envelope_immutable'));
 const protectedRule=immutable.replace('p4_outbound_messages_envelope_immutable','p4_outbound_messages_envelope_v34')
  .replace('NEW.payload_hash IS NOT OLD.payload_hash',`(NEW.payload_hash IS NOT OLD.payload_hash AND NOT (${permit}))`)
  .replace('NEW.input_generation IS NOT OLD.input_generation',`(NEW.input_generation IS NOT OLD.input_generation AND NOT (${permit}))`);
 const contentRule=old.triggers.find(v=>v.startsWith('CREATE TRIGGER IF NOT EXISTS p4_outbound_messages_content_append_only'))
  .replace('p4_outbound_messages_content_append_only','p4_outbound_messages_content_v34')
  .replace("WHEN NEW.content_state <> 'REDACTED' AND",`WHEN NEW.content_state <> 'REDACTED' AND NOT (${permit}) AND`);
 triggers.push(`CREATE TRIGGER IF NOT EXISTS p4_morning_refresh_consume AFTER UPDATE ON outbound_messages WHEN NEW.message_class='MORNING_BRIEF_V1' AND NEW.execution_mode='LIVE' AND (NEW.payload_hash IS NOT OLD.payload_hash OR NEW.input_generation IS NOT OLD.input_generation) AND NEW.content_state='PRESENT' BEGIN INSERT INTO morning_projection_consumptions(user_id,message_id,from_revision,consumed_at) VALUES(OLD.user_id,OLD.message_id,OLD.revision,NEW.updated_at); END`);
 const replacements=[{oldName:'p4_outbound_messages_envelope_immutable',kind:'TRIGGER',ddl:protectedRule},
  {oldName:'p4_outbound_messages_content_append_only',kind:'TRIGGER',ddl:contentRule}];
 for(const [table,fields] of Object.entries(V34_HEALTH_FIELDS)){
  for(const action of ['INSERT','UPDATE'])triggers.push(`CREATE TRIGGER IF NOT EXISTS p4_${table}_scrub_${action.toLowerCase()} BEFORE ${action} ON ${table} WHEN NEW.content_state='REDACTED' AND (${fields.map(f=>`NEW.${f} IS NOT NULL`).join(' OR ')}) BEGIN SELECT RAISE(ABORT,'stage8_redacted_plaintext'); END`);
  triggers.push(`CREATE TRIGGER IF NOT EXISTS p4_${table}_no_rehydrate BEFORE UPDATE ON ${table} WHEN OLD.content_state='REDACTED' AND NEW.content_state<>'REDACTED' BEGIN SELECT RAISE(ABORT,'stage8_no_rehydration'); END`);
 }
 // Dedicated dual-principal copied-content erasure. This is never a generic
 // cross-tenant read. A changed owner or subject source/privacy fence erases
 // retained copies; delivery/audit/semantic identities remain permanent.
 const scrub=table=>`UPDATE ${table} SET ${V34_HEALTH_FIELDS[table].map(f=>`${f}=NULL`).join(',')},content_state='REDACTED',source_linkage_state='DISCONNECTED',content_digest_salt=NULL,
 health_content_redacted_at=NEW.updated_at,health_content_redaction_reason='SOURCE_CORRECTED'
 ${table==='owner_monitoring_outbox'?",state=CASE WHEN state='DELIVERY_STARTED' THEN 'AMBIGUOUS' WHEN state IN ('PROPOSED','FAILED_DEFINITE') THEN 'SUPPRESSED' ELSE state END,revision=revision+1":''}
 WHERE (user_id=NEW.user_id OR owner_id=NEW.user_id) AND content_state<>'REDACTED';`;
 triggers.push(`CREATE TRIGGER IF NOT EXISTS p4_owner_copy_fence AFTER UPDATE OF source_generation,purge_generation,pending_purge_count ON phase4_user_state
 WHEN NEW.source_generation<>OLD.source_generation OR NEW.purge_generation<>OLD.purge_generation OR NEW.pending_purge_count>OLD.pending_purge_count
 BEGIN ${scrub('owner_monitoring_authorizations')} ${scrub('owner_monitoring_outbox')} END`);
 return Object.freeze({version:34,ddl,indexes,triggers,replacements,columns:[{table:'tenant_delivery_modes',column:'cutover_health_date',definition:'TEXT NULL'},{table:'user_onboarding',column:'enrollment_revision',definition:'INTEGER NOT NULL DEFAULT 0 CHECK(enrollment_revision>=0)'}]});
}
