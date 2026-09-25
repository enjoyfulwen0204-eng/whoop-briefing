# Stage 5 RC6 — Durable Result Authority

Work package: `PHASE4_STAGE5_RC6_DURABLE_RESULT_AUTHORITY`. Starting commit: `769d323ffa20f0f744960a0c47c3da1cac827e3b`, branch/upstream `v1.2-phase4` / `origin/v1.2-phase4`. Production `origin/main` and the peeled release-freeze tag remain `ecbd23287cac591e76741771d77caa3d814f84a3`. Stage 5 remains SHADOW-only; Stage 6 has not started.

## Architecture and schema

The authoritative allocation is v25 Stage 5 revision history, v26 Stage 5 durable result authority, v27 Stage 7 Quick Actions / TRUSTED_REGISTRY / Journal source-kind, and v28 Stage 8 Owner Monitoring / Family View. The latter two versions remain specifications only.

V26 adds `phase4_evidence_result_authorities`, with a NOT NULL composite primary key `(user_id, execution_mode, evidence_item_id, result_scope)` and `WITHOUT ROWID`. The existing metric adapter explicitly permits one original episode membership per evidence item. Association analysis can return an independently replayable current insight and opposite-direction contradiction; scopes `INSIGHT_CURRENT` and `INSIGHT_CONTRADICTION` distinguish them. `METRIC` identifies the metric result. Null origins are authenticated absence, preventing later computation from silently acquiring a previously absent result.

The row contains evidence/run identity, scope, format version, immutable original-result JSON, a complete versioned required-root manifest, salted input/item commitments, authority HMAC, input/lifecycle/auth/purge generations, the standard privacy artifact envelope and operational creation time. Metric origin binds episode ID, original revision and revision-producing event. The previous semantic hash used at original computation is an immutable calculation input, so later membership ordering cannot alter historical novelty. Insight origins bind the exact returned revision bytes, including terminal or contradictory results; replay no longer scans later evidence references to infer an origin.

Three indexes cover unique scoped privacy artifact identity, run lookup and privacy state/generation. Ten triggers protect mode, duplicate/REPLACE insertion, deletion, immutable identity/content, monotonic redaction/no rehydration, redaction plaintext absence and scoped completed-run/item parents. The duplicate guard covers both primary and unique artifact keys. WITHOUT ROWID removes the rowid replacement alias. Present rows must be SHADOW, JSON-valid, complete and linked; redacted payloads and salt must be null. Existing v21–v25 schema definitions remain frozen.

The existing injected audit key authenticates all authority-critical fields through the domain `evidence-result-authority-v1`; input, item and root commitments use separate domains. No secret, key storage, environment fallback or runtime activation was added. User/mode/item/run/scope/origin/version/generation/privacy identity changes invalidate the seal. Snapshot HMAC remains its separate v25 trust layer.

## Four replay trust layers

1. **Original result authority:** deterministic evidence resolves an immutable v26 origin. Membership must agree with that origin and cannot select another revision. No read repairs storage.
2. **Required-source authority:** every manifest root must still exist, be readable in the current tenant and satisfy its source-version/content commitment and Journal as-of rules.
3. **Snapshot integrity:** the original episode revision must have its authentic v25 snapshot and exact event and structural graph bindings. Missing snapshots are not reconstructed from authority payloads. Insight result bindings similarly require the recorded revision bytes.
4. **Current authorization/privacy:** branded contexts, lifecycle/auth/input/purge/lease fences, resource access, tombstones and current parent readability remain mandatory. Authenticated history never overrides current privacy.

The generic Foundation snapshot primitive remains a revision-addressed persistence API. Unregistered synthetic Foundation evidence does not acquire fabricated deterministic Stage 5 authority. Evidence-specific replay always requires v26; generic snapshot reads involving registered Stage 5 evidence also validate its root authority.

## Required-root completeness

The model is a canonical **flattened calculation-input closure**, never a traversal of surviving source links:

