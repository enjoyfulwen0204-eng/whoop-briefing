# Phase 4 Stage 5 — Blind Final consolidated repair

## VERDICT

`PHASE4_STAGE5_BLIND_FINAL_REPAIR_COMPLETE`

All seven Blind Final findings are CLOSED through the four packages below. A–N and M006/M007/M008 pass. No schema stop condition was encountered.

## IDENTITY

- Start: `532cc5858cf9ed27762a2150d04bb49458abd7e6`.
- Branch: `v1.2-phase4`; execution: SHADOW; schema: v27.
- Local main: `18530a6705744ef435be2b58c310d5cb59eec058`.
- Remote/origin main: `ecbd23287cac591e76741771d77caa3d814f84a3`.
- Release tag: `v1.2-production-release-freeze`; annotated object `4be66e4eba256622f73e204e9d43350dd7f16cff`; target `ecbd23287cac591e76741771d77caa3d814f84a3`.
- Runtime/test endpoint: `52434abc9ca97c9088e7e0d14d313710c4f2dc29`; tree `1b77c814fed92f254aa6dcee6d66825454aa8f63`.
- The delivery endpoint is the subsequent commit containing this report and its evidence. Its exact HEAD/upstream SHA, tree and clean-status verification are recorded in the delivery response. `git log -1 --format=%H -- docs/phase4-stage5-blind-final-repair.md` identifies that commit.
- Start HEAD equaled upstream. Final delivery is pushed only to `origin/v1.2-phase4`. Final fingerprints cover 392 runtime, test, script and dependency-manifest files.

## ROOT CAUSE A — PRIVACY COMPLETION

BF-H01: **CLOSED**.

Erasure has a shared physical postcondition: REDACTED, disconnected, marked, salt removed, and every sensitive field set to its explicit redaction-policy sentinel. A redaction marker alone does not satisfy it. The independent Stage 5 inventory checks every scoped sensitive row before considering readability or dependency edges. Unreadable retained content conservatively joins tenant-wide purge traversal; completion rejects it independently of naming links and purge-target membership. Missing artifact identity also prevents certification. The redactor skips work only when the physical postcondition already holds, and COMPLETE retries repeat verification.

The exact reproduction creates genuine association receipts, marks the outer receipt unreadable, removes naming links, then purges. COMPLETE must leave every receipt payload field null. A second probe restores only captured genuine bytes while omitting its target record; completion must reject. SQL no-rehydration guards are also exercised. No historical authority is invented.

## ROOT CAUSE B — AUTHENTICATED CURRENT/ABSENCE

BF-H02: **CLOSED**. BF-H03: **CLOSED**.

One lifecycle resolver inventories scoped parents, immutable revisions, v27 receipts and v26 origins under the existing limits of 1,000 rows in each inventory and 64 MiB of authority payload per user/mode scope. Signed identity and contiguous revision history establish the latest lifecycle state; signed supersession edges establish a unique lineage tip. Materialized pointer, status and lifecycle disposition must agree with that latest projection. Materialized keys may locate a candidate but never establish absence. Current reads, current/opposite association reuse, lifecycle mutation and predecessor admission use this resolver.

A sealed terminal revision 3 with a pointer/status rolled back to revision 2 rejects on both typed readers and new operations, without new derived writes or receipts. A hidden opposite is discovered from sealed identity; mutable-key divergence cannot result in a receipt containing `contradiction = null`. Mutation rejects the divergent materialization; restoring its genuine key permits the expected contradiction. A future authenticated opposite revision cannot prove absence for a new past request.

M006 terminal chronology still comes from authenticated retired time; M007 hidden predecessors retain authenticated lineage discovery; M008 wrong-family hints remain identity errors after authority validation. Exact historical receipts continue to replay their original complete result, even after later lifecycle changes. Internal producer dependency validation can be deferred only to the same transaction's commit validation boundary while genuine producer evidence is being assembled; there is no read-time repair.

## ROOT CAUSE C — JOURNAL TYPED AUTHORITY

BF-M01: **CLOSED**.

