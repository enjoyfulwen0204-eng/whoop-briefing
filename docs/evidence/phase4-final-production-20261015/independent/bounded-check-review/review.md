# Independent bounded-check review: 87cc513 and test-only b44134b

Whole release: **NO_GO**. Scoped source-delta acceptance: **GO for the reviewed bounded read-only callback transport and native scheduler withdrawal**, subject to the limitations below. This is not a Production deployment, native-stability, capacity, weekly-completion, campaign-settlement, or migration approval.

## Immutable identity and exact scope

Independently executed source: 87cc51311d16e8b7eab3f29ed0d9983de050bfcf; tree f0a39a3e549b3d71b15e71c018640a8ab267f70c; src tree 01ba2540dbd87f56b8183d83595783938ae0c5fb. Fresh detached checkout: /private/tmp/phase4-final-independent-review/bounded-check-review/checkout. Before and after all checks, commit/tree/src tree/status and every src/test/package hash match.

Only src/processingTransaction.js differs from d539277abbb13191f6110dac92a2cb32a0cd2511. db.js and phase4Core.js are byte-exact d539. stage6NativeScheduling.js is absent; the fd native fairness tests and wrapper were withdrawn. The explicit schema32/job/SHADOW/STAGE6_DRAIN coalescing condition and all its exact guard keys remain unchanged. No expanded schema34/35/LIVE coalescing was applied. Automatic rejection of that earlier proposal remains part of the record; this review did not implement a patch or loader to evade it.

Test-only successor b44134bafa5fbb8e025fde0d31172d2afdb02ae3 has tree d779d6722cc71025cf4d4ffdddc1f4eac58bbab2 and the identical src tree. Its sole changed path is test/stage8-owned-live-classes.test.mjs (SHA256 f05ab4e302a920ebd0f38473efa0753c8d2da3888e4ff46f5c4f4d53da1c056c). Runtime conclusions carry by byte identity; that new capacity-style test was not duplicated by this reviewer.

## Bounded transport finding

runChecks gathers the same contiguous marked-read-only group, then uses one checking.run({readOnly:true}) around the complete fixed-32 batch loop. Every original callback, including duplicate function identities and callbacks in later batches after an earlier rejection, is invoked once. Promise.resolve().then captures synchronous throws. Each batch settles before the next begins; all results are retained in original array order, then the original first rejected result object determines failure. Throwing its reason preserves undefined or other falsey rejection values in this helper.

No successful authority observation is cached or reused. Unmarked separators remain sequential and outside the marked group's read-only context. SQL classification, root queue, actual transaction/client, snapshots, receipt generation/verification, execution mode, permit/lease/generation authority, final fences, COMMIT attempts, rollback, and replay code are unchanged. Later callback start time changes, but the existing fresh checks and deadline/budget failures remain authoritative. The bound is on top-level callbacks, not every SQL nested inside them; the group and settled-result storage remain O(N).

No blocker was found in the reviewed delta's tested authority boundaries. This conclusion depends on the existing trusted contract that grouped checks are independent read observations. It is not a guarantee for arbitrary mutually dependent callbacks or unbounded latency.

## Independent executed evidence

There are **66 completed passing checks** across these scoped runs:

- 56/56 PASS, exit0, 44.2153 seconds: six independent real-native counterexamples plus committed bounded300 checks (success/error/undefined), ordinary stale context, receiver lifetime, coverage-time cases, real receipt routing, privacy/purge/replay boundaries, LIVE producer/execution authority, scope/tenant isolation, and finite contention/no callback replay.
- 6/6 PASS, exit0, 12.5986 seconds: installed HTTP driver, independent marked-check packet composition, mutation refusal, whole-group settlement before rollback, nested before/after checks and current metadata revocation. This is an isolated copy of the pre-existing HTTP test, changing only its synthetic migration target32 to34 and module URL relocation; assertions and runtime guards are unchanged.
- Four schema34 SYNC checks completed PASS: normal 115 ms transport-latency window plus exact replay; named receipt failure rolls canonical/provenance/source/cursor back; lost COMMIT acknowledgement plus natural expiry/recovery; and expired source lease rejection. The same isolated fixture-target/module-URL adaptation applies, with unchanged application/leg/deadline limits and original assertions.

The six independent counterexamples prove: 70 repetitions of the same marked function all run while an external-root writer stays queued; forbidden batch writes after await at callback0,33,64 are rejected while all70 callbacks settle and root writes roll back; an unmarked separator waits for40 earlier callbacks and keeps its original ordinary-write semantics before40 later reads; and an immediate first Symbol rejection retains exact identity despite a later undefined rejection, with all67 callbacks settled before rollback.

