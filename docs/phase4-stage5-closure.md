# Stage 5 consolidated closure contract

This document supplements the controlling [Phase 4 architecture](phase4-architecture.md). It describes the isolated, default-off SHADOW implementation. It does not authorize production migration, activation, delivery, or Stage 6.

## Schema ownership

| Version | Responsibility |
| --- | --- |
| v25 | Immutable episode semantic state and event binding at a revision |
| v26 | Evidence/result origin, authenticated input manifest and required roots |
| v27 | Complete public operation request and return receipt |
| v28 | Future Stage 7 Quick Actions, TRUSTED_REGISTRY and Journal provenance |
| v29 | Future Stage 8 Owner Monitoring and Family View |

The v27 migration adds `phase4_operation_receipts`, its indexes and immutable/privacy guards, and no-rehydration guards for `health_insights`. It inserts no receipts or historical authorities. Earlier migrations remain independently verifiable. A version row is withheld until its durable statements and postconditions finish. Installation verifies exact definitions, not merely object names.

## Receipt authority

The primary key is `(user_id, execution_mode, operation_kind, operation_key)`. Only SHADOW is admitted. The operation key is a keyed digest of the versioned canonical request envelope: operation, normalized arguments, user, mode, timezone, algorithm set, registered method profiles, and input/lifecycle/auth/purge generations. Lifecycle identity includes target, expected predecessor revision, requested result, evidence and semantic time; an evidence item is never the sole operation identity.

The HMAC seals the complete envelope, canonical request, complete return tree, related identities and row projections, schema contracts, required roots, salt, privacy identity/state, generations and operational creation time. SQL forbids replacement, deletion and content mutation. Redaction destroys request/result/relationship/root/schema JSON, semantic time, HMAC and salt, preserves opaque identity barriers, and prevents rehydration.

One transaction commits the public operation and its receipts, including semantic child lifecycle operations. Preparation, relationship validation, v25 snapshots, v26 evidence authority, v27 receipts, memberships, events, current materialization and privacy links share that transaction. Failures roll back the entire operation. Internal lookup, observation insertion and bookkeeping steps receive no independent operation receipt.

Exact receipt lookup precedes calculation and lifecycle CAS. A duplicate returns the sealed result even when a later revision exists. Current privacy, generation and root authority remain mandatory. Operational `created`/`replayed` flags can change on retry. No old result is repaired or recomputed to manufacture missing history.

## Projection inventory

All public semantic fields are captured recursively, including nested wrappers. Branded references are stored as authenticated scoped identities and complete row projections; a new branded capability is issued only after validation. They are not serialized as reusable capabilities.

| Result type | A: historical semantics | B: immutable identity | C: operational metadata | D: current-only delivery |
| --- | --- | --- | --- | --- |
| Metric operation | Baseline, quality, calculation, result state, run/item, episode wrapper, event and reversed episode relationship | Run/item/episode/event keys and versions | Creation/replay flags | None |
| Association operation | Full family result, every analysis, item, current insight and contradiction | Family/focus/evidence/insight identities | Per-item replay flag, creation flags | None |
| Evidence run/item | Every returned column, including counts, timezone, window/start/as-of, confidence/provenance/confounds | Tenant/mode, primary and deterministic keys, registered versions | Creation/completion bookkeeping may be retained exactly | None |
| Episode | Full returned state, revision, explanation/context, confidence, severity, semantic times, lifecycle and generation semantics | Logical/family/fingerprint identity, predecessor links, v25 event/revision identity | Creation/update bookkeeping | Question/delivery/ambiguity pointers are null in historical projection |
| Insight | Every returned parent and revision field: statement, status, disposition, confidence, evidence, samples/effect, subject/type, all lifecycle times and generations | Logical key, incarnation, predecessor and revision identity | Creation/replay flags, storage/privacy bookkeeping | None |
| Body Energy | Complete row, manifest, calculation, and checkpoint relationship | Result/checkpoint lookup identities and algorithm profile | Retained invalidation metadata can reflect later correction | None; retained audits issue no current reference |

