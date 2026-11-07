/** v33 erasure ownership contract. No database access, secrets, or identifiers.
 * A table's class does not authorize blanket deletion: USER selectors must be
 * bound to one fenced subject; shared rows require the retention closure. */
const direct=`ai_usage analytics_daily_state analytics_invalidation analytics_runs analytics_work_state
body_energy_checkpoints body_energy_results briefing_evaluations context_questions
episode_events episode_evidence episode_observations episode_semantic_events evidence_items evidence_runs
experiment_field_groups experiments health_insights health_plaintext_purges health_purge_replacements health_purge_targets
healthspan_metrics healthspan_snapshots insight_revisions journal_callback_tokens journal_coverage_windows
journal_delivery_attempts journal_event_tombstones journal_events journal_prompt_deliveries journal_tracking_preferences
oauth_states observation_episodes outbound_delivery_attempts outbound_messages outbound_semantic_reservations
pending_questions phase4_computation_state phase4_episode_revisions phase4_evidence_result_authorities
phase4_execution_producers phase4_family_directory_entries phase4_family_directory_manifests phase4_family_work_tips
phase4_invalidations phase4_jobs phase4_operation_receipts phase4_proactive_decisions phase4_question_interaction_slots
phase4_receipt_route_entries phase4_receipt_route_manifests phase4_receipt_routes phase4_source_links phase4_user_state
prediction_models prediction_runs proactive_agent_state proactive_events quick_action_interactions report_claims report_runs
structured_answer_events tenant_delivery_modes user_link_codes user_locale_prompts user_locales user_notification_preferences
user_onboarding user_telegram user_whoop_tokens whoop_body_measurements whoop_capabilities whoop_cycles
whoop_reconciliation_discrepancies whoop_reconciliation_runs whoop_reconciliation_state whoop_recoveries whoop_resource_access
whoop_resource_tombstones whoop_sleeps whoop_sync_state whoop_webhook_events whoop_workouts`.split(/\s+/);
const item=(classification,selector)=>Object.freeze({classification,selector});
export const ERASURE_TABLES=Object.freeze({
 ...Object.fromEntries(direct.map(t=>[t,item('USER','user_id = subject; preserve NULL/global rows')])),
 users:item('USER','id = subject; delete last, after lifecycle fence'),
 whoop_webhook_events:item('USER','user_id = subject; also unresolved rows joined by the captured, exclusive user_whoop_tokens.whoop_user_id'),
 telegram_operations:item('USER','owner_user_id, or update_id joined to subject conversation; inspect unowned result JSON'),
 telegram_processed_updates:item('USER','user_id = tg:<chat>; chat IDs from retained user_telegram before fencing'),
 telegram_state:item('USER','per-prefix signed KV ownership; shared family consent must be sanitized and re-signed; unresolvable historical envelopes block erasure'),
 error_notifications:item('USER','scope = user:<id>; preserve global scope'),
 system_heartbeats:item('USER','scope = user:<id>; global projections must be checked for indirect references'),
 resource_locks:item('USER','user/chat lock names and keyed context-tenant prefixes; preserve unrelated/global locks'),
 app_state:item('USER','legacy singleton: require proven ownership or empty; never assume SYSTEM'),
 whoop_tokens:item('USER','legacy singleton credentials: require proven ownership or empty; never export values'),
 phase4_execution_work_receipts:item('SHARED_OPERATIONAL','individually derived named-work receipt keys are USER overrides; remaining opaque results use retention closure'),
 phase4_executions:item('SHARED_OPERATIONAL','terminal/dead, older than retention cutoff, not latest, no retained references'),
 phase4_migration_checkpoints:item('USER','mixed: redact completed v21 tenant_metadata cursor equal to subject, and v23 legacy_insights cursor joined to subject insight; retain key checks and all shared checkpoint fields'),
 schema_version:item('SYSTEM','schema version, application time and fixed migration note'),
 sqlite_sequence:item('SYSTEM','table names and monotonically increasing sequence counters'),
});

// Explicit source inventory. Disabled v34/v35 namespaces are classified but
// are never silently erased by a v33 implementation. Unknown keys fail closed.
export const ERASURE_KV_PREFIXES=Object.freeze({
 'canonical-profile-revision:v1:':'USER', 'settings:v1:':'USER', 'account-self:v1:':'USER',
 'beta:v1:':'USER', 'family:v1:':'USER', 'body-energy:notification-control:':'USER',
 'body-energy:alert-pointer:':'USER', 'body-low-discard:':'USER', 'association-check-v1:':'USER',
 'night-analysis:':'USER', 'morning-snapshot:':'USER', 'stage8-source-consent:':'USER',
 'stage8:sync-subject:':'USER', 'stage8:sync-progress:':'USER', 'stage8-owner-cursor:':'USER',
 'e1b:pending:':'USER', 'e1b:retention:':'SHARED_OPERATIONAL',
});
export function classifyErasureKey(key){
 if(key==='telegram_offset')return 'SYSTEM';
 if(key==='canonical-profile-revision:v1:supervisor:boot-generation:v1')return 'SYSTEM';
 const prefix=Object.keys(ERASURE_KV_PREFIXES).find(p=>key.startsWith(p));
 if(!prefix)throw Object.assign(Error('ERASURE_KV_UNCLASSIFIED'),{code:'ERASURE_KV_UNCLASSIFIED'});
 return ERASURE_KV_PREFIXES[prefix];
}
export function assertErasureTables(names){
 // Fresh v33 fixtures omit the two retained single-user legacy tables. Both
 // are explicitly classified when present; no other table is optional.
 if(new Set(names).size!==names.length||names.some(n=>!ERASURE_TABLES[n])
  ||Object.keys(ERASURE_TABLES).some(n=>!['app_state','whoop_tokens'].includes(n)&&!names.includes(n)))
  throw Object.assign(Error('ERASURE_SCHEMA_UNCLASSIFIED'),{code:'ERASURE_SCHEMA_UNCLASSIFIED'});
}

/** Actual v33 key chain, not a guess from an unkeyed digest or receipt result.
 * Inputs are used only in memory. This is the exact semantic API fact list in
 * index.js / bindExecutionApi; generation is captured before disabling. */
export function userErrorClearReceiptKey(keys,execution,userId,lifecycleGeneration){
 const step=keys.lookup(['phase4-logical-work-v1','api:clearUserErrorNotify',
  [userId,'whoop_auth',{expectedLifecycleGeneration:lifecycleGeneration}]]);
 return keys.lookup(['execution-work-step-v2',execution.identity_digest,execution.scope_key,['named',step]]);
}
