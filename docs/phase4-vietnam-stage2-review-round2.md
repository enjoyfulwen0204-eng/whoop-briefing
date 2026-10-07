# Vietnam Stage 2 independent review repair — Round 2

This is the focused local repair of the six findings against reviewed/rejected
candidate `1577b1bec81b9f490c28b51b5ab6594d4d1537ad`, tree
`7b0e86b7f3cf7de258bc83d933b4d2f88c1b8d95`. Exact branch/upstream/clean-tree
identity and Node v22.23.2/npm 10.9.8 were verified before editing. Upstream remains
RC2 `c364ea7a7586bcaafb3fccd66bc18a461643732c`; schema remains v31.
No other Mac or unknown Taiwan state was used. The final handoff records ending
commit/tree identity after local commits and clean-tree readback.

## Six findings

| Independent finding | Repair |
| --- | --- |
| High — original deadline/cancellation dropped in settlement | Original whole-phase and work authority remain active through each settlement write, HMAC, heartbeat, outermost COMMIT and response serialization. Cleanup cannot authorize success. |
| High — capability resurrection | Private non-revivable lifetime tokens; supported driver close/reconnect methods are observed before callers retain them. Old tokens never become valid again. |
| Medium — malformed dispatch falls back to manual | Closed-set GitHub source mapping, independently checked at CLI and execution context. Unknown/missing/case-altered events fail with `GITHUB_SOURCE_UNSUPPORTED`. |
| Medium — missing release identity | Runtime determines actual loaded checkout HEAD. Exact SHA binds request, config proof, durable record and HMAC; drain independently checks its own actual SHA. |
| Medium — async signing loses cancellation | Attempt and caller authority cover WebCrypto. Checks before/after signing and a cancellation race prevent fetch after cancelled/expired signing. |
| Medium — normal-driver Stage 5 contention | Reconnect performs complete fresh read-only admission within the shared contention retry window and replaces server-factory capabilities; never revives the old object. |

Every original review failure was reproduced before application edits. Seven new
focused probes failed on the starting candidate; the unchanged real normal-driver
Stage 5 case failed too. An isolated exact-RC2 archive passes that normal-driver
case. Reproduction assertions remain in regression tests.

## Settlement authority

One whole-phase authority begins at invocation entry and covers release verification,
admission, work and successful settlement. The original AbortSignal reaches all
sub-clocks. The original work clock is also retained through successful settlement;
it cannot be replaced with a fresh success clock. The fifteen-second settlement
clock is only a cap inside original authority.

The helper checks authority before and after async settlement boundaries, after
handoff generation, before heartbeat, before release, and immediately before the
outermost COMMIT. Backend lease expiry is rechecked at final release and COMMIT;
conditional release must affect exactly this owner’s live lease. Nested transactions retain synchronous commit authority. Success
serialization is checked under original authority. Request owner/generation and
unexpired lease are verified in the atomic write transaction; owner-checked release
cannot release a successor. Original expiry/cancellation or lost ownership yields
an unsuccessful response, no handoff and no successful completion evidence.
Failure cleanup, when overall time remains, may record only FAILED/TIMEOUT/CANCELLED
under bounded cleanup authority and the same ownership/identity checks.

Tests cover expiry in admission and work; expiry after work/during settlement;
cancellation before request/heartbeat writes; cancellation and expiry inside HMAC;
owner-generation loss; nested outermost COMMIT; and normal valid success. Stage 6
NO_WORK, PARTIAL and COMPLETE cancellation cases remain aborted; retained aggregate
counts describe completed durable progress and never convert cancelled settlement
into COMPLETE/NO_WORK.

No physical termination of uncancelable provider/driver work is claimed. Existing
server cancellation and durable write/commit fencing remain; ambiguous settlement
cannot authorize drain.

## Capability lifetime and contention

A capability binds exact executor, transaction kernel, original keys and a private
lifetime object. Close irreversibly revokes that object; reconnect creates another
lifetime and requires full fresh admission. The public `closed` flag cannot restore
private authority. Observing a closed client also irreversibly revokes its token.
Tests cover facade, raw, underlying, retained and prototype paths; real SQLite,
HTTP and WebSocket driver lifecycle methods; forged/copied/serialized objects;
other connections; mutable closed flag; reopening; and altered schema while closed.

The kernel's bounded idle reconnect path obtains a new capability only after all
five canonical checks pass. Already-authorized live server factories receive that
new capability; the old object remains rejected. Root callbacks are not replayed
for BEGIN/COMMIT contention. No active transaction is reconnected. Re-admission
metadata contention shares the original fifteen-second retry window. Historical
v27–v30 factory assertions remain separate.

