# Phase 4 Stage 5 — Final M007 repair

## VERDICT

`PHASE4_STAGE5_M007_REPAIR_COMPLETE`

S5-B-M-007 is CLOSED. Previous Review B closures remain preserved. No schema change or Stop Condition was needed.

## IDENTITY

- Start HEAD/upstream: `11b51d64fc2dfb76311c3270955e6ccda8bbb451`, clean `v1.2-phase4`.
- Runtime/test endpoint: `a76c912e236af32b3e52e68c17322079fc9529e6`. The delivery endpoint is the subsequent commit containing this report/evidence. Its exact matching HEAD/upstream SHA and final clean-tree check are in the delivery response; `git log -1 --format=%H -- docs/phase4-stage5-m007-repair.md` identifies it.
- Local main: `18530a6705744ef435be2b58c310d5cb59eec058`, unchanged.
- Remote main / origin/main: `ecbd23287cac591e76741771d77caa3d814f84a3`, unchanged.
- `v1.2-production-release-freeze`: object `4be66e4eba256622f73e204e9d43350dd7f16cff`, peeled target `ecbd23287cac591e76741771d77caa3d814f84a3`, unchanged.
- Schema v27 unchanged; SHADOW only. Final source fingerprints cover 379 runtime, test, script and dependency-manifest files.

## S5-B-M-007 — CLOSED

`discoverInsightPredecessor` is the canonical discovery/absence boundary. Every new public `INSIGHT_CREATE` operation invokes it, including direct calls that omit `supersedesId`. Association creation invokes the same helper before deriving its incarnation key, and the common creation boundary revalidates the result. Exact receipt replay remains ahead of discovery.

The helper inventories parents, immutable insight revisions, v27 operation receipts and v26 result authorities within the user/execution-mode scope. Each inventory uses a deterministic cap+1 query with a 1,000-row limit; serialized v27/v26 authority content has a shared 64 MiB budget. No mutable logical-key, terminal-status or generation selector can remove a possible predecessor from the completeness inventory.

V27 HMAC-authenticated projections establish canonical logical identity, revision sequence and incarnation linkage. The helper verifies consistent identity across revisions, complete signed revision coverage, retained immutable revision bytes, and the matching parent's current pointer. Existing typed readers validate relevant current privacy, generations and root authority. V26 origins authenticate through the existing verifier; a retained origin naming missing v27 history is unavailable. Orphaned revisions and parents without authenticated identity also prevent an absence result. Legacy, redacted or incomplete history is never guessed into a new authority.

Within the authenticated logical family, signed `supersedes_id` edges distinguish consumed ancestors from an applicable terminal tip. Exactly one valid tip is linked; multiple tips, branching, missing lineage or cycles reject. Revision ordering is used only within one incarnation's signed history; candidates are never chosen by row ID, timestamp or first/latest position.

M006 remains the chronology authority: the discovered tip goes through `terminalInsightPredecessor`, which enforces successor time at or after the sealed terminal transition. Mutable retirement fields cannot override it. The direct boundary fills the discovered `supersedesId`, so an omitted/null caller field cannot bypass linkage. Only exhaustive bounded discovery with no applicable predecessor allows an unlinked first incarnation.

## REVIEW B REPRODUCTION

Both direct and association tests create a genuine predecessor whose sealed logical key is K and whose authenticated retirement is `2026-09-25T12:00:02.000Z`. A controlled fault changes only materialized `health_insights.insight_key` to a different key. Typed history still returns K. A successor at `2026-09-25T12:00:01.000Z` fails with `PHASE4_SEMANTIC_CHRONOLOGY_INVALID` on both paths.

## ZERO-WRITE PROOF

The exact reproduction records these unchanged counts independently for both entry paths:

| Store | Direct before → after | Association before → after |
| --- | --- | --- |
| evidence_runs | 1 → 1 | 1 → 1 |
| evidence_items | 1 → 1 | 1 → 1 |
| health_insights | 1 → 1 | 1 → 1 |
| insight_revisions | 3 → 3 | 3 → 3 |
| phase4_evidence_result_authorities | 2 → 2 | 2 → 2 |
| phase4_operation_receipts | 4 → 4 | 4 → 4 |
| resource_locks | 0 → 0 | 0 → 0 |

Assertions additionally compare the contents of **every database table**, including sequences and source links. No committed changes remain. Association work prepared inside its transaction rolls back completely on rejection. Raw diagnostics are retained in the focused TAP log and `final-summary.json`.

## VALID SUCCESSOR PROOF

With the same corrupted materialized key, both paths admit a successor at `12:00:02.001Z`, retain canonical K, and populate predecessor linkage with the authenticated predecessor ID. Exact retry preserves the full return and table contents. Original association history still replays unchanged.

After retiring that successor, a third incarnation links its immediate authenticated predecessor despite both ancestors' mutable keys being inconsistent. This verifies that a legitimate sealed chain is not confused with ambiguity. Truly empty predecessor history admits `supersedes_id = null`; concurrent identical first-creation requests converge to one incarnation with zero leaked leases.

