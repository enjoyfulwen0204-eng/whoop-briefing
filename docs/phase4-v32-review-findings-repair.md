# v32 Settlement Authority Review Findings Repair

PHASE4_V32_REVIEW_FINDINGS_REPAIR_COMPLETE

This repairs the unpublished v32 design in place. All nine findings are CLOSED.
Acceptance is 1,339 passing cases across 151 files, plus 20 consecutive Stage 5
normal-driver repetitions. The original frozen-code broad run includes one native
SIGSEGV after all six migration assertions passed; its unchanged isolated rerun
passed. Both results remain in the evidence. No production operation occurred.

## IDENTITY

- Start HEAD: `0a8597b555b37a3945c7451d3bd7cca590809547`.
- Start tree: `9e90349be7c816bd56894c41c3a43764b5bb6a36`.
- Branch: `v1.2-phase4`.
- Upstream: `origin/v1.2-phase4`, authoritative RC2 `c364ea7a7586bcaafb3fccd66bc18a461643732c`.
- Candidate schema: exact v32, repaired in place; production retained v31.
- The enclosing local candidate commit/tree is the final identity; exact read-back
  HEAD/tree and clean working-tree status are returned in the session response.
- Local recovery branch: `recovery/vietnam-stage2-rc3`, to be fast-forwarded to
  the same final candidate. RC1/RC2 unchanged; RC3 uncreated.

## FINDINGS

| Finding | Status | Repair and independent proof |
|---|---|---|
| H01 aborted authority | CLOSED | SQL terminal-state matrix; receipt-backed ESTABLISHED is reconciled, never revived from ABORTED. All 25 state pairs tested. |
| H02 finalized replacement | CLOSED | Duplicate-ID/ordinal BEFORE INSERT guard rejects REPLACE even with recursive triggers OFF; DELETE forbidden; explicit CAS only. INSERT/IGNORE/REPLACE/UPSERT/UPDATE/DELETE probes pass. |
| H03 ambiguity reconciliation | CLOSED | Shared read-only reconciliation classifier and sticky execution-context ambiguity; domain mapping follows it. Swallowed errors, first/second Stage 6 checkpoint ACK loss and sync business ACK loss cannot grant success. |
| H04 finalized producing currentness | CLOSED | Additive producing-execution bindings with tenant HMAC, generation and ordinal; every contributor must finalize successfully before currentness. Later NO_WORK cannot launder prior work. |
| H05 controlled migration only | CLOSED | Removed admin/preflight/authorize startup migrations; all application entrypoints reject old schema. Only the controlled operator/argument-preserving alias can migrate. |
| M01 deterministic receipt | CLOSED | Named generic work steps bind immutable request/scope/kind/business identity; receipt lookup precedes callback and commits atomically with effect. Generic exactly-once real-driver/process tests pass. |
| M02 immutable request match | CLOSED | Full canonical request, raw authenticated-body identity, scope and owner/generation checked before result persistence, including handoff and legacy body digest. Rejected calls leave valid retry intact. |
| M03 monotonic execution ordering | CLOSED | Immutable AUTOINCREMENT execution_seq, ordinal regression guard and indexed progress selection. Same-millisecond, older-late-finalization, two-process allocation and allocation death pass. |
| L01 indeterminate logging | CLOSED | COMMIT_INDETERMINATE and distinct unfinalized/finalized operational outcomes are accepted by the safe logger. Counts/hashes only; no secret or health payload. |

The nine independent tests all failed before fixes on the unchanged rejected
candidate; preserved [original source/TAP custody](phase4-v32-review-evidence/reproduction-custody.json).
All nine pass on the repaired candidate. No assertion was weakened to hide a
failure. Positive presentation fixtures now establish real finalized producing
execution authority; stale-owner fixtures now expire leases before legal takeover.

## V32 STATE MACHINE — PASS

Rows are old states; columns are requested states. Y remains subject to immutable
identity, owner/generation CAS, result, database-clock lease/deadline constraints.
Terminal rows permit no UPDATE, even to their own state. No projection is stored
by mutating terminal authority.

