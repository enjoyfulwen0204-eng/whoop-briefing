# Reviewed v32 rollout — immutable RC3 and post-RC3 admission repair

Repository artifact only. No deployment, migration, tag, push or activation is
authorized by this implementation. RC1/RC2/RC3 are immutable. Published
v1.2-phase4-public-beta-rc3 remains ce8e4fd76baab494d32de11e4d022311e303a066.
The post-RC3 delivery-default admission repair is a new candidate; proposed tag
v1.2-phase4-public-beta-rc4 requires Architecture Owner approval and is not created
here. See [v32 contract](phase4-v32-settlement-authority.md) and
[delivery-default repair](phase4-rc4-delivery-default-repair.md).

## Current paused production state

User-reported controlled-rollout state on 2026-10-09, not freshly verified here:
the v31→v32 migration passed; DB is v32; Render maintenance is ON with the existing
RC2 deploy still selected and auto-deploy OFF. RC3 was not deployed. GitHub remains
disabled, Cloudflare cron count zero, SHADOW/presentation OFF, allowlist empty,
LIVE rows zero, original keys retained, fresh verified pre-v32 backup available.
Gate 14 stopped on the preserved v7 telegram_operations.delivery_state default
'DELIVERED'. Fixing admission metadata does not require another migration,
downgrade, table rewrite or backup restore. This session does not resume production.

## Historical pre-migration recovery baseline

Recovery-audit facts, not new live checks: exact RC2 c364ea7a7586bcaafb3fccd66bc18a461643732c;
schema v31; Render auto-deploy OFF; Beta OFF/OFF; empty allowlist; GitHub manually
disabled with no queued/in-progress runs; Cloudflare zero cron triggers; original
lookup/audit keys; six pending SHADOW jobs; verified pre-v31 backup retained. The
missed morning brief is explained by deliberately paused schedulers.

## Original reviewed v31→v32 order (historical reference)

The migration portion is already completed according to the current rollout
context. Do not repeat it to repair the preserved delivery-state default.

1. Fresh read back exact RC2/OFF/OFF; verify Render auto-deploy OFF **before publishing**,
   and verify GitHub/Cloudflare automation paused.
2. Verify recovery readiness and a current v31 backup; the retained pre-v31 backup
   alone is not the v31→v32 migration backup. Preserve original key custody.
3. Publish only the approved final RC3 commit/tag after independent review.
4. Establish maintenance/quiescence and stop writers as required by migration.
5. Run the reviewed controlled operator with --target-version 32, original keys,
   exact database/commit assertions and explicit production confirmation.
6. Read back exact v32, full authority/postconditions, integrity OK, FK zero,
   preserved data/keys, no LIVE and no Stage 7/8 structures.
7. Deploy the exact reviewed RC3 server with Beta OFF/OFF.
8. Verify actual server SHA and health. Runtime and read/admin/health entrypoints must not auto-migrate.
9. Install the disabled split workflow artifact. Both checkout/environment pins
   equal RC3; actual HEAD verification and FINALIZED_SUCCESS dependency remain.
10. Deploy the compatible phase-aware Worker only now; cron remains OFF. Read back
    exact Worker version/config, release proof and both GitHub pins.
11. Controlled OFF/OFF validation: ordinary morning path, finalized sync, no drain.
12. Controlled Stage 2 SHADOW ON / presentation OFF, without Telegram Beta sends.
13. Prove finalized typed sync, signed handoff, bounded Stage 6 progress, durable
    receipts, truthful ordinal-ordered unfinalized/finalized health, producing-execution
    currentness, deterministic generic receipts and restart/reconciliation.
14. Only later restore the reviewed morning cron.
15. Authorized zh-TW/vi production smoke and isolated en rendering/persistence/privacy/recipient integration follow review. Production English smoke is deferred until an authorized en user exists.

Cloudflare signing/body/header/size limits stay unchanged. Indeterminate SYNC
never authorizes drain. GitHub jobs each retain timeout-minutes: 10 and Node 22
with npm ci. Neither reviewed artifact is installed live in this session.

## Post-RC3 resume order — separate review and authorization required

1. Independently review the delivery-default repair and new exact candidate SHA.
   Confirm RC3 tag immutability; freshly verify v32, maintenance ON, auto-deploy
   OFF and automation paused before any publication/deployment.
2. Publish only the separately approved new release identity. Do not move RC3.
3. Re-run read-only Gate 14 admission against the canonical production v32
   metadata: all 520 objects, original keys/checkpoints, integrity and FK contract.
   The exact historical DELIVERED column definition is accepted; arbitrary
   defaults, changed constraints and unrelated structural corruption reject.
4. Deploy the exact approved new server OFF/OFF under the reviewed maintenance
   controls, then read back actual SHA/config/health. Keep automation paused.
5. Install the disabled split GitHub artifact with both pins and actual checkout
   checks equal to the new SHA. Deploy only its compatible Worker, cron OFF;
   read back Worker/config and both GitHub pins.
6. Resume only the separately approved controlled OFF/OFF and Stage 2 validation:
   finalized SYNC, bounded Stage 6 progress, truthful heartbeat, no Beta sends.
   Maintenance/ingress changes each remain part of that production authorization.
7. Restore reviewed morning scheduling only after those gates; locale, allowlist
   and three-language smoke follow. Never infer renderer failure from paused cron.

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

The rollback binary must include this exact historical-default admission repair.
The unrepaired ce8e4fd binary also rejects the production DELIVERED definition;
selecting its rollback profile cannot bypass that structural check. The repaired
profile is tested against the production-like v32 history with authenticated
legacy OFF/OFF ingress, request replay and no drain authorization.

Retain v32, original keys, user data and execution/business receipts. No schema
downgrade, raw RC2 deployment, or pre-v31 backup restore for ordinary code rollback.
Catastrophic data recovery requires its own approval and verified backup plan.

## Deferred work

v31 Localization; v32 Execution Settlement Authority; v33 Stage 7; v34 Stage 8.
Settings v1 is DEFERRED_POST_LAUNCH: /settings, Change Language, Change Display
Name, /language and /name remain the first post-launch UX patch. Body Energy stays
NOT_AUTHORIZED_NOT_PRESENTED. No LIVE, Quick Actions, TRUSTED_REGISTRY or Owner/Family
View is implemented or activated here.