Two unsuccessful reviewer harness runs are retained, not counted as passing suites. The initial broad run recorded56 PASS lines and14 schema32/34 controlled-admission failures, then hit an80-second outer ceiling without a terminal summary. The original v32 HTTP/SYNC fixtures cannot reach their intended behavior under the unchanged min34 runtime guard. The first schema34 SYNC file completed2 PASS, then its30-second file ceiling cancelled a recovery case whose unchanged leg/overall budgets are31/33 seconds. A corrected60-second file ceiling for only the remaining two recovery cases completed2/2 PASS in55.0599 seconds. This corrected harness accommodates the test's existing natural lease wait; it does not extend any runtime budget, original campaign allocation, or weekly limit, and is not evidence of a native fix.

## Native failure preservation

The fd07931 post-ACK scheduler remains rejected. Independent native close probes caused SIGABRT before the business callback, with native Option::unwrap panic; the identical d539 marker probe exited0. Restoring the original db.js removes that added scheduler window. It does not repair or close the older retained N-API cleanup SIGSEGV, prove all close races safe, or prove endpoint process containment. The separate fd report and all crash/invalid-harness evidence remain intact.

## Functional/resource gates remain NO_GO

Parent's exact87cc weekly artifact was read and hashed, not independently rerun in parallel. Its TAP SHA256 is c26288d62f2fcdb0e6523505e9802fe8ebdd42aebf5a0760c084105774e63fdc. It ends0 PASS /0 FAIL /1 CANCELLED at120 seconds. Completed observations are legs0..33,24 committed units,66 items,0 reported jobsFailed, only ANALYSIS_UPDATING. Leg34 was unfinished, so absence of a completed zero-progress BUDGET_EXHAUSTED leg is not completion proof. Maximum reported heap was155,536,440 bytes; reported cumulative kernel maxRSS1,446,128 KiB is at least a1.379GiB observed floor, with unfinished-leg peak unmeasured. A lower sampled heap relative to fd is neither target-capacity proof nor isolated causal attribution.

Parent's unchanged generic IMPORTANT/pipeline artifact remains0 PASS /1 FAIL /1 CANCELLED: the IMPORTANT file timed out120 seconds, and the pipeline failed its original CURRENT expectation after its original20-leg ceiling (actual ANALYSIS_UPDATING). These failures remain open even if another fixture succeeds. The direct owned b441 test adds useful real producer/typed-reader/Owner DAILY/IMPORTANT paths, explicit dual principals/subscriptions, replay, revoked authority and negative WEEKLY, without inserting fabricated evidence/alert/publication results. Its direct producer64-leg loop does not exercise the actual finalized-SYNC wrapper or HTTP endpoint and cannot replace the existing20/40-leg regression expectations. At the recorded readback, its legs0..63 still ended ANALYSIS_UPDATING with two remaining jobs; no completed DAILY/IMPORTANT acceptance is inferred from progress logs or signed unit counters. Its final terminal status is separately reported by the parent.

All these resource runs use a local Darwin owned/native or generic fixture. None qualifies the actual Node22 Linux HTTP0.5CPU/512MB target. The denied Docker mount attempt remains prelaunch with no container, not a target test. The known native baseline fault and endpoint containment remain open. Preserve the completed graph/job/receipt diagnostics and investigate the persistent nonterminal jobs within the original limits; do not convert zero reported failures or signed control units into completed computation, widen budgets/leg counts, or bypass guards.

## Unchanged prior gates and safe next actions

The earlier669/669 semantic/model/boundary execution is evidence on6f5, carried only through the previously reviewed exact literal/import, test-only, and current narrow runtime deltas; it was not rerun as a new669-test execution on87cc/b441. The prior privacy/migration addendum remains applicable: exact sentinel literals and protected privacy predicates/DDL;39 PASS/2 retained baseline invalid-fixture purge failures; and the populated ordered32→33→34→35 local recovery rehearsal1 PASS. This does not grant Production migration/backup/rollback-route approval.

The original Stage6 RID b6b5b100-5741-4ed5-a92d-22a08ae1cf83 remains metadata-settlement-only work outstanding, under its original source/manifest/lease/receipt identity. Preserve RESPONSE503 and the spent dispatch; any eventual PARTIAL/RECONCILIATION_ONLY metadata recovery must be a separate nonproductive controller record, never productive completion. No original settlement was executed here and no original budget/receipt/generation was changed. Full original convergence, original Production budget exhaustion, F02 accepted risk, actual target capacity, native containment and deployment gates are unchanged.

Freeze source and preserve these artifact hashes. Further functional diagnosis should explain the persistent jobs using exact original authority and receipt identities; any new source change needs its own immutable review. There is no release GO.

No reviewer candidate-source, Production, token, permit, ledger, original journal/DB, migration route, push or deployment mutation occurred. Reviewer-created files and test databases are isolated under /private/tmp.