| From / to | ESTABLISHED | WORK_COMMITTED | FINALIZED_SUCCESS | FINALIZED_FAILURE | ABORTED |
|---|---|---|---|---|---|
| ESTABLISHED | Y | Y | N | N | Y, no committed receipt |
| WORK_COMMITTED | N | Y | Y | Y | N |
| FINALIZED_SUCCESS | N | N | N | N | N |
| FINALIZED_FAILURE | N | N | N | N | N |
| ABORTED | N | N | N | N | N |

New rows start ESTABLISHED/generation one only. ESTABLISHED takeover requires
expired lease and increments generation exactly once with a new owner. A
WORK_COMMITTED takeover retains immutable result bytes/digest. No terminal
owner/generation reset is legal. ABORTED retries require a new execution ID.
An ESTABLISHED execution with durable receipts cannot be aborted: it remains
explicitly reconcilable. An ambiguous observation is orthogonal to durable state.

Final v32 contains three tables (`phase4_executions`,
`phase4_execution_work_receipts`, `phase4_execution_producers`), two explicit
indexes and sixteen triggers: 21 canonical objects. Whole runtime contract has
520 canonical objects. The authority checkpoint is `phase4-execution-v2`.

## GENERIC EXACTLY-ONCE RECONCILIATION — PASS

`transaction(callback, {workStep})` requires a stable server-chosen logical
operation identity for generic/custom-state mutations. Its deterministic receipt
binds canonical scope and immutable authenticated request, hence release, phase,
source, mode and config. It excludes random nonce, wall clock, PID and retry
owner/generation. Different work steps differ; same retry finds the same receipt
before callback. Receipt and effect commit atomically. Returned receipt data is
only an optional finite scalar count, boolean or opaque 64-hex hash; unsafe
payloads roll back. Unkeyed generic mutation fails before DML.

Definite rollback leaves no effect or receipt. Lost ACK, expiry, repeated retry,
real SIGKILL after commit, and two real OS processes racing one expired named
step leave exactly one counter effect and one receipt. Reviewed health domains
retain deterministic object receipts/cursors; their root progress ordinal is not
used as generic business dedupe. Private-runtime replacement requires fresh
admission and reconciliation, never revival of stale capability.

`reconcileExecution` validates complete immutable request, receipt scope/digest/
generation and sanitized result digest, then returns NOT_COMMITTED,
WORK_COMMITTED_UNFINALIZED, FINALIZED_SUCCESS, FINALIZED_FAILURE or ABORTED.
Corruption/mismatch raises a typed error. Domain handlers cannot consume raw
COMMIT ambiguity as calculation failure or retry-wait. Original cancellation is
authoritative before submission; after submission it is not proof of rollback.
Immediate uncertain callers return non-success without handoff. A later fresh,
matching authenticated invocation reads durable truth and finalizes idempotently.

An already committed drain can reconcile after its parent handoff ages out only
under the same complete request/release/config/source authority and fresh owner/
deadline. WORK_COMMITTED skips business work; receipt-only ESTABLISHED records
PARTIAL/RECONCILIATION_ONLY with historical receipts and zero new items. It performs
no new discovery/drain/presentation and never fabricates complete backlog state.
New or receipt-absent work still requires the fresh age-bounded parent handoff.

## SYNC→DRAIN — PASS

Only FINALIZED_SUCCESS plus complete typed SYNC produces the deterministic HMAC
handoff. Actual checkout SHA, source, mode, cohort/config proof and authenticated
request are bound and independently checked by drain. A lost business COMMIT ACK,
receipt-only/unfinalized state, failed producer or corrupt identity cannot produce
syncComplete=true, drainAuthorized=true or handoff. Reconciled final success can
reproduce the same handoff. Signed conflicting requests still reject. Valid
workflow_dispatch remains manual; schedule remains GitHub scheduled; unknown
sources fail closed. Both reviewed jobs keep Node 22, npm ci and ten-minute guards.
No live workflow or Worker was edited or enabled.

## STAGE6 ACK LOSS — PASS

Real supported HTTP/libsql transport tests lose ACK at the first and second
actual worker checkpoints. The invocation returns 503 COMMIT_INDETERMINATE;
committed cursors/progress survive. It does not enter CALCULATION_FAILED or
RETRY_WAIT, falsely finalize failure, return successful PARTIAL, or continue
settlement as success. Sticky context prevents a swallowed error from bypassing
this rule. Repeated lost ACK and finalization ACK loss use the same canonical
reconciliation path. Business receipts prevent duplicate effects.

