# v32 final blocking repair — NEW-H01 and M01

PHASE4_V32_FINAL_BLOCKER_REPAIR_COMPLETE

Local implementation only. Production retains RC2/v31 and paused scheduling;
no new live verification or production mutation was performed. Retained audit
facts: exact RC2 live, schema v31, Beta OFF/OFF, GitHub manually disabled,
Cloudflare zero cron triggers, original lookup/audit keys retained and six pending
SHADOW jobs. The audit retained the verified pre-v31 backup; production backup
readiness for a future controlled v32 migration still requires fresh rollout checks.

## IDENTITY

Start HEAD: 52f8a231e9087c9dafa19c8dcdf874c861f5288e.
Start tree: d48ff805ffabac45541726986bdf6e3c2f590a0a.
Branch: v1.2-phase4. Upstream origin/v1.2-phase4 remains authoritative RC2
c364ea7a7586bcaafb3fccd66bc18a461643732c. Schema remains v32, repaired in place.
The final local commit/tree and clean working-tree read-back are returned in the
session response; recovery/vietnam-stage2-rc3 is fast-forwarded to that candidate.
RC1/RC2 remain immutable; RC3 uncreated/unpublished.

## NEW-H01 — CLOSED

The existing SQL transition trigger now requires OLD lease_until and deadline_at
strictly greater than databaseNowMs when ESTABLISHED→WORK_COMMITTED executes.
Owner/generation and authority clocks cannot be changed in that work transition.
Same-generation clock extension, including a separate expired-authority restamp,
also rejects. Immutable request constraints and application CAS remain intact.
Cleanup uses MIN and only decreases existing authority clocks.

Raw SQL after expiry is rejected at the database; no work result exists to adopt.
A fresh valid invocation executes legitimate business work once. Stale owner and
generation cannot update the row. Exact DB-time boundaries and deadline-only
expiry reject; deadline-valid/lease-expired is already prohibited by deadline<=lease.

Three installed HTTP/libsql/Hrana tests submit valid work before expiry and delay
COMMIT, acknowledgement, or lose acknowledgement beyond expiry. Durable work can
still reconcile under fresh matching authority without rerunning business work.
This preserves the approved non-retroactive COMMIT contract.

## M01 — CLOSED

Removed the declared-table/SQL-target trust heuristic and root-ordinal fallback.
Every accepted v32 business mutation belongs to an explicit deterministic root
unit. Generic unkeyed transactions reject before callback; read-only declarations,
identity preparation and replay cannot mutate. A swallowed work-contract failure
remains sticky and cannot finalize successful SYNC or generate a handoff.

Unit identity binds immutable execution/request scope, semantic operation and
stable tenant/item/window/cursor facts. Selected-item APIs identify the candidate
read-only under the same short transaction before assigning the key. Domain
operations use their canonical request envelope and retain existing dedupe.
Receipt lookup precedes callback; effect and receipt commit atomically. Complex
results reconstruct from existing domain receipts; no health payload is added to
v32 receipts. Replayed notification/delivery acquisition is not a fresh send grant.

SYNC windows read committed effect/fetch-count receipts before fetching again,
so a later retry clock cannot repeat the logical window. Stage 6 receipt-only
reconciliation finalizes metadata-only PARTIAL with zero new items, then later
bounded invocations resume durable cursors. Existing v31 leases use only four
fixed parameter-only coordination commands, accepting no caller SQL/table/callback;
this is infrastructure bookkeeping, never a generic business-write exemption.

The [complete caller inventory](phase4-v32-final-callers.json) records 173 source
call sites and the 119 closed API operations, including read-only, nested protected
and explicit non-business/non-phase paths. Unsupported unkeyed phase mutation is
rejected, not silently accepted.

## GENERIC EXACTLY-ONCE — PASS

Known-table counter: 1→2, one callback, one effect and one logical receipt after
lost COMMIT ACK, expiry, fresh admission and three retries. Never 1→2→3.
Two real processes race one step: combined callback count one, counter two,
one receipt; the loser re-admits and reconciles. Two distinct steps both execute.
Real SIGKILL after commit preserves one effect/receipt; replacement process runs
zero business callbacks and returns the stored deterministic result.

