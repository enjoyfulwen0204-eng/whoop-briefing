# M008 repair evidence

This checkpoint covers current-insight logical-family binding. Earlier closure and repair evidence remains unchanged.

- `final-summary.json`: identities, source digest, all selected per-file results/budgets, A–N matrix, reproduction counts and matching-reuse proof.
- `final/`: complete accepted process output.
- `iteration-history.json` and `history/`: both pre-repair rejection failures, including the corrected structural replay diagnostic.
- `source-fingerprints.json`: final JavaScript/script sources and package-manifest SHA-256 values.

All 24 accepted files ran serially on the same final implementation. The 15-case focused M008 suite is counted once; the remaining 23 files ran afterward without source changes. Test/subtest counts are not assertion counts, and matrix groups overlap.

Reproduce the selected gate from repository root:

```python
import json, os, subprocess
from pathlib import Path
summary = json.loads(Path('docs/evidence/stage5-m008/final-summary.json').read_text())
for index, result in enumerate(summary['results']):
    env = {**os.environ,
           'STAGE5_TEST_OUTPUT': f'/private/tmp/stage5-m008-recheck/{index}',
           'STAGE5_TEST_TIMEOUT_MS': str(result['timeoutMs'])}
    subprocess.run(['node', 'scripts/test-stage5-closure.mjs', result['file']], env=env, check=True)
```

Runtime: Node v22.23.2, macOS arm64; installed dependencies unchanged. No live provider or environment credentials are needed.