## CURRENTNESS / PRESENTATION — PASS

Every v32 Stage 6 contributor records producing execution ID, generation,
immutable ordinal, tenant input generation and keyed tenant proof. Currentness
requires the completed input generation and every contributor FINALIZED_SUCCESS.
Unfinalized/failed/missing/forged/cross-user producers withhold presentation.
An unrelated later NO_WORK is not a producer. Older late finalization cannot
outrank a newer pending producer. Reconciliation can make committed progress
eligible without erasing/replaying it. Retained old facades read durable schema
version so they cannot bypass the new gate after migration.

Success heartbeat projection occurs after durable finalization, carries identity/
ordinal and is never the sole authority. Projection failure is reconstructible.
Watchdog/progress selects execution_seq, distinguishes pending, durable progress,
indeterminate, partial/full finalized and aborted states, and does not treat
unfinalized progress as silence or success.

## MIGRATION ENTRYPOINT CONTROL — PASS

Complete [source/test caller inventory](phase4-v32-review-migration-inventory.json)
records each source call and line, all executable/alias classifications and 152
isolated fixture caller files. All entrypoints below have no implicit migration.

| Entrypoint | Classification | Auto-migration |
|---|---|---|
| `scripts/authorize.js` | RUNTIME | No |
| `scripts/probe-fields.js` | RUNTIME | No |
| `scripts/pickUser.js` | LIBRARY_ONLY | No |
| `scripts/sync.js` | RUNTIME | No |
| `scripts/whoop-webhook.js` | READ_ONLY or RUNTIME by explicit command | No |
| `scripts/phase4-run.js` | RUNTIME | No |
| `scripts/health-status.js` | READ_ONLY; explicit legacy-read-only optional | No |
| `scripts/analytics.js` | READ_ONLY or RUNTIME by explicit command | No |
| `scripts/phase0-status.js` | READ_ONLY; explicit legacy-read-only optional | No |
| `scripts/preflight.js` | RUNTIME | No |
| `scripts/migrate.js` | CONTROLLED_MIGRATION | No |
| `scripts/reconcile.js` | READ_ONLY or RUNTIME by explicit command | No |
| `scripts/admin.js` | READ_ONLY or RUNTIME by explicit command | No |
| `scripts/telegram-webhook.js` | PROVIDER_ADMIN; no database/schema access | No |
| `scripts/dry-run.js` | OFFLINE_FIXTURE | No |
| `scripts/phase4-migrate.js` | CONTROLLED_MIGRATION | No |
| `src/index.js` | RUNTIME | No |
| `src/bot/index.js` | RUNTIME | No |
| `src/bot/webhook.js` | RUNTIME | No |
| `scripts/test-stage5-closure.mjs` | OFFLINE_TEST_HARNESS; child migrations only in isolated test fixtures | No |
| `scripts/test-v32-evidence.mjs` | OFFLINE_TEST_HARNESS; child migrations only in isolated test fixtures | No |
| `scripts/test-v32-review-evidence.mjs` | OFFLINE_TEST_HARNESS; child migrations only in isolated test fixtures | No |
| `scripts/test-v32-review-shards.mjs` | OFFLINE_TEST_HARNESS; child migrations only in isolated test fixtures | No |
| `scripts/test-v32-shard.mjs` | OFFLINE_TEST_HARNESS; child migrations only in isolated test fixtures | No |
| `scripts/test-v32-stage5-stability.mjs` | OFFLINE_TEST_HARNESS; child migrations only in isolated test fixtures | No |
| `cloudflare/briefing-scheduler/worker.js` | RUNTIME_TRANSPORT; no database/schema access | No |
| `src/publicBetaEntry.js` | RUNTIME; callable entry uses fresh admission, no auto migration | No |

Actual production-capable migration calls are only `scripts/phase4-migrate.js`
lines 102 and 110. `scripts/migrate.js` preserves arguments into that reviewed
main. Library forwarding calls are `src/db.js:647`, `src/migrations.js:109` and
`:203`; definitions are not entrypoints. There is no application startup caller.
Test-only `migrate()` calls construct isolated fixtures and are inventoried.

