# Vietnam Stage 2 full repair review handoff

> Historical report for reviewed candidate `1577b1b`, subsequently rejected with six findings. Original evidence and claimed statuses are retained below. The Round 2 handoff supersedes this report: [review repair](phase4-vietnam-stage2-review-round2.md).

`PHASE4_VIETNAM_STAGE2_FULL_REPAIR_COMPLETE`

Implementation, workflow artifacts and synthetic regression evidence are ready for
independent review. This report does not approve a release or activate scheduling.

## Identity and RC2 alignment — PASS

Repository: `/Users/kelvin/Desktop/whoop-briefing`.
Remote: `https://github.com/enjoyfulwen0204-eng/whoop-briefing.git`.
Starting local HEAD: `32e6af485b2bf7e75fb4e00afb21711a9b2799f1` (clean).
After fetch, branch switch and fast-forward-only alignment: HEAD
`c364ea7a7586bcaafb3fccd66bc18a461643732c`, tree
`2d88d0674abb82958a4aa585c4c2f4c8b9263c10` (clean).
Branch: `v1.2-phase4`; upstream: `origin/v1.2-phase4`; schema: v31.
The final local commit/tree and clean-tree readback accompany the session's final
handoff. RC1/RC2 remain immutable; no unknown Taiwan state was reconstructed.

## H1 fast admission — CLOSED

The canonical contract is compiled from repository `SCHEMA`, `ADDITIVE_COLUMNS`
and all `PHASE4_MIGRATIONS`, including replacements: 499 objects (86 tables,
210 indexes, 203 triggers), excluding five retired indexes. Complete table column,
constraint/FK, index uniqueness/column/predicate and trigger definitions are
checked with quote-aware normalization. Five bounded read-only metadata queries
also check exact v31 migration authority, completed Phase 4 checkpoints, original
lookup/audit continuity, foreign-key enforcement and CHECK enforcement.

Negative controls reject missing/wrong/weak triggers; missing, nonunique,
wrong-column and wrong-predicate indexes; quoted-literal predicate substitution;
missing/altered columns; altered CHECK/FK constraints; corrupt/missing/incomplete
checkpoints and version authority; missing/wrong independent keys; old/future
schema; and disabled FK/CHECK enforcement. Admission and actual SYNC/drain/nested
factory query paths prove no DDL, DML, checkpoint initialization or migration
replay, with one admission on the same live connection. Explicit operator
migration remains separate. The empty-v21 operator migration checkpoint case is
repaired without changing frozen DDL or allocating a schema version.

Local admission: 41.35 ms / five queries. With 150 ms injected per query: 2,805.58 ms
/ five queries. No tenant or health-history scan; production: NOT_MEASURED.

## L1 capability lifetime — CLOSED

Private WeakMap issuance binds capability to exact executor, transaction kernel,
keys and connection epoch. Forged, copied, serialized, other-connection,
closed-connection and stale reconnect capabilities fail. Normal live reuse
passes. Fresh admission after reconnect rebuilds cached stores. Both client and
facade close paths are covered; caller-created admission methods cannot authorize
forged objects. No caller boolean bypass exists.

## H2 sync outcome — CLOSED

Exact RC2 reproduction: required sleep resource `status=failed`, runner
`failed=0`, `outcome=completed`; runtime executed 1,126 queries including 86 DDL
statements. The repaired canonical typed result is `REQUIRED_RESOURCE_FAILED`,
runner `failed=1`, HTTP 424 with `ok=false`, `syncComplete=false`,
`drainAuthorized=false` and no handoff. The actual GitHub CLI exits 1 with both
dependency outputs false. Cloudflare rejects failed/partial sync and HTTP 207.

COMPLETE_SUCCESS, NO_NEW_DATA_SUCCESS, INTENTIONALLY_INAPPLICABLE, PARTIAL,
REQUIRED_RESOURCE_FAILED, AUTH_FAILED, TIMEOUT and CANCELLED are distinguished.
Incomplete pagination/backfill/bootstrap cannot authorize drain. Ordinary historic
report availability retains its separate policy.

## H3 server deadline and ownership — CLOSED

Overall SYNC budgets: GitHub/manual 180 s; Cloudflare/event 120 s. Admission/claim
has 30 s; outcome settlement has 15 s. WHOOP cancellation/deadline reaches request
initiation, headers, streamed bodies, pagination, retry/sleep, refresh, tenant
scheduling, post-fetch processing and durable commit. No new work starts after
expiry; timeout/cancellation cannot authorize drain.

Existing v31 `resource_locks` supports atomic tenant-scope claims, random owner
as generation, bounded lease (remaining budget + 15 s; maximum 195 s), expiry
and takeover. Every durable write and transaction COMMIT rechecks owner/budget.
Old owners cannot overwrite successors or release successor leases. No transaction
is held across external HTTP waits. Two actual OS processes and two HTTP server
processes prove overlap rejection after client abort, old server still running,
process death, expiry/takeover, delayed stale response and legitimate retry.

