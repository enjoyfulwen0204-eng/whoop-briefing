# Phase 4 deployment control — reviewed future procedure

For the reconstructed Vietnam RC3 code release, use the
[Vietnam Stage 2 coordinated rollout](phase4-vietnam-stage2-rc3-rollout.md).
The initial v31 migration procedure and RC2 transport facts below are retained
as historical controls. They do not describe current provider state or the new
split-phase protocol. RC3 code rollback retains v31, keys and user data.

This is a deployment plan, not activation. Record the final reviewed release SHA, deployed IDs, timestamps, and evidence during a separately authorized deployment. Keep Public Beta presentation and SHADOW runtime OFF until their later stages. The repository target schema is **v31**. Do not rotate either Phase 4 key.

## Gate 0 — Render inspection before any push

**No push of the local deployment-control commits is permitted until this gate passes.** Render auto-deploy is enabled. Authenticate to Render and record the production service ID/name, linked repository, linked branch, currently deployed commit SHA, current deploy ID/status, plan, build/start commands, health path, and configured database hostname (never its token). Set Auto-Deploy to **Off** in service Settings or with the supported Render service update control. Read the setting back and record proof that it is Off. Inspect pending/queued/deploying automatic deploys and cancel them; read back until none can start. A push before this gate could start the new binary on v20.

The checked-in Blueprint's free plan does not prove the live plan. Render [maintenance mode](https://render.com/docs/maintenance-mode) requires a paid web service; if needed, move the actual service to a capable plan before quiescence. If the actual service cannot support the sequence below, **stop for a separately reviewed alternative**. There is no free-tier suspension shortcut here. Keep auto-deploy **Off throughout the later push, RC/tag publication, backup, migration, manual RC deployment, deployed-SHA readback, and initial health verification**. Do not implicitly re-enable it. Any later decision to re-enable auto-deploy requires a separately reviewed stable-release decision that preserves immutable release-source control.

## Gate 1 — one authoritative writer-quiescence sequence