The controlled tool requires explicit --preflight/--apply and --expected-target,
Node 22, original lookup/audit keys and target version. Production additionally
requires the exact approved host/token, clean exact expected commit and explicit
apply confirmation. Backup and writer quiescence are separately controlled.
Normal v31 commands return CONTROLLED_MIGRATION_REQUIRED without changing schema,
rows or checkpoints; future schema rejects. Explicit legacy-read-only diagnostics
never upgrade. v32 read/admin commands retain behavior without mutation.

## V31→V32 MIGRATION — PASS

Fourteen migration cases cover clean upgrade, interrupted DDL/checkpoint/version
resume, repeat no-op, wrong lookup/audit, missing keys, v31 runtime rejection,
v32 corruption/future v33 rejection, preserved health/user row hashes, integrity
OK/FK zero, empty execution authority and no fabricated historical success.
Canonical admission validates the repaired final v32 including sequence, receipts,
producer constraints and triggers. No historical backfill, original key change,
Stage 7/8 structure or LIVE activation occurs. Already-rejected unpublished v32
fixtures need reconstruction from v31; this is not a production upgrade from the
rejected v32 candidate.

## RC2/V32 ROLLBACK — PASS

Raw RC2 rejects v32 and must not be deployed against it. Rollback uses the exact
reviewed v32-compatible candidate binary with
PHASE4_EXECUTION_PROFILE=RC2_V32_ROLLBACK, Beta OFF/OFF and empty allowlist.
It accepts normal legacy authenticated ingress and preserves ordinary sync/
briefing, fresh v32 admission and durable settlement. No split-phase Beta demand,
Shadow drain, presentation, automatic migration or schema downgrade. Stop
incompatible clients first; preserve v32, original keys and user/business receipts.

## STAGE5 / OWNERSHIP — PASS

Unchanged business assertions: RC2 control 2/2 pass; final candidate 20 consecutive
normal-driver runs, 40/40 cases, all code zero and no signals/timeouts. Focused
real-driver COMMIT BUSY, metadata admission contention, connection replacement,
ambiguous COMMIT and real-process death/competition pass. HTTP lazy BEGIN is
acknowledged before callback so genuine setup contention can retry without effect;
explicit COMMIT BUSY retries the same transaction under the original bounded
budget, not business replay. Admission remains complete on every replacement.
Cross-process resource_locks ownership, lease takeover, stale settlement fencing
and real client-abort/old-server-running tests remain green. No transaction spans
external HTTP waits. No global busy-timeout inflation or timeout increase.

## MORNING BRIEF — PASS

Ordinary OFF/OFF scheduled brief and SHADOW ON/presentation OFF brief still run.
Beta Summary remains separately OFF. Once-per-user/date and retry/reconciliation
dedupe hold; Stage 6 drain emits no ordinary brief. Indeterminate SYNC cannot
blindly duplicate delivery. The production missed brief remains explained by
paused GitHub/Cloudflare schedulers, not a newly proven renderer defect.

## BACKLOG / PROCESS DEATH — PASS

Three tenants, six jobs, 23/115/99 source items plus USER roots: 480 total passes.
First invocation: 24 processed, zero jobs completed, PARTIAL, six remaining,
401.6 ms. Real SIGKILL preserves committed cursor/receipt and unfinalized progress;
restart honors lease then takes over with new generation. Stale finalization is
rejected. Twenty-eight bounded iterations complete all six jobs, zero remaining,
no duplicate operation receipt or delivery, no LIVE and no REPAIR_REQUIRED from
normal budget exhaustion. Checkpoint ACK-loss and producer-finalization gate are
also tested independently with actual SQL/HTTP transport.

## LOCALIZATION / PRESENTATION — PASS

zh-TW, en and vi pass with isolated per-user display names, neutral missing-name
behavior, no Kelvin fallback and no cross-user data. Presentation OFF and allowlist
isolation hold. Freshness/privacy/recipient/delivery-dedupe gates remain. Partial
or unfinalized producer state is withheld rather than mislabeled current.

## PRODUCT PRESERVATION — PASS

Stage 5/6 algorithms, authority/fairness/family isolation, retry/cursors, original
lookup/audit key continuity, v22 linkage repair, localization and Public Beta
policy remain. Body Energy is NOT_AUTHORIZED_NOT_PRESENTED. No LIVE, Settings,
Stage 7/8, Quick Actions, TRUSTED_REGISTRY or Owner/Family View implementation.

