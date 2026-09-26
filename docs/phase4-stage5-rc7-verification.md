# Stage 5 RC7 repair verification

Work package: `PHASE4_STAGE5_RC7_REPAIR`. Start: `8e377dcfbc7f27f003c4e44e511051c472fceac1`, branch/upstream `v1.2-phase4` / `origin/v1.2-phase4`. Production `origin/main` and the peeled `v1.2-production-release-freeze` tag are `ecbd23287cac591e76741771d77caa3d814f84a3`. Schema remains **v26**, with no DDL or migration changes. Stage 5 remains SHADOW-only. Stage 6 has not started; implementation closure does not grant Stage 5 independent approval.

Implementation commit: `e29abd0c0202b1e064d41aeb064db5a180ff0306`.

## Starting-HEAD proof

The [retained pre-repair log](phase4-stage5-rc7-pre-repair.txt) was recorded before any runtime edits. The seven primary tests in [the permanent RC7 suite](../test/phase4-stage5-rc7.test.js) produced **0 passes / 7 behavioral failures**. The cycle child was killed by the deterministic 20-second safety deadline because the expected explicit integrity error never arrived; this is the expected logical defect reproduction, not an infrastructure timeout.

| Finding | Starting behavior | Repair |
|---|---|---|
| RC6-H-001 | Authentic snapshot returned after required root + naming edges were deleted and `algorithm_version` was changed | Mandatory v26 validation selected by authenticated snapshot semantics, never mutable registration |
| RC6-H-002 | Real Journal purge left the returned insight revision PRESENT after evidence-edge loss | Authenticated original targets and their scoped owned revisions join privacy traversal |
| RC6-H-003 | Parseable manifest with a removed root and invalid HMAC retained authority | Shared cryptographic verifier; corrupt payload cannot supply roots, targets or retention decisions |
| RC6-M-001 | Original INSUFFICIENT_QUALITY / novelty false / meaningfulness 0.85 replayed NO_MEANINGFUL_CHANGE / true / 1 | Versioned authenticated exact null-result calculation projection |
| RC6-M-002 | Historical September 25 insight reported September 26 on replay | Original revision's semantic timestamp projection is sealed with the result |
| RC6-M-003 | Negative-offset spelling selected a different duplicate-day baseline sample and median | Parse the health version tuple and normalize its timestamp components before comparison/identity |
| RC6-M-004 | Self-cycle failed to terminate | Iterative scoped lineage traversal, visited identities and explicit integrity error |

The final permanent primary tests were also copied into an isolated `git archive` of the exact starting SHA: [second immutable-checkout proof](phase4-stage5-rc7-final-tests-on-start.txt), again 0/7 passing with seven expected behavioral failures.

An initial M002 test setup used references branded to an earlier context. That harness defect was corrected before the final seven-failure pre-repair recording; it is not counted as a defect reproduction. The runtime remained unchanged throughout both pre-repair runs.

## Generic history trust chain

Current branded user/mode/lifecycle/auth/input/purge/lease authorization remains the outer transaction boundary. The v25 snapshot must authenticate before its semantic discriminants can be used. A signed `METRIC_DEVIATION` snapshot requires the `METRIC` authority for its signed latest evidence identity, including its original membership/event binding and every required root. Every supplemental evidence reference in a metric snapshot must also have v26 authority; all its recorded result scopes are validated through the same verifier, independent of run algorithm or method metadata. Missing supplemental authority fails unavailable. Successful RC3/RC4/reuse fixtures now compute genuine registered evidence instead of bypassing authority with synthetic registrations. V25 snapshot/event/structural provenance and current readability are still required. Evidence-specific replay additionally requires the requested revision to equal the authenticated original result.

`algorithm_version` never disables validation. Known, unknown, malformed and changed registration values may describe the registration; a safe generic structural read still traverses the complete authority chain. Missing required authority returns `PHASE4_EVIDENCE_RESULT_AUTHORITY_UNAVAILABLE`; readers never recreate it. Unknown authority or payload formats fail closed.

The Foundation's low-level non-metric synthetic snapshot primitive remains structurally distinct: its **signed** snapshot does not claim to be a Stage 5 metric calculation. No unauthenticated registration value selects that distinction. A synthetic Foundation refresh of an existing metric episode still creates its v25 snapshot, but cannot manufacture a v26 calculation result. The RC4 refresh fixture now checks the authentic full snapshot and generation fences while explicitly expecting exact metric history to be unavailable. This tightens the historical-read contract without inventing authority or implementing Stage 6 refresh computation.

## Privacy and corrupt authorities

Read and purge use the same v26 envelope, identity, version, canonical payload, HMAC and scoped parent-commitment verifier. Purge runs under its separately branded privacy controller: it does not require deleted roots to remain readable or old creation generations to match the newly admitted purge. Cryptographic verification is unchanged.

