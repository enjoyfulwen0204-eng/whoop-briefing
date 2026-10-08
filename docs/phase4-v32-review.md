> Historical implementation report for rejected unpublished candidate 0a8597b.
> The independent v32 review found H01–H05, M01–M03 and L01. Its original test
> results remain evidence; acceptance claims are superseded by the review repair.

# Vietnam v32 settlement authority — implementation review

Implementation evidence, not release approval or production authorization.
Status: PHASE4_V32_SETTLEMENT_AUTHORITY_IMPLEMENTATION_COMPLETE.
READY_FOR_V32_SETTLEMENT_AUTHORITY_REVIEW.

## Identity and boundary

Started at 6eabd67ef3c99604db975014b3f65e13053f0fee, tree
c9d88cf5245665912198a52b92f9a3efae9127bd, clean v1.2-phase4. Upstream remains
origin/v1.2-phase4 at authoritative RC2 c364ea7a7586bcaafb3fccd66bc18a461643732c.
The ending commit/tree is reported after the local commit; this document belongs
to that candidate. Recovery branch recovery/vietnam-stage2-rc3 advances locally.
No push, tag, deployment, production migration/write, provider activation or
Telegram send occurred. No other Mac or unknown Taiwan state was used.

Proposed tag remains v1.2-phase4-public-beta-rc3, uncreated. RC1/RC2 remain
immutable. Allocation: v31 Localization; v32 Execution Settlement Authority;
v33 Stage 7; v34 Stage 8. Settings v1 remains DEFERRED_POST_LAUNCH.

## Architecture and schema

See [the controlling settlement contract](phase4-v32-settlement-authority.md).
Two tables: phase4_executions and phase4_execution_work_receipts. Two indexes
cover provider/phase creation order and unfinalized leases. Six triggers enforce
initial state, immutable identity, monotonic transitions/generation, finalization
authority, immutable receipts and receipt scope/generation. CHECK/FK contracts
bind the closed phase/source/mode/release/result state and parent SYNC identity.
There are 10 new objects in the 509-object canonical runtime contract.

ESTABLISHED → WORK_COMMITTED → FINALIZED_SUCCESS / FINALIZED_FAILURE; ABORTED
and COMMIT_INDETERMINATE observation remain distinct. Work mutations carry an
atomic receipt. The work-result transaction contains no success heartbeat or
handoff. Finalization is a separate database-clock owner/generation/result/release
CAS. Transport acknowledgement alone cannot authorize success. A fresh read
reconciles committed work or immutable finalized truth; no business callback is
blindly replayed. Cancellation after submitted COMMIT is not proof of rollback.

Durable finalized rows are completion authority; heartbeat projection is
recoverable and uses the immutable finalization timestamp. Handoff is deterministic
from finalized complete SYNC and the exact authenticated release/source/mode/config
identity. Unfinalized/indeterminate SYNC blocks both clients' dependent drain.
Diagnostics preserve committed progress and expiration, and an older reconciliation
cannot hide a newer pending invocation.

## Closure evidence

| Area | Accepted result |
| --- | --- |
| Async COMMIT | PASS: installed HTTP/Hrana driver with actual SQLite SQL; cancellation/deadline/lease expiry, definite constraint failure, lost ACK, work/finalization reconciliation, no duplicate success |
| Runtime/capability | PASS: private phase client, genuine native methods captured before application import, no prototype interception, copied/forged/serialized/wrong-client contexts, permanent close, replacement/fresh admission |
| External compatibility | PASS: complete fresh admission at privileged roots; retained original native methods cannot bypass schema verification; metadata helper cannot exempt tenant SQL |
| Stage 5 contention | PASS: exact historical stock-driver test; final frozen-source 20 consecutive runs, 40 cases; RC2 control 2/2; COMMIT BUSY retries one transaction/callback; two-process death/replacement proof |
| SYNC/drain and replay | PASS: typed required-resource failure, honest HTTP/job results, explicit phases, malformed GitHub rejection, actual SHA pin and signed handoff/conflict/retry identities |
| Ownership | PASS: original resource_locks model plus v32 generation CAS; real process takeover/death/stale finalization rejected |
| Worker | PASS: signing cancellation, stalled headers/body, slow/oversized/endless body, 16 KiB boundary, cleanup, timeout/late success, HTTP 207, indeterminate retry with no drain |
| Morning brief | PASS: OFF/OFF and SHADOW ON/presentation OFF; per-user/date dedupe, retry/indeterminate reconciliation, drain sends no ordinary brief |
| Backlog | PASS: 3 tenants, 6 jobs, 480 source-plus-USER passes; first 24 passes/0 completed jobs is PARTIAL; SIGKILL/restart/takeover, eventual 6 complete, no duplicate receipt/delivery or budget-induced repair |
| Presentation/localization | PASS: post-finalization ordering, zh-TW/en/vi, separate names/neutral missing name, no Kelvin fallback/cross-user data, currentness/privacy/allowlist/dedupe |
| Migration | PASS: narrow v31→v32, interruption/resume, repeated no-op, keys, old/future/corrupt schema, preserved health/key rows, integrity OK/FK zero, no Stage 7/8 tables |
| Product | PASS: focused/broad Stage 5/6, v22 repair/key continuity, no LIVE, Body Energy NOT_AUTHORIZED_NOT_PRESENTED |