Public Journal classification enumerates active coverage candidates under a bound and resolves every candidate through `core.root(..., 'JOURNAL_COVERAGE', ...)`, the same canonical lineage authority used by the typed coverage reader. It no longer accepts raw coverage rows as classification authority. Self-cycles, missing roots, invalid root revisions, invalid factors and foreign-user predecessors reject in both paths with unchanged database snapshots and no context leases. Valid typed coverage still supports CONFIRMED_UNEXPOSED. After a legitimate correction has scrubbed its predecessor, classification now returns the same CONTENT_REDACTED failure as the typed reader until an intact lineage is available. The older Journal assertion that bypassed this authority was replaced with typed-reader/classifier parity and zero-write assertions; validation was not relaxed.

## ROOT CAUSE D — REQUEST CANONICALIZATION

BF-M02: **CLOSED**. BF-M03: **CLOSED**. BF-L01: **CLOSED**.

The request contract declares set and time fields by operation and full path. Undeclared arrays preserve order, including domain-like names inside arbitrary explanation JSON. Path segments escape literal slash, tilde and wildcard characters, so arbitrary property names cannot impersonate domain paths. Evidence admission and dependency capture also use declared domain fields; evidence-like JSON property names do not become references. Receipt identity and performed arguments share the same normalization.

Body Energy validates its optional exact instant representation then removes redundant `asOfUtc`; accepted public offset spellings remain equivalent. Insight identity uses the same six-field Unicode/case/whitespace normalizer as its domain identity key, applied once to the same captured input in each boundary. NFC followed by lowercase is not universally idempotent: a second pass could change a legacy key. The INSIGHT_CREATE receipt profile `domain-insight-identity-once-v1` distinguishes already-normalized identity from older raw request authority. Replay normalizes older raw authority once and preserves newer canonical authority verbatim; domain creation retains the original captured input for its own single pass. Genuine pre-repair Unicode keys therefore retain active-family exclusion and valid successor linkage. No key namespace or historical signature is rewritten. A bounded authenticated equivalence lookup permits genuine pre-repair aliases to replay original receipts without replacing or re-signing authority; ambiguous equivalence fails closed.

Domain/provenance/receipt set ordering now uses exact UTF-16 code-unit comparison, with equality only for identical strings. Opaque source IDs are not Unicode-normalized or collapsed. Historical manifests retain their original authenticated bytes and ordering; validation checks uniqueness and the existing signed content, counts, byte bounds, versions and roots instead of requiring the current writer's sort order.

## PRIOR CONTRACT REGRESSION

M006: **PASS, 13/13**. M007: **PASS, 17/17**. M008: **PASS, 15/15**. The same final source preserves authenticated terminal chronology, hidden predecessor discovery, requested-family matching, complete historical replay and zero-write rejection. The seven temporal regressions and full lifecycle suite also pass.

## A–N MATRIX

| Group | Result | Executable evidence |
| --- | --- | --- |
| A Complete result oracle | PASS | closure, lifecycle, operation-surface, blind lifecycle and canonical replay |
| B Add-a-column | PASS | closure |
| C Reader × authority fault | PASS | readers, review-b-admission, rc7, M006/M007/M008, blind lifecycle |
| D Complete request dimensions | PASS | contracts, closure, review-b-scope-json, blind canonical |
| E Representation equivalence | PASS | contracts, v27, blind canonical aliases/Unicode and genuine pre-repair receipts |
| F Legacy discovery | PASS | discovery, bounds, v25/v26/v27, M007 historical ambiguity |
| G Privacy closure | PASS | blind privacy, privacy-oracle, review-b-privacy, privacy, closure, rc7, M006/M007/M008 |
| H Null / absence | PASS | contracts, association-store, v27, final-fixture, M007, blind lifecycle |
| I Coverage lineage | PASS | blind journal, lineage, rc7, journal stores/inbound/answers/inventory |
| J Insight lifecycle | PASS | blind lifecycle, M006/M007/M008, review-b-temporal, lifecycle, insight/association stores |
| K Root completeness / scale | PASS | closure independent 360-day root oracle, bounds, M007 overflow |
| L Concurrency / fencing | PASS | M007, review-b-process, review-b-scope-json, processing-contention, foundation-isolation, contracts |
| M Migration / cutover | PASS | v25/v26/v27 including interruption/cutover tests, genuine pre-repair alias replay |
| N Process stability | PASS | all serialized final exits, 12 isolated fixture generations, normal-driver race and orphan tests |

