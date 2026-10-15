# V3 companion integration candidate

The original Stage 7 candidate `a1ec7317989d3a05c1b68198a2f9a6eebed73e2e` remains unchanged. V3 authorizes this subsequent integration and owner rollout after its exact review, publication, migration, and deployment gates. This document supersedes the original candidate's development-only description for the new entry points; it does not claim a production cutover occurred.

The repaired Stage 6 continuation and provisional Body presentation are retained. The exact binary still rejects an unmigrated v32 database. The final v33 definition adds Coach fields before its first application, using existing private interaction/preferences/delivery/attempt tables. No v35 or destructive migration is introduced.

## Product defaults and controls

`STAGE7_COMPANION=off` is the default. `on` requires the singleton `STAGE7_COMPANION_USER_IDS` to match the server's existing owner identity. It does not use the optional calculation pilot's attempt or expiry as publication consent. Stored Daily Journal, Weekly Review, and Coach preferences remain independent, initially disabled. Coach topics initially have no selections. The existing notification pause still suppresses dispatch. `/settings` links to the Journal/Coach controls; `/journal` retains tracking/exclusion preferences and optional Weekly Review. Quiet-hour choices use the user's timezone, initially 22:00–08:00.

One Daily Journal follows confirmed Morning delivery. A still-valid unanswered prior Journal or canonical question is preserved. Unknown, skipped, unanswered, and explicit No remain distinct. The accepted answer retains its original target date and registered question identity, including the 48-hour answer period and existing optional clarification, correction, and undo.

One optional Coach invitation selects a strictly future deployed UTC slot 4–6 hours after the confirmed main wake, after the Brief and at least two hours after the acknowledged Journal card. If Daily Journal is disabled, a conservative two-hour gap after the Brief is used without fabricating a Journal delivery. `STAGE7_COACH_MIN_HOURS`, `STAGE7_COACH_MAX_HOURS`, and `STAGE7_JOURNAL_GAP_HOURS` expose bounded server tuning within these limits. They are product defaults, not measured optima.

The existing keyed user/day seed selects once. Persisted schedule, day and wake-occasion barriers prevent restart, release, preference, locale, or timezone changes from redrawing another invitation. No eligible slot/topic, quiet hours, open question/input flow, expiry, changed consent, lifecycle, source or privacy suppress the invitation. Suppression is final for that reservation. Accepted or ambiguous sends are never retried with another identity. At most one Journal and one Coach optional initiation can occur per day; this is not a meaningful-health-alert cap.

Manual `/coach`, relevant existing replies and completed Journal confirmations offer icon + localized topic/range/free-text choices in the same response. Navigation never enters the trusted Journal writer. A selected query reads only the user's requested topic and today/last-seven-day interval, with at most 100 registered roots. It reports actual scored data or explicit missingness. No model decides whether to send each scheduler tick.

## Runtime and privacy

The synthetic memory/provider guards remain. A separate admitted owner runtime supplies production hooks to the existing Telegram update processor and its durable action/reply receipts. Telegram edits update the bound message; callback actor, private chat, nonce, expiry, revision, locale/profile and lifecycle checks remain. Webhook/polling registration retains message and callback_query without dropping pending updates.

The authenticated `/internal/briefing/companion` endpoint has a 45-second total budget including admission and dispatch. The Worker invokes it once after the existing morning/readiness job, only with `BRIEFING_COMPANION_ENABLED=on`; its transport bound is 55 seconds with no retries. It cannot enter SYNC, DRAIN, WHOOP refresh, an optional pilot or a model call. The 44 existing daily cron opportunities remain unchanged. Up to 44 additional bounded service calls/day and two optional Telegram initiations/owner/day are authorized service volumes, not guaranteed billed cost or mandatory sends. Existing provider plans are retained. Server flag, provider flag, notification pause and independent preferences are stop controls.

Private schedule/topic/quiet/query fields are in the v33 redaction registry with source links. Redaction removes plaintext and callback tokens while preserving non-health semantic barriers. No Foundation LIVE authority, SHADOW-to-LIVE result copy, owner monitoring or cross-user query is enabled here. The original four-action decision engine and synthetic Phase 4 dispatcher remain retained; their separate physiological delivery cutover is not claimed by companion availability.

## Release and recovery conditions

Before any v33 mutation: freeze exact migration/candidate, verify backup consistency, inventory and quiesce all writers, protect due reports and the Taiwan morning window, and verify the `COMPANION_V33_RECOVERY` profile on this same schema. That profile requires Beta computation/publication, Body publication/alerts and companion disabled while ordinary readiness remains admitted. It retains all v33 rows; it never restores old DB contents or selects a strict-v32 binary.

The migration rehearsal must cover interrupted DDL/columns/indexes/triggers, no-op, existing content and original key continuity, complete schema postconditions, foreign keys and integrity. Production release/proof/Worker/webhook identities and actual scheduler ticks remain operational readback requirements. Local tests are not evidence of an actual score, insight or Telegram delivery.
