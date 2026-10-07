# Evidence custody and reproduction

`round3/` preserves the original v31 blocker probes, TAP and original Round 2
test sources byte-for-byte. Their old relative paths/contracts are historical;
do not run them against v32 as acceptance assertions. The controlling v32 contract
explains each superseded assertion. The archived orchestration/long-fixture
scripts likewise record diagnostics, including failed/interrupted runs.
Original TAP whitespace is preserved in deterministic `.tap.gz` files.
`round3/tap-custody.json` records the original byte length/SHA-256; decompression
was checked byte-for-byte. No original assertion or output was trimmed. The first
staged whitespace check flagged those raw TAP blanks; compression resolved the
artifact-format issue without changing evidence.

Current accepted file/case names, original failures, reruns, log SHA-256 and
timings are in `../phase4-v32-tests.json`. Raw v32 logs remain under the referenced
ignored local `tmp/v32-*` directories; no historical result is overwritten by the
accepted selection. `relevant-files.json` lists the 144 relevant files.

Use Node 22.23.2 or compatible Node 22 and the deterministic lockfile install.
The three `node scripts/test-v32-shard.mjs 0|1|2` commands should run sequentially
on this machine: concurrent dense native fixtures produced recorded timeout
history. Each file has the existing 600-second test guard. The serialized harness
also accepts explicit files, for example:

```
STAGE5_TEST_OUTPUT=tmp/review-v32 STAGE5_TEST_TIMEOUT_MS=600000 node scripts/test-stage5-closure.mjs test/phase4-v32-settlement.test.js test/phase4-v32-process.test.js test/phase4-v32-contention.test.js test/phase4-v32-runtime.test.js test/phase4-v32-migration.test.js
STAGE5_STABILITY_OUTPUT=tmp/review-v32-new-stability node scripts/test-v32-stage5-stability.mjs
```

Stability output must be a fresh directory. The runner executes 20 real
normal-driver contention repetitions and reports native signals/failure exits
honestly. It never rewrites business assertions or forces success. The descendant
kill case intentionally expects its inner 1.5-second TIMEOUT. Synthetic listener
tests may require local loopback permission; no production/provider credentials
or network targets are required.

The raw RC2 control uses an exact `git archive` of
c364ea7a7586bcaafb3fccd66bc18a461643732c in an isolated directory, the installed
locked dependencies, and its unchanged historical normal-driver test. The
portable rollback test independently creates that archive and proves v32 rejection.