| Calculation input | Required semantic roots |
|---|---|
| Metric evidence | Current observation and every supplied baseline/quality input, including exclusions, sufficiency and persistence inputs |
| Prior episode state | Authenticated same-generation revision history and the evidence/root references contributing to it |
| Association family | All hypotheses contributing to multiplicity adjustment, not only the focused hypothesis; supplied outcomes including invalid/missingness inputs and retained authoritative Journal facts/coverage |
| Prior insight state | Supporting and contradicting evidence across the returned insight's same-generation revision history |
| Dependent evidence | Complete versioned run manifest plus any existing authenticated flattened authority; legacy run manifest/hash/key are verified without asserting an origin |
| Body Energy | Authenticated versioned manifest: selected sleep/recovery, baseline samples, cycle/workout load, naps and retained exclusion identities |

Roots preserve stable type/identity and inherited user scope, explicit mode, source version, Journal semantic as-of where applicable, and a salted content commitment. The existing source-version tuple is retained. Mutable operational/privacy transitions are excluded from root content identity and validated independently by the current privacy rules. Unknown manifest contracts or excessive/incomplete closures fail before commit.

Operational diagnostics and incidental graph rows are auxiliary. Losing one root-index edge is tolerated if roots/manifest validate and existing minimum graph connectivity holds. Snapshot→event, snapshot→episode and event→evidence bindings remain required: edge-only corruption there rejects. Both policies are permanent tests. Neither policy changes the manifest after an edge disappears.

## Pre-repair proofs and finding closure

[The retained starting-HEAD log](phase4-stage5-rc6-pre-repair.txt) comes from an isolated `git archive` of the exact required SHA, using synthetic fixtures and the same installed dependencies. The permanent reproduction suite yields **0 passes / 3 logical failures**, all missing expected rejection:

- **RC4-H-001:** A creates R1. An authentic R2 event and snapshot genuinely reference A+B, with A still a legitimate latest reference. Only A's membership is forged to R2, its schema guard restored, and core/store restarted. Baseline returns R2; repaired replay rejects without durable mutation. R2/R3/R4 legitimate reuse separately preserves A→R1.
- **RC4-H-002:** a required baseline root is deleted, then every graph edge naming it is removed. After restart baseline accepts the historical snapshot. V26 still knows the root is required and rejects. Independent version and cross-user substitutions also reject.
- **RC4-M-001:** canonical expiry rejects while the equivalent negative-offset instant is incorrectly current on baseline. Canonical UTC normalization now preserves the exclusive expiry boundary across Z, both offsets and fractionless representations.

Snapshot-without-authority returns `PHASE4_EVIDENCE_RESULT_AUTHORITY_UNAVAILABLE`; authority-without-snapshot returns `PHASE4_EPISODE_HISTORY_UNAVAILABLE`. Neither path falls back to current membership, current episode values, minimum/maximum referenced revision or timestamps. HMAC/version/salt/identity/generation corruption and scoped transplants reject even after SQL guard bypass.

## Legacy cutover and migration

No backfill exists. The populated [cutover fixture](../test/fixtures/stage5-v25-cutover.json) was exported from the original runtime at the starting SHA after genuine R1/R2/R3 calculations. The test loads those frozen synthetic bytes into v25, restores every exact schema guard, and verifies integrity/FKs before migration. V26 preserves evidence, memberships, events, snapshots and the current episode byte-for-byte and creates zero authorities. A new B creates R4 and its own authority atomically; B/R4 survives later mutation and restart. Reused legacy A remains origin-unavailable, with no authority created for it.

Fresh install, v25→v26 and full v20→v26 paths preserve unrelated user data and add no fabricated authority. Every v26 durable boundary (table, three indexes, ten triggers and version-row write) is interrupted, reopened, resumed and rerun. The migration ledger advances only after exact definitions and data postconditions. Integrity and foreign-key checks pass in the migration fixtures. Recorded schema drift fails without repair.

## Privacy, transactions and isolation

Authority is part of the existing derived-artifact inventory and redaction matrix. Direct links to flattened roots and evidence preserve privacy traversal. The immutable manifest also contributes traversal-only privacy edges to its authority, run and item, so removing every mutable edge naming a Journal root cannot strand those payloads. Malformed manifests conservatively redact only the same tenant’s affected authority/result; they cannot grant reads. No graph row is reconstructed. Journal/transitive/repeated purge, including after naming-edge loss, erases original result JSON, root manifest, HMAC, input/item commitments and salt. Redaction is monotonic; rehydration and subsequent reconstruction are rejected. Health-root deletion also makes retained authority unreadable under existing source/generation rules. Privacy availability takes precedence over replay.