Row fields are semantic by default. Every captured derived type records its complete current SQLite column contract (name, type, nullability and primary-key position). Missing fields at capture or schema growth at replay produces `PHASE4_OPERATION_RESULT_UNAVAILABLE`. A future non-row return contract must retain this recursive ownership and advance its receipt/profile version when its interpretation changes. It must never source a new historical semantic field from current materialization.

Related dependency rows seal the complete run/item metadata needed by direct lifecycle operations. They are marked `DEPENDENCY`, cannot independently become public historical results, and do not reverse privacy dependency direction. A new direct operation does not make a legacy calculation replayable.

## Supported operation surface

| Public method | Durable return |
| --- | --- |
| `intelligence.analyzeMetric` | Positive, null/quality/warming/no-change result, opening/revision and reversal wrapper |
| `intelligence.analyzeAssociationFamily` | Complete analyses, current/contradicting insight, no-insight and empty-universe result |
| `intelligence.expireEpisode`, `expireInsight` | Explicit semantic expiry result, including terminal no-op return |
| `episodes.open`, `revise`, `reverse`, `refresh` | Full direct result; revise covers explanation, context, stabilization, resolution, expiry and invalidation |
| `episodes.semantic` | Read-only authenticated retry of a semantic event already committed within a revision |
| `insights.create`, `transition` | Complete original creation/transition; promotion, reconfirmation, weakening, recovery, refutation, retirement and refresh use this receipt boundary |
| `bodyEnergy.compute`, `persist`, `checkpoint` | Complete new SHADOW result/checkpoint receipt; retained audit remains a separate read |

v25 remains state authority and retains its structural edge checks. A verified v27 direct lifecycle origin can authorize evidence reuse that is distinct from a calculation's own original episode. An explicit calculation-origin read still requires its v26 binding. Missing non-privacy v25 structural edges may make an otherwise authentic historical read unavailable; this is the accepted V1 availability limitation.

## Semantic time and identity

New Stage 5 instants require an explicit timezone, a real calendar instant and lossless millisecond precision. Canonical spelling is `YYYY-MM-DDTHH:mm:ss.sssZ`. Offset aliases and additional fractional zeroes normalize; offset-less strings, calendar rollover, unrecognized spellings and additional nonzero fractional digits reject. Semantic transitions cannot precede their predecessor or creation, or exceed request-time authority. Historical replay does not apply a new wall-clock lifecycle decision.

The shared time/version utility covers health source versions and their ordering. Journal request and transaction times and coverage lineage use the same contract. Opaque version strings remain opaque. The explicit v1 root compatibility decoder uses authenticated original adapter tuple spelling solely to verify old bytes; it never changes the old key, hash, manifest or row.

New metric manifests and keys use `phase4-metric-evidence-input-v2`, `stage5-metric-request-v2` and v2 digest domains. `windowFamily`, metric, semantic as-of, source-derived target date, source/version universe, registered method profile, timezone and generations participate. Association v2 binds family, every hypothesis's factor/outcome/lag/comparison dates, selected Journal authority, semantic as-of, multiplicity universe and result scope.

Unordered source/evidence/hypothesis/date sets are canonicalized before both identity generation and execution. Duplicate semantic sources are rejected with `PHASE4_SEMANTIC_SOURCE_DUPLICATE`; distinct capability objects cannot double-count one physical source. Journal assertions absent at semantic as-of do not enter the selected universe. Legacy observation lookup compares scoped source type/id and canonical semantic version before insertion; multiple equivalent stored candidates reject as ambiguous.

## Compatibility discovery

An exact receipt miss triggers read-only discovery before metric or association calculation. Completeness is scoped by user, mode and current input generation. Mutable method, algorithm registration, subject and as-of columns cannot exclude candidates. Original stored manifests recompute their original keyed hash and deterministic key before semantic comparison; matching v26 envelopes and roots must authenticate.

