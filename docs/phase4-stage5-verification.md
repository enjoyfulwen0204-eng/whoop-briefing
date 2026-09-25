# Phase 4 Stage 5 Intelligence Core RC1 verification

Historical verification record: original-result and complete required-root authority claims are superseded by the [v26 RC6 repair](phase4-stage5-rc6-verification.md). V25 snapshot integrity remains required but is not sufficient for evidence replay.
Historical verification record. Its v24 replay-authority claims are superseded by the [v25 RC4 repair](phase4-stage5-rc4-verification.md): missing v24 history is unavailable; only full durable snapshots authorize episode replay.

This is the independent-review handoff for Stage 5 Repair Cycle 1. It is not authorization to
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

## RC1 blocker closure

- **S5-H-001:** Journal facts and coverage are resolved to the readable revision
  authoritative at the requested `asOfUtc`. Future assertions are excluded;
  post-T corrections cannot replace the T revision; privacy purge remains
  authoritative and makes unavailable history fail closed.
- **S5-H-002:** callers declare a bounded comparison-health-date universe that is
  independent of outcome rows. PRESENT, MISSING, and INVALID outcomes are counted
  separately for EXPOSED and CONFIRMED_UNEXPOSED groups; missing plus invalid is
  the >40% comparison/promotion guardrail denominator.
- **S5-M-003:** hypotheses, comparison dates, outcome sources, Journal revisions,
  coverage revisions, and exposure-source sets use canonical semantic ordering.
  Focus identities use the semantic hypothesis key rather than array position.
- **S5-M-004:** active-family selection computes elapsed semantic time from
  `last_observed_at`. Gaps through exactly 36 hours merge; larger gaps append a
  `CONTINUITY_GAP` expiry and open a new auditable episode.
- **S5-M-005:** DEGRADED/ineligible current observations persist diagnostic
  evidence but cannot create membership, SUPPORTING evidence, or an episode
  revision. LIMITED and AVAILABLE retain their registered behavior.
- **S5-M-006:** analysis as-of/effective observation time drives episode opening,
  stabilization, resolution, recurrence, continuity, episode expiry, insight
  recency, and insight expiry. Processing timestamps remain operational metadata.
- **S5-M-007:** `evidence-confidence-v1` is persisted with score, label, all
  deterministic components, hard-confound and uncertainty inputs. Reload checks
  formula compatibility; episode confidence uses the observation/evidence minimum,
  and promotion consumes compatible stored confidence.
- **S5-L-008:** scale-aware machine-epsilon helpers preserve inclusive 2.50/open
  and exclusive 1.50/close boundaries without materially widening thresholds.

## Deterministic contracts

- Baseline: latest 30 unique valid earlier health days within 45 days, minimum
  7, median, MAD x 1.4826, then IQR / 1.349 fallback.
- Change: registered absolute/relative floor plus normalized inclusive absolute
  robust-z 2.5 open;
  two qualifying observations separated by 30 minutes through 36 hours, or the
  registered severe-single exception at robust-z 4 and confidence 0.80.
- Hysteresis: absolute robust-z below 1.5 enters `STABILIZING`; resolution needs
  a 24-hour hold. A seven-day expiry is explicit and auditable.
- Association: complete comparison dates are classified independently from
  outcome availability; each group at least 5 usable outcomes and classified
  usable total at least 20 for a
  candidate; each group at least 8 and total at least 30 plus two non-overlapping,
  direction-consistent slices spanning seven days for repeated evidence.
- Promotion: UNKNOWN fraction greater than 0.50 blocks; exactly 0.50 passes only
  that confound; group outcome missingness greater than 0.40 blocks comparison;
  adjusted significance must be at most 0.10 and support current.
- Insight: no direct `HYPOTHESIS` to `SUPPORTED`; `SUPPORTED` requires a second
  compatible evidence item from an independent window.

Failed association floors emit no comparative effect. Absence of a Journal fact
is `UNKNOWN`, never `CONFIRMED_UNEXPOSED`. Observational outputs always carry
`ASSOCIATION_ONLY`, and no lifecycle wording permits a causal or medical claim.

## Focused executable evidence

From the repository root with Node 22 or newer:

```sh
node --test --test-concurrency=1 test/phase4-intelligence.test.js test/phase4-intelligence-store.test.js test/phase4-association-store.test.js test/phase4-insight-store.test.js
```

The focused gate covers registry closure, typed quality, canonical-source and
Journal-revision as-of exclusion, complete comparison-day missingness, canonical
association ordering, baselines, magnitude/persistence/severe-single boundaries,
hysteresis, durable confidence, numeric boundary stability, multiplicity, UNKNOWN
0/0.49/0.50/0.51/1.0 boundaries, trend/correlation/similar-days/Body Energy
adapters, durable replay, concurrent convergence, the 35:59:59/exact-36h/>36h/118h
episode boundary, DEGRADED deferral, semantic-clock equivalence, resolution,
reversal, linked recurrence and expiry, promotion floors, refutation, candidate
rejection, transitive purge, Alice/Bob isolation, generation ABA fences, and
SHADOW authority.

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

- Focused Stage 5 gate: 65/65 assertions passed.
- Controlled Foundation/Stage 5 matrix: 204/205 assertions passed in the
  aggregate process. The sole failure was a native `SIGSEGV` in
  `phase4-intelligence-store.test.js`; the exact file then passed 25/25 in
  isolation with no logical assertion failure.
- Repository-wide serialized gate: 2,511/2,540 assertions passed inside the
  restricted sandbox. All 29 reported failures were `listen EPERM` errors from
  the sandbox denying the final loopback HTTP fixture in `whoop.test.js`; the
  exact affected file passed 9/9 when rerun with loopback permission.
- Static JavaScript syntax validation passed for every changed JavaScript file;
  `git diff --check` passed.
- Mutation proofs: all eight deliberate weakenings A–H were killed by their
  targeted regression tests and fully restored before final validation.

The known FND-LOW-002 native libSQL test-worker teardown/concurrency instability
remains a non-product harness risk. Native process exits and environment-denied
loopback binds are reported separately above; no logical assertion failure was
reclassified as an environment issue.

## Mutation proof map

Each mutation below was temporary, produced the expected targeted failure, and
was restored before final validation:

| RC1 rule weakened | Test that killed the mutation |
| --- | --- |
| A — Journal as-of selection bypassed | `Future-created Journal facts and coverage stay UNKNOWN at T and replay identically later` |
| B — days rebuilt only from outcome rows | `Full comparison universe retains both 30-day groups with only 16 outcomes each and blocks >40% missingness` |
| C — request order retained in comparison dates | `Shuffled hypotheses and source arrays converge on identical association hashes and identities` |
| D — 36-hour continuity check forced true | `Episode merge continuity is inclusive through exactly 36 hours and splits beyond it` |
| E — active-episode quality classification bypassed | `A DEGRADED current observation persists diagnostics but cannot join or advance an active episode` |
| F — episode opening used processing timestamp | `Fixed semantic as-of yields identical evidence and episode lifecycle fields under different wall clocks` |
| G — durable confidence removed | `Metric analysis persists completed traceable evidence before one OPEN episode and semantic event` |
| H — normalized thresholds replaced by raw comparisons | `Robust-z thresholds are stable at 2.49/2.50/2.51 and 1.49/1.50/1.51 in both directions` |

No mutation experiment is committed.

## Review boundary

Independent review should focus on temporal/statistical integrity, exact episode
state transitions, concurrency convergence, promotion sufficiency, non-causal
language, tenant/mode/generation isolation, and purge non-resurrection. A Stage 5
PASS authorizes neither Stage 6 implementation nor production activation.
