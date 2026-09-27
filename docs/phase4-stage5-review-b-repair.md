# Phase 4 Stage 5 — Fixed Review B repair report

## VERDICT

`PHASE4_STAGE5_FIXED_REVIEW_REPAIR_COMPLETE`

Both High findings, all five substantive Medium findings, and the tooling finding are closed. This handoff returns to the same fixed Review Session B.

## IDENTITY

- Repository: `/Users/kelvin/Desktop/whoop-briefing`.
- Starting HEAD: `2a6930b16369a003401d1fccf9cd42faa9eb0b6b`, clean `v1.2-phase4` tracking `origin/v1.2-phase4`.
- Runtime endpoint: `1438053ea12636ef26743922f4582cdc6d06cab3`; test/fixture endpoint: `e5e74ed5ae9c5d5f8f5f472de681c3a72e893a00`.
- Ending delivery commit: the commit containing this report and evidence; its exact SHA, matching `origin/v1.2-phase4`, and clean-tree verification are supplied in the delivery message. Source fingerprints bind the runtime/test endpoint above.
- Local `main`: `18530a6705744ef435be2b58c310d5cb59eec058` (its unchanged reflog entry dates to September 13).
- Production remote/main baseline: `ecbd23287cac591e76741771d77caa3d814f84a3`.
- Annotated freeze tag object: `4be66e4eba256622f73e204e9d43350dd7f16cff`; target `ecbd23287cac591e76741771d77caa3d814f84a3`.
- Schema v27 unchanged. SHADOW-only Stage 5; Stage 6 not started.

## FINDING STATUS

All eight findings are CLOSED, with retained clean process results and permanent regressions:

| Finding | Status | Repair and proof |
| --- | --- | --- |
| S5-B-H-001 | CLOSED | Historical pre-v25 and v25 binaries generate real standalone Journal explanations. With all naming edges deleted, purge removes the family; a deliberately omitted/restored family prevents COMPLETE. Modern standalone, pre-v26 run/insight and corrupt-authority regressions also pass. |
| S5-B-H-002 | CLOSED | Direct child admission verifies the evidence's complete typed chain. Missing v26/v27, corrupt sample count/timezone, or a missing root rejects with zero durable writes. A registered producer can create evidence, insight and promotion atomically; missing producer authority rolls everything back. Exact retry is idempotent. |
| S5-B-M-001 | CLOSED | Current selection checks authenticated semantic creation/revision time, terminal disposition and strict expiry. Tests cover expiry −1 ms, exact expiry, +1 ms, future-created incarnations, zero-write rejection of unrepresentable new past requests, and historical exact replay. |
| S5-B-M-002 | CLOSED | Both reopen and reversal-linked opening require successor time ≥ valid predecessor resolution, before the active-family shortcut. Earlier/invalid times and valid-looking timestamps that disagree with the authenticated predecessor commit nothing; exact equality and historical replay succeed. |
| S5-B-M-003 | CLOSED | Bounded transaction admission/commit and read-only startup retries preserve a single application callback. The normal-driver two-process/file-DB test observes actual operation contention, then both callers return the same run/item/episode/revision, with one receipt per operation and zero leases. Unit cases verify exhaustion and non-contention failure. |
| S5-B-M-004 | CLOSED | `withContext` owns nested operations and defers release through outer transaction completion. Top-level success/error, nested success/error, outer rollback, failed after-check, repeated release and reuse within an active scope are covered. |
| S5-B-M-005 | CLOSED | Own-data-property reconstruction preserves special keys during request normalization, result encoding and replay restoration. Different accepted content has different operation keys; key order is equivalent. |
| S5-B-T-001 | CLOSED | Tooling only: timed-out files run in their own process group, which the runner terminates as a whole. A real hanging worker/grandchild probe verifies both disappear and the nested run is classified TIMEOUT. |

## PRIVACY CLOSURE

Retained legacy event reference formats widen discovery independently of mutable source links. Original keyed run manifests, signed v25 snapshots, v26 roots/origins and v27 receipts remain their original authorities. Episodes missing a complete authenticated revision history and unsigned legacy insight state receive conservative tenant-scoped privacy dependencies. No modern authority or historical receipt is invented.

The independent completion oracle inventories retained sensitive stores and follows roots without trusting the target ledger. A dependency cycle cannot certify closure. Present dependencies of missing/redacted roots, unproven legacy state, corrupt authority or unsupported bounds prevent completion and keep the purge fenced. The old consolidated report/evidence remains a historical checkpoint; it is not rewritten to imply Review B originally passed.

## AUTHORITY ADMISSION

Every explicit supporting evidence ID/reference is admitted through the typed receipt/root verifier before mutation. Validation covers the run/item's sealed semantic fields, required v26 authority, privacy/readability, current generations and source roots. Insight predecessor dependency chains are also checked.