| Budget | Behavior |
| --- | --- |
| 500 run candidates | Fetch 501; overflow unavailable |
| 1000 v26 authority candidates | Fetch 1001; dangling ownership rejects |
| 5-second discovery deadline | Checked through validation; timeout unavailable |
| 1000 candidate v27 receipts per scoped read | Fetch 1001; overflow unavailable |

Exhaustive successful absence permits a new calculation. Pre-v25, v25 and v26 operations lack a complete public v27 return and remain unavailable even when their evidence/origin is authentic. Multiple authentic equivalent legacy identities return `PHASE4_LEGACY_IDENTITY_AMBIGUOUS`. Redacted candidates, corrupt envelopes, unsupported contracts and overflow are distinct failures. Full supported v27 exact/representation-equivalent requests replay their complete original result. There is no historical receipt backfill, re-key, alias row or resealing path.

## Read and absence authority

Every public Stage 5 derived route validates a typed authority chain. Generic row existence or graph membership cannot supply history. `core.artifact` is internal inventory/parent validation; public run, item, event, membership, observation, episode/snapshot, insight/revision, v26/v27 authority and Body routes add their receipt/root contracts.

Receipt reads authenticate schema, envelope, generation, immutable related rows, complete dependency run metadata, v26 scope completeness, required roots and applicable v25 structural relationships. Current mutable parents contribute no historical health semantics. Legacy partial v26 insight payloads never merge into current `health_insights`.

| Condition | Public contract |
| --- | --- |
| Positive result | `resultState: POSITIVE` plus complete artifact relationships |
| Warming/no data | Distinct `WARMING_UP` / `NO_DATA` state with durable diagnostics |
| Insufficient quality/evidence | Distinct `INSUFFICIENT_QUALITY` / `INSUFFICIENT_EVIDENCE` state |
| No meaningful change | `NO_CHANGE` |
| Qualified operation with no artifact | `NO_ARTIFACT` |
| Empty association universe | `EMPTY_ASSOCIATION_UNIVERSE` |
| Valid family without insight | `NO_INSIGHT`, complete item analyses explain the absence |
| Incomplete historical operation | `PHASE4_OPERATION_RESULT_UNAVAILABLE` |
| Missing complete operation receipt | `PHASE4_OPERATION_RESULT_UNAVAILABLE_MISSING_RECEIPT` |
| Missing evidence authority | `PHASE4_EVIDENCE_RESULT_AUTHORITY_UNAVAILABLE` |
| Ambiguous legacy identity | `PHASE4_LEGACY_IDENTITY_AMBIGUOUS` |
| Redacted content | `CONTENT_REDACTED`; pending purge is fenced |
| Corrupt operation/evidence binding | Typed integrity/binding error |
| Scoped artifact identity never found | `PHASE4_PARENT_NOT_FOUND`; calculation admission still requires exhaustive discovery |

Retained Body audit authenticates its original calculation/manifest and complete v27 projection, validates every retained physical root's current existence/privacy, and issues no current-source capability. A legitimate later generation may own corrected source values while the sealed retained manifest owns historical measurements. Current-parent reads still enforce current generations. Legacy Body rows without the additional complete projection authority are unavailable through the strengthened public facade.

## Insight lifecycle and coverage lineage

The stable logical insight key is separate from an incarnation creation key. A post-terminal association creates a distinct row and references the terminal predecessor. Terminal parents cannot become current. Existing statistical qualification and independent-window rules govern emerging/support/reconfirmation and recovery. A resample overlapping an already counted support window does not append independent support. Direct reconfirmation also requires new evidence disjoint from every previously counted window. Qualified repeated evidence recovers a weakened insight to EMERGING under the existing thresholds. Direct transitions authenticate the predecessor and exact retry precedes CAS. Non-Stage-5 legacy writers explicitly exclude PHASE4 and redacted insight rows. They inspect the installed column shape so the same writer still works against the untouched v20 production schema and observes fences after migration.