For a valid authority, the flattened authenticated roots contribute traversal-only edges to the authority, item, run, **original result target**, and scoped owned result history:

- `METRIC`: exact episode ID, revision and producing event; the v25 snapshot HMAC is verified. The owned episode snapshots, events, observations and memberships are included for conservative erasure of the logical artifact.
- `INSIGHT_CURRENT` and `INSIGHT_CONTRADICTION`: exact insight ID and revision; stored revision bytes must equal the authenticated `revision_json`. The owned insight and revision history are included, including interim revisions created in the same result transaction.
- An authenticated null has no original artifact target; it still has sensitive evidence/authority content subject to redaction.

No origin is selected from today's current pointer. No lost source link is reconstructed in storage. Both insight scopes, metric Journal dependency, association-to-association support, root-edge loss, revision-edge loss and repeated purge are permanent tests.

If the authority payload does not authenticate, none of its JSON is used for traversal or retention. Scoped authority/item/run registry identity must still agree. The independently keyed calculation manifest (`input_manifest_hash` plus deterministic run key) supplies bounded direct inputs; same-user/same-mode memberships and revision evidence references bound conservative invalidation of associated artifacts. Independently authenticated v25 event references and scoped prior insight evidence also carry transitive dependencies into this fallback. Already erased target content is not required to remain readable to perform a later purge. These relationships permit erasure only, never read authorization or inference of an original result. Corrupt payload cannot nominate another tenant, mode or arbitrary target. Unrelated user/mode evidence remains byte-identical in the adversarial test.

If that independent scoped fallback cannot authenticate, discovery fails with `PHASE4_PURGE_AUTHORITY_INVALID`; the redaction transaction rolls back and the ledger stays ADMITTED under the privacy fence. It cannot report DB_REDACTED or COMPLETE. Failure injection after an insight redaction proves rollback of all durable health rows, followed by safe successful retry. Normal complete redaction erases authority payloads, hashes, salts and sensitive revision content; SQL no-rehydration guards remain active.

## Exact result projections within existing v26 JSON

No columns, tables, checks, triggers, indexes or schema versions changed. The SQL envelope remains `evidence-result-authority-v1` and its existing HMAC domain. Explicit nested payload versions evolve within its already authenticated flexible JSON:

- `stage5-null-metric-result-v2`: `{ version, origin: null, calculation }` contains the existing API's full deterministic calculation object, including classification, novelty, meaningfulness, quality, components and null target. It is written atomically with the original evidence/authority. Replay returns these authenticated original values, never a calculation using today's episode. Baseline/quality/evidence still validate against the deterministic input/item commitments.
- Old signed bare-null metric authorities lack the original active-episode calculation context. They remain authenticated absence, but exact calculation replay returns unavailable. Missing, legacy, corrupt and redacted authority retain their respective fail-closed paths; an uncomputed request can create a new first result. No backfill is performed.
- `stage5-insight-result-v2`: the existing exact insight/revision binding also seals `last_recalculated_at` and `retired_at` from the original returned revision projection. These are the already persisted semantic values used by the transition, captured before later changes can overwrite the materialized row. Request `asOfUtc`, processing time and revision operational `created_at` never substitute for them. Old insight bindings without that exact semantic projection remain authenticated targets for purge, but exact projection replay is unavailable.

Degraded, ordinary no-change and warming null results are tested across restart, later episodes and different processing clocks. The durable metric API requires an actual current source, so it cannot emit a NO_DATA request with a missing current source; that pure quality-calculator state is not an additional persistence contract.

## Timestamp ordering

The existing adapter source version grammar is a JSON tuple `[updated_at, synced_at, as_of_utc, score_state]`. Only recognized four-component tuples with valid timestamp/null components are normalized. Opaque strings and malformed/unrecognized tuples keep their existing representation and validation behavior. Arbitrary version strings are not parsed as ISO timestamps.

Sampling and provenance share the comparator: health date descending, observation instant descending, canonical version tuple descending, stable source ID/type, canonical ingestion instant, and value tie-breaker. Adapter timestamps are normalized before quality, manifest and identity construction. Tests compare UTC, negative and positive offsets, reversed caller order, selected samples, provenance, manifest bytes, run/item identity, median/z/classification and exact replay. Different instants and score-state discriminators stay distinct.

`stage5-required-roots-v2` explicitly identifies normalized timestamp commitments for newly captured health roots. Existing v1 manifests retain their original byte/commitment rules and are still verified as v1; there is no rewriting or resealing. Root content hashes still detect genuine version/content replacement.

## Coverage lineage