Only internal deterministic producers can register exact-row provisional evidence tickets within their active operation transaction. Child use schedules a complete typed check before commit, after producer v26/v27 authority exists. Existing evidence cannot acquire a ticket. No failure path commits a trusted child from a parent rejected by its own reader. To keep this stronger admission within the existing process gate, one read-only provenance traversal deduplicates repeated shared root/as-of checks; nothing is cached across calls, writes, contexts or transactions.

## TEMPORAL SELECTION

Current selection and public current-insight reads check semantic eligibility against the authenticated typed projection they return, including when mutable timestamps have been forged. An insight is selected only if its incarnation/current revision exists by the requested `asOf`, it has no terminal disposition, and its expiry is strictly later. Expired current state is retired through the existing lifecycle before a new incarnation. New past work that would require a future incarnation/revision returns `PHASE4_INSIGHT_AS_OF_UNAVAILABLE`; historical exact receipt replay remains available. Statistical thresholds are unchanged.

Linked opens first authenticate the predecessor materialization against its signed snapshot. Reopen/reversal lower bounds accept equality and reject earlier or invalid predecessor times. The existing seven-day reopen upper bound remains intact.

## CONCURRENCY / LEASES

Contention handling is finite: a 15-second budget and at most 65 attempts, with backoff capped at 250 ms, at transaction admission/commit and read-only startup queries. Application callbacks are not rerun for contention. A failed local BEGIN/read refreshes only an idle driver connection, avoiding an unfinished native statement; active transactions are never reconnected. An admitted loser reads the winner's deterministic receipt before calculating. Lease cleanup uses the same bounded admission path.

The process regression uses separate OS processes and the installed normal driver against a synthetic file database. It checks successful process exits, a shared positive result, one run/item/episode/snapshot/event, one analysis receipt and one child-open receipt, and zero completed-request locks. Structured scopes keep capabilities alive through outer validation on both success and rollback. A later process-test failure happened during concurrent source-binding setup, before the deliberate operation barrier. The fixture now binds each complete source snapshot atomically and drains idle finalizers before that barrier. Manual cleanup is restricted to preparation errors; successful operation callers must still prove runtime lease release without helper cleanup.

## JSON IDENTITY

The accepted-key contract is preservation, not rejection. Tests cover own `__proto__`, nested `__proto__`, `constructor`, `prototype`, empty/unusual Unicode/NUL keys, and reordered equivalent objects. Persisted content and normalized request content agree. Changing only accepted JSON content changes the operation key. Object prototypes are not modified.

## A–N MATRIX

| Gate | Result | Principal executable evidence |
| --- | --- | --- |
| A Complete result oracle | PASS | stage5-closure, stage5-lifecycle, stage5-operation-surface; complete replay trees |
| B Add-a-column | PASS | stage5-closure; controlled schema growth rejects incomplete projections |
| C Reader × authority fault | PASS | stage5-readers, review-b-admission, RC6/RC7; own-chain rejection and zero child writes |
| D Complete request dimensions | PASS | stage5-contracts, stage5-closure, review-b-scope-json; special own keys and generations |
| E Representation equivalence | PASS | stage5-contracts, stage5-closure, v27; offsets, sets, JSON key order |
| F Legacy discovery | PASS | stage5-discovery, stage5-bounds, v27; real historical binaries and bounded discovery |
| G Privacy closure | PASS | review-b-privacy, stage5-privacy-oracle, stage5-closure, v27, RC6/RC7; legacy/modern standalone explanations |
| H Null / absence | PASS | stage5-contracts, stage5-closure, association/cutover suites |
| I Coverage lineage | PASS | stage5-lineage, invalid-lineage zero-write closure regression |
| J Insight lifecycle | PASS | review-b-temporal, stage5-lifecycle, association/insight suites; authenticated semantic as-of and chronology |
| K Root completeness / scale | PASS | 360-day independent root oracle, root count/byte overflow checks |
| L Concurrency / fencing | PASS | review-b-process, review-b-scope-json, processing-contention, generation/ABA/rollback suites |
| M Migration / cutover | PASS | v21–v27, Foundation migration, authentic cutover fixtures; no schema change |
| N Process stability | PASS | 169 selected clean exits, normal-driver process race and independent native probes; earlier failures separately retained |

Categories overlap and their test counts must not be added. Selected logs are indexed in [the final summary](evidence/stage5-review-b/final-summary.json).

## TESTS

**2821/2821 tests passed across 169 selected processes:** 594 tests in 56 closure/affected files and 2227 tests in 113 additional repository files. Every selected process exited 0 without a signal; 0 failures, 0 cancellations, 0 skips. The new Review B suites and contention-unit suite contribute 30 focused tests in six files, included within the closure total. These are Node-reported parent/subtest counts, not assertion counts. Syntax checks passed for all 35 changed JavaScript files, and `git diff --check` passed.