Review B repair: current association selection uses the semantic `asOf`, including `first_detected_at <= asOf`, the applicable revision time, no terminal disposition, and strictly `expires_at > asOf`. At/exceeding expiry, the old incarnation retires through its existing lifecycle before a replacement is created. A new past request that would need a future incarnation/revision fails `PHASE4_INSIGHT_AS_OF_UNAVAILABLE`; it does not reconstruct unrecorded history. Exact prior receipts still replay before selection. Reopen and reversal-linked episode opens authenticate the predecessor against its signed snapshot and require a valid resolution instant no later than the successor, including before an active-episode shortcut. Equality is legal; the seven-day reopen ceiling is unchanged.

Final Review B repair (M006): every predecessor-linked insight creation uses one terminal-lifecycle validator, including association-created incarnations. The v27 receipt's authenticated terminal row and immutable revision supply retirement time; mutable `health_insights.retired_at` never supplies or overrides it. The sealed status, disposition, identity, revision, first-detected time and last-recalculated time must agree with a terminal projection, and successor time must be at or after sealed retirement. The existing typed reader still verifies roots, generations and privacy. Missing/corrupt authority or redacted history fails closed; exact recorded replay precedes new admission.

Coverage uses one validator for every node, including root. It checks scope, source domain/profile, safe revisions/generations, root revision 1 and null predecessor, parent revision +1, source origin metadata, finite confidence, factor set/domain, canonical real windows, health-date/timezone consistency, readable status and monotone transaction time. Corrections may narrow factors; timezone/profile cannot silently change. A linear chain may have equal timestamps, ordered by revision. Branches have no authenticated winner and reject. Parents must be superseded, the leaf active; deleted or redacted lineage is unavailable. Traversal uses visited identities and a 1000-node cap; it never truncates or recurses indefinitely. Invalid lineage commits no derived artifacts.

## Privacy and lifetime

Privacy discovery reconstructs dependencies independently from authenticated v27 receipts, v26 roots/origins, v25 snapshots, original keyed legacy calculation manifests, retained Body manifests, and revision relationships. Mutable source-link tables are indexes, not the only closure source. Receipt dependencies point from inputs to receipts/results, not from receipts back to independent input computations.

Before `COMPLETE`, an independent inventory rereads all scoped Stage 5 sensitive stores, including ones omitted from the original target ledger. Present descendants of redacted/missing inputs and unsupported/orphaned sensitive artifacts keep the purge fenced. Corrupt or unauthenticated authority cannot narrow closure. Each sensitive table inventory fetches 10001 and admits at most 10000 rows; larger or unprovable scopes remain pending with an explicit error. The existing privacy controller, transactional redactor and cache acknowledgment gates remain in force.

Review B repair: discovery also consumes retained pre-v25 event reference formats (raw item IDs and typed references, including privacy IDs). Episodes with incomplete authenticated snapshot history and insights without authenticated complete state receive conservative `TENANT_LEGACY` dependencies for any scoped user purge. These are reconstructed privacy edges, never new receipt/authority rows. The independent oracle rejects remaining unproven legacy state and requires every retained sensitive node to reach a checked root; a parent/revision cycle is insufficient. An omitted target or corrupt authority keeps the purge pending/fenced.

Completed public calculation/lifecycle operations own their captured context and release it in `finally`, on success, replay and failure. Nested processing scopes defer release until transaction completion. Multi-read callers use `withContext(userId, options, work)` or explicitly release their borrowed context. A completed routine does not retain the crash-recovery 15-minute lease. The TTL remains only a bounded recovery mechanism for abandoned active work.

Review B repair: `withContext` owns its capability across contained operations and defers nested release until the outer transaction's validation and commit/rollback finish. Transaction admission and commit have bounded contention retries (15 seconds and at most 65 attempts, with capped backoff); application callbacks are never retried for contention. Read-only foundation/schema reads share the bound. After a failed local BEGIN/read, the idle driver connection is refreshed to avoid carrying an unfinished native statement into a later transaction. Active transactions are never reconnected. The eventual admitted callback checks the deterministic receipt before calculation; completion cleanup uses the same transaction admission path.

