# M007 repair evidence

This checkpoint covers authenticated predecessor discovery/absence. Earlier closure and repair evidence remains unchanged.

- `final-summary.json`: identities, source digest, all selected per-file results/budgets, A–N matrix and exact zero-write counts for both entry paths.
- `final/`: complete accepted process output.
- `iteration-history.json` and `history/`: all superseded execution output from this delta.
- `source-fingerprints.json`: final JavaScript/script sources and package-manifest SHA-256 values.
- `auxiliary-tooling.json`: documentation-script cache-permission failure and successful scoped-cache retry, separate from application test classifications.

All 23 accepted files ran on the final implementation; the 17-case focused suite includes retained-v26 and orphaned-revision checks. The earlier 15-case focused run and three initial regression runs are retained separately. Test/subtest counts are not assertion counts, and overlapping matrix groups are not additive.

Reproduce the selected serialized gate from repository root:

```python
import json, os, subprocess
from pathlib import Path
summary = json.loads(Path('docs/evidence/stage5-m007/final-summary.json').read_text())
for index, result in enumerate(summary['results']):
    env = {**os.environ,
           'STAGE5_TEST_OUTPUT': f'/private/tmp/stage5-m007-recheck/{index}',
           'STAGE5_TEST_TIMEOUT_MS': str(result['timeoutMs'])}
    subprocess.run(['node', 'scripts/test-stage5-closure.mjs', result['file']], env=env, check=True)
```

Runtime: Node v22.23.2, macOS arm64; installed dependencies unchanged. Databases and historical application archives are synthetic/local. No live provider or environment credentials are needed.