Failure injection after evidence item, run completion, membership, event, materialization, v25 snapshot, v26 authority and source-link writes rolls back the first result. Existing RC4 revision-update injection and CAS tests remain. Concurrent exact first computation converges on one item, origin and snapshot; revision CAS admits one winner. Replay leaves durable result tables unchanged.

User/mode substitution, copied valid authority, source-version replacement and current lifecycle/auth/input/purge fences are covered. No LIVE authority rows are created. Existing lifecycle ABA, context lease, Journal and Body Energy gates remain required.

## Regression mapping

| Finding | Retained closure/coverage |
|---|---|
| S5-H-001 | Journal revision/coverage semantic as-of and privacy precedence |
| S5-H-002 | Outcome-independent universe and missing/invalid denominators |
| S5-M-003 / RC2-M-002 | Full baseline/association permutation determinism |
| S5-M-004 | Inclusive 36-hour continuity and explicit expiry |
| S5-M-005 | DEGRADED non-support |
| S5-M-006 / RC2-M-001 | Explicit semantic clocks before shortcuts |
| S5-M-007 | Durable versioned confidence and reload validation |
| S5-L-008 | Statistical boundary behavior |
| S5-H-009 | Revision-pure metric and association replay after later revisions |
| RC2-H-001 / RC3-H-001 | Full v25 history, immutable snapshots and no legacy reconstruction |
| RC2-H-002 / RC4-H-001 | Authenticated original origin despite genuine later reuse and forged membership |
| RC4-H-002 | Required roots survive root-plus-edge deletion knowledge loss |
| RC4-M-001 | Equivalent-instant currentness and exclusive expiry |

## Executed verification

The [final per-file ledger](phase4-stage5-rc6-test-results.json) records **2,633 passing tests across all 151 repository test files**, with **0 accepted failures, 0 cancellations and 0 skips**. Gates overlap and are not additive. Standard invocation is `node --test --experimental-test-isolation=none --test-force-exit --test-concurrency=1 FILE`, one file/process at a time, with a 600-second deadline. The original 95-test Stage 5 gate also passed as one serialized aggregate before the final hardening additions.

| Final accepted gate | Files | Passed |
|---|---:|---:|
| Stage 5 focused | 10 | 121 |
| Foundation + Stage 5 | 31 | 307 |
| RC6 authority adversarial | 1 | 23 |
| RC5 defect reproductions | 1 | 3 |
| RC4 snapshot/history / blockers | 2 | 18 |
| RC3 diagnostics / RC2 adversarial | 2 | 11 |
| V26 migration, interruption and cutover | 1 | 22 |
| V25 migration/history | 1 | 25 |
| Association | 2 | 23 |
| Multi-user | 3 | 48 |
| Lifecycle | 5 | 162 |
| Journal/privacy | 8 | 79 |
| Body Energy | 2 | 24 |
| Repository-wide | 151 | 2,633 |

The initial sweep reported 2,601 passes and 20 failures across 2,621 summarized tests: 19 loopback `listen EPERM` failures in five mocked-server files, plus one SQLite test-helper error from ordering the new WITHOUT ROWID table by `rowid`. The helper now orders by actual primary-key columns and retains its unchanged-database assertion. One additional file (`multiuser-cron`) terminated with native SIGSEGV before a complete summary; no missing counts were invented. There were **0 timeouts**. All seven affected files then passed in an independent serialized rerun: **103/103**, with loopback permitted for mocked HTTP servers. The ledger preserves initial classifications, accepted replacements, earlier development fixture corrections and SHA-256 hashes of the local raw logs.

All **339 JS/MJS files** pass syntax checks. `git diff --check`, migration integrity/FK assertions and the added-content secret/debug scan pass. The sole whole-file debug-pattern match is unchanged pre-existing test diagnostics. Deployment/configuration files have no changes.

All tests use synthetic local memory or temporary-file databases. Production databases, main, the release tag, schedulers, providers, configuration and feature flags remain unchanged. The 13 Foundation defaults remain false; no local/process Phase 4 flag overrides are present. No Stage 6–8 functionality was added.