Both forward authority validation and backward as-of selection use one tenant-scoped iterative lineage loader. Ancestor and descendant visited sets reject cycles explicitly; missing predecessors and impossible revision/time ordering reject with `PHASE4_COVERAGE_LINEAGE_INVALID`. No recursive `UNION ALL` or unguarded predecessor loop remains. A 100,000-node ceiling matches the existing privacy graph corruption limit and is not a small product history-depth limit; reaching it errors rather than truncating coverage.

Self, two-node and three-node cycles run in child processes with a deadline as a secondary safety oracle. A 150-revision acyclic history, a branch with a shared predecessor, historical selection in the middle, missing predecessor and recreated core are tested. The one-predecessor schema cannot encode a two-parent diamond; shared ancestry is tested without treating it as a cycle.

## Regression coverage

| Findings | Required evidence |
|---|---|
| S5-H-001 | Historical Journal facts/coverage, correction, privacy precedence; new bounded lineage cases |
| S5-H-002 | Outcome-independent comparison universe and missing/invalid denominators |
| S5-M-003, RC2-M-002 | Original caller permutation gates plus full timezone-version identity/replay tests |
| S5-M-004 | Inclusive continuity and explicit expiry |
| S5-M-005 | DEGRADED cannot support an episode/insight; exact degraded null projection |
| S5-M-006, RC2-M-001 | Required semantic time, processing-clock independence, normalized expiry/replication/continuity, original insight time and normalized baseline versions |
| S5-M-007 | Versioned durable confidence/reload validation |
| S5-L-008 | Statistical threshold boundaries |
| S5-H-009 | Positive and null metric history, insight history, original times, forward current state and mandatory roots |
| RC2-H-001, RC3-H-001 | Full immutable v25 snapshots and unavailable absent legacy history |
| RC2-H-002, RC4-H-001 | Authentic original origin despite later legitimate reuse and forged membership |
| RC4-H-002 | Required root deletion plus complete naming-edge deletion |
| RC4-M-001 | Equivalent expiry instants and exclusive boundary |
| All seven RC6 blockers | Primary pre/post tests plus RC7 matrices above |

## Execution ledger

The [machine-readable ledger](phase4-stage5-rc7-test-results.json) records **2,656/2,656 passing tests in 152 files**, with **0 accepted failures, 0 cancellations and 0 skips**. Each repository file ran serially in a separate process with a 600-second deadline. Required gates below overlap and are not additive.

| Gate | Files | Passed |
|---|---:|---:|
| RC7 adversarial | 1 | 23 |
| RC6 authority | 1 | 23 |
| RC5 reproductions | 1 | 3 |
| RC4 history | 1 | 13 |
| RC4 blockers | 1 | 5 |
| RC3 diagnostic | 1 | 1 |
| RC2 adversarial | 1 | 10 |
| Complete Stage 5 focused | 12 | 152 |
| Foundation + Stage 5 aggregate | 33 | 338 |
| Associations | 2 | 23 |
| V26 migration | 1 | 22 |
| V25 history | 1 | 25 |
| Multi-user | 3 | 48 |
| Lifecycle / generations | 5 | 162 |
| Journal / privacy | 9 | 84 |
| Body Energy | 2 | 24 |
| Repository-wide | 152 | 2,656 |

The initial sweep reported 2,634 passes and 22 failures across 2,656 tests. Failure classes: one logical/application failure (nullable pure observation normalization), 19 mocked-server loopback EPERM failures across 5 files, and two RC4 fixture failures. **No SIGSEGV/native termination or unexpected timeout/process failure occurred.** The pre-repair cycle deadline is separately classified as an expected logical reproduction.

All affected files passed their final reruns. Nullable observations retain the prior exclusion behavior. The RC4 CAS fixture now supplies genuine registered evidence; the non-metric synthetic Journal fixture uses its original synthetic evidence helper. These fixture changes retain CAS, exact snapshot, purge, rollback and read-only assertions. The metric persistence suite also reran 25/25 after the final generic-history hardening. The ledger retains initial file results, accepted replacements, development-run classifications and raw-log SHA-256 hashes.

All 344 JS/MJS syntax checks pass. `git diff --check` and the changed-file credential/debug scan pass. Runtime hashes match the final verified source. Migration and RC7 privacy fixtures report `PRAGMA integrity_check=ok` and empty foreign-key checks.

All fixtures are synthetic local databases. Production databases, main, the release tag, providers, scheduler/deployment configuration, `.env`, flags and environment configuration remain untouched. Migration coverage includes fresh install, populated v25→v26, v20→v26, interruption recovery, idempotent rerun, frozen populated cutover and zero backfill.

All 24 findings in the regression table are implementation-CLOSED. RC6-L-001's stale schema allocation text is also corrected or explicitly identified as historical. This is implementation verification only: Stage 5 remains NOT APPROVED pending independent RC7 review, Stage 6 remains UNSAFE, and no production release is authorized.