Groups overlap; counts are not additive. The gate also includes Body Energy and intelligence component/store tests affected by request normalization and ordering.

## TESTS

**440/440 tests passed in 41 accepted processes**, including 18 independent Blind Final tests across six files. All 41 ran serially on one unchanged final source snapshot and exited 0 without signals, failures, cancellations or skips. All 23 changed JavaScript files passed syntax checks; source and documentation whitespace checks passed (raw TAP output excluded). Source fingerprints were verified after the gate. These are test/subtest counts, not assertion counts.

| Classification | Accepted final gate | Earlier baseline/development runs | Separate tool commands |
| --- | --- | --- | --- |
| PASS | 41 processes / 440 passed tests | 57 fully passing processes; 625 passed tests across all 70 processes | 23 JavaScript syntax checks |
| Logical / assertion failure | 0 | 13 processes / 24 failed tests | 0 |
| Native SIGSEGV | 0 | 0 | 0 |
| EPERM / EACCES | 0 | 0 | 1 Python cache-write EPERM |
| Unexpected timeout | 0 | 0 | 0 |
| Harness / setup tooling failure | 0 | 0 | 1 Python archive-setup incompatibility |
| Raw evidence whitespace check | 0 | 0 | 1 check flagged 8 preserved TAP blank lines |

Historical output is preserved and excluded from accepted counts: 70 processes, 649 tests, 625 passed and 24 failed. The three baseline batches contain 6 processes / 17 tests, with 1 pass and 16 expected failures. The other development batches contain 64 processes / 632 tests, with 624 passes and 8 failures. The original isolated archive of the starting commit reproduced all seven findings (four files, 15 tests, 14 failures); later baselines captured literal request-path collisions and non-idempotent Unicode identity normalization. Exact baseline test sources are retained.

Development failures include corrected synthetic fixture assumptions, M006 error-precedence integration, explicit evidence-field admission, an M007 fault injector dependent on preserved SQL formatting, and an older Journal expectation inconsistent with the typed authority now required by BF-M01. Every attempted test process, budget, duration, assertion name and raw output is retained in [the evidence index](evidence/stage5-blind-final/README.md) and [iteration ledger](evidence/stage5-blind-final/iteration-history.json). No failing run was relabeled as an accepted pass.

The archive setup initially used a Python `tarfile` option unavailable in the installed version; system tar completed setup before baseline tests ran. Separately, Python syntax compilation attempted a protected default cache directory and received EPERM; in-memory compilation succeeded without a cache write. The staged artifact whitespace check also flagged eight whitespace-only blank lines in four historical TAP logs; those logs retain their original bytes, and the final whitespace check excludes only TAP output. These are tool/artifact incidents, not native test failures. There were no test-process permission errors, native crashes or unexpected timeouts.

Each accepted test file had a declared 600,000 ms timeout, enforced on its process group by the existing serial runner. T001's nested timeout is an intentional negative probe; its outer test passes only after both descendants are gone. The final closure oracle independently verified 542 distinct roots and 128,663 canonical bytes for 360 days. Runtime: Node v22.23.2, macOS arm64; dependencies unchanged.

## SCHEMA

v27 remains unchanged. Existing v25 revisions, v26 origins and v27 receipts represent the required facts; no schema stop condition was encountered. No schema file, migration or statistical threshold was changed.

## PRODUCTION ISOLATION

Only `v1.2-phase4` is committed and pushed, using `--no-follow-tags` and `HEAD:refs/heads/v1.2-phase4`. Local main, remote main and the release-freeze tag retain the identity values above. No production database, `.env`, credentials, deployment, scheduler or workflow was changed or activated. Tests use synthetic fixtures. Stage 6 was not started.

## COMMITS

- `52434abc9ca97c9088e7e0d14d313710c4f2dc29` — `fix(stage5): close blind final authority and request gaps`
- The containing delivery commit — `docs(stage5): record blind final repair evidence` (exact SHA and final tree in the delivery response).

## NEW FINDINGS

None.

## EXACT NEXT ACTION

`RETURN_TO_SAME_BLIND_FINAL_REVIEW_SESSION_C`
