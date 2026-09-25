# Phase 4 Stage 5 Intelligence Core verification

This is the independent-review handoff for Stage 5. It is not authorization to
start Stage 6, enable a flag, create LIVE intelligence, publish a value, send a
message, deploy, migrate production, or merge the Phase 4 branch.

## Scope boundary

Stage 5 implements the ADR-owned deterministic evidence, observation-episode,
and insight-memory runtime against the existing v24 Foundation schema:

- a closed, versioned processed-record metric registry;
- earlier-only robust personal baselines and the shared typed quality envelope;
- meaningful-change, persistence, severity, novelty, polarity, and hysteresis;
- registered deterministic trend, correlation, similar-day, Journal association,
  Body Energy decomposition, confidence, and multiplicity calculations;
- durable `PERSONAL_BASELINE_DEVIATION` and `JOURNAL_ASSOCIATION` runs/items
  with source links, manifests, generation fences, and stable replay identity;
- episode open/update/escalation/stabilization/resolution/reversal/reopen/expiry,
  observation membership, evidence membership, and eligible semantic events;
- Journal tri-state classification, lag 0/1, UNKNOWN promotion confound,
  Benjamini-Hochberg family adjustment, replication, and non-causal language;
- insight `HYPOTHESIS`/`EMERGING`/`SUPPORTED`/`WEAKENED`/`RETIRED`
  transitions with versioned revisions, independent supporting evidence,
  contradiction, `REJECTED`, `REFUTED`, and `EXPIRED` handling;
- transitive Foundation privacy lineage and fail-closed lifecycle, auth, input,
  purge, tenant, mode, source-currentness, and as-of checks.

Stage 5 does not implement or activate the Stage 6 invalidation/reanalysis drain
or scheduler. It does not implement Stage 7 proactive decisions, context-question
policy, Quick Actions, outbound proposals, or delivery. It does not implement
Stage 8 Morning Brief, Q&A, Owner Monitoring, or display-name changes.

## Authority and persistence

Both Stage 5 runtime entry points require a server-minted, current `SHADOW`
context. The public Foundation factory still refuses LIVE authority. No Stage 5
path owns a Telegram/provider capability, creates an outbound message, or creates
a proactive decision. All metric and Journal inputs are branded tenant-bound
source snapshots and are revalidated before use and again through stored
provenance.

Stage 5 uses the existing v23 evidence/episode/insight tables installed by schema
v24. There is no schema, migration, feature-flag, scheduler, workflow, or
production-configuration change.

## Deterministic contracts

- Baseline: latest 30 unique valid earlier health days within 45 days, minimum
  7, median, MAD x 1.4826, then IQR / 1.349 fallback.
- Change: registered absolute/relative floor plus absolute robust-z 2.5 open;
  two qualifying observations separated by 30 minutes through 36 hours, or the
  registered severe-single exception at robust-z 4 and confidence 0.80.
- Hysteresis: absolute robust-z below 1.5 enters `STABILIZING`; resolution needs
  a 24-hour hold. A seven-day expiry is explicit and auditable.
- Association: each group at least 5 and classified total at least 20 for a
  candidate; each group at least 8 and total at least 30 plus two non-overlapping,
  direction-consistent slices spanning seven days for repeated evidence.
- Promotion: UNKNOWN fraction greater than 0.50 blocks; exactly 0.50 passes only
  that confound; adjusted significance must be at most 0.10 and support current.
- Insight: no direct `HYPOTHESIS` to `SUPPORTED`; `SUPPORTED` requires a second
  compatible evidence item from an independent window.

Failed association floors emit no comparative effect. Absence of a Journal fact
is `UNKNOWN`, never `CONFIRMED_UNEXPOSED`. Observational outputs always carry
`ASSOCIATION_ONLY`, and no lifecycle wording permits a causal or medical claim.

## Focused executable evidence

From the repository root with Node 22 or newer:

```sh
node --test --test-concurrency=1 test/phase4-intelligence.test.js test/phase4-intelligence-store.test.js test/phase4-association-store.test.js
```

