# Stage 5 closure evidence

The [implementation report](../../phase4-stage5-closure-report.md) explains the contracts, test matrix and limits. All data in these logs came from synthetic fixtures. The final gate is **564/564 tests in 50 cleanly exiting processes**, with A–N passing and zero failures, cancellations or skips.

`final-summary.json` is the final gate index: one selected passing run per test file, exact Node-reported counts, exits/signals, durations, command batches and A–N status. `final/*.tap` contains each complete selected process log. `source-fingerprints.json` records SHA-256 hashes of application JavaScript, tests/fixtures, the runner and package manifests. Counts include Node's reported parent/subtest totals; they are not a count of individual assertion calls.

`iteration-history.json` preserves earlier process classifications. Failed process logs are in `history/`; successful earlier runs are historical entries, not added to the final totals. The original runner classified one canceled nested migration test as an assertion failure; its reviewed classification is explicitly `HARNESS_DEFECT`. That test was moved to the top level and rerun with zero cancellation. `diagnostics/` retains early runs and batch-console logs without promoting them into the final gate.

`native-crash-excerpts.json` contains only crash exception/frame details and the native module UUID match. Personal system diagnostics and full crash reports are excluded. A SIGSEGV after passing assertions remains a failed process. Historical timeout and sandbox loopback EPERM are also retained; the loopback-only rerun used the existing fake provider and temporary databases.

Reproduce selected batches from the `commands` array using `scripts/test-stage5-closure.mjs`. The runner starts one separate process per explicit test file, serially, with `--expose-gc --test --test-concurrency=1`, preserves output immediately, and records a five-minute timeout as failure. Do not count partial TAP output as a pass. The fixture connection-ownership mitigation and its limits are documented in the implementation report.

No migration command against an application or production database is part of this verification.

Captured logs preserve their original whitespace. This directory's attributes exempt only `.tap` and diagnostic `.txt` records from source whitespace checks; application, test and documentation files retain the normal checks.
