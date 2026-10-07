# Vietnam Stage 2 RC3 coordinated rollout artifact

This is a future operator plan. This implementation session performs no deployment,
provider mutation, production sync, Stage 6 drain, Telegram send, workflow enablement,
cron enablement, tag creation or push. RC1 and RC2 remain immutable; the rejected
Taiwan candidate is not an authority. The reconstruction baseline is RC2
`c364ea7a7586bcaafb3fccd66bc18a461643732c`, tree
`2d88d0674abb82958a4aa585c4c2f4c8b9263c10`, schema v31.

## Coordinated release order

1. Keep production automation paused. Read back Render auto-deploy OFF, the
   manually disabled GitHub workflow with zero queued/in-progress jobs, and zero
   Cloudflare cron triggers. Preserve original lookup/audit keys and user data.
2. After independent review approves an exact commit, publish that approved
   commit and proposed tag `v1.2-phase4-public-beta-rc3`. Never retarget RC1/RC2.
3. Deploy the phase-aware RC3 Render server with Beta OFF/OFF. The runtime admits
   v31 read-only; deployment does not implicitly run a migration.
4. Verify the exact approved SHA, live health and v31 connectivity before changing
   scheduler clients. Verify ingress and maintenance against the reviewed plan.
5. While GitHub remains disabled, install `docs/phase4-main-workflow.yml` with BOTH
   checkout refs replaced by the SAME approved immutable RC3 SHA. Retain Node 22,
   npm ci, concurrency and separate 10-minute job guards. Read back both refs,
   disabled status and zero queued/in-progress jobs.
6. Only after the compatible server is live, update the phase-aware Worker. Keep
   `crons = []`. Set the reviewed execution mode and configuration proof for the
   exact server configuration; retain the existing independent HMAC trigger secret.
   The checked-in configuration proof is deliberately a non-runnable placeholder.
7. Read back the exact active Worker version, endpoint, phase/config values, zero
   triggers and both GitHub pins. A new Worker cannot call an old RC2 server.
8. Perform separately approved, controlled OFF/OFF validation. SYNC preserves
   eligible ordinary morning briefs. OFF/OFF does not authorize SHADOW drain.
9. Perform separately approved SHADOW ON/presentation OFF validation. A COMPLETE,
   NO_NEW_DATA or intentionally inapplicable SYNC issues the durable handoff;
   STAGE6_DRAIN makes bounded progress without repeating WHOOP or ordinary reports.
   PARTIAL/failed/cancelled/timed-out SYNC cannot authorize drain. Beta sends none.
10. Only after those gates pass, separately approve and restore the morning cron
    `*/10 0-3 * * *` (08:00–11:50 Taipei). Read back triggers and phase outcomes.
11. Review three locale choices and the three-person allowlist, then run separately
    approved zh-TW/en/vi pre-transport/current-state/recipient smoke checks before
    presentation activation. Missing names stay neutral; no Kelvin fallback.

## Runtime and transport bounds

| Source | Admission/claim | Overall SYNC | Drain wall / work stop | Overall drain | Outcome settlement |
| --- | ---: | ---: | ---: | ---: | ---: |
| Cloudflare | 30 s | 120 s | 45 / 30 s | 45 s | 15 s |
| GitHub scheduled | 30 s | 180 s | 90 / 75 s | 90 s | 15 s |
| workflow_dispatch / manual | 30 s | 180 s | 45 / 30 s | 45 s | 15 s |
| event | 30 s | 120 s | 25 / 10 s | 25 s | 15 s |

Stage 6 retains the approved per-source job/item/tenant/lease policy in
`src/phase4DrainPolicy.js`. Each GitHub job retains `timeout-minutes: 10`; full
backlog completion is never a dependency. GitHub drain requires job success AND
explicit `sync_complete=true` AND `drain_authorized=true`, then verifies the stored
handoff again against source, mode, configuration proof and the distinct request.

The Worker has two attempts per phase, a 180 s SYNC transport budget and a 100 s
STAGE6_DRAIN transport budget, including headers, streamed response and cleanup.
Responses are capped at 16 KiB before materialization. Server maxima are 165 s for
Cloudflare SYNC and 90 s for drain, leaving 15 s and 10 s transport margin.
Worst-case sequential transport/backoff is `2*(180+100)+0.5+0.5 = 561 s`, leaving
39 s in a 10-minute cadence. No provider maximum wall limit is used as the fence.
An HTTP client timeout does not mean Render or WHOOP terminated: the server's own
budget, connection-bound admission and durable owner/commit fences are separate.