## SQL EXPIRY AUTHORITY — PASS

DB clock controls submission. Valid-before/late-ACK and expired-before-submission
are independent tests. No application-only expiry assertion substitutes for SQL.

## SYNC→DRAIN — PASS

Expired SQL, unkeyed mutation (including caught error), ESTABLISHED, unfinalized,
indeterminate, aborted and finalized failure cannot authorize drain. Only finalized
complete typed SYNC returns handoff. Release/source/mode/config binding remains.

## STAGE6 ACK LOSS — PASS

First/later checkpoint ACK-loss tests retain committed cursors and require
reconciliation before domain mapping. No false calculation failure, retry-wait,
partial success or failure finalization. Explicit checkpoint/family identities
compose with existing receipts and family isolation.

## STATE MACHINE — PASS

The existing terminal matrix is unchanged. Submission-time authority is an added
precondition for the legal ESTABLISHED→WORK_COMMITTED transition. Terminal rows
remain immutable, nonreplaceable and nonrevivable.

## MIGRATION — PASS

Controlled v31→v32, interruption/resume, no-op, keys, integrity/FK, row-hash
preservation, structural corruption and future-schema checks rerun. No historical
success fabricated, health rewrite, Stage 7/8 structures or LIVE. Runtime does not
migrate. The repaired SQL definition is canonical admission metadata.

## ROLLBACK — PASS

RC2_V32_ROLLBACK remains the v32-compatible OFF/OFF binary profile with normal
legacy ingress and morning behavior. Raw RC2 remains incompatible with v32;
no downgrade or original key change.

## STAGE5 CONTENTION — PASS

Twenty consecutive final candidate repetitions after the last shared source change:
20/20 pass (40 cases), no stale capability reuse, callback replay, timeout or native
crash. Original same-transaction COMMIT BUSY retry and fresh admission semantics
remain bounded. Two earlier 20/20 series are retained separately.

## BACKLOG / PROCESS DEATH — PASS

Three tenants, six jobs, 23/115/99 sources plus USER roots: 480 passes eventually,
bounded first invocation (24 items, zero jobs complete), real SIGKILL/restart,
no duplicate receipt/delivery, no LIVE and no repair from normal exhaustion.
Receipt-only reconciliation makes no new work claim. Final rerun: first invocation
859.6 ms, 29 repeated invocations to complete; no full-backlog-per-call requirement.

## MORNING BRIEF — PASS

OFF/OFF and SHADOW ON/presentation OFF remain eligible. Ordinary date/user dedupe,
retry and drain-emits-no-ordinary-brief tests pass. Paused schedulers remain the
explanation for previously missed production briefings.

## LOCALIZATION / PRESENTATION — PASS

zh-TW/en/vi, per-user names and neutral missing-name behavior preserved. No Kelvin
fallback, cross-user data or unfinalized producer publication. Presentation OFF
and allowlist/currentness/privacy/delivery gates remain.

## PRODUCT PRESERVATION — PASS

Stage 5/6 algorithms, source/family authority, ownership, key continuity, private
runtime/capability and split signed protocol preserved. Body Energy remains
NOT_AUTHORIZED_NOT_PRESENTED. No Settings, Stage 7/8 or LIVE implementation.

## PERFORMANCE

Focused fixture timings (ms), with injected latency per facade query:

| Latency | Receipt lookup (2) | Work-step establishment (7) | Expiry-enforced transition (2) | Reconciliation (2) |
|---|---|---|---|---|
| 0 ms | 8.8 | 14.4 | 9.8 | 13.8 |
| 20 ms | 53.4 | 167.1 | 53.4 | 58.7 |
| 50 ms | 114.3 | 376.5 | 113.9 | 119.0 |
| 150 ms | 323.3 | 1099.0 | 327.2 | 337.9 |

