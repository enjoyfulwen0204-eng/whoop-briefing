# Phase 4 Stage 5 RC4 — durable episode revision history

Historical verification record: original-result and complete required-root authority claims are superseded by the [v26 RC6 repair](phase4-stage5-rc6-verification.md). V25 snapshot integrity remains required but is not sufficient for evidence replay.
Work package: `PHASE4_STAGE5_RC4_DURABLE_REVISION_HISTORY`.
Starting commit: `5e4269533fd0add72bbea7f651307ec80dc758a8` on `v1.2-phase4`.
Production baseline and peeled release tag: `ecbd23287cac591e76741771d77caa3d814f84a3`.
Schema: v24 → v25. Authority: SHADOW-only; all Foundation flags remain off.

## Architecture decision

The Architecture Owner explicitly replaced the old reservation:

| Version | Owner / scope | Status |
|---|---|---|
| v25 | Stage 5 RC4 full episode revision history | Implemented SHADOW-only |
| v26 | Stage 7 Quick Actions, TRUSTED_REGISTRY, Journal source-kind/provenance | Reserved; no functionality implemented |
| v27 | Stage 8 Owner Monitoring / Family View persistence | Reserved; no functionality implemented |

The [authoritative ADR](phase4-architecture.md) and stage graph use this allocation throughout. Earlier RC1/RC2 verification records remain historical evidence, not the current replay contract.

## Schema and immutable authority

`phase4_episode_revisions` has the existing R privacy envelope plus:

- `user_id`, `execution_mode`, `episode_id`, `revision`: compound primary identity;
- `episode_event_id`: unique within user/mode, bound to the origin's episode/revision/input generation;
- `snapshot_version = episode-revision-v1`, `semantic_at`, `snapshot_json`, `snapshot_hash`;
- `input_generation`, `lifecycle_generation`, `auth_generation` and R `purge_generation`;
- operational `created_at` and a separate per-snapshot digest salt.

The full canonical payload includes its version, explicit semantic time, the complete semantic episode projection and the originating event projection. Existing recursive `canonicalJson` sorts object keys at every depth; arrays retain meaningful order. The integrity value uses the existing application-held audit HMAC plus a per-artifact salt. Reads verify the persisted bytes, never normalize and silently accept a changed encoding. Unknown format, malformed JSON, missing/extra columns, wrong types, identity mismatch, altered event, invalid hash and missing required provenance edges fail closed.

Indexes cover scoped privacy identity (unique), privacy state/generation and episode semantic time. A unique `(user_id, execution_mode, episode_id, resulting_revision)` event index removes ambiguous event authority. Table uniqueness also prevents multiple snapshots for one origin event. Compound parent triggers follow the repository's same-tenant/same-mode trigger conventions instead of introducing a separate FK model.

Triggers enforce mode/owner/envelope immutability, content append-only behavior, redaction with no retained payload/hash/time, permanent non-rehydration, scoped origin parents, immutable metric identity and sealed current-revision semantics. V25 installs a versioned replacement of the v23 monotonic episode trigger, then retires the old trigger. Frozen v21–v24 definitions remain unchanged and independently verifiable. Privacy invalidation can mark an active episode as an unreadable INVALIDATED tombstone without incrementing its semantic revision.

## Exhaustive episode column classification

Every current `observation_episodes` column is classified here. The production projection and independent test projection exclude only the explicit C/D lists. Any future column participates automatically and must be classified when added; a reader cannot omit it silently.

| Class | Columns | Historical handling |
|---|---|---|
| A — stable identity | `user_id`, `execution_mode`, `episode_id`, `privacy_artifact_id`, `fingerprint`, `episode_family_key`, `domain`, `subject_key`, `direction`, `reopens_episode_id`, `reverses_episode_id`, `opened_at` | Included in snapshot; checked against stable materialized identity |
| B — revision semantics | `revision`, `episode_type`, `state`, `severity`, `current_confidence`, `current_novelty`, `explained_status`, `explanation_evidence_item_id`, `explanation_context_id`, `first_observed_at`, `last_observed_at`, `last_material_change_at`, `stabilization_started_at`, `resolved_at`, `expires_at`, `invalidated_at`, `health_window_start`, `health_window_end`, `timezone`, `latest_evidence_item_id`, `resolution_reason`, `semantic_summary_hash`, `explanation_json`, `current_context_json`, `last_semantic_event_id`, `max_semantic_severity_ordinal` | Exclusively snapshot-authoritative |
| B — revision authority | `input_generation`, `lifecycle_generation`, `auth_generation`, `purge_generation` | Persisted with the revision; current authorization remains mandatory |
| C — operational/privacy controls | `created_at`, `updated_at`, `content_digest_salt`, `content_state`, `source_linkage_state`, `health_content_redacted_at`, `health_content_redaction_reason`, `source_subject_deleted_at` | Not historical semantics; current readability controls always apply |
| D — materialized delivery pointers | `last_question_id`, `last_delivered_notification_id`, `last_ambiguous_attempt_id` | Null in historical projection; excluded from semantic equality |

