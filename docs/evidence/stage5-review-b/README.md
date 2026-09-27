# Fixed Review B repair evidence

This is the repair delta from `2a6930b16369a003401d1fccf9cd42faa9eb0b6b`, separate from the historical [consolidated closure evidence](../stage5-closure/README.md). See the [repair report](../../phase4-stage5-review-b-repair.md) for the eight findings, contracts, identity, A–N matrix and final verdict.

`final-summary.json` records one selected, complete clean exit per permanent test file, the exact Node-reported counts, closure versus additional-repository totals, command batches and source digest. `final/*.tap` contains each selected log. Counts include Node's parent/subtest totals; they are not individual assertion counts. `source-fingerprints.json` records the delivered application code, tests, fixtures, runner and package manifests. The broad sweep began during the repair series; affected files were rerun after the last runtime/test repair, while unaffected completed suites were retained. Per-file batches make that provenance explicit. This is not a claim that every earlier process ran the final complete source tree.

`iteration-history.json` retains earlier process results. Failed outputs remain under `history/`, including logical failures, early fixture/harness mistakes, environment EPERM, native signals and timeouts. An earlier failure is never counted as a final pass; a later clean rerun is a separate process. The first legacy fixture ordered Journal mutation after evidence creation and correctly hit a generation fence; the first special-key test queried `rowid` on a WITHOUT ROWID table. Those are identified as harness defects without erasing the runner's original classification. Three additional failed files exposed stale latest-schema assertions (26 instead of the required 27); latest-schema expectation corrections were applied in twelve test files. The analytics-repair fixture later also received the disclosed native ownership correction.

The new process test uses two real OS processes and the installed normal libSQL driver against a synthetic file database. It waits for actual analysis-operation contention before releasing the winning writer. Both callers must exit successfully and share the same durable result; the parent independently counts rows and leases. The isolated native driver probes remain separate from application semantics.

The timeout regression intentionally runs a nested failing suite and verifies both its test worker and grandchild are gone. That expected TIMEOUT is proof for the tooling test, not a passing application process. All ordinary successful suites exit naturally.

Reproduce any selected batch with explicit paths from the summary:

```sh
STAGE5_TEST_OUTPUT=/private/tmp/review-b-rerun node scripts/test-stage5-closure.mjs test/phase4-stage5-review-b-admission.test.js test/phase4-stage5-review-b-privacy.test.js test/phase4-stage5-review-b-temporal.test.js test/phase4-stage5-review-b-scope-json.test.js test/phase4-stage5-review-b-process.test.js test/processing-contention.test.js
```

The runner executes files serially with `--expose-gc --test --test-concurrency=1` and a five-minute default per-file limit. The exhaustive v22 migration suite uses an explicitly recorded ten-minute limit to include per-fixture native finalizer drainage; prior five-minute timeouts remain failures. Loopback mock-server tests need permission to bind `127.0.0.1`; a sandbox EPERM is retained separately from their rerun. No live database, provider credentials, production migration or deployment is involved.

`native-crash-excerpts.json` contains only exception details and fault frames from four representative repair-validation SIGSEGV reports. They show N-API `CallFinalizer` / `Reference::Finalize` and the same native module UUID as the prior closure evidence. Full system crash reports and personal machine metadata are excluded.

Final selected gate: **2821/2821 tests in 169 cleanly exiting processes** (594 in the 56-file closure/affected gate; 2227 in 113 additional repository files). No failed, cancelled or skipped selected tests. Earlier failures remain separately classified in the history.

To reproduce the explicitly budgeted migration run:

```sh
STAGE5_TEST_OUTPUT=/private/tmp/review-b-v22 STAGE5_TEST_TIMEOUT_MS=600000 node scripts/test-stage5-closure.mjs test/phase4-v22.test.js
```
