# Vietnam Stage 2 RC3 coordinated rollout artifact

This is a future operator plan. This implementation session performs no deployment,
provider mutation, production sync, Stage 6 drain, Telegram send, workflow enablement,
cron enablement, tag creation or push. RC1 and RC2 remain immutable; the rejected
Taiwan candidate is not an authority. The reconstruction baseline is RC2
`c364ea7a7586bcaafb3fccd66bc18a461643732c`, tree
`2d88d0674abb82958a4aa585c4c2f4c8b9263c10`, schema v31.

## Coordinated release order

1. Keep production automation paused. Read back Render auto-deploy OFF, the
   manually disabled GitHub workflow with zero queued/in-progress jobs and zero
   Cloudflare cron triggers. Preserve the original keys and user data.
2. After the SAME independent review accepts all six Round 2 fixes, publish the
   APPROVED final commit/tag `v1.2-phase4-public-beta-rc3`. Never retarget RC1/RC2.
3. Deploy that exact phase-aware server OFF/OFF. Keep `.git` checkout identity
   available: runtime independently reads `HEAD^{commit}` and rejects unverifiable
   identity; an environment string cannot substitute for actual HEAD.
4. Verify the exact live server SHA and health/v31 connectivity.
5. While GitHub is disabled, install the split workflow artifact with BOTH refs,
   both identity-verification pins and both `PHASE4_RELEASE_SHA` values equal to
   the SAME approved exact SHA. Each job verifies actual checkout HEAD before
   installation; the runtime verifies it again. Retain Node 22, npm ci, concurrency
   and separate ten-minute guards.
6. Read back both pins and checkout checks, disabled status and zero active jobs.
7. Deploy the compatible phase-aware Worker only after the server is compatible.
   Keep `crons=[]`; bind `BRIEFING_RELEASE_SHA`, mode and release-bound config
   proof to that exact server SHA. Retain the independent HMAC secret.
8. Read back the exact Worker version/config, compatible server identity and
   GitHub pins. Different commits cannot share handoffs even with identical trees.
9. Perform separately approved controlled OFF/OFF validation; eligible ordinary
   morning briefs remain reachable and SHADOW drain is disabled.
10. Perform separately approved SHADOW ON/presentation OFF validation. Only a
    complete typed SYNC settled under its original authority can authorize drain.
11. Prove separate Stage 6 discovery, bounded progress and truthful settled
    heartbeat. PARTIAL/failed/cancelled/timed-out sync cannot authorize drain.
12. Only after those gates pass, separately approve restoring the reviewed morning
    cron `*/10 0-3 * * *` (08:00–11:50 Taipei). Read back actual triggers/outcomes.
13. Locale choices, three-person allowlist and zh-TW/en/vi smoke remain later gates.
    Missing names remain neutral; no Kelvin fallback.

## Runtime and transport bounds

| Source | Admission/claim sub-budget | Work sub-budget SYNC / drain | Settlement sub-budget | Authoritative whole phase SYNC / drain |
| --- | ---: | ---: | ---: | ---: |
| Cloudflare | 30 s | 120 / 45 s | 15 s | 165 / 90 s |
| GitHub scheduled | 30 s | 180 / 90 s | 15 s | 225 / 135 s |
| workflow_dispatch / manual | 30 s | 180 / 45 s | 15 s | 225 / 90 s |
| event | 30 s | 120 / 25 s | 15 s | 165 / 70 s |

One authoritative phase clock starts at invocation entry and includes identity
verification, admission, work and successful settlement. Sub-clocks are constrained
by it. The original work clock and original AbortSignal also remain valid through
success settlement, heartbeat/HMAC generation, outermost COMMIT and response
serialization. Settlement's 15 seconds is a cap, never a fresh success authority.
A cleanup clock can record only failure/aborted evidence, with owner CAS and within
remaining overall time. It cannot create a handoff or successful completion.

Stage 6's approved worker wall/work-stop budgets remain 45/30 s Cloudflare/manual,
90/75 s GitHub and 25/10 s event. Job/item/tenant/lease limits remain unchanged.
Full backlog completion is never an invocation dependency. GitHub drain requires
job success and explicit `sync_complete=true`/`drain_authorized=true`, then checks
stored source, mode, cohort/config proof, exact release and distinct request.

Worker attempt timeout: 180 s SYNC, 100 s drain, now including async WebCrypto
signing, connection/headers, streamed body and cleanup. Each attempt and the whole
invocation also check absolute time; cancellation during uninterruptible signing
is gated before fetch. Two attempts per phase plus two 500 ms backoffs total at
most **561 s**. The Worker whole invocation cap is 561 s, inside the future
600 s cadence with 39 s margin; no provider maximum wall limit is used as authority.
Cloudflare server maxima 165/90 s leave 15/10 s transport margins. Each GitHub job
has a separate 600 s guard including checkout/install/CLI; it is not the server
work clock. Response cap stays 16 KiB. No timeouts were increased to hide a defect.
Client timeout never proves Render/WHOOP termination; server authority and durable
ownership/commit fences remain separate. Production timing is NOT_MEASURED.

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
transaction kernel, original keys and private, non-revivable connection lifetime. Copied/serialized
objects, different connections, closed clients and reconnects fail. A reopened
connection must be admitted again. Retained underlying/prototype close methods and public closed-flag mutation cannot revive an old capability. Idle contention reconnect performs a complete fresh read-only admission and replaces server factory capabilities; it never revives the old object or replays migrations. Runners verify the private issuer record;
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
mode, release-bound configuration proof, exact actual checkout release SHA and settlement time, and expires after 15 minutes.
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
outcome settlement also use owner-checked atomic transactions under the original authority, including nested outermost COMMIT. Uncancelable remote
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