The actual supported normal libsql driver, in two OS processes, proves equivalent
requests replay one durable result, exactly one receipt/evidence family, all
completed leases released, fresh admission after reconnect, stale capability
rejection and zero migration DDL during recovery. Owned/mock fixtures do not
substitute for this regression.

## Release, dispatch and replay

`runningReleaseSha()` executes only fixed local `git rev-parse --verify
HEAD^{commit}` from the loaded module's repository, with a two-second guard and
Git override environment removed. Caller cwd, request SHA and provider pin cannot
substitute for actual checkout identity. GitHub requires an expected
`PHASE4_RELEASE_SHA`; every supplied provider/build pin must equal actual HEAD.
Missing/unverifiable/malformed identity fails closed. Deployments must retain
verifiable checkout metadata.

The exact forty-character commit SHA is included in request identity, release-bound
configuration HMAC, durable outcome/heartbeat and sync handoff HMAC. Drain checks
stored SHA against request SHA and its own independently determined actual HEAD.
Identical code trees at different commits are rejected. The real CLI fixture makes
an empty second Git commit and proves its drain cannot consume the first commit's
handoff. Same-release sync/drain, missing/malformed/tampered SHA, wrong expected pin
and release-bound proof differences are covered.

Only GitHub `schedule` → `github` and `workflow_dispatch` → `manual` are accepted.
Missing, empty, typo, push, pull_request, repository_dispatch, arbitrary strings and
wrong casing reject. Partial GitHub context cannot fall back to local manual.
Source remains bound through request/handoff, context, policy and heartbeat.
Existing signed phase substitution, conflicting pending/completed IDs and exact
idempotent retries remain covered.

Both future workflow jobs retain the same immutable reviewed pin, explicitly
verify actual checkout HEAD before install and export that pin to runtime for
independent verification. Installed `.github/workflows/briefing.yml` is unchanged.

## Cloudflare transport and budget model

WebCrypto may finish physically after cancellation; its result is gated and ignored.
Signing is inside the original attempt timer, with checks before/after it and before
fetch. Caller abort and absolute deadline survive through headers/body. Late signing
never starts fetch. Response cleanup also cancels a body when deadline expires
between headers and reader acquisition. No timeout was increased.

| Source | Admission/claim cap | Work cap SYNC / drain | Settlement cap | Authoritative whole-phase SYNC / drain |
| --- | ---: | ---: | ---: | ---: |
| Cloudflare | 30 s | 120 / 45 s | 15 s | 165 / 90 s |
| GitHub schedule | 30 s | 180 / 90 s | 15 s | 225 / 135 s |
| workflow_dispatch / manual | 30 s | 180 / 45 s | 15 s | 225 / 90 s |
| Event | 30 s | 120 / 25 s | 15 s | 165 / 70 s |

Whole-phase authority is one clock. Sub-clocks cannot extend it; original work
expiry also prevents successful settlement. Tests may reduce budgets, never
increase production source limits. Stage 6 worker wall/work-stop remains 45/30 s
Cloudflare/manual, 90/75 s GitHub, 25/10 s event, with original job/item/tenant/lease
limits. A drain does not require full backlog completion.

Worker client attempts: 180 s SYNC, 100 s drain, including signing, connection,
headers, body streaming and cleanup; max two attempts per phase. Retry/backoff total
and whole Worker invocation cap: 561 s, within the future 600 s cadence with 39 s
margin. Server maxima leave 15 s / 10 s client transport margins. GitHub has a
separate 600 s guard per job including checkout/install; it is not the server work
clock. Cloudflare provider maximum wall time is not used as safety authority.
16 KiB cap, exact boundary/overflow, endless and slow-drip bodies, headers/body
stalls, abort, late success, failed sync, HTTP 207 and retries remain covered.

## Preserved product and runtime contracts

Fresh structural admission still derives the full 499-object canonical contract,
with five read-only queries and all previous negative controls. No DDL/DML or
historical migration replay occurs on admission/re-admission. Cross-process sync
fencing, morning brief continuity, backlog/process death, typed Stage 6 outcomes,
signed replay, localization and Public Beta gates remain covered.

OFF/OFF and SHADOW ON/presentation OFF preserve eligible ordinary morning briefs;
Beta Summary stays OFF, date/retry dedupe holds and drain emits no ordinary brief.
The three-tenant/six-job fixture retains 24-pass first PARTIAL progress, zero initial
completed jobs, real kill/restart and eventual 480 passes/six completed jobs without
duplicate receipt/delivery. Presentation remains after drain, typed current-state
and recipient/privacy gates intact; zh-TW/en/vi, neutral missing names, no Kelvin
fallback and cross-user isolation remain covered.

Schema stays v31, original keys retained, no LIVE; Body Energy remains
`NOT_AUTHORIZED_NOT_PRESENTED`. No Settings v1, Stage 7/8 or other deferred features.
Settings remains `DEFERRED_POST_LAUNCH`: first UX patch after stabilization,
`/settings` language/name with `/language` and `/name` shortcuts.