`last_semantic_event_id` and the maximum semantic severity are included, not treated as delivery conveniences. Eligible semantic events update them within the revision transaction before the snapshot is sealed. A standalone `semantic` call may replay an existing matching event; it cannot attach a new event to or mutate a sealed revision. Changed uncertainty/action/claim fields cannot exploit semantic-event idempotency.

## Write and replay contracts

Open/R1, revise (including explanation/context updates), reversal, expiry, continuity transitions and complete generation refresh all persist the origin event and full post-mutation snapshot through the existing processing transaction. Any failure rolls back state, event, snapshot and source links together. A privacy tombstone creates no semantic revision. No Stage 6 worker or new scheduler is involved.

Required semantic time is validated before duplicate, prior-event and no-op success. Missing time returns `PHASE4_SEMANTIC_TIME_REQUIRED`; malformed time returns `PHASE4_SEMANTIC_TIME_INVALID`. No migration/creation/update/wall-clock timestamp substitutes for revision semantic time. V25 change identity includes the expected revision, canonical sources, complete requested mutation and semantic time, so a state transition's exact retry cannot become a second revision after its state changes.

Metric replay resolves deterministic evidence before consulting current chronology, then verifies the unique readable membership and observation, exact full snapshot, legitimate origin event, authorized evidence IDs and direct source-link bindings. The same-time A→R1 / B→R2 adversary proves that semantic-time agreement and existence of R2 cannot authorize A at R2. Corruption returns `PHASE4_DURABLE_REPLAY_BINDING_INVALID`; it never moves membership, looks for another revision or repairs storage.

The materialized episode is consulted for current authorization, stable identity, latest-revision consistency, operational metadata and the canonical branded artifact reference. It supplies no historical revision-owned value. Historical and original canonical episode results both contain `{row, ref}` with the same stable reference identity. R1/R2/R3 replay after store/core recreation remains exact, and later current state stays forward.

Baseline sampling and quality provenance share `compareBaselineSources` before any manifest/hash/run/item identity construction. Original, reverse and additional permutations produce identical complete outputs. Exclusions and duplicate-day selection also use this order; meaningful source/version differences remain visible and the duplicate-input contract is retained.

## Legacy v24 and migration

No v25 backfill exists. Pre-v25 revisions without snapshots return `PHASE4_EPISODE_HISTORY_UNAVAILABLE`, including a still-current v24 revision. Current values, incomplete events, source links and processing time cannot recover overwritten history.

The first legitimate post-v25 mutation of a readable legacy episode records its complete known post-mutation state. Unchanged values from its known current state are legitimate new-revision values; they are never projected backward. Its earlier revisions remain unavailable permanently.

Fresh install, v20→v25, v24→v25, version re-run and recorded-definition drift are tested. Every durable migration boundary is interrupted and reopened: table, all indexes/triggers, replacement installation/removal and the version-row write. The version is withheld until all postconditions pass. A populated synthetic v24 episode is preserved byte-for-byte by migration, gains no history row, rejects old-revision replay and gains exactly one snapshot when legitimately revised afterward. SQLite integrity and foreign-key checks pass.

## Privacy and authorization

Snapshots are registered in the existing derived-artifact inventory and R redaction matrix. Each is linked directly to its episode and origin event; those retain the health/Journal dependency graph. Journal purge transitively nulls payload, integrity hash, semantic time and digest salt. The R1→later-revisions→purge proof rejects R1/R2 afterward, checks physical removal of the stored historical content and rejects rehydration. Current values never serve as fallback. WHOOP root deletion also fences historical reads through existing input-generation/provenance checks. No parallel purge mechanism is introduced.

All reads retain current tenant, mode, lifecycle, auth, input, purge and context-lease checks. ABA/stale contexts fail; fresh unchanged-generation contexts succeed. Two-user historical replay and SHADOW/LIVE boundaries remain covered. Public Foundation authority cannot issue LIVE contexts, and Stage 5 intelligence rejects LIVE even in the explicitly isolated test factory.

## Pre-fix / post-fix evidence

The exact starting SHA was exported with `git archive` to a temporary isolated directory, using only synthetic fixtures and the installed dependencies. The new blocker tests were copied there without changing the baseline source.

| Finding | Starting SHA proof | v25 proof |
|---|---|---|
| RC2-H-001 | R1 replay contains later explanation/context values | Complete semantic equality plus stable artifact reference after overwrite/restart |
| RC2-H-002 | Forged A membership borrows legitimate B revision at the same semantic time | Exact event/evidence/snapshot/source-link binding rejects it |
| RC2-M-001 | Duplicate operation succeeds without semantic time | Required/malformed-time errors precede prior-event and no-op success |
| RC2-M-002 / S5-M-003 | Reversed source order changes quality provenance and identity | Complete equality across permutations, including exclusions |
| RC3-H-001 | No authoritative table; diagnostic markers disappear from every durable table after overwrite | Markers exist only in full snapshot history and exact replay survives restart |

