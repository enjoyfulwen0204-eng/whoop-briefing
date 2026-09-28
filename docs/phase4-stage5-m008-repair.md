# Phase 4 Stage 5 — M008 final repair

## VERDICT

`PHASE4_STAGE5_M008_REPAIR_COMPLETE`

S5-B-M-008 is CLOSED. Prior Review B closures remain preserved. No schema change or Stop Condition was needed.

## IDENTITY

- Start HEAD/upstream: `a3b8c7d17cc47fac4ec707706ca38d0a41ef90f1`, clean `v1.2-phase4`.
- Runtime/test endpoint: `a2c67423b03a4f9e1f6458df53b233a8ff011990`. The delivery endpoint is the subsequent commit containing this report/evidence. Its exact matching HEAD/upstream SHA and clean-tree check are in the delivery response; `git log -1 --format=%H -- docs/phase4-stage5-m008-repair.md` identifies it.
- Local main: `18530a6705744ef435be2b58c310d5cb59eec058`, unchanged.
- Remote main / origin/main: `ecbd23287cac591e76741771d77caa3d814f84a3`, unchanged.
- `v1.2-production-release-freeze`: object `4be66e4eba256622f73e204e9d43350dd7f16cff`, peeled target `ecbd23287cac591e76741771d77caa3d814f84a3`, unchanged.
- Schema v27 unchanged; SHADOW only. Final source fingerprints cover 380 runtime, test, script and dependency-manifest files.

## S5-B-M-008 — CLOSED

The existing `currentInsight` helper now owns selection, authentication and requested-family comparison. The production change is confined to `phase4IntelligenceStore.js`.

**Requested identity:** `insightIdentity(hypothesis, direction)` derives subject (`journal:<factor>`), outcome, direction, exposure category, algorithm family and evidence-contract major from the semantic association hypothesis and registered analysis. The shared `insightIdentityKey` function, already used by direct creation and M007, validates those six fields, applies NFC/whitespace/case normalization and hashes them with the existing user-scoped `insight-key-v1` contract. The duplicate association implementation was removed; no identity domain, method profile or statistical threshold changed. Execution mode remains fenced by scoped selection and the typed reader.

**Selected identity:** the mutable lookup locates an ID only. `insights.read(..., {history:true})` obtains the existing v27-authenticated projection at the selected revision, validating its immutable revision, schema, roots, privacy and generations. Comparison uses that projection's sealed `insight_key`, never the materialized lookup value or a current-parent reconstruction.

**Comparison and failure:** sealed selected key must equal the independently computed requested key. A mismatch raises `PHASE4_INSIGHT_IDENTITY_MISMATCH` before future/expiry exclusion, automatic expiry, support/reconfirmation, recovery or contradiction transitions. It returns no association result and rolls back all prepared writes through the existing transaction. It does not rewrite lookup metadata, fall back to parent fields, or turn mismatch into absence. Missing/corrupt/redacted/stale authority retains its existing typed failure. A genuine lookup miss continues through the existing M007 new-incarnation discovery boundary.

## REUSE-PATH AUDIT

| Path | Authority and disposition |
| --- | --- |
| Current association result | Shared selector authenticates and compares before reuse |
| Promotion / support / reconfirmation / weakened recovery | All consume the checked current selection before their existing lifecycle logic |
| Opposite-direction contradiction | Same selector computes the requested opposite direction and compares before weakening/refutation |
| Automatic current expiry / replacement | Comparison precedes expiry; M007 absence/linkage and M006 sealed chronology remain mandatory for a successor |
| Explicit lifecycle / expiry by insight ID | No mutable logical-key lookup; existing typed ID/revision authority and CAS apply |
| Direct creation | Existing shared canonical identity, M007 discovery and supplied-predecessor validation remain unchanged |
| Historical replay | Exact v27 requests replay before new selection; valid history remains unchanged. Unsupported v26-only insight reconstruction remains unavailable |

Source search found one current-insight lookup by mutable logical key, with both current and opposite callers routed through this helper. No second weaker selection path was found.

## REVIEW B REPRODUCTION

The fixture uses genuine direct/association APIs and real v26/v27 authorities. It retires the initial caffeine incarnation, creates and promotes a separate `journal:other-factor` insight, then changes only that current insight's materialized key to the caffeine lookup key. The typed reader independently confirms that the selected insight is authentic and still belongs to `journal:other-factor`.

Before the repair, the caffeine request returned that wrong-family insight, committed one run, one item, two v26 authorities and one v27 receipt, and exact replay preserved the complete wrong-family result. The corrected structural replay diagnostic is retained in `history/baseline-replay--phase4-stage5-m008.test.tap`.

After the repair, the same request raises `PHASE4_INSIGHT_IDENTITY_MISMATCH`, returns no result and leaves every table unchanged. The selected authenticated key differs from the requested key in both baseline and repaired diagnostics; neither test fabricates or re-signs durable authority.

## ZERO-WRITE PROOF

| Store | Before rejected mismatch | After rejected mismatch |
| --- | --- | --- |
| evidence_runs | 1 | 1 |
| evidence_items | 1 | 1 |
| health_insights | 2 | 2 |
| insight_revisions | 5 | 5 |
| phase4_evidence_result_authorities | 2 | 2 |
| phase4_operation_receipts | 6 | 6 |
| resource_locks | 0 | 0 |

