# Future RC3 rollout — v32 authority

Repository artifact only. No deployment, migration, tag, push or activation is
authorized by this implementation. Proposed tag: v1.2-phase4-public-beta-rc3, still
uncreated. RC1/RC2 are immutable. See [v32 contract](phase4-v32-settlement-authority.md).

## Retained production baseline

Recovery-audit facts, not new live checks: exact RC2 c364ea7a7586bcaafb3fccd66bc18a461643732c;
schema v31; Render auto-deploy OFF; Beta OFF/OFF; empty allowlist; GitHub manually
disabled with no queued/in-progress runs; Cloudflare zero cron triggers; original
lookup/audit keys; six pending SHADOW jobs; verified pre-v31 backup retained. The
missed morning brief is explained by deliberately paused schedulers.

## Separately authorized future order

1. Read back exact RC2/OFF/OFF and verify all automation paused.
2. Verify recovery readiness and a current v31 backup; the retained pre-v31 backup
   alone is not the v31→v32 migration backup. Preserve original key custody.
3. Publish only the approved final RC3 commit/tag after independent review.
4. Establish maintenance/quiescence and stop writers as required by migration.
5. Run the reviewed controlled operator with --target-version 32, original keys,
   exact database/commit assertions and explicit production confirmation.
6. Read back exact v32, full authority/postconditions, integrity OK, FK zero,
   preserved data/keys, no LIVE and no Stage 7/8 structures.
7. Deploy the exact reviewed RC3 server with Beta OFF/OFF.
8. Verify actual server SHA and health. Runtime must not auto-migrate.
9. Install the disabled split workflow artifact. Both checkout/environment pins
   equal RC3; actual HEAD verification and FINALIZED_SUCCESS dependency remain.
10. Deploy the compatible phase-aware Worker only now; cron remains OFF. Read back
    exact Worker version/config, release proof and both GitHub pins.
11. Controlled OFF/OFF validation: ordinary morning path, finalized sync, no drain.
12. Controlled Stage 2 SHADOW ON / presentation OFF, without Telegram Beta sends.
13. Prove finalized typed sync, signed handoff, bounded Stage 6 progress, durable
    receipts, truthful unfinalized/finalized health and restart/reconciliation.
14. Only later restore the reviewed morning cron.
15. Locale selection, allowlist isolation and zh-TW/en/vi smoke follow review.

Cloudflare signing/body/header/size limits stay unchanged. Indeterminate SYNC
never authorizes drain. GitHub jobs each retain timeout-minutes: 10 and Node 22
with npm ci. Neither reviewed artifact is installed live in this session.

## Rollback after v32

Raw RC2 is NOT v32-compatible; its exact migration/schema guard rejects 32. Stop
incompatible workflow/Worker clients first. Use the exact reviewed v32-capable
rollback binary, pinned to the approved candidate SHA, with:

- PHASE4_EXECUTION_PROFILE=RC2_V32_ROLLBACK
- PHASE4_BETA_SHADOW_RUNTIME=off
- PHASE4_PUBLIC_BETA_MODE=off
- PHASE4_PUBLIC_BETA_USER_IDS empty

This closed profile retains ordinary sync/report and authenticated legacy HTTP
execution, enforces fresh v32 admission, uses durable settlement and never enters
Shadow drain or presentation. Read back the exact rollback SHA/config. A later
manual sync uses scripts/phase4-run.js with PHASE4_EXECUTION_PHASE=SYNC. New clients
stay paused until compatibility is independently revalidated.

Retain v32, original keys, user data and execution/business receipts. No schema
downgrade, raw RC2 deployment, or pre-v31 backup restore for ordinary code rollback.
Catastrophic data recovery requires its own approval and verified backup plan.

## Deferred work

v31 Localization; v32 Execution Settlement Authority; v33 Stage 7; v34 Stage 8.
Settings v1 is DEFERRED_POST_LAUNCH: /settings, Change Language, Change Display
Name, /language and /name remain the first post-launch UX patch. Body Energy stays
NOT_AUTHORIZED_NOT_PRESENTED. No LIVE, Quick Actions, TRUSTED_REGISTRY or Owner/Family
View is implemented or activated here.