The focused gate covers registry closure, typed quality, as-of exclusion,
baselines, magnitude/persistence/severe-single boundaries, hysteresis, confidence,
multiplicity, UNKNOWN 0/0.49/0.50/0.51/1.0 boundaries, trend/correlation/similar
days/Body Energy adapters, durable replay, concurrent convergence, episode merge,
resolution, reversal, linked recurrence and expiry, promotion floors, refutation,
candidate rejection, evidence expiry, transitive purge, Alice/Bob isolation,
generation ABA fences, and SHADOW authority.

## Controlled regression commands

```sh
node --test --test-concurrency=1 test/phase4-*.test.js test/body-energy*.test.js test/journal-foundation-validation.test.js
node --test --test-concurrency=1 test/phase4-v21.test.js test/phase4-v22.test.js test/phase4-v23.test.js test/phase4-v24.test.js test/phase4-foundation-migration.test.js test/migration.test.js test/migration-v4.test.js
node --test --test-concurrency=1 test/phase4-stores.test.js test/phase4-foundation-isolation.test.js test/phase4-foundation-privacy.test.js test/phase4-privacy.test.js
node --test --test-concurrency=1 test/phase4-journal-store.test.js test/phase4-journal-inbound.test.js test/phase4-journal-answers.test.js test/phase4-journal-inventory.test.js test/journal-foundation-validation.test.js
node --test --test-concurrency=1 test/body-energy.test.js test/body-energy-store.test.js
node --test --test-concurrency=1 test/*.test.js
```

Serialized execution is the controlled gate because FND-LOW-002 records native
libSQL test-worker teardown/concurrency instability. Logical assertion failures
must not be reclassified as that known harness issue.

## Verification results

- Stage 5 focused: 44/44 passed.
- Foundation focused matrix, including v21-v24, privacy, ownership, transport,
  Journal, and Body Energy coverage: 186/186 passed.
- Legacy migration compatibility: 17/17 passed.
- Multi-user/lifecycle focused: 25/25 passed.
- Structured Journal focused: 37/37 passed.
- Body Energy focused: 24/24 passed.
- Full serialized traversal: 2,493/2,519 passed in the first sandboxed process.
  Node counted 26 failures: 25 were loopback-listener `EPERM` errors in
  `test/whoop.test.js`, and one was the documented FND-LOW-002 native worker
  `SIGSEGV` while closing `test/association-measurability.test.js`. The affected
  files then passed 9/9 with loopback permission and 8/8 in isolation,
  respectively. No logical assertion failure remains.
- Mutation proofs: 5/5 representative weakenings were killed by tests.
- Static syntax: 8/8 changed JavaScript files passed `node --check`.
- `git diff --check`: passed. Changed-file credential-pattern scan: no match.

The focused and Foundation matrices produced no native crash. The single crash
in the exhaustive traversal matches FND-LOW-002 and was not reclassified as a
product assertion failure; the exact crashed file passed immediately in its
isolated rerun.

## Mutation proof map

Each mutation below was temporary, produced the expected test failure, and was
restored before final validation:

| Critical rule weakened | Test that failed |
| --- | --- |
| Source reference context ownership/revalidation | `Canonical values are derived from branded source snapshots; cross-user and forged references fail closed` |
| Repeated-evidence promotion floor | `A candidate that ages out before repetition is retired as REJECTED, not promoted or silently deleted` |
| Evidence-to-episode replay short circuit | `Exact replay converges on the same evidence, episode, observation and semantic identities` |
| Stale lease CAS-loss settlement | `Source fanout advances existing modes only; LIVE starts fresh, and FULL cannot fake completion` |
| Intelligence SHADOW-only guard | `Public and internal Stage 5 authority is SHADOW-only even though persistence identities remain mode-qualified` |

No mutation experiment is committed.

## Review boundary

Independent review should focus on temporal/statistical integrity, exact episode
state transitions, concurrency convergence, promotion sufficiency, non-causal
language, tenant/mode/generation isolation, and purge non-resurrection. A Stage 5
PASS authorizes neither Stage 6 implementation nor production activation.