## PERFORMANCE

Final measured fixture timings in milliseconds (single controlled samples;
provider performance is not inferred from local measurements):

| Injected latency per query | Admission empty / 1,000 tenants + 50,000 history | Receipt lookup (2 queries) | Sequence allocation (3) | Definite settlement (5) | Finalized reconciliation (2) |
|---|---|---|---|---|---|
| 0 ms | 15.2 / 13.2 | 8.6 | 13.5 | 20.4 | 8.5 |
| 20 ms | 155.6 / 127.1 | 78.1 | 75.2 | 171.3 | 61.7 |
| 50 ms | 296.7 / 297.5 | 134.8 | 222.0 | 336.4 | 136.5 |
| 150 ms | 802.1 / 803.5 | 343.1 | 483.1 | 839.2 | 336.2 |

Admission is exactly five metadata queries, no DDL/DML, checkpoint initialization,
health-history scan or migration. Query count does not change with data volume.
Caller-owned compatibility boundaries still pay five fresh verification queries;
normal top-level private phase performs one fresh admission. The lost-ACK HTTP
phase/next-reconciliation fixture uses 39 transport requests, nine more than the
previous candidate measurement due to BEGIN acknowledgement/identity verification.
Attempt/reconciliation times at 0/20/50/150 ms: 145.2/239.7, 650.2/732.1,
1345.1/1401.5, 3499.7/3457.4 ms. Empty-cohort phase with 10 ms/query:
SYNC 756.8 ms (29 queries); drain 858.0 ms (34). These are not cohort-throughput
or production benchmarks. Remote: NOT_MEASURED. Production: NOT_MEASURED.

| Budget | Exact configured policy |
|---|---|
| Admission | 30 s |
| SYNC work | Cloudflare/event 120 s; GitHub/manual 180 s |
| Drain work | Cloudflare/manual 45 s; GitHub 90 s; event 25 s |
| Settlement sub-budget | ≤15 s inside original work/overall authority |
| Whole phase | SYNC 165/225 s; drain 90/135/70 s for the sources above |
| Cleanup | ≤15 s within remaining overall budget; grants no success |
| COMMIT submission | At least 25 ms remaining; not a remote-completion guarantee |
| Worker attempt | SYNC 180 s / drain 100 s; max two attempts each |
| Worker retry/backoff total | 561 s combined configured window, 500 ms backoff per phase |
| Worker body | 16 KiB streamed cap; header/body/signing/cleanup cancellation |
| GitHub | 10 min per job |
| Future Cloudflare cadence | 15 min; current retained cron count zero |

No budget changed to hide a cancellation/commit defect. Before submission original
signals/deadlines/ownership prevent settlement; after submitted COMMIT, indeterminate
truth is reconciled rather than falsely described as rollback.

## TESTS

Node v22.23.2; npm 10.9.8; unchanged supported @libsql/client 0.15.15/libsql 0.5.29.
[151 exact accepted files and case titles, all attempts and hashes](phase4-v32-review-tests.json).
[Serialized raw TAP archives and SHA-256 custody](phase4-v32-review-evidence/log-custody.json).
No forced-success exits or assertions deleted.

- Frozen-code primary broad: 151 files, 1,340 TAP entries, 1,339 pass, one native
  failed-file entry from migration.test.js SIGSEGV after its six cases passed.
- Unchanged isolated correction: migration.test.js 6/6 pass, code zero, no signal.
- Accepted selection: 151 files, 1,339 cases PASS; fail/skip/cancel zero; zero
  substantive application failures and zero unresolved contention failures.
- Final stability: additional 20/20 repetitions, 40/40 cases; RC2 control 2/2.
- JS syntax: 540 files PASS; YAML: both reviewed/local workflow artifacts PASS;
  shell syntax: all nine inline workflow blocks PASS; git diff --check PASS.

New focused files: phase4-v32-review-findings (9), authority (5, includes exhaustive
matrix), generic (6), currentness (3), entrypoints (15), ACK loss (2), performance
(1). Re-run v32 settlement (18), migration (14), runtime (7), contention/process,
Stage 5/6, sync/ownership, scheduler, replay, signing/body transport, morning,
localization, typed/presentation, v22/key continuity and rollback, as itemized in
the ledger. All test DBs and provider transports are synthetic/isolated.