Uncancelable driver/provider operations may physically finish later; physical
termination is not claimed. Late continuations retain expired/aborted budgets and
durable fences. Ambiguous/failed settlement cannot become success.

## Cloudflare transport — PASS

Headers and full response streaming share the request deadline; responses are
capped at 16 KiB before materialization. Overflow aborts and cancels the reader;
stall/abort/late success cannot become success. Retries retain exact ID/body and
refresh signatures. Failed sync, HTTP 207, misleading HTTP 200 and conflicting
requests never authorize drain.

Two attempts per phase; transport SYNC 180 s, drain 100 s. Server maxima 165 s and
90 s provide 15 s / 10 s margin. Worst-case sequential requests/backoff: 561 s,
with 39 s margin inside the future 10-minute cadence. Tests cover stalled headers,
stalled bodies, endless oversize, boundary completion, abort, late completion,
retry overlap and cleanup. Client timeout is not Render termination.

## M1 progress and heartbeat — CLOSED

Typed drain results distinguish invocation/discovery, no eligible work, bounded
PARTIAL progress, jobs completed, full relevant completion, budget exhaustion and
failure. Safe aggregates include source, considered/attempted/processed/completed/
failed/remaining counts and stop reason. Zero completed jobs cannot mean fully
drained. Cursor, receipt and independent family outcomes remain durable.

Separate v31 operational heartbeat records prove SYNC start/outcome and Stage 6
start/discovery/drain/outcome. A current start identity must match completion;
crash before settlement emits no completion heartbeat. Health distinguishes
NOT_ENTERED, discovery only, in progress, PARTIAL and COMPLETE. The dedicated
storage codec accepts only closed operational enums/counts/times/opaque hashes;
generic heartbeat free text stays discarded. No user IDs, cohort IDs, health
values, keys, tokens or arbitrary narrative enter these records or ordinary logs.

Markers precede admission, sync, discovery and drain; successful completion
markers follow durable settlement, with safe counts, source, duration and outcome.

## M2 dispatch and replay — CLOSED

`workflow_dispatch` remains manual; schedule remains GitHub scheduled. Source is
bound through request, handoff, runner, budgets, heartbeat and observability.
Signed identity binds request ID, phase, exact body hash, mode, source and opaque
configuration/cohort proof. Pending and completed conflicts reject; unsigned
phase substitution fails signature verification. Same authenticated ID/body
returns its original result. Distinct legitimate SYNC and drain requests both
execute. A cached SYNC cannot satisfy drain. Handoff lifetime: 15 minutes.

## GitHub split workflow — PASS

Only the reviewed `docs/phase4-main-workflow.yml` artifact changes. Separate SYNC
and STAGE6_DRAIN jobs each retain 10 minutes, Node 22, npm ci, concurrency and the
same immutable `REVIEWED_RELEASE_SHA` placeholder. Drain requires dependency
success and both explicit successful-sync and drain-authorized outputs, then
rechecks the durable handoff. OFF/OFF cannot drain; SHADOW ON/presentation OFF can
make eligible Stage 6 progress and sends no Beta Summary. The installed
`.github/workflows/briefing.yml` is unchanged. YAML and each embedded shell script
parse successfully.

## Morning brief continuity — PASS

Fake-transport tests prove eligible ordinary scheduled morning briefs in OFF/OFF
and SHADOW ON/presentation OFF, Beta Summary OFF, once-per-user/date dedupe and
no duplicate on sync retry. Drain never emits an ordinary morning brief. Existing
non-Beta scheduling eligibility is preserved. The missed morning brief remains
explained by paused schedulers from the recovery audit; no renderer/delivery
failure has been demonstrated and scheduling has not been restored.

## Backlog and process death — PASS

Fixture: three tenants, six jobs, two kinds per tenant, 23/115/99 eligible sources
plus three USER roots. Stable total: 480 source-plus-USER passes across both kinds.
First GitHub invocation: 24 durable passes, zero jobs complete, PARTIAL, 245.36 ms;
8-per-tenant scheduled bound respected. Cursor progress survives real SIGKILL.
Before expiry a competing attempt makes zero progress; after expiry restart
resumes. Repeated bounded drains (29 subsequent iterations) complete all six
jobs/480 passes, three receipts, no duplicate receipt/delivery, no outbound
transport or LIVE row. Budget exhaustion remains normal, not REPAIR_REQUIRED;
independent family success is retained.

## Presentation and localization — PASS

SYNC has no Beta presentation. The reachable post-drain path reads authorized
typed current state and preserves freshness/currentness/privacy/recipient gates.
Partial state cannot be labeled current. Presentation OFF sends none. Tests cover
zh-TW/en/vi, different names, neutral missing name, no Kelvin fallback, recipient
and cross-user isolation, allowlist isolation and delivery dedupe. Body Energy:
`NOT_AUTHORIZED_NOT_PRESENTED`.

## Product preservation — PASS