The selected batches are `final`, `rerun-final`, `loopback-final`, `corrective`, `final-fixtures`, `migration-v22`, `analytics-fixture`. The full sweep began during the repair series; affected files were rerun after the final runtime/test repair, while unaffected sweep results were retained. [Per-file logs, counts and source fingerprints](evidence/stage5-review-b/README.md) make that provenance explicit.

Earlier failed processes remain failures and contribute zero tests to the selected passed total:

| Original process classification | Failed processes |
| --- | --- |
| ASSERTION_FAILURE | 9 |
| ENVIRONMENT_EPERM | 6 |
| NATIVE_SIGSEGV | 13 |
| TIMEOUT | 11 |
| HARNESS_ERROR | 0 |
| HARNESS_FAILURE | 0 |

Two assertion-failure processes are additionally identified as fixture/harness defects (a WITHOUT ROWID query and invalid legacy fixture ordering); three broad-sweep assertion failures were stale schema expectations. Earlier race-test failures exposed real contention handling and a nested-runner environment defect. A later process-race file failed during fixture source binding before the deliberate operation barrier; its atomic setup and finalizer drainage were corrected while retaining real operation contention and the independent zero-lease check. These explanations do not erase their original failures. The intentional nested TIMEOUT in the tooling regression is expected negative-test evidence; its outer process passes only after proving the worker and grandchild are gone.

## NATIVE PROCESS STABILITY

The installed Node/libSQL code and dependencies are unchanged. Cross-process convergence and isolated native probes use the normal driver. Normal-driver finalizer drainage alone did not stabilize v27. Its file fixture and the repeatedly crashing analytics-repair fixture now use the preexisting owned-connection helper with the installed SQL/transaction executor; real file reopen and all migration/cutover assertions remain. The Review B race and independent native probes retain the normal driver lifecycle.

The exhaustive v22 interruption loop closes each fixture once in `finally` and drains before/after close, avoiding hundreds of retained, already-closed fixture hooks. The prediction-pipeline and proactive-gate fixtures likewise drain before/after close after repeated post-assertion native crashes. Every migration fault boundary and application assertion remains intact. The exhaustive v22 suite has an explicitly recorded 600-second process budget for its per-fixture cleanup, while the default stays 300 seconds. Earlier 300-second timeouts remain failed processes; no process is force-exited as a pass. Successful tests are allowed to exit naturally.

The timeout runner kills only timed-out groups and records failure. Historical lifecycle validation timeouts remain failures; repeated root checks were reduced without weakening admission. Semantic correctness and process/native outcomes are reported separately.

Representative repository sweep crashes (`e2e` and `maintenance-independence`) show the same N-API `CallFinalizer` / `Reference::Finalize` frames and native module UUID `15297104-5a23-3847-9a99-938dd2f1ac9e` as the prior closure investigation. `dwarfdump` matches that UUID to the installed `@libsql/darwin-arm64/index.node`. Sanitized excerpts are retained; full system reports are excluded. This is a continued disclosed native-finalizer limitation, not a claim to repair the vendor driver.

## PRODUCTION ISOLATION

No production/main merge, deployment, scheduler activation, application-database migration, live credential read, live provider call or message send occurred. `.env`, `.env.example`, package/dependency files and deployment/workflow configuration are unchanged. All test data is synthetic. Only `origin/v1.2-phase4` is authorized for push. The local main, remote production baseline and release freeze tag are separately verified, not conflated. Schema remains v27, existing feature gates stay unchanged, and Stage 6 has not started.

## COMMITS

- `38380db765c505a4fa1e20bc2c707b53519c5984` — `fix(stage5): close Review B authority and lifecycle gaps`
- `ae192ca55b929715c2b836034ff921210c5b0d43` — `test(stage5): cover Review B repairs and process cleanup`
- `cc57ba7473928830d6f71d4891a0c3cb0de50ec8` — `fix(stage5): authenticate linked episode predecessors`
- `98fa553358fb5cd9b0fe0356f79d330002125e08` — `test: align repository schema assertions with v27`
- `1438053ea12636ef26743922f4582cdc6d06cab3` — `fix(stage5): select insights using authenticated semantic times`
- `e5e74ed5ae9c5d5f8f5f472de681c3a72e893a00` — `test(stage5): stabilize fixture cleanup and retain process budgets`
- The subsequent `docs(stage5): record Fixed Review B repair evidence` commit contains this report and retained logs. The delivery message gives its exact SHA and upstream verification.

## NEW FINDINGS

The full repository sweep found stale latest-schema expectations in 12 preexisting test files. They now assert the required v27 (test-only maintenance; no schema change). No new Critical, High or substantive Medium runtime finding was identified. The broader sweep also reproduced the already-disclosed native finalizer instability; failed native processes remain in history, with their separate clean reruns in the final selected gate. No production/vendor fix is claimed.

## EXACT NEXT ACTION

`RETURN_TO_SAME_FIXED_REVIEW_SESSION_B`