1. Confirm Render auto-deploy Off and no queued automatic deploy. Disable the existing GitHub scheduled workflow. Read back `disabled_manually` and drain or cancel all queued/in-progress runs; disabling alone does not stop a running job.
2. Remove the live Cloudflare Cron Trigger from `whoop-briefing-scheduler` (Dashboard Triggers, or schedules API `PUT` with `[]`). Read back **zero active triggers** with the schedules `GET` and record cutoff time `T0` in UTC. No replacement trigger is installed yet.
3. Wait Cloudflare's full **15-minute** documented propagation allowance after `T0`. The Worker code configures three 120-second fetch attempts and 500 ms + 1,000 ms retry backoffs: 361.5 seconds of configured request/backoff time. Cloudflare's [Cron invocation wall-time limit](https://developers.cloudflare.com/workers/platform/limits/) is **15 minutes**, which is the larger bound. Add a 60-second safety margin: the minimum elapsed gate is **31 minutes after T0** (15 + 15 + 1). Verify **no new** `briefing_cloudflare` heartbeat/invocation after cutoff and no in-flight scheduler request in Cloudflare/Render logs where observable. If one arrives, fail this window, wait for it to finish, record a new cutoff with zero triggers, and restart the full wait. The Render handler awaits `runBriefing` without a server-side timeout; elapsed time alone never proves drain. If in-flight status cannot be established, stop.
4. Enable Render maintenance mode after any required plan change. Read back the setting and verify a public request returns maintenance/503. Verify `/internal/briefing/run` does not accept production work. Verify Telegram webhook, WHOOP webhook, and OAuth ingress cannot write through the public service. Account for private-network and direct writers separately; maintenance does not block private access.
5. Wait for existing scheduler, Telegram, WHOOP, OAuth, background, and manual writers to drain. Confirm zero active writers from service logs and provider run state. Keep traffic blocked throughout backup and migration.
6. Only now create and verify the Turso backup. Only after every backup gate passes may the controlled v20→v31 migration start.

If any quiet-window, ingress, or writer-drain proof fails, **do not start the backup or migration**. Keep GitHub and Cloudflare triggers disabled. The Cloudflare [propagation allowance](https://developers.cloudflare.com/workers/configuration/cron-triggers/) is up to 15 minutes; this runbook uses the full allowance plus the configured Worker request window and an observed drain.

## Gate 2 — fail-closed Turso backup

Use authenticated Turso **management** access, not just the application SQL token. The current Turso Cloud CLI [branch command](https://github.com/tursodatabase/turso-cli/blob/main/README.md) is `turso db branch <source-database> <target-database>`; confirm installed `turso db branch --help` matches before use. Use a unique named target such as `whoop-briefing-pre-v31-YYYYMMDDTHHMMSSZ`. Do not overwrite a branch. Record production database name/URL identity, region/group, source schema version (`SELECT MAX(version) FROM schema_version` must be 20), and baseline counts for `users`, `user_telegram`, `user_whoop_tokens`, `whoop_sleeps`, `whoop_recoveries`, `whoop_cycles`, `whoop_workouts`, `journal_events`, and `report_runs`.

While writers remain quiesced, run `turso db branch <PRODUCTION_DB_NAME> <UNIQUE_PRE_V31_BRANCH_NAME>`. Record returned branch identity and URL. The management SQL syntax is:

```sh
turso db shell "$BRANCH_NAME" 'SELECT MAX(version) FROM schema_version;'
turso db shell "$BRANCH_NAME" 'PRAGMA integrity_check;'
turso db shell "$BRANCH_NAME" 'PRAGMA foreign_key_check;'
turso db shell "$BRANCH_NAME" 'SELECT COUNT(*) FROM users;'
```

Run the last query for each recorded baseline table. Require branch schema **20**, integrity exactly `ok`, zero FK rows, and every branch count equal to the production baseline. Retain branch ID/name, creation time, CLI version, source identity, verification output, and operator in deployment evidence. Confirm branch identity with management `turso db show`/`turso db list`. If CLI syntax, branch creation, read access, schema, integrity, FK, or any count fails: **MIGRATION MUST NOT START**. A database bearer token alone does not establish branch permission.

## Gate 3 — controlled key-aware migration, then reviewed application

The production DB URL must be canonical `libsql://whoop-briefing-enjoyfulwen0204-eng.aws-ap-northeast-1.turso.io` (trailing `/` accepted). The guarded script rejects credentials, port, extra path, query, fragment, and other schemes. Supply `TURSO_AUTH_TOKEN`, distinct stable hex `PHASE4_LOOKUP_KEY` and `PHASE4_AUDIT_KEY` (at least 32 bytes each) through the operator environment without printing them. Node 22, exact clean reviewed release SHA, database identity, integrity/FK, preserved counts, and v31 postconditions are mandatory. `FINAL_REVIEWED_RC_SHA` means the literal full commit SHA of the final immutable reviewed RC commit/tag; resolve and record the tag target before deployment. A moving branch or ambiguous latest-branch deployment is not an approved release source.

**Order:** quiesce the old application → verify pre-v31 backup → controlled migration → verify v31 → manually deploy the exact reviewed RC under maintenance → read back the deployed SHA and status → validate startup/health/v31/OFF gates → reopen traffic. **Never start the new v31 application on production v20:** its ordinary startup migrator could race the controlled migration. The old v20 binary must not run after v31.

```sh
node scripts/phase4-migrate.js --preflight --expected-target whoop-briefing-enjoyfulwen0204-eng.aws-ap-northeast-1.turso.io --expected-commit FINAL_REVIEWED_RC_SHA
node scripts/phase4-migrate.js --apply --expected-target whoop-briefing-enjoyfulwen0204-eng.aws-ap-northeast-1.turso.io --expected-commit FINAL_REVIEWED_RC_SHA --confirm-production whoop-briefing
```

**Preflight is key-authority establishing, not read-only on v20.** It first advances through key-independent v21 checkpoint-storage bootstrap, then atomically establishes/verifies separate lookup and audit verifiers. Run it only after verified backup and writer quiescence. Both verifiers are checked before v22 or later key-dependent writes, and on every rerun including a v31 no-op. A changed key fails. An old v31 database missing audit authority can establish it only after deterministic exhaustive absence proof for audit-dependent durable history; otherwise it fails `PHASE4_AUDIT_KEY_CONTINUITY_UNPROVEN`. A failed checkpoint gate prohibits further migration. Generic `npm run migrate` is not the controlled production entry.

Every v31-compatible application startup and migration invocation must receive the original lookup and audit keys even while SHADOW runtime and presentation are OFF. Missing keys fail closed on an established Phase 4 database; OFF gates do not waive durable key continuity. The only no-key migration exception is an explicit structural bootstrap to v21 from a pre-v21 database without existing key checkpoints.

After `--apply`, require v31, integrity `ok`, zero FK violations, unchanged preserved counts, zero newly created LIVE state and zero Body Energy rows from a v20 start. Record the script result. Keep Render maintenance mode **ON** and public ingress **closed**; keep GitHub and Cloudflare scheduler activation at their disabled/staged gates. Manually deploy `FINAL_REVIEWED_RC_SHA` to the verified production Render service by selecting that exact immutable commit/tag, never “latest branch.” Record the resulting Render deploy ID and wait for completion. Read back the Render service ID, deployed commit SHA, and deploy status. Require the service ID to match the inspected production service, deployed SHA **exactly equal** `FINAL_REVIEWED_RC_SHA`, and deploy status to be successful/live under Render's current status vocabulary. A mismatched SHA, failed/incomplete status, or wrong service **stops deployment; do not reopen ingress**. Redeploy or roll back only to the reviewed v31-compatible release.

While maintenance remains ON, verify the new application started, `/health` succeeds, DB connectivity reports v31, Phase 4 lookup/audit continuity passes with the original keys, Beta SHADOW runtime is OFF, Public Beta presentation is OFF, and no LIVE execution exists. Record these readbacks with the deploy ID. Only after **all** release, health, v31, and OFF-state checks pass may public ingress be reopened. Keep auto-deploy Off through this verification.

## Gate 4 — staged default-branch GitHub transition

GitHub schedules execute from default branch `main`. Install the reviewed [workflow transition template](phase4-main-workflow.yml) on `main` while the existing workflow remains disabled. Replace `REVIEWED_RELEASE_SHA` with the **literal full `FINAL_REVIEWED_RC_SHA`**, then read back the installed workflow and verify exact checkout SHA, Node 22, command, secrets/config names, schedule, and disabled state. Do not use a moving branch/tag as checkout ref. Confirm no queued/in-progress runs. Preserve hourly `17 * * * *`, group `whoop-briefing`, and `cancel-in-progress: false`.

Activation is staged through GitHub environment/config values, with readback at each step:

| Stage | `PHASE4_BETA_SHADOW_RUNTIME` | `PHASE4_PUBLIC_BETA_MODE` | Cohort | Gate |
| --- | --- | --- | --- | --- |
| 0 | `off` | `off` | empty | Workflow disabled; installed reviewed source read back; zero queued/running jobs. |
| 1 | `off` | `off` | empty | Enable reviewed v31-compatible legacy/bootstrap command; verify one healthy run and heartbeat. |
| 2 | `on` | `off` | empty | Verify worker heartbeat, bounded backlog, no LIVE execution, and healthy legacy report path. |
| 3 | `on` | `allowlist` | approved canonical IDs only | Only after **three** controlled READY users: one zh-TW, one en, one vi. |

Each READY user must have ACTIVE lifecycle, an active Telegram binding, a valid WHOOP token, and READY onboarding state. Verify each with real production read-only evidence. If only two qualify, presentation remains OFF. Do not fabricate production users or messages. No `all` rollout is authorized. Final three-language live smoke happens only after the Stage 3 gate and separate activation authorization.

## Gate 5 — Cloudflare post-migration activation

Deploy reviewed Worker/config only after the v31 application is healthy and writers may resume. Install **only** `*/10 0-3 * * *` (UTC). Wait full propagation allowance, read back actual trigger list, and prove old all-day trigger absent. Verify configured target is exact reviewed HTTPS `/internal/briefing/run` endpoint; perform a separately authorized authenticated scheduler request, observe `briefing_cloudflare` heartbeat attribution, and prove no duplicate heavy tenant pass. Never overlap old and new triggers. Repository Wrangler target is already `*/10 0-3 * * *`; actual live Cloudflare state remains whatever the provider reports until later deployment.

## Rollback and disaster recovery

**Routine application rollback:** keep schema v31 and exact reviewed v31-compatible release tree. Set presentation OFF, then SHADOW runtime OFF. Use its compatible legacy/non-beta execution path, retain both original keys, and verify health on an isolated v31 database before production use. The old v20 `main` binary is **not** a valid rollback after v31. Do not downgrade schema.

**Database disaster recovery is separate.** Select a restore point from the verified pre-migration branch or approved PITR. For the branch path, create an isolated restore DB with `turso db branch <VERIFIED_PRE_V31_BRANCH_NAME> <UNIQUE_RESTORE_DB_NAME>` and record its new identity. Validate it *before* use with `turso db shell <UNIQUE_RESTORE_DB_NAME>`: schema version 20, `PRAGMA integrity_check = ok`, zero `PRAGMA foreign_key_check` rows, and matching baseline/expected counts. For PITR, first confirm the installed management CLI/API's supported point-in-time syntax and retention; the same validations apply. Repoint **every** production DB consumer consistently (Render web service, GitHub runner, any Worker/direct writer, and operational jobs); verify each readback before accepting traffic. Keep presentation OFF and SHADOW runtime OFF where appropriate. Start only a binary compatible with restored schema, verify health and critical reads, then reopen traffic after validation. Restoring the pre-migration snapshot may discard writes made after that snapshot; record and approve that loss boundary. Never treat snapshot restoration as routine rollback.
