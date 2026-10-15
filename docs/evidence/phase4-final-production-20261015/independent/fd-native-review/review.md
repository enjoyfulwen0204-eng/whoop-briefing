# Independent review of fd07931 (superseded runtime)

Reviewed source: fd07931db0e2cb503b53a7a93f1f723b09f8ae02; tree 78271c046ed217be3f7d9e6ef5255eb2e56297fa; src tree 6c2cba536677bbd914fe32f863201283d05e33c9. The independent detached checkout was immutable throughout the recorded weekly run. This report grants no release or Production approval.

## Native fairness: NO_GO; withdrawal required

The post-ACK native scheduling helper passed 13 focused tests (10 committed cases and 3 independent cases) in 5.3392 seconds. These establish result/error identity for the wrapper, root writer exclusion, rollback after concurrent rejected work, ordinary stale context rejection, and receiver ALS lifetime cases. They do not establish native close safety.

A separate real-process counterexample creates an owned native in-memory DB, makes the 8 ms scheduling threshold due, schedules an external immediate close, and enters a transaction. On fd07931, the BEGIN acknowledgement yield exposes close before the business callback. The process prints NATIVE_CLOSE_START and NATIVE_CLOSE_RETURNED, then aborts with SIGABRT (-6), a Rust panic at src/database.rs:155:34 (Option::unwrap on None). No BUSINESS_CALLBACK_ENTERED marker appears. The identical marker probe on d539277 exits 0 with the business callback and transaction completed, and the close timer has not fired. This differential proves a newly reachable native close window; it does not prove the old runtime is generally native-safe or assign the older cleanup SIGSEGV's root cause. The source's deferred receiver-scope retirement does not defer native anchor close.

The initial test-runner close probe also failed 0 PASS / 1 FAIL with SIGABRT. The plain marker differential corroborates it in a separate subprocess. Parent acknowledged withdrawal of the scheduler helper and db.js wrapping. No reviewer source implementation was made.

## Frozen weekly observation: valid identity; completion/capacity NO_GO

One authorized run used the exact detached fd07931 source, Node 22.23.2, node --test --test-timeout=120000 test/stage8-live-weekly-functional.test.js. No commits or checkouts occurred. Before/after commit, tree, src tree, status, and every source/test/package hash match. NODE_OPTIONS was null. No profiler or query instrumentation was added; the committed sanitized error-code diagnostic loader remained present and is disclosed in the execution record.

Actual result: process return code 1 after 120.5138 seconds; Node reports 0 PASS / 0 FAIL / 1 CANCELLED, testTimeoutFailure at 120000 ms. Legs 0 through 35 produced 36 observations, zero reported jobsFailed, 25 committed units and 66 processed items in aggregate, only ANALYSIS_UPDATING, and no CURRENT. Leg 28 spent 40,310.7062 ms with zero progress and BUDGET_EXHAUSTED. Maximum reported heapUsed was 2,655,440,448 bytes; maximum sampled RSS 1,341,030,400 bytes; kernel maximum RSS 2,155,296 KiB. These separately sampled fields are not additive.

This is a local Darwin native owned-memory fixture measurement, not actual Linux 0.5 CPU/512 MB HTTP qualification. It neither completes weekly acceptance nor proves Production memory consumption. Parent's earlier run changed HEAD while running and failed RELEASE_CHECKOUT_MISMATCH; it remains classified INVALID_IDENTITY_CHANGED in a separate record, never merged with the valid run or treated as a retry fix.

## Fanout lead and unapplied alternatives

The existing schemaVersion===32, job, SHADOW, STAGE6_DRAIN coalescing condition excludes current 34/35 and LIVE. Expanding it changes callback observation multiplicity and authority boundaries. Automatic approval rejected the proposed expansion before execution; no reviewer patch/loader applied it. It remains unapplied.

The authentic association diagnostic logs a group of 2383 marked read-only checks. Its tested operation is an ordinary SHADOW fixture at schema 27 without a job scope, so the proposed schema 32/33/34/35 job-scope condition would not affect that case. It demonstrates fanout exists, not that the proposed coalescing is the cause or solution for the LIVE weekly failure. Retained snapshot content (3383 records, 2,083,728 content bytes, 104 distinct row values) alone is also insufficient to assign allocator root cause.

Fixed-width scheduling of every original marked read-only callback is a distinct, materially narrower proposal. Static conditions: retain duplicates, order and the complete callback inventory; settle every batch even after failure; retain the first rejected result object even when its reason is undefined; keep read-only ALS across the whole loop; preserve final authority/budget/COMMIT guards and rollback sequencing. It bounds top-level transport concurrency, not all nested SQL or O(N) callback storage, and still needs an immutable source review and tests.

## Preserved release gates

Whole release remains NO_GO. The earlier native cleanup SIGSEGV remains open, endpoint containment is unproved, actual target HTTP/Linux resource qualification is absent, original retained Stage6 request/controller settlement remains outstanding, and no full original campaign convergence or Production migration/backup authorization has been established. Prior report and privacy/migration addendum remain applicable with their exact reviewed-source qualifications, including both retained purge-fixture failures. Passing focused tests or a later retry cannot close these gates.

All work here was isolated/read-only against source candidates. No Production state, original DB, token, permit ledger, controller journal, migration route, or deployment was modified.