Private phase transport supports file/HTTP. The installed WebSocket driver has
unobservable automatic replacement; phase execution fails closed for it. The
production libsql URL uses HTTP. Caller-owned compatibility contexts are never
a verification shortcut. Native SDK crash history is preserved below; final
accepted stability runs contain none. Physical cancellation of submitted remote
COMMIT is not claimed.

## Tests and original failure history

Node v22.23.2; npm 10.9.8; installed @libsql/client 0.15.15 / libsql 0.5.29.
The [complete evidence ledger](phase4-v32-tests.json) records exact files/case
names, raw-log SHA-256, measured fixtures, every attempt and corrected selection.
The [144-file manifest](phase4-v32-evidence/relevant-files.json) is reproducible
with the existing serialized test harness, or the three shard commands run
sequentially. Accepted selection: 1,296 pass; 0 fail/skip/cancel; 144 files PASS.
Final Stage 5 repetitions are separate: 20/20, 40 cases PASS. Exact RC2 control
passes both cases. No forced-success exits were used.

The initial complete 142-file sharded attempt remains recorded: 1,269 observed
cases, 1,239 pass, 30 fail; 14 assertion-failing file entries, 6 timed-out entries,
1 native SIGSEGV entry and 121 passing files. Partial timeout output is not a
completed pass. All 21 affected files subsequently passed serially under the
unchanged 600-second harness guard. The dense Stage 5 lifecycle rerun passed
4/4 in 387,654 ms; Stage 6 recurrence 23/23 in 407,592 ms.

Earlier v32 focused runs also remain visible: schema-version/protocol fixtures,
trigger-dependent column-drop construction, trigger-order expectation, tiny
deadline fixtures that failed to enter work, portable archive ENOBUFS, a genuine
abort-classification gap, WHOOP body cleanup after deadline, and historical-schema
diagnostic compatibility. Corrected reruns do not erase them. Original assertions
remain; explicitly superseded post-submission cancellation assertions are explained
in the contract and their original sources retained.

The preliminary Stage 5 20-run series was 19/20: repetition 8 had a native child
SIGSEGV after result exchange. It is not accepted as clean stability. Later clean
series and the final frozen-source series are separately recorded. The original
proactive-processing native SIGSEGV also remains; its unchanged serial rerun is
12/12. Fresh accepted runs have no EPERM, SIGSEGV or unintended harness timeout.
The intentional 1.5-second descendant-kill test expects TIMEOUT and passes.
The failed 20-minute lifecycle diagnostic and the interrupted/failed RC2 and v29
diagnostics remain historical tooling results, never accepted passes.

Prior Round 1/2 ledgers are unchanged. [Round 3 original probes](phase4-v32-evidence/round3/round3-evidence.json)
retain the v31 settlement blocker, pre-import attacks and contention failures.
The user-supplied independent Round 2 review reported 1,144/1,142 pass/2 fail,
including the fixture-key and Stage 5 failures. Earlier listener EPERM/SIGSEGV
history remains in the older ledgers. PyYAML/Node YAML availability failures were
tooling; Ruby Psych parses both workflows and bash -n checks their nine run blocks.
Final static checks passed: 533 JS/MJS files, two workflow YAML files, nine shell
run blocks, and git diff --check. The evidence-writer syntax was also rechecked.
The first staged diff check flagged original TAP whitespace; deterministic gzip
and decompression SHA-256 custody preserve it exactly while keeping source diffs
clean. No assertion was removed or output trimmed.