## Tests and performance evidence

Final exact files/cases, accepted totals, timings, source/log hashes and every
Round 2 attempt are recorded in
[phase4-vietnam-stage2-round2-tests.json](phase4-vietnam-stage2-round2-tests.json).
Original first-round failure history is retained unchanged in
[phase4-vietnam-stage2-tests.json](phase4-vietnam-stage2-tests.json). Independent
review's listener EPERM, fixture-key omission, Stage 5 failure and SIGSEGV entry
are retained as reported; external raw logs were not supplied.

Round 2 additionally records its pre-fix failures, an initial driver-proxy invariant
error, admission contention during reconnect, an async-reconnect fixture needing
await, source-boundary/clock-fixture corrections, body cleanup timing failure,
listener EPERM followed by authorized loopback reruns, process-inventory
EPERM, and a sync fixture native SIGSEGV after all fifteen assertions passed.
The sync fixture now owns its SQLite connection and awaits cleanup; assertions
remain unchanged. Corrected reruns do not erase those results. No forced-success exit is used.
The harness serializes explicit per-file child processes with 300/600 s guards.

Admission measurements include local and 20/50/150 ms per-query injection, both
empty and populated with 100 synthetic tenants/10,000 history rows. Query count
remains five and contains no tenant/history scan. Exact final measurements are in
the ledger. Production and remote timing: `NOT_MEASURED`.

## Repository and production boundaries

Coherent LOCAL repair commit(s) and their exact ending tree are supplied in the
final handoff after all required checks. Push `NOT_PUSHED`; tag `NOT_CREATED`;
production mutation `NONE`. Proposed release remains
`v1.2-phase4-public-beta-rc3`; no release/tag has been created.

Current production facts remain the recovery-audit baseline, not freshly verified:
Render exact RC2, auto-deploy OFF, SHADOW/presentation OFF, empty allowlist,
maintenance OFF and ingress open; GitHub manually disabled with zero active jobs
and exact RC2 combined-job pin/Node 22; Cloudflare `f78e3f69`, zero cron triggers;
Turso v31, integrity OK/FK zero, authority COMPLETE, six pending SHADOW jobs and
zero LIVE/attempts/leases/cursors/receipts/work tips/routes. Backup retained,
Developer plan and overages ON. No new live health checks are claimed.

Future coordinated release and rollback are in
[phase4-vietnam-stage2-rc3-rollout.md](phase4-vietnam-stage2-rc3-rollout.md): approved
exact commit first, compatible server OFF/OFF, disabled split clients with verified
actual SHA, Worker cron OFF, controlled validation/progress, scheduling later.
Rollback disables incompatible clients first, restores RC2-compatible execution
and Render RC2 OFF/OFF, retains v31/keys/data and performs no DB downgrade or
ordinary pre-v31 backup restore.

## Final accepted result and handoff

`PHASE4_VIETNAM_STAGE2_REVIEW_REPAIR_COMPLETE`

All six findings: **CLOSED**. Final accepted results: **535 passed across 66 files,
zero failed, zero skipped, zero cancelled**. The broad 44-file run completed with
four failing file entries (source-boundary assertion, sync native SIGSEGV, WHOOP
listener EPERM and rollback listener EPERM); their corrected/authorized reruns
are retained separately and pass. No broad or failed run is relabeled as green.
The last helper lease-expiry reproduction initially failed, then passes with the
final ownership-time fence; its assertion remains in the eleven settlement cases.

JS syntax: 32 files PASS. YAML, both checkout checks/pin exports, all embedded
shell syntax and git diff --check PASS. Frozen schema, original key code, installed
GitHub workflow, Node engine guard and lockfile remain unchanged from RC2.

| Admission fixture | Local | +20 ms/query | +50 ms/query | +150 ms/query | Queries |
| --- | ---: | ---: | ---: | ---: | ---: |
| Empty | 21.38 ms | 180.98 ms | 279.81 ms | 776.80 ms | 5 |
| 100 tenants / 10,000 history rows | 19.25 ms | 128.09 ms | 279.50 ms | 779.29 ms | 5 |

Final phase fixture with 10 ms/query: SYNC/drain exact timings are in the ledger;
production and remote remain NOT_MEASURED. These fixtures are not live completion
forecasts. Admission cost remains independent of tenant/history volume.

The local recovery branch remains non-production and unpushed. The final handoff
records its pointer and local commit/tree; RC1/RC2 remain immutable. No push or tag
is authorized in this session.

`READY_TO_RETURN_TO_VIETNAM_STAGE2_FULL_REPAIR_REVIEW`

`RETURN_TO_SAME_REVIEW_VIETNAM_STAGE2_FULL_REPAIR_SESSION`