The tests compare the contents of **every database table**, including sequences and source links, beyond these counts. The deliberately inconsistent materialized key also remains unchanged. Current/opposite HYPOTHESIS, EMERGING and WEAKENED candidates, future/expired candidates, missing/corrupt receipts or revisions, redacted parents and generation mismatch all preserve the snapshot and release every lease on rejection.

## MATCHING REUSE PROOF

A directly created candidate uses case/whitespace variants of the six identity fields and produces the same canonical key as the caffeine association request. The association reuses its ID and revision, leaves both insight and revision inventories unchanged, and records the matching insight in v26/v27 results. Exact association replay, original pre-retirement history, and the original direct creation receipt retain their semantic results even after later mutable-key drift.

A matching authenticated opposite-direction candidate remains eligible for contradiction: its ID and sealed key are preserved, it advances to WEAKENED, and `INSIGHT_CONTRADICTION` binds that result. Exact replay remains unchanged.

## DIRECT / ASSOCIATION / CONTRADICTION PARITY

PASS. Direct creation and association derive the same canonical requested key. Direct creation rejects an explicit wrong-family predecessor with the existing `PHASE4_INSIGHT_INCARNATION_INVALID`; current/opposite reuse rejects the selected wrong family with `PHASE4_INSIGHT_IDENTITY_MISMATCH`. Both reject without committed changes. Correct matching current and opposite results succeed.

## M006 / M007 REGRESSION

PASS. All 13 M006 predecessor tests and all 17 M007 discovery tests pass on the final runtime. Hidden mutable keys still lead to authenticated predecessors, valid successors retain linkage, impossible chronology rejects against sealed retirement, competing histories fail closed, absence remains bounded/authenticated, and exact historical retries remain unchanged. The seven temporal regressions and full lifecycle suite also pass.

## A–N MATRIX

| Group | Result | Final executable evidence |
| --- | --- | --- |
| A Complete result oracle | PASS | closure, lifecycle, operation-surface, M008 valid replay |
| B Add-a-column | PASS | closure |
| C Reader × Authority Fault | PASS | readers, review-b-admission, rc7, M008 candidate authority, M006/M007 |
| D Complete request dimensions | PASS | contracts, closure, review-b-scope-json |
| E Representation equivalence | PASS | contracts, closure, v27, M008 canonical direct identity |
| F Legacy discovery | PASS | discovery, bounds, v27, M007 genuine historical ambiguity |
| G Privacy closure | PASS | privacy-oracle, review-b-privacy, closure, rc7, M006/M007/M008 redaction |
| H Null / absence | PASS | contracts, association-store, v27, final-fixture, M007 absence, M008 mismatch exclusion |
| I Coverage lineage | PASS | lineage, rc7 |
| J Insight Lifecycle | PASS | M008 reuse/contradiction, M006/M007, review-b-temporal, lifecycle, insight/association stores |
| K Root completeness / scale | PASS | closure independent 360-day root oracle, bounds |
| L Concurrency / Fencing | PASS | M007 concurrent admissions, review-b-process, review-b-scope-json, processing-contention, foundation-isolation, contracts |
| M Migration / cutover | PASS | v27 including migration interruptions and genuine historical cutovers |
| N Process stability | PASS | all 24 accepted exits, 12 isolated fixture generations, normal-driver race and orphan checks |

C/J receive affected-path regressions; the remaining groups receive the listed regression/smoke coverage. Groups overlap and are not additive. Previous full repository sweeps remain separate historical evidence.

## TESTS

**268/268 tests passed in 24 accepted processes.** All accepted processes exited 0 without a signal, failures, cancellations or skips. M008 contributes 15 new tests. Both changed JavaScript files passed syntax checks; `git diff --check` passed. Focused M008 results are counted once, followed by the other 23 files serially on the same unchanged source.

| Classification | Accepted final gate | Pre-repair reproduction history |
| --- | --- | --- |
| PASS | 24 processes / 268 tests | 0 |
| Logical / assertion failure | 0 | 2 processes / 2 failed tests |
| EPERM / EACCES | 0 | 0 |
| Native SIGSEGV | 0 | 0 |
| Unexpected timeout | 0 | 0 |
| Harness / tooling failure | 0 | 0 |

Both historical failures are the new rejection assertion against the unmodified starting implementation; they demonstrate the blocker and are excluded from accepted totals. The first run's extra replay diagnostic compared JSON serialization order, which was too strict. The second uses structural equality and confirms exact wrong-family replay. All raw output is retained, including that first diagnostic. The T001 nested timeout remains an intentional negative probe, whose outer test passes only after both descendants are gone. Earlier repair failures remain in their untouched evidence directories.

The default file budget is 300 seconds; the full lifecycle file has a declared 600-second budget. Each actual budget, elapsed time and classification is retained in [the evidence index](evidence/stage5-m008/README.md).

## PRODUCTION ISOLATION

Only `v1.2-phase4` is committed and pushed, using `--no-follow-tags` and `HEAD:refs/heads/v1.2-phase4`. Local main, remote main and the release-freeze tag remain untouched. No production database, `.env`, credentials, schema migration, statistical threshold, deployment, scheduler or workflow was changed or activated. All test data is synthetic. Stage 6 was not started.

## COMMITS

- `a2c67423b03a4f9e1f6458df53b233a8ff011990` — `fix(stage5): bind current insight reuse to authenticated identity`
- The containing delivery commit — `docs(stage5): record M008 repair evidence` (exact SHA in delivery response).

## NEW FINDINGS

None.

## EXACT NEXT ACTION

`RETURN_TO_SAME_FIXED_REVIEW_SESSION_B`
