# Phase 4 Stage 1–6 Public Beta preparation

> Current pre-Stage7 v32 procedure: [release handoff](pre-stage7/release-handoff.md). The v20/v31 migration and older deployment facts below are historical. Do not execute them against current production v32. This session made no provider changes.

For the Vietnam RC3 repair and future phase-aware deployment, use the
[coordinated rollout artifact](phase4-vietnam-stage2-rc3-rollout.md).
Cloudflare triggers remain empty in the new checked-in configuration; restoring
the proposed morning cron requires a later reviewed production action.

This is repository preparation, not activation. The checked-in beta runtime and presentation gates remain OFF. The later [Localization Gate](phase4-localization-gate.md) adds schema v31 for per-user language choices; v33 and v34 are reserved for Stages 7 and 8.

## Release surface

| Stage 1–6 intelligence | Public Beta classification | User-visible behavior |
| --- | --- | --- |
| Recovery and other approved derived metric deviations | PRESENTED | Current, active episodes are summarized as a metric relative to the user's personal baseline. |
| Episode state and severity | SHADOW-ONLY BY DESIGN | The summary gives concise context; operational state and severity are not exposed as independent UI. |
| Supported or emerging Journal associations/correlations with approved outcome metrics | PRESENTED | Current, receipt-checked insight claims appear as associations, with no causal claim. |
| Raw WHOOP facts, Journal entries, evidence runs/items, provenance, receipts, revisions, queue jobs and diagnostics | SHADOW-ONLY BY DESIGN | These support typed authority and audits; no raw record is a public message. |
| Proactive proposals, notification slots, preferences, work tips and family directory | SHADOW-ONLY BY DESIGN | Stage 6 produces/maintains them without adding an interaction surface. |
| Body Energy results, checkpoints, scores and Body Energy-derived associations | NOT YET AUTHORIZED FOR PUBLICATION | Calibration/publication approval is unsatisfied; no runtime cohort setting can display them. Computation and durable SHADOW state remain. |
| Stage 7 Quick Actions, buttons, callbacks, trusted registry and Journal provenance | NOT YET AUTHORIZED FOR PUBLICATION | No Stage 7 interaction in this release. |
| Stage 8 Owner/Family View | NOT YET AUTHORIZED FOR PUBLICATION | No v34 interaction in this release. |

This gives beta users real, current Core intelligence to observe and report: personal recovery deviations and supported/emerging Journal associations. It does not claim a separate UI for every internal object. Existing daily and weekly legacy reports remain available.

## Authority, ordering and delivery

The optional **Phase 4 Beta Summary** is read-only Telegram text. For each scheduled user, source sync and durable input processing precede the bounded Stage 6 SHADOW drain. Each user's semantic as-of time is captured immediately before that post-drain read. The repository's `betaSummary.readCurrent` calls the canonical typed episode and insight readers, checks receipts/provenance, current generation, completion, expiry/as-of, tenant and SHADOW mode, and omits any invalid item. The presenter receives only a small whitelisted projection. The typed Body Energy reader stays available to internal SHADOW code; the presentation object has no Body Energy publication helper.

The summary reads the target user's canonical display name at render time. A blank name yields a neutral heading. The active chat binding is resolved for the same user and lifecycle generation. Immediately before send, the held Phase 4 context and typed item set are rechecked at the actual current time, followed by the account delivery authorization fence. An expired, stale or privacy-fenced item cannot pass to transport. The pre-sync daily/weekly order is unchanged.

A summary is sent at most once per user and local date. The existing durable `report_claims` authority uses report type `phase4_beta_summary`; it fences overlap, retry, ambiguity and restart. A definite pre-send failure can be retried. No new schema or delivery table is needed. If no current approved item exists, no summary is sent. The beta cohort is OFF by default.

## Configuration for a later activation review

| Setting | Preparation/default | Proposed initial cohort | Expansion | Rollback |
| --- | --- | --- | --- | --- |
| `PHASE4_BETA_SHADOW_RUNTIME` | `off` | `on` in explicit beta composition | `on` | `off` |
| `PHASE4_PUBLIC_BETA_MODE` | `off` | `allowlist` only after authorized zh-TW/vi READY smoke and isolated en coverage | No `all` rollout authorized | `off` first |
| `PHASE4_PUBLIC_BETA_USER_IDS` | empty | canonical internal `users.id` list | update list | empty |
| `PHASE4_LOOKUP_KEY`, `PHASE4_AUDIT_KEY` | existing Phase 4 authority | retain same keys | retain | retain, never rotate as rollback |
| 13 Foundation `PHASE4_*` flags | off | off | off | off |

The lookup and audit keys are distinct hex-encoded secrets of at least 32 bytes and must match existing stored authority. Missing/malformed keys or an invalid gate fail closed. Secret values must never enter logs or review reports. `npm start` and the ordinary runner do not issue a beta runtime capability. The explicit `src/publicBetaEntry.js` composition is SHADOW-only. The webhook selects it only with `PHASE4_BETA_SHADOW_RUNTIME=on`; the separate cohort mode controls presentation. No deployment definitions are activated by this preparation.

## Mandatory deployment precheck before activation

1. Inspect the actual Render deployed commit, service command, env settings and scheduler endpoint configuration.
2. Inspect the actual GitHub scheduled workflow state, active branch/commit, command and beta environment configuration.
3. Inspect the actual Cloudflare deployed Worker commit/configuration and live cron, including the authenticated trigger path.
4. Verify production beta gate values, cohort IDs, Phase 4 key authority and the current scheduler overlap behavior in each runtime. Repository files do not prove live state.
5. Record the prior live values before any activation. Do not infer them from this branch.

The checked-in Cloudflare Worker target is already `*/10 0-3 * * *` UTC (08:00 to before 12:00 Asia/Taipei). The live provider trigger has not been changed by this repository preparation and must be read back during deployment. GitHub remains hourly and follows the Stage 6 fallback policy. Use the [deployment control](phase4-deployment-control.md) quiet-window and staged activation gates for any live scheduler change.

## Rollback after any later activation

1. Set `PHASE4_PUBLIC_BETA_MODE=off` on all active beta runtimes. This stops the new post-drain summary without altering legacy reports.
2. Set `PHASE4_BETA_SHADOW_RUNTIME=off`. Keep GitHub and Render pinned to the reviewed v31-compatible release tree. Never restore the old `main` binary or `npm start` scheduled workflow against v31.
3. Restore the prior Cloudflare cron/configuration if changed; verify the authenticated endpoint and hourly fallback.
4. Preserve all v28/v29/v30/v31 data, operation receipts, keys and user data. No DB rollback, deletion, migration downgrade, or LIVE mode promotion.

`npm run beta:smoke` uses synthetic users and a fake Telegram transport. It verifies final daily and Beta Summary payloads for Alice, Bob and an unnamed user, reversed order and a fresh process, with no real send. The historical broad-suite updates distinguish an authentic old schema fixture from an impossible v30 schema rewind: old version constants move to v30; hybrid rewinds must be rejected without weakening v30 postconditions; old downgrade fixtures expect incompatibility; missing scheduler heartbeat is stale under the Stage 6 policy.

English policy: **EN_IMPLEMENTED_AND_TESTED_NO_LIVE_USER_YET**. Production English smoke is **DEFERRED UNTIL AUTHORIZED EN USER EXISTS**. No English human or unauthorized locale change is required for Stage 7 entry. Current production v32 requires no migration for Core C or Settings D.
