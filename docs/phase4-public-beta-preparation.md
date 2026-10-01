# Phase 4 Stage 1–6 Public Beta preparation

This preparation adds a separate presentation authority for one Stage 1–6 surface: a Body Energy section in the existing daily Telegram briefing. The section is optional. It comes from `bodyEnergy.readLatestCurrent` through the public SHADOW repository, which checks tenant, execution mode, current input generation, completed generation, retained source authority, and the v27 operation receipt. A missing, stale, invalidated, redacted, ambiguous, corrupt, privacy-fenced, or unavailable result is omitted. Rendering never starts computation or reads Phase 4 tables directly. The existing legacy daily briefing continues.

The Stage 6 worker remains SHADOW-only. `src/publicBetaEntry.js` is a separate explicit server composition: it requires an issued in-process Public Beta runtime capability, the existing Stage 6 SHADOW worker capability, an explicit database, and the two Phase 4 keys. `npm start` and the normal `runBriefing` composition do not issue either capability. The webhook chooses this composition only when `PHASE4_BETA_SHADOW_RUNTIME=on`. This switch does not make a user eligible for presentation; `PHASE4_PUBLIC_BETA_MODE` separately controls that. The existing Foundation flags remain off, including `PHASE4_MORNING_BRIEF`, `PHASE4_QA_CONTEXT`, and `PHASE4_REANALYSIS_WORKER`. None is a substitute for these capabilities.

## Configuration for a later activation review

| Setting | Preparation/default | Proposed initial cohort | Expansion | Rollback |
| --- | --- | --- | --- | --- |
| `PHASE4_BETA_SHADOW_RUNTIME` | `off` (absent means off) | `on` only in the approved explicit runtime composition | `on` | `off` |
| `PHASE4_PUBLIC_BETA_MODE` | `off` (absent means off) | `allowlist` | `allowlist`, then `all` | `off` first |
| `PHASE4_PUBLIC_BETA_USER_IDS` | absent/empty | comma-separated canonical internal `users.id` values | update IDs, then empty for `all` | empty |
| `PHASE4_LOOKUP_KEY` | absent before migration; required for explicit beta runtime | existing Phase 4 lookup key | same key | retain for v30 legacy/Phase 4 authority; never rotate as rollback |
| `PHASE4_AUDIT_KEY` | absent before migration; required for explicit beta runtime | existing Phase 4 audit key | same key | retain for v30 legacy/Phase 4 authority; never rotate as rollback |
| 13 Foundation `PHASE4_*` flags | all off | all off | all off | all off |

The two key settings are hex-encoded, distinct, and at least 32 bytes each. They must match the authority already used by schema migrations and stored artifacts. A missing/malformed key or invalid gate mode fails closed. Secret values must never appear in logs, review reports, or this document. Existing WHOOP, Turso, OpenRouter, Telegram, and `BRIEFING_TRIGGER_SECRET` configuration remains required by the current service; no value changes are proposed here.

The admission switch is intentionally **not active** in the checked-in deployment definitions. At activation review, select the exact reviewed commit for Render and GitHub, configure the two key secrets and the three beta settings in each runtime, and change the GitHub scheduled command from `npm start` to `node src/publicBetaEntry.js`. The authenticated Render briefing endpoint can then select the explicit beta composition. Do not treat a repository branch or a working tree as deployment identity. Confirm the live environment and key authority before any change; repository files alone do not establish current live values.

Cloudflare's later target cron is `*/10 0-3 * * *` (08:00 inclusive to 12:00 exclusive Asia/Taipei). The checked-in cron remains `*/10 * * * *` during preparation. GitHub stays hourly (`17 * * * *`) and runs directly as background/out-of-window fallback, or in-window fallback when Cloudflare is stale. Event and manual calls retain their own attribution. Change the live Cloudflare cron only after review. Preserve a record of the prior live scheduler configuration for rollback.

## Rollback after activation

1. Set `PHASE4_PUBLIC_BETA_MODE=off` on every active beta runtime and restart those runtimes. No new Phase 4 section is eligible. Leave the legacy briefing enabled.
2. Set `PHASE4_BETA_SHADOW_RUNTIME=off` on Render and GitHub. Restore GitHub's scheduled command to `npm start` so legacy reports continue. Remove the beta-only environment settings from the workflow if added.
3. Restore the prior Cloudflare cron if activation changed it and legacy production requires that cadence. Verify the authenticated scheduler endpoint and hourly GitHub fallback still run.
4. Preserve v28/v29/v30 state, all operation receipts, Phase 4 keys, and user data. No database rollback, deletion, migration downgrade, mode promotion, or Stage 5/6 authority change is part of rollback.

This is a restart/configuration rollback; an external provider call already started cannot be recalled. Delivery remains subject to the existing report claim and account lifecycle fences. Production values and scheduling must be checked at activation rather than inferred from this repository.

## Identity and surface audit

Daily and weekly headers use the target internal user's canonical `users.display_name`, fetched through `db.getUser(userId)` at message generation time. A blank or missing usable name produces a neutral header. The coach's legacy prompt and the unused Q&A prompt no longer prescribe Kelvin. The Telegram link confirmation already uses the canonical linked user. Scheduler output binds each user to that user's active chat before rendering. Proactive, guardian, Body Energy, insight, and episode modules contain no hard-coded recipient name; Stage 1–6 Phase 4 insights and episodes currently have no approved user-facing publisher in this preparation. Historical test fixtures and the product name “Kelvin Health OS” remain as non-greeting metadata.

`npm run beta:smoke` uses only synthetic users and data. It emits the actual daily payload captured immediately before fake transport for Alice, Bob, and a no-name user, including recipient, canonical user ID, and synthetic result ID. The accompanying typed-reader test exercises real v30 SHADOW stores and receipts. No real Telegram destination is contacted.