## v31 operational storage contract

Runtime admission derives the complete contract from `SCHEMA`, `ADDITIVE_COLUMNS`
and every frozen `PHASE4_MIGRATIONS` entry, including replacements: 86 tables,
210 indexes and 203 triggers, with five retired indexes excluded. It compares
complete column/constraint definitions, index uniqueness/columns/predicates and
trigger bodies. Quoted SQL literals are preserved by normalization. Five bounded
metadata reads verify that contract, exact v31 version authority, all required
completed checkpoints, original lookup/audit key continuity and FK/CHECK enforcement.
Admission performs no DDL, DML, migration or checkpoint initialization and scans
no tenant or health history. Only the explicit operator migration path can repair
schema or establish missing migration authority.

An admission capability is privately branded and bound to the exact executor,
transaction kernel, original keys and live connection epoch. Copied/serialized
objects, different connections, closed clients and reconnects fail. A reopened
connection must be admitted again. Runners verify the private issuer record;
caller-created facade methods cannot authorize a forged capability.

No table or schema version is added. `resource_locks` supplies atomic claims,
random owner generations, finite expiry and owner-checked takeover/release.
`system_heartbeats` supplies separate SYNC and Stage 6 start/discovery/drain/outcome
records and request idempotency. Its generic writer still discards free text.
The new dedicated codec accepts only fixed non-health enum codes, nonnegative
aggregate counts, timestamps and opaque authenticated transport hashes. It never
accepts tenant IDs, cohort IDs, names, health values, provider payloads or narrative.
These records are operational metadata; they do not infer tenant/source linkage.

A handoff is an HMAC over the complete admitted SYNC request identity, source,
mode, configuration proof and settlement time, and expires after 15 minutes.
Same authenticated ID/body retries return their original result. A conflicting
phase/body is rejected even while pending; a cached SYNC cannot stand for drain.
Request IDs remain reserved rather than pruned into a conflicting reusable ID.

A killed invocation cannot write a completion heartbeat. Current start identity
must match a completion before health can call it settled. Discovery only,
IN_PROGRESS, PARTIAL, NO_WORK and COMPLETE are separate evidence; old scheduler
liveness is not Stage 6 completion evidence. Successful independent family work
and committed scan cursors survive bounded stops and process death.

SYNC owns each canonical tenant scope with an atomic random owner generation and
a lease bounded by remaining server budget plus 15 seconds (at most 195 seconds).
Every durable write and each transaction COMMIT rechecks budget and owner. A
takeover replaces the owner; a stale owner cannot overwrite newer state or release
the successor's lease. No transaction spans WHOOP HTTP waits. Request leases and
outcome settlement also use owner-checked atomic transactions. Uncancelable remote
operations can finish after abort, but their late continuations retain their old
budget and ownership fences. Client timeout never proves provider termination.

## Rollback

Stop incompatible new workflow/Worker clients first. Restore RC2-compatible OFF/OFF
execution and the reviewed RC2 code/configuration, while keeping automation paused
until separately approved. Retain schema v31, the original keys and user data.
There is no migration rollback and no pre-v31 backup restore for ordinary code
rollback. Retain the pre-v31 backup as recovery evidence. Read back exact code and
client versions after rollback.

## Product and recovery boundaries

The missed morning brief is explained by intentionally paused schedulers in the
recovery audit: GitHub disabled and Cloudflare zero cron triggers. This session
has not demonstrated a renderer or delivery defect and does not restore schedules.

Stage 5 and Stage 6 authority, fairness, family isolation, retries, localization,
Public Beta privacy/currentness/recipient gates, OFF/ALLOWLIST/ALL policies and
SHADOW-only composition remain. Body Energy is
`NOT_AUTHORIZED_NOT_PRESENTED`. No Settings v1, Stage 7/8, Quick Actions,
TRUSTED_REGISTRY, Owner/Family View or Body Energy publication is introduced.

Settings v1 remains `DEFERRED_POST_LAUNCH`, the FIRST UX patch after successful
Public Beta stabilization: `/settings` offers Change Language (zh-TW/en/vi) and
Change Display Name; retain planned `/language` and `/name` shortcuts.

After local commits and a clean working tree, create local recovery branch
`recovery/vietnam-stage2-rc3`. Do not push the canonical branch or create a tag.
A recovery push is safe only after the Architecture Owner freshly verifies that
Render auto-deploy is not linked to that branch. Provider state was not freshly
verified in this code session, so its push status is NOT_PUSHED.