The five blocker tests produce 0 passes / 5 logical failures on baseline and 5 passes / 0 failures after repair. The independent RC3 overwrite diagnostic produces 0 passes / 1 logical failure on baseline and 1 pass / 0 failures afterward. This proves prevention of future information loss; it makes no recovery claim for missing v24 values.

## Finding regression and atomicity

| Finding | Result / coverage |
|---|---|
| S5-H-001 | Preserved: Journal revision/coverage authority at semantic as-of; purge precedence |
| S5-H-002 | Preserved: outcome-independent universe and missing/invalid denominators |
| S5-M-003 | Closed for baseline and association source ordering |
| S5-M-004 | Preserved: inclusive 36-hour continuity and explicit gap expiry |
| S5-M-005 | Preserved: DEGRADED evidence cannot create membership/support |
| S5-M-006 | Closed: explicit semantic clocks throughout revision/shortcut APIs |
| S5-M-007 | Preserved: durable versioned confidence, bounds and reload validation |
| S5-L-008 | Preserved: scale-aware inclusive/exclusive statistical boundaries |
| S5-H-009 | Preserved: T→T+1/T+2→T pure replay; insight promotion/weakening/contradiction without current mutation |
| RC2-H-001 / H-002 / M-001 / M-002 | Closed for supported v25 history |
| RC3-H-001 | Closed for new v25 revisions; legacy unavailable by design |

Fault injection after event insert, materialization update, snapshot insert and provenance-link insert preserves all before-counts and the original row. CAS competition commits one winner and one next revision/event/snapshot. In the dedicated fixture, the winning change leaves two events/two snapshots; exact duplicate and invalid-clock calls leave both at two and preserve snapshot bytes. Pure historical replay leaves every durable evidence/episode/event/semantic/insight/source-link/snapshot count unchanged.

## Executed verification

All verification used Node v22.23.2 and synthetic in-memory or temporary-file databases. The [per-file result ledger](phase4-stage5-rc4-test-results.json) records the complete repository sweep, accepted clean runs, original environment failures and baseline pre-fix counts. Overlapping gates below are not additive.

| Gate | Passed | Failed |
|---|---:|---:|
| RC4 full snapshot/history adversaries | 13 | 0 |
| RC4 pre/post blockers | 5 | 0 |
| Independent RC3 overwrite diagnostic | 1 | 0 |
| RC2 adversarial suite | 10 | 0 |
| Complete Stage 5 focused gate, eight files | 95 | 0 |
| Association store / measurability | 15 / 8 | 0 |
| Fresh/v20/v24→v25, all 18 interruption boundaries, legacy rows and drift | 25 | 0 |
| Foundation + Stage 5 aggregate, 28 files | 259 | 0 |
| Body Energy | 24 | 0 |
| Complete repository, 148 files, one accepted clean run per file | 2585 | 0 |

The aggregate includes all `phase4-*.test.js`, `body-energy*.test.js` and `journal-foundation-validation.test.js` files. The focused Stage 5 gate comprises intelligence pure/store, association store, insight store, RC2, RC3 diagnostics and both RC4 suites. Multi-user, lifecycle/generation, Journal/purge/privacy and legacy application regressions are included in the repository ledger. After the final null-input comparator guard, its four affected pure/blocker/intelligence/association files reran cleanly: 67 passed, 0 failed.

The initial file-by-file sweep reported **2539 passes / 30 failures / 2569 reported tests**, plus **3 timed-out files** without a final runner summary. Failure classification: **0 logical assertions**, **19 loopback `listen EPERM` failures**, and **11 native `SIGSEGV` runner failures**. The v22/v23/v24 timeout logs contain all nine passing tests each but stalled at process teardown. These raw outcomes are retained, not relabeled as passing runs.

Standard execution was `node --test --test-concurrency=1 FILE`, one process per file. Every environment-affected file completed a clean rerun using `node --test --experimental-test-isolation=none --test-force-exit --test-concurrency=1 FILE`; loopback fixtures additionally ran outside the network sandbox. The longer migration retry deadline was 600 seconds. Force-exit occurs after test/hook completion. No assertion was skipped or accepted as failed, and accepted runs contain zero skipped/cancelled tests. The installed native-process teardown instability remains an environment limitation, not a claim that the ordinary one-shot repository runner is clean in this environment.

All 34 changed JavaScript files pass `node --check`; `git diff --check` passes. The independent column audit classifies all 53 episode columns with no missing or extra fields. Added-content secret/debug scanning finds no private keys, provider/Telegram credentials, debugger statements or console debugging. All 13 Foundation flags remain false, with no local-file or process overrides. Frozen v21–v24 definitions remain unchanged; SQLite integrity and foreign-key checks pass.

No production database, main branch, release tag, scheduler, workflow, feature flag, environment file, Telegram/provider path or Stage 6–8 functionality was changed. All migration and mutation tests use synthetic local memory or temporary-file databases.