Facade counts exclude protocol-internal BEGIN/COMMIT/close. Admission remains five
read-only metadata queries, no DDL/DML/history scan. Empty versus 1,000 tenants/
50,000 history: local 23.3/20.2 ms, +20ms 188.2/130.3, +50ms 294.2/295.2,
+150ms 800.5/796.4. Receipt lookups use indexed identity, not health history.
No global lock table or lock across provider waits is introduced. Existing short
SQLite write transactions remain. No timeout policy was increased.
Production: NOT_MEASURED. Remote: NOT_MEASURED.

## TESTS

Node v22.23.2; npm 10.9.8. Exact files/cases, source snapshots, original attempts,
corrected reruns and final totals are in
[phase4-v32-final-tests.json](phase4-v32-final-tests.json). Failed TAP/control results
are kept in one [compact archive](phase4-v32-final-failures.json.gz).
The two independent pre-repair probes returned 0 pass / 2 fail. Raw TAP is preserved
in [phase4-v32-final-baseline.tap.gz](phase4-v32-final-baseline.tap.gz); the first
two-probe source is retained beside it.

The 61-file primary run returned 609 pass / 11 fail / 0 skip / 0 cancel out of
620 entries; two failures were native file entries. After corrected per-file reruns
and one additional localization bot-command test, accepted results are **62 files,
633 pass / 0 fail / 0 skip / 0 cancel**. The final shared-path reruns cover both
blockers, localization storage, currentness, typed presentation, ACK loss, morning
briefs, backlog and rollback. Stage 5 final repetition series adds 40 passing cases.
These totals describe selected completed per-file results, not a relabeled primary
run. Every invocation and exact accepted case name is in the linked ledger.

Two current-run native events remain recorded: analytics cycle2 passed its 9 cases
then exited with SIGSEGV; onboarding cycle1 passed 10 cases then exited with SIGSEGV
before completing the file. Unchanged isolated reruns passed 9/9 and 24/24. No
accepted test timeout or listener EPERM occurred. Previous native/EPERM history
remains unchanged. Static checks pass: 551 JS/MJS files, two YAML artifacts, nine
inline bash blocks and git diff --check.
Historical failures remain separate: earlier native SIGSEGV/EPERM and prior review
failures are unchanged in existing ledgers. This repair's intermediate failures
include the direct expired SQL/known-table bypass, a pending-owner fixture setup,
unkeyed positive fixture setup, and manifest/cancellation diagnostic declarations.
Assertions were retained; setup now declares legitimate stable units. The semantic
API wrapper now preserves the method receiver required by locale persistence. Two
old CLI-message expectations and one obsolete schema31 expectation also failed on
untouched 52f8a23 controls; corrected typed messages/schema32 keep exit, pre-network
ordering and no-migration assertions. Two mistakenly named test files produced
zero-case harness failures; actual files passed separately. A temporary
Python edit-script syntax error and incomplete-module import were tooling events,
not application passes. Corrected runs do not erase the originals.

## REPOSITORY CHANGES

Focused local code, two new test files, one real-process helper, five positive
fixture/legacy expectation corrections, caller inventory, contract/report and
compact evidence. No hundreds of new raw-log artifacts.
The exact local commit/tree is returned in the final session response.

## PUSH STATUS

NOT_PUSHED

## TAG STATUS

NOT_CREATED

## PRODUCTION MUTATION

NONE

## SCHEMA ALLOCATION

v31 Localization; v32 Execution Settlement Authority; v33 Stage 7; v34 Stage 8.

## RELEASE CANDIDATE

Proposed v1.2-phase4-public-beta-rc3, uncreated/unpublished. Candidate commit/tree
is the final local identity returned in the session response and recovery branch.

## SETTINGS V1

DEFERRED_POST_LAUNCH

## REVIEW READINESS

READY_FOR_FINAL_V32_BLOCKER_REREVIEW

## EXACT NEXT ACTION

RETURN_TO_SAME_REVIEW_V32_SETTLEMENT_AUTHORITY_SESSION