## Budgets and performance

| Authority / transport | Configured cap |
| --- | --- |
| Admission | 30,000 ms; transient contention retry ≤15,000 ms/64 retries, within original authority |
| SYNC work | CF/event 120,000 ms; GitHub/manual 180,000 ms |
| Drain work | CF/manual 45,000 ms; GitHub 90,000 ms; event 25,000 ms |
| Settlement | ≤15,000 ms inside original authority; ≥25 ms required before COMMIT submission |
| Overall phase | SYNC 165,000/225,000 ms; drain 90,000/135,000/70,000 ms |
| Cleanup | ≤15,000 ms inside remaining overall authority; no success grant |
| Worker attempt | SYNC 180,000 ms; drain 100,000 ms; 16,384-byte streamed response cap |
| Worker retries | 2 attempts/phase, 500 ms backoff each, explicit 561,000 ms invocation ceiling |
| GitHub | 10 minutes per job, deterministic npm ci and Node 22 |

The work clock remains a conservative submission guard in addition to the overall
clock. Neither a cleanup clock nor client timeout replaces successful phase
authority. Submitted DB requests may finish later; durable reconciliation handles
that uncertainty. Live provider invocation/cadence configuration requires readback
during the separately authorized rollout.

Fast admission remains exactly five read-only metadata queries on empty and
1,000-tenant/50,000-history fixtures at 0/20/50/150 ms per query. It performs no
DDL/DML/migration/checkpoint write or health scan. Full timings, including actual
HTTP lost-ACK settlement and reconciliation at each latency, are in the ledger.
The external-client fallback adds five queries per privileged boundary; the
normal private phase path does not. Remote and production: NOT_MEASURED.

| Added latency/query | Admission empty / populated | Lost-ACK attempt / reconciliation |
| --- | --- | --- |
| 0 ms | 23.90 / 20.02 ms | 210.83 / 363.70 ms |
| 20 ms | 183.44 / 130.78 ms | 534.21 / 702.96 ms |
| 50 ms | 295.26 / 298.36 ms | 1,060.37 / 1,201.30 ms |
| 150 ms | 804.23 / 800.73 ms | 2,627.02 / 2,843.91 ms |

The final production-like backlog's first bounded invocation took 563.28 ms,
processed 24 passes and completed zero jobs; 28 subsequent/resume loop iterations
converged to 480 passes and all six jobs. These are isolated synthetic fixtures.

## Rollout and rollback

The [future rollout](phase4-vietnam-stage2-rc3-rollout.md) requires current v31
backup/readiness, quiescence, original-key controlled v32 migration/postconditions,
server first OFF/OFF, exact SHA checks, disabled split workflow pins, compatible
Worker with cron OFF, controlled OFF/OFF then SHADOW/presentation OFF, finalized
sync/bounded progress proof, and only later cron/locale/allowlist/smoke.

Raw RC2 fails its exact migration/schema guard at v32. The prepared rollback
binary is this reviewed v32-capable candidate in RC2_V32_ROLLBACK profile with
OFF/OFF/empty allowlist. It preserves ordinary briefing and authenticated legacy
HTTP, admits no Shadow drain or presentation, and uses v32 durable settlement.
Stop incompatible clients first; retain v32, original keys, user data and receipts.
No schema downgrade or ordinary pre-v31 restore. Deployment review must pin/read
back that exact rollback binary.

Production facts are retained from recovery audit, not new live health checks:
RC2 live/schema v31, auto-deploy OFF, Beta OFF/OFF/empty allowlist, GitHub disabled,
Cloudflare zero triggers, original keys, six pending Shadow jobs and retained
pre-v31 backup. The missed brief remains explained by paused schedulers.

Exact next action: RETURN_TO_ARCHITECTURE_OWNER_FOR_V32_SETTLEMENT_AUTHORITY_REVIEW.