Schema and frozen DDL remain v31. Stage 5 semantics and Stage 6 authority,
fairness, retries, family isolation and localization pass focused regressions.
OFF/ALLOWLIST/ALL, SHADOW-only composition and no LIVE remain. No Settings v1,
Stage 7/8, Quick Actions, TRUSTED_REGISTRY, Owner/Family View or Body Energy
publication is implemented.

## Performance

Admission: local 41.35 ms; injected 150 ms/query 2,805.58 ms; production
NOT_MEASURED. With 10 ms/query injected on actual empty-cohort phase paths:
SYNC 378.97 ms / 23 queries; drain 336.73 ms / 23 queries; one admission reused.
One-user ordinary-brief fake transport: OFF 232.82 ms; ON 187.91 ms.
Backlog first bounded invocation: 245.36 ms. These are synthetic fixture timings,
not production completion forecasts.

| Source | SYNC | Drain overall / work stop | Max jobs / items / items per tenant | Stage 6 lease |
| --- | ---: | ---: | ---: | ---: |
| Cloudflare | 120 s | 45 / 30 s | 8 / 48 / 6 | 60 s |
| GitHub scheduled | 180 s | 90 / 75 s | 16 / 128 / 8 | 120 s |
| Manual | 180 s | 45 / 30 s | 8 / 48 / 6 | 60 s |
| Event | 120 s | 25 / 10 s | 2 / 8 / 4 | 40 s |

Admission/claim is 30 s and settlement 15 s for each phase. GitHub's two separate
10-minute job guards exceed the bounded server work and leave installation margin.
Full backlog completion is never required by one drain invocation.

## Tests

Node v22.23.2; npm 10.9.8. Latest accepted results: **469 passed, zero failed,
zero skipped, zero cancelled across 56 files**. Exact files, individual cases,
run classifications, timings and log hashes are in
[`phase4-vietnam-stage2-tests.json`](phase4-vietnam-stage2-tests.json).

The relevant broad 37-file run completed with two failures: an outdated Beta
assertion and a native E2E process SIGSEGV. Corrected assertions and owned SQLite
fixture/awaited cleanup pass their separate final reruns. Earlier runs include
logical/application assertion failures, SQLite native SIGSEGV, sandbox EPERM
(local listeners and git FETCH_HEAD), fixture/tooling failures and one interrupted
unbounded wildcard full-suite run. That wildcard run ran about 26 minutes, stalled
for over eight minutes, then its exact test process tree was killed. It has no
final totals and is not claimed as a completed full suite. No forced-success exit
was used. All recorded failed/interrupted attempts are retained in the ledger;
raw synthetic logs remain ignored locally. Required current test files all have
passing latest results. The completed broad coverage includes Stage 5, Stage 6,
v22/key continuity, lifecycle/concurrency, legacy WHOOP/reporting, localization
and Public Beta.

Static validation: 53 changed/new JS/MJS files pass Node --check; YAML and shell
syntax PASS; git diff --check PASS. Frozen schema, installed GitHub workflow,
package engine guard and lockfile remain unchanged from RC2.

## Repository, push, tag and production

Local implementation/test/artifact commits are created for this repair. The final
handoff supplies their exact commit/tree identities and clean-tree readback.
Local recovery branch: `recovery/vietnam-stage2-rc3` at the final commit.
Push: `NOT_PUSHED`. Tag: `NOT_CREATED`. Production mutation: `NONE`.
Proposed release candidate only: `v1.2-phase4-public-beta-rc3`.

Production facts are retained from the recovery audit, **not freshly verified**:
Render exact RC2, auto-deploy OFF, maintenance OFF, ingress open, SHADOW and
presentation OFF, allowlist empty. GitHub manually disabled, zero queued/running
jobs, exact RC2 pin, one combined job and Node 22. Cloudflare Worker
`whoop-briefing-scheduler`, active version `f78e3f69`, zero cron triggers/no recent
events; morning cron inactive. Turso v31, integrity OK/FK violations zero,
lookup/audit COMPLETE, Stage 6/locale tables present, LIVE zero, six pending SHADOW
jobs, attempts/leases/cursors/receipts/work tips/routes zero, pre-v31 backup
retained, Developer plan and overages ON.

Follow the future coordinated rollout/rollback order in
[`phase4-vietnam-stage2-rc3-rollout.md`](phase4-vietnam-stage2-rc3-rollout.md).
A recovery push is **not currently cleared**: the Architecture Owner must freshly
verify that Render auto-deploy is not linked to `recovery/vietnam-stage2-rc3` before
pushing that non-production branch. Do not push canonical branch or create tags
before release review.

## Settings v1

`DEFERRED_POST_LAUNCH`: FIRST post-launch UX patch after Public Beta stabilization:
`/settings` → Change Language (zh-TW/en/vi), Change Display Name; `/language` and
`/name` shortcuts.

## Review readiness and exact next action

`READY_FOR_VIETNAM_STAGE2_FULL_REPAIR_REVIEW`

`RETURN_TO_ARCHITECTURE_OWNER_FOR_VIETNAM_STAGE2_FULL_REPAIR_REVIEW`
