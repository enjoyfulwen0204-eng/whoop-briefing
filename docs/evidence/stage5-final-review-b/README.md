# Final Fixed Review B evidence

This is a new checkpoint for M006/T002; previous closure and Review B evidence remains unchanged.

- `final-summary.json`: exact selected results, budgets, identity, source digest, A–N status and 12 isolated-child diagnostics.
- `final/`: complete output of every accepted test process.
- `iteration-history.json` and `history/`: every earlier process in this delta, including failures and the superseded initial fixture run.
- `source-fingerprints.json`: SHA-256 of final runtime/test/script sources and package manifests.

The accepted selection contains 24 distinct files. The failed predecessor attempts are superseded only for selection; they remain failed executions in the historical record. No assertion bodies from failed processes are counted as accepted passes. No tests are skipped in the selected gate.

Reproduce the selected serial gate from repository root (synthetic fixtures only):

```python
import json, os, subprocess
from pathlib import Path
summary = json.loads(Path('docs/evidence/stage5-final-review-b/final-summary.json').read_text())
for index, result in enumerate(summary['results']):
    env = {**os.environ,
           'STAGE5_TEST_OUTPUT': f'/private/tmp/stage5-final-review-recheck/{index}',
           'STAGE5_TEST_TIMEOUT_MS': str(result['timeoutMs'])}
    subprocess.run(['node', 'scripts/test-stage5-closure.mjs', result['file']], env=env, check=True)
```

Runtime: Node v22.23.2, macOS arm64, installed dependency versions unchanged. Test connection ownership overlays historical fixture setup only; archived historical application source and serializer/authority behavior stay unchanged. Process exit and child cleanup are required in addition to semantic assertions.