## AMBIGUITY / CORRUPTION

Two unlinked terminal candidates are generated using genuine archived application code from starting commit `11b51d64fc2dfb76311c3270955e6ccda8bbb451`, on the unchanged core and owned synthetic database. No test re-signs fabricated authorities. Both repaired entry paths reject those candidates as `PHASE4_INSIGHT_PREDECESSOR_AMBIGUOUS`; an explicit caller choice cannot override ambiguity.

Missing/corrupt terminal receipts or revisions, redacted predecessors, generation mismatch, an unauthenticated retained parent, orphaned revisions, and v26 origins surviving parent/v27 loss all reject without committed changes. Row and byte overflow fail closed. Foreign-user and other-mode inventory is excluded; authenticated unrelated logical identities do not become candidates. Unknown or redacted identity cannot be excluded using its mutable key, so it conservatively prevents an absence proof within the scoped inventory.

## A–N MATRIX

| Group | Result | Final executable evidence |
| --- | --- | --- |
| A Complete result oracle | PASS | closure, lifecycle, operation-surface, M007 exact replay |
| B Add-a-column | PASS | closure |
| C Reader × Authority Fault | PASS | readers, review-b-admission, rc7, M007, M006 predecessor |
| D Complete request dimensions | PASS | contracts, closure, review-b-scope-json |
| E Representation equivalence | PASS | contracts, closure, v27 |
| F Legacy discovery | PASS | discovery, bounds, v27, genuine pre-M007 ambiguity |
| G Privacy closure | PASS | privacy-oracle, review-b-privacy, closure, rc7, M006/M007 redaction |
| H Null / absence | PASS | contracts, association-store, v27, final-fixture, M007 absence |
| I Coverage lineage | PASS | lineage, rc7 |
| J Insight Lifecycle | PASS | M007, M006, review-b-temporal, lifecycle, insight/association stores |
| K Root completeness / scale | PASS | closure independent 360-day root oracle, bounds |
| L Concurrency / Fencing | PASS | M007 concurrent admissions, review-b-process, review-b-scope-json, processing-contention, foundation-isolation, contracts |
| M Migration / cutover | PASS | v27 including migration interruptions and genuine historical cutovers |
| N Process stability | PASS | all 23 accepted exits, 12 isolated fixture generations, normal-driver race and orphan checks |

Groups overlap; counts are not additive. C/J/L receive affected-path regressions. Other groups receive the listed regression/smoke coverage. Earlier complete repository sweeps remain separate historical evidence.

## TESTS

**253/253 tests passed in 23 accepted processes.** Every process exited 0 without a signal, with no failures, cancellations or skipped tests. The new M007 file contributes 17 tests. Six changed JavaScript files passed syntax checks, and `git diff --check` passed.

| Classification | Final gate | Earlier attempts in this delta |
| --- | --- | --- |
| Logical / assertion failure | 0 | 0 |
| EPERM / EACCES | 0 | 0 |
| Native SIGSEGV | 0 | 0 |
| Unexpected timeout | 0 | 0 |
| Application test harness failure | 0 | 0 |

These classifications cover application test processes. Separately, one documentation-script syntax check exited 1 because Python tried to write bytecode into the sandbox-protected macOS cache directory (`EPERM`). Repeating that same check with `PYTHONPYCACHEPREFIX=/private/tmp/stage5-m007/pycache` exited 0. This auxiliary tooling retry did not change application sources or affect the test gate; both outcomes are recorded in `auxiliary-tooling.json`.

Four earlier successful processes (39 tests) preceded the final v26/orphan inventory additions and are retained as superseded history, not added to the accepted total. The final selection reruns all applicable files on the final implementation. The T001 nested timeout is an intentional negative probe; its outer test passes only after both descendants are gone. Prior repair failures remain in their untouched earlier evidence.

The final default process budget is 300 seconds, with 600 seconds declared for the full lifecycle file. Earlier exploratory runs used 600 seconds. Every actual budget and elapsed duration is recorded in [the evidence index](evidence/stage5-m007/README.md).

## PRODUCTION ISOLATION

Only `v1.2-phase4` is committed and pushed, using `--no-follow-tags` and `HEAD:refs/heads/v1.2-phase4`. Local main, remote main and the release freeze tag remain untouched. No production database, `.env`, credentials, schema migration, statistical threshold, deployment, scheduler or workflow was changed or activated. All test data is synthetic. Stage 6 was not started.

## COMMITS

- `a76c912e236af32b3e52e68c17322079fc9529e6` — `fix(stage5): prove authenticated insight predecessor absence`
- The containing delivery commit — `docs(stage5): record M007 repair evidence` (exact SHA in delivery response).

## NEW FINDINGS

None.

## EXACT NEXT ACTION

`RETURN_TO_SAME_FIXED_REVIEW_SESSION_B`
