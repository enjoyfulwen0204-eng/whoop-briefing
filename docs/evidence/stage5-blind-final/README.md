# Blind Final consolidated repair evidence

All seven findings are closed through the four packages in [the repair report](../../phase4-stage5-blind-final-repair.md). Earlier closure evidence remains unchanged.

- Starting commit: `532cc5858cf9ed27762a2150d04bb49458abd7e6`.
- Final runtime/test commit: `52434abc9ca97c9088e7e0d14d313710c4f2dc29`; tree `1b77c814fed92f254aa6dcee6d66825454aa8f63`.
- Branch `v1.2-phase4`, schema v27 unchanged, SHADOW only.
- Accepted gate: **41 processes, 440/440 tests passed**, no failures, cancellations, skips or signals.
- Runtime: v22.23.2, darwin arm64; dependencies unchanged.
- Source fingerprints: 392 files; fingerprint-manifest SHA-256 `f7c2ba83cc9a695badf7ab0cd103c84df70700eb4cd178f1be77d77a8c5b0984`.

Every accepted file ran serially on the same final source. Source hashes were checked after the gate. Historical runs are excluded from accepted totals; matrix groups overlap and must not be added together. Test/subtest counts are not assertion counts.

## Files

- [final-summary.json](final-summary.json): identity, provenance, exact per-file results, durations, 600,000 ms budgets and A–N PASS matrix.
- [final/](final/): complete output of all accepted processes.
- [source-fingerprints.json](source-fingerprints.json): final runtime, test, script and dependency-manifest SHA-256 values.
- [syntax.json](syntax.json): all 23 changed JavaScript files passed syntax checks.
- [accepted-files.json](accepted-files.json): exact ordered list of the 41 final files.
- [iteration-history.json](iteration-history.json) and [history/](history/): every earlier test run, both setup/cache tool incidents and the raw-evidence whitespace check.
- [baseline-test-sources/](baseline-test-sources/): exact original independent reproduction tests and helper used with the pinned starting-source archive.
- `primary-source-fingerprints.json`, `path-source-fingerprints.json`, `gate-files.json`, `completion-files.json`: source/list provenance for superseded development checkpoints.

## Historical runs (excluded from acceptance)

| Batch | Processes | Tests | Passed | Failed | Purpose |
| --- | ---: | ---: | ---: | ---: | --- |
| dev-01 | 2 | 17 | 16 | 1 | M006 error precedence integration |
| dev-02 | 4 | 13 | 9 | 4 | Initial new regressions and fixture corrections |
| dev-03 | 3 | 12 | 11 | 1 | Remaining fixture time correction |
| baseline | 4 | 15 | 1 | 14 | All seven findings against untouched starting runtime |
| focused | 7 | 60 | 59 | 1 | Development integration; SQL-sensitive M007 injection |
| primary | 39 | 438 | 437 | 1 | Earlier full gate; outdated raw Journal expectation |
| path-baseline | 1 | 1 | 0 | 1 | Literal JSON path collision |
| completion | 9 | 92 | 92 | 0 | Targeted path/Journal verification; superseded |
| identity-baseline | 1 | 1 | 0 | 1 | Genuine legacy Unicode identity compatibility |
| Total | 70 | 649 | 625 | 24 | 57 PASS processes, 13 ASSERTION_FAILURE processes |

There were no historical or accepted test-process SIGSEGVs, EPERM/EACCES failures, unexpected timeouts or harness failures. Separately, one archive-setup Python incompatibility and one protected-cache Python EPERM occurred; both were corrected before evidence generation. These tool incidents are explicitly recorded in the ledger. One staged whitespace check additionally flagged eight whitespace-only blank lines in four historical TAP logs. Raw logs retain their original bytes; source/documentation whitespace checks exclude only TAP output and pass. T001's deliberately timed-out nested process is expected; the outer test confirms child and grandchild termination.

The 360-day root oracle found 542 distinct roots, 128,663 canonical bytes. M006 passed 13/13, M007 17/17, M008 15/15. The six new Blind Final files passed 18/18.

## Reproduction

From repository root, run the selected gate serially with the declared budget:

```python
import json, os, subprocess
from pathlib import Path
files = json.loads(Path('docs/evidence/stage5-blind-final/accepted-files.json').read_text())
env = {**os.environ,
       'STAGE5_TEST_OUTPUT': '/private/tmp/stage5-blind-final-recheck',
       'STAGE5_TEST_TIMEOUT_MS': '600000'}
subprocess.run(['node', 'scripts/test-stage5-closure.mjs', *files], env=env, check=True)
```

The compatibility helper uses a local `git archive` of the pinned starting commit and synthetic databases to create genuine historical authorities. It does not load live provider credentials. The initial baseline archive's test sources are retained separately because later regressions added future-opposite, path-escaping and single-pass Unicode cases.