### Historical failures retained separately

The nine pre-fix independent reproductions are 0 pass/9 fail on start HEAD.
Intermediate rejected runs include: retained old facade currentness bypass;
illegal live-owner takeover fixture; fabricated copied execution ordinal fixture;
positive typed presentation without a finalized producer; HTTP lazy BEGIN BUSY
in two-process generic tests; missing typed entrypoint diagnostics/invalid fixture
arguments; and one degenerate cross-user baseline fixture. Each original result
and its correction is retained; corrected fixtures establish real authority and
keep the business/negative assertions.

The earlier non-frozen broad run had a post-drain native SIGSEGV, the stale-owner
fixture failure, and three loopback EPERM file results (rollback, ownership and
WHOOP). Loopback-authorized reruns passed all 14 cases. Post-drain isolated rerun
passed. Final broad ran with localhost fixture access and had no EPERM or timeout;
its migration native SIGSEGV and unchanged correction are both preserved.

Tooling: static refresh first used unavailable Ruby 2.6 Psych.safe_load_file;
evidence archival first included a regular .out file in a directory scan.
Both exited one, were corrected, and fully rerun; neither was an application/test
assertion. Prior review/candidate failures including the earlier Stage 5 issue,
EPERM, fixture-key omission and SIGSEGV are unchanged in the historical ledgers
linked from this ledger. Corrections do not erase those results.

## REPOSITORY CHANGES

Local repair covers v32 schema/store/context, shared transaction kernel,
reanalysis/currentness/diagnostics/logger, controlled entrypoint guards, seven
independent review test files, real-process/Hrana fixtures, focused fixture
corrections and source-bound acceptance evidence. Full code identity is captured
by SHA-256 hashes for all 540 JS/MJS files in the test ledger. Source aggregate:
`4fc4a4f88a6bc0a0cabd31a5e3e31c9d999f9afc560bcf958c02295f816c52d0`.

Exact local commit(s), final tree and clean status are read back after committing
and returned in the final response. Recovery branch fast-forwards locally only.
The rollout artifact now requires fresh RC2/OFF/OFF and Render auto-deploy OFF
before publication, paused automation, current v31 backup, controlled migration,
exact RC3 server and disabled split pins, compatible Worker cron OFF, finalized
sync and bounded truthful Stage 6 progress before later cron/locale/allowlist smoke.
Rollback uses the v32-compatible profile, never raw RC2.

## PUSH STATUS

NOT_PUSHED

## TAG STATUS

NOT_CREATED

## PRODUCTION MUTATION

NONE

## CURRENT PRODUCTION BASELINE

Retained recovery-audit facts only; no fresh production health check was made:
exact RC2 live at c364ea7, schema v31, Beta OFF/OFF/empty allowlist, Render auto-deploy
OFF, maintenance OFF and normal ingress; GitHub manually disabled, zero queued/
in-progress runs, exact RC2 pin and Node 22; Cloudflare Worker f78e3f69 with zero
triggers; original lookup/audit keys and completed checkpoints, integrity OK/FK
zero, six pending SHADOW jobs, zero attempts/leases/cursors/receipts/routes/LIVE,
pre-v31 backup retained, Developer plan/overages ON. Nothing was changed here.

## SCHEMA ALLOCATION

v31 Localization; v32 Execution Settlement Authority; v33 Stage 7; v34 Stage 8.
Only repaired v32 is implemented.

## RELEASE CANDIDATE

Proposed: v1.2-phase4-public-beta-rc3. Uncreated/unpublished. Candidate is the final
local commit/tree returned in the session response, also at the recovery branch.

## SETTINGS V1

DEFERRED_POST_LAUNCH — first post-launch UX patch: /settings, language/name change,
/language and /name. No implementation here.

## REVIEW READINESS

READY_TO_RETURN_TO_V32_SETTLEMENT_AUTHORITY_REVIEW

## EXACT NEXT ACTION

RETURN_TO_SAME_REVIEW_V32_SETTLEMENT_AUTHORITY_SESSION