## Review B input admission and JSON identity

Every explicit supporting evidence ID/reference passes the public typed authority chain before a child mutation: current item/run, complete receipt and sealed semantic metadata, required v26 origins, roots, privacy, and generation fences. Only internal deterministic producers can record a provisional, exact-row ticket for newly created evidence. Child admission checks that ticket and registers a commit-time typed verification after the producer has written its v26/v27 authorities. Missing authority or row mutation rolls back all producer/child writes. Existing evidence never receives a provisional ticket. Insight predecessor receipts also validate their complete dependency chains.

Request normalization, result encoding, and replay restoration reconstruct objects with own data properties. Accepted `__proto__`, nested `__proto__`, `constructor`, `prototype`, and unusual JSON keys participate in canonical identity and retained content. Object key order remains equivalent. The canonical request/profile version and schema stay unchanged; old ambiguous requests cannot use a new identity to manufacture historical authority.

## Root scale and verification

Required roots deduplicate by scoped type/id/as-of. The v3 root manifest retains the v26 envelope and records exact root count and canonical serialized root-array bytes. Bounds are 10000 roots and 1048576 bytes. Each v27 JSON projection has a 4 MiB bound; each auxiliary result query admits 1000 rows with cap+1 detection. Overflow returns scoped unavailable and the operation rolls back; no partial authority is sealed.

The frozen verification categories are A complete recursive returns; B schema growth; C reader-by-authority faults; D request dimensions; E representation equivalence; F compatibility discovery; G independent privacy closure; H typed absence; I coverage lineage; J insight lifecycle; K independently derived root sets and scale; L concurrency/fencing/atomicity; M migration/cutover; N native process stability.

Final Review B repair (T002): historical fixture generation archives the genuine historical application unchanged and overlays only its test connection ownership. Each child uses the installed native SQL/transaction executor on one anchor, drains finalizers before/after its single awaited close, and exits naturally. The parent waits for child termination and records exit status, signal, cleanup state and orphan check; failed or incomplete children cannot return fixture bytes as successful. Repeated RC6 metric-null generation and the v27 cutover suite exercise this boundary.

Run native suites with `scripts/test-stage5-closure.mjs` and explicit test file arguments. It launches one separate test process at a time, retains full logs and machine-readable counts, and classifies assertion failure, environment EPERM, native SIGSEGV, timeout and harness failure separately. The synthetic in-memory fixture owns one native connection and uses the installed libSQL SQL executor and transaction implementation on it. Its cleanup drains statement finalizers before closing the connection. This avoids the rotating-connection finalizer crashes observed in the original in-memory harness; it does not modify production connection ownership or vendor code. The file-backed v26 fixture and two legacy insight regression fixtures use the same owned-connection cleanup after native finalization crashes; their real file/reopen, migration and application assertions remain intact. Review B extends the existing owned-connection fixture to v27 file-backed migration/cutover tests after repeated normal-driver finalizer crashes; real file reopen and all migration assertions remain. The two-process Review B race and no-application probes retain the installed driver’s normal connection lifecycle. No successful test process is force-exited; the runner kills timed-out processes and records them as failures. The no-application native probe is separate from application assertions. Final gate evidence and exact counts are recorded in the [closure implementation report](phase4-stage5-closure-report.md), separately from historical RC checkpoints.

The Review B runner uses a separate POSIX process group per file and kills that group on timeout (Windows uses tree termination). Its regression proves both a hanging test worker and its grandchild are gone; expected timeout probes remain failures inside their own nested logs. The real two-process convergence regression uses the installed normal driver against one synthetic file database. Review B delivery and evidence are tracked separately from the historical consolidated implementation report.

Review B semantic selection uses the same authenticated insight projection for the as-of checks and returned result. Mutable creation/recalculation timestamps cannot make a sealed future incarnation eligible for a new past request. Exact historical receipt replay retains its existing behavior.
