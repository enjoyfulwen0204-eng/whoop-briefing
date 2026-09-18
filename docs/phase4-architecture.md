# WHOOP Personal Health OS Phase 4 Architecture Decision Record

Status: Accepted for staged implementation

Decision date: 2026-09-18

Repository baseline: v20 schema at commit ecbd23287cac591e76741771d77caa3d814f84a3

Architecture version: phase4-adr-v1

This record defines the contracts for Phase 4. It is deliberately implementation-free. Every Phase 4 feature described here remains disabled until its stage-specific flag and rollout gate are satisfied.

## 1. Scope, non-goals, and implementation stages

### Scope

Phase 4 adds a deterministic Personal Health OS layer above the existing tenant-scoped WHOOP ingestion, journal, evidence, memory, Telegram, and daily-report foundations. Its product surfaces are:

- Body Energy v1, an OS-authored 0–100 estimate with provenance and confidence.
- Meaningful-change detection and durable Observation Episodes.
- Structured context capture with correction and deletion.
- Durable evidence and insight lifecycles.
- A proactive decision policy with an exact four-action output.
- Event-driven reanalysis separated from delivery.
- A once-per-local-health-day Morning Brief.
- A tenant-scoped Q&A read boundary for all Phase 4 claims.
- Crash-safe outbound delivery for Phase 4 questions and notifications.

### Non-goals

Phase 4 does not:

- deploy to production, enable production flags, or change production scheduler behavior in this stage;
- present Body Energy as a WHOOP metric, medical diagnosis, or physiological measurement;
- provide medical diagnosis, treatment, emergency monitoring, or assurance of safety;
- infer causality from observational associations;
- enable family, coach, employer, administrator, or cross-user health-data browsing;
- perform population-health inference, cohort comparison, or cross-tenant model training;
- enable the dormant Phase 3 analytics workers or route Phase 4 work through them;
- replace WHOOP as the authoritative source for WHOOP records;
- change webhook authentication, reconciliation semantics, OAuth identity, or lifecycle truth;
- change the Cloudflare or GitHub scheduler cadence in this architecture stage;
- send directly from analysis, evidence, episode, or decision code;
- introduce a normal-operation notification quota;
- build a new mobile application, broad health dashboard, or unrelated platform rewrite;
- implement full-account erasure; account-erasure policy remains outside this phase;
- retain deleted health content in a tombstone;
- use an LLM to calculate metrics, decide lifecycle transitions, or authorize delivery.
- allow arbitrary LLM calculation or invention of missing health facts.

### Compatibility posture

The following foundations are **reused**:

- internal tenant identity and lifecycle in [src/identityStore.js](../src/identityStore.js), especially **transitionUserLifecycle**;
- lifecycle and delivery authorization in [src/accountLifecycle.js](../src/accountLifecycle.js);
- canonical WHOOP records and freshness protection in [src/store.js](../src/store.js);
- webhook durability and authoritative refetch in [src/whoopWebhookIngest.js](../src/whoopWebhookIngest.js) and [src/whoopWebhookProcessor.js](../src/whoopWebhookProcessor.js);
- shared write transactions and invalidation hooks in [src/processingTransaction.js](../src/processingTransaction.js) and [src/analyticsInvalidation.js](../src/analyticsInvalidation.js);
- report-claim delivery identity in [src/reportDelivery.js](../src/reportDelivery.js);
- deterministic evidence-card presentation in [src/evidence.js](../src/evidence.js);
- current insight transition concepts in [src/healthMemory.js](../src/healthMemory.js);
- Telegram inbound deduplication and serialized conversation handling in [src/bot/updateProcessor.js](../src/bot/updateProcessor.js).

The following foundations are **extended**:

- v20 with additive, restart-safe migrations;
- journal records with logical fact identity, provenance, correction, and deletion;
- health insight records with durable evidence linkage, expiry, and terminal disposition;
- report delivery to support a Phase 4 Morning Brief report type;
- invalidation writes with a separate Phase 4 generation and job queue;
- Q&A routing with a mandatory scoped context service and perspective gate.

The following behaviors are **replaced for Phase 4 only**:

- the normal-operation cap in **ANTI_SPAM_POLICY.DAILY_PROACTIVE_CAP** and the early cap return in [src/attention.js](../src/attention.js);
- **downgradeAskToNotify** in [src/attention.js](../src/attention.js);
- direct Telegram sending in the current proactive path;
- the current daily-report readiness behavior when it would omit a Morning Brief solely because data is missing;
- generic JSON as the authoritative representation of question, episode, evidence, or delivery lifecycle state.

Legacy behavior remains unchanged until a Phase 4 flag explicitly selects its replacement.

### Requirement and engineering-decision provenance

Confirmed product requirements are the Morning Brief entitlement, OS ownership of Body Energy, correction/deletion behavior, association-only language, dormant Phase 3, no normal message cap, one highest-value question, no ASK-to-NOTIFY conversion, and strict tenant privacy. This ADR does not reopen them.

The formulas, coefficients, time windows, state names, migration layout, default Morning Brief schedule, statistical floors, retention periods, and abnormal circuit-breaker threshold are engineering decisions made here to make those requirements implementable. They are versioned and may change only through an ADR amendment and compatible version transition.

Repository motivation and compatibility are:

| Decision | Existing path or symbol | Treatment |
|---|---|---|
| Tenant/lifecycle authority | [src/identityStore.js](../src/identityStore.js) **transitionUserLifecycle** | REUSE |
| Atomic changed-data invalidation | [src/analyticsInvalidation.js](../src/analyticsInvalidation.js), [src/processingTransaction.js](../src/processingTransaction.js) | EXTEND with a separate Phase 4 generation |
| Body Energy source data | [src/store.js](../src/store.js) **createHealthStore** and [src/time.js](../src/time.js) | REUSE canonical/freshness rules; ADD a calculator |
| Journal taxonomy and deterministic validation | [src/journal.js](../src/journal.js) **CATEGORIES**, **validateEvent**, **healthDateFor** | EXTEND with revision, confirmation, and realignment |
| Insight statuses | [src/healthMemory.js](../src/healthMemory.js) | EXTEND rather than discard |
| Normal proactive cap and downgrade | [src/proactivePolicy.js](../src/proactivePolicy.js) **DAILY_PROACTIVE_CAP**, [src/attention.js](../src/attention.js) **downgradeAskToNotify** | REPLACE for Phase 4 |
| Delivery-start crash boundary | [src/reportDelivery.js](../src/reportDelivery.js) | REUSE exactly for Morning Brief; EXTEND as a pattern for other classes |
| Specialized evidence Q&A ordering | [src/bot/router.js](../src/bot/router.js) | REPLACE with perspective-first scoped reads |
| Migration sequencing | [src/migrations.js](../src/migrations.js) **runMigrations** | EXTEND with restart-safe additive steps |

Key alternatives and failure behavior are frozen as follows:

| Decision and class | Selected design | Alternative considered | Safety, compatibility, and failure behavior |
|---|---|---|---|
| Body Energy calculation — engineering | ADD a pure versioned calculator over [src/store.js](../src/store.js) canonical reads | Ask an LLM or relabel WHOOP recovery | Deterministic provenance and no future data; missing inputs produce typed no-value/limited states |
| Episode persistence — engineering | ADD dedicated episode, membership, and event records | Treat each [src/proactiveAgent.js](../src/proactiveAgent.js) run or **proactive_events** row as an episode | Preserves history and concurrent uniqueness; replays converge instead of repeating daily messages |
| Evidence persistence — engineering | ADD immutable runs/items around eligible [src/analyze.js](../src/analyze.js) calculations | Compute all evidence transiently | User-visible claims remain reproducible; failed runs cannot masquerade as evidence |
| Insight lifecycle — engineering | EXTEND [src/healthMemory.js](../src/healthMemory.js) statuses with revisions/disposition | Replace legacy statuses or promote directly from one observation | Preserves compatibility and prevents one-day/competing-current promotion |
| Phase 4 work queue — confirmed product plus engineering | EXTEND the transaction pattern but ADD separate jobs | Reuse **analytics_work_state** and its dormant workers | Cannot implicitly activate Phase 3; a failed job is isolated and repairable |
| Morning Brief identity — confirmed product plus engineering | REUSE [src/reportDelivery.js](../src/reportDelivery.js) claims and ADD per-user schedule preferences | Send from opportunistic proactive logic | Exact daily identity and safe ambiguous-send behavior; missing data renders explicit states |
| Event-message delivery — engineering | ADD a generic Phase 4 outbox/attempt ledger | Reuse **proactive_events** or **report_claims** for every class | Message-class identity stays correct; post-start crash becomes AMBIGUOUS rather than duplicate retry |
| Normal notification policy — confirmed product | REPLACE Phase 4 use of **DAILY_PROACTIVE_CAP** and **downgradeAskToNotify** | Retain them as principal controls | Meaningfulness decides normal behavior; abnormal loops trip an incident breaker without changing action |
| Q&A authorization — confirmed privacy plus engineering | REPLACE specialized-first routing in [src/bot/router.js](../src/bot/router.js) with one scoped read boundary | Depend on handler-specific tenant predicates | Perspective and currentness are uniform; uncertain scope clarifies or fails closed |
| Referential integrity — engineering | ADD tenant-qualified application checks and an integrity audit | Introduce isolated SQL foreign keys into only new tables | Matches v20 behavior and avoids partially enforced assumptions; detected orphans invalidate artifacts |
| Migration recovery — engineering | EXTEND [src/migrations.js](../src/migrations.js) with introspection, deterministic backfill, and forward fixes | Assume the version is globally atomic or roll back destructively | Partial application safely reruns; flags remain off on failed postconditions |
| Journal deletion — confirmed product plus engineering | EXTEND [src/journal.js](../src/journal.js) facts and physically remove deleted health content with a minimal tombstone | Soft-delete health payload indefinitely | Deleted data is immediately unreadable; tombstone prevents replay without preserving health content |
| Retention defaults — engineering | Versioned bounded retention in Section 15 | Indefinite derived payload and message retention | Minimizes sensitive data; loss of reproducibility becomes explicit rather than fabricated |

### Stage outline

Implementation is divided into dependency-ordered stages. Section 19 is the normative stage graph and gate list.

1. Additive persistence and pure domain contracts.
2. Body Energy and quality calculation.
3. Evidence, episodes, and insight memory.
4. Structured journal and context discovery.
5. Event-driven invalidation and reanalysis.
6. Proactive decision and outbound delivery.
7. Morning Brief and Q&A integration.
8. Shadow evaluation, canary rollout, and final enablement.

No stage may activate delivery before the storage, lifecycle, privacy, and failure-injection tests for that stage pass.

## 2. Domain vocabulary

The following terms are normative:

- **Canonical health event**: a tenant-scoped WHOOP sleep, recovery, cycle, workout, or body-measurement row whose freshness and tombstone rules are enforced by **createHealthStore**. It is source truth, not an episode or insight.
- **Health day**: the local calendar date assigned using the user timezone snapshot and the rules in the relevant contract. A health day is an identity key, not an elapsed-time unit.
- **As-of instant**: an exact UTC instant. A result may use only information ingested and effective at or before this instant.
- **Input generation**: a monotonically increasing tenant-scoped number changed by an eligible canonical or journal mutation. It makes derived-state freshness explicit.
- **Health observation**: a versioned, quality-labelled fact derived from canonical data, structured context, or an earlier deterministic result. It is one measurement or assertion, not a durable episode.
- **Meaningful change**: an observation change that crosses the versioned magnitude, quality, persistence, and hysteresis gates in Section 4.
- **Observation Episode**: the durable lifecycle that groups related meaningful observations without treating every sample or recomputation as a new event.
- **Evidence run**: an immutable execution record for a versioned statistical or deterministic method over an explicit input window.
- **Evidence item**: one typed result from an evidence run, including population, effect estimate, uncertainty, quality, provenance, and causal status.
- **Candidate insight**: a HYPOTHESIS retained for evaluation after candidate evidence; it is not a published personal relationship.
- **Promoted insight**: an EMERGING or SUPPORTED insight that met the repeated-evidence contract and may be used with status-appropriate association language.
- **Rejected, refuted, or expired insight**: a historical RETIRED insight whose disposition respectively records failure to meet promotion gates, sufficient contradictory evidence, or loss of current support with time.
- **Context fact**: a normalized journal assertion with logical identity, provenance, and revision state.
- **Context question**: the single highest-value eligible question selected to reduce decision-relevant uncertainty.
- **Decision**: a durable evaluation producing exactly one action from the Phase 4 action space.
- **Outbound message**: an immutable delivery proposal linked to a decision or Morning Brief, with its own delivery state.
- **Morning Brief**: the once-per-active-ready-unpaused-user, once-per-local-health-day report that explicitly represents missing data rather than disappearing.
- **Current**: not deleted, superseded, invalidated, expired, lifecycle-stale, or based on an older input generation than the read contract permits.
- **Invalidation**: a durable declaration that a derived scope may no longer be current. Invalidation does not itself recompute or send.
- **Reanalysis**: deterministic recomputation of invalidated derived state. Reanalysis does not itself deliver.
- **OS-authored**: calculated by this application. The user-visible name and provenance must not imply WHOOP authorship.
- **Tenant**: one internal **users.id**. Telegram chat IDs and WHOOP user IDs are external identifiers, never tenant primary keys.
- **Definite delivery failure**: a provider result proving the message was not accepted.
- **Ambiguous delivery outcome**: delivery may have occurred, but the application cannot prove either success or failure. It must not be blindly retried.
- **Delivery attempt**: one immutable provider-call boundary for an outbound message, created before the call and completed as delivered, definitely failed, or ambiguous.

The concepts relate as follows:

~~~mermaid
flowchart TD
    C[Canonical health event] --> O[Health observation]
    J[Structured journal fact] --> O
    O --> E[Observation Episode]
    O --> R[Evidence run]
    R --> I[Evidence item]
    I --> E
    I --> M[Candidate or promoted insight]
    E --> D[Proactive decision]
    M --> D
    D -->|ASK| Q[Context question]
    D -->|NOTIFY| X[Outbound message]
    Q --> X
    X --> A[Delivery attempt]
    Q --> J
    J --> Z[Invalidation and reanalysis]
    Z --> O
~~~

An observation is not an episode. An episode is not an insight. A decision is not a notification, because two actions do not send. Reanalysis is not sending. User confirmation creates context and may affect evidence eligibility, but it is not statistical evidence by itself.

## 3. Body Energy v1 deterministic contract

### Decision and ownership

Body Energy is a **Kelvin Health OS-authored estimate**, named “Body Energy” and never “WHOOP Body Energy.” It is a bounded operational summary, not a diagnosis, recovery score, or prediction of medical safety. The result must always expose:

- value or explicit no-value state;
- algorithm version and constants hash;
- as-of instant, health day, wake anchor, and timezone snapshot;
- data-quality state and numeric confidence;
- included inputs, excluded inputs, and source versions;
- positive and negative drivers;
- an explanation that it is calculated by Kelvin Health OS.

The implementation must be a pure deterministic function around a versioned input object. LLM output, journal sentiment, insights, user messages, notification history, and delivery outcomes are prohibited inputs.

### Algorithm identity

The first contract is:

- algorithm version: **body-energy-v1.0.0**;
- constants version: **body-energy-constants-v1**;
- baseline version: **robust-baseline-v1**;
- output range: integer 0 through 100 after half-away-from-zero rounding;
- internal arithmetic: IEEE 754 numbers with every published intermediate rounded to six decimal places before hashing;
- as-of buckets for persisted intraday checkpoints: 15-minute UTC buckets, while calculation still receives the exact as-of instant;
- retrospective recomputation horizon after an eligible correction: 45 local health days.

A constants change requires a new constants version. A formula or input-semantic change requires a new algorithm version. Historical results are never silently rewritten under the same version.

All coefficients, weights, thresholds, and horizons in Body Energy v1 are versioned engineering calibration defaults. They are not presented as evidence-derived medical constants.

### Accepted canonical inputs

Only records visible to the tenant and current under canonical freshness/tombstone rules may enter v1:

| Input | Role | Eligibility |
|---|---|---|
| Main sleep | Required wake anchor | Non-nap sleep, end at or before as-of, not deleted, most recent usable end within 36 elapsed hours |
| Sleep performance | Initial charge factor | Score 0–100 from the anchor sleep; omitted if unavailable |
| Sleep need/debt | Initial charge factor | WHOOP-derived duration fields from the anchor sleep; converted to debt hours and bounded 0–8 |
| Recovery score | Initial charge factor | Recovery paired to the anchor cycle or sleep, score 0–100, source-effective at or before as-of |
| HRV | Initial charge factor | Recovery HRV with a valid personal baseline built only from earlier health days |
| Resting heart rate | Initial charge factor | Recovery RHR with a valid personal baseline built only from earlier health days |
| Current cycle strain | Wake-period load | Cycle beginning no later than as-of; strain bounded 0–21 |
| Completed workout strain | Load fallback only | Used only when current cycle strain is unavailable; completed no later than as-of |
| Completed scored nap | Recharge | Nap sleep ending after the main wake anchor and no later than as-of, 20–180 minutes |

Body measurements are excluded from the v1 score. Their current storage uses synchronization-time day semantics and lacks an equivalent WHOOP source update timestamp, so using them would weaken reproducibility. They may be displayed as non-score provenance only after a later contract resolves that ambiguity.

In-progress workouts, future-ended records, deleted records, records rejected by ownership fences, records whose ingestion time is after as-of, and unverified free text are excluded.

### Personal baselines

HRV and RHR baselines use earlier health days only:

- target: 30 valid daily values;
- lookback: 45 health days;
- minimum for a usable standardized factor: 7 values;
- center: median;
- scale: median absolute deviation multiplied by 1.4826;
- fallback when median absolute deviation is zero: interquartile range divided by 1.349;
- if both scales are zero or unavailable, the factor is omitted rather than treated as normal;
- values from the current health day never enter its baseline.

Baseline readiness is:

- **WARMING_UP**: fewer than 7 valid earlier days;
- **LIMITED**: 7–29 valid earlier days;
- **READY**: 30 valid earlier days.

### Initial charge

Define factor scores:

- recovery factor = recovery score;
- sleep-performance factor = sleep performance;
- sleep-sufficiency factor = clamp(0, 100, 100 − 12.5 × debt_hours);
- HRV factor = clamp(0, 100, 50 + 12 × robust_z_hrv);
- RHR factor = clamp(0, 100, 50 − 12 × robust_z_rhr).

Weights are:

- recovery: 0.35;
- sleep performance: 0.25;
- sleep sufficiency: 0.20;
- HRV: 0.10;
- RHR: 0.10.

Omitted factors contribute neither weight nor a zero. Let available_weight be the sum of available factor weights and factor_mean be the weighted mean over available factors.

The score has no value unless:

- a valid main-sleep wake anchor exists;
- available_weight is at least 0.45; and
- at least one of recovery or sleep performance is available.

Otherwise initial_charge is:

initial_charge = clamp(40, 95, 45 + 0.50 × factor_mean)

This deliberately starts a typical adequately recovered day near 70, keeps extreme starts bounded, and makes missing factors visible through confidence rather than inventing values.

### Time depletion and physiological load

Elapsed time is measured in UTC instants, never local-clock hours:

wake_hours = max(0, elapsed_seconds(wake_at, as_of) ÷ 3600)

time_depletion =

- 1.60 × min(wake_hours, 8), plus
- 2.30 × max(wake_hours − 8, 0).

If current cycle strain is present:

load_depletion = 0.85 × cycle_strain ^ 1.25

If cycle strain is absent, completed workouts are a fallback:

load_depletion = min(24, 0.75 × sum(workout_strain ^ 1.15))

Cycle strain and workout strain are never added together, which avoids double-counting. Negative strain deltas and source corrections do not create negative depletion; a corrected lower strain can increase a newly recomputed result, but the provenance must identify the source correction.

### Qualified nap recharge

V1 recognizes canonical scored naps only. Unstructured “rest” text is not a score input because the repository has no authoritative rest-duration source. A future version may add a separately measured rest contract.

A nap qualifies when it:

- is explicitly a nap;
- ends after the main wake anchor and at or before as-of;
- lasts 20–180 minutes;
- has a stable source record ID and is not tombstoned; and
- ended at least 15 elapsed minutes before as-of.

Each nap contributes:

nap_bump = min(12, 2 + 0.06 × duration_minutes)

The health-day sum is capped at 15. A source nap ID contributes at most once. The bump becomes eligible only when the completed nap first enters the as-of input set.

### Final score

raw = initial_charge − time_depletion − load_depletion + min(15, sum(qualified_nap_bumps))

body_energy = round_half_away_from_zero(clamp(0, initial_charge, raw))

The upper clamp to initial_charge ensures that naps restore part of the day’s depleted estimate without converting the score into a higher-than-morning recovery claim.

### Freshness, quality, and confidence

Core freshness age is elapsed time between as-of and the newest successful synchronization evidence covering sleeps, recoveries, and cycles. It is not the age of the physiological event.

Only synchronization evidence at or before as-of is eligible.

Freshness component:

- 1.00 at 90 minutes or newer;
- linearly declines to 0.50 at 6 hours;
- linearly declines to 0.20 at 24 hours;
- 0 after 24 hours.

Completeness component is available_weight. Baseline component is valid_baseline_days ÷ 30, clamped 0–1. Source-validity component is 1 only when tenant ownership, lifecycle, non-tombstone, and as-of checks all pass; otherwise the result has no value.

confidence = clamp(0, 1,
0.35 × completeness +
0.25 × freshness +
0.25 × baseline +
0.15 × source_validity)

Confidence labels are:

- **HIGH** at 0.80 or above;
- **MEDIUM** at 0.60–0.799999;
- **LOW** at 0.40–0.599999;
- **INSUFFICIENT** below 0.40.

Quality state is one of:

- **UNAVAILABLE**: required WHOOP capability is known to be unavailable or lifecycle authorization fails;
- **NO_DATA**: there is no valid wake anchor, insufficient factor weight, or core freshness is older than 24 hours;
- **WARMING_UP**: a value exists with fewer than 7 baseline days;
- **LIMITED**: a value exists with 7–29 baseline days or confidence below 0.60;
- **READY**: a value exists with 30 baseline days, freshness no older than 90 minutes, and confidence at least 0.80;
- **DEGRADED**: a value exists but freshness is older than 90 minutes, a normally present core resource is temporarily missing, or reconciliation reports a relevant unresolved discrepancy.

Quality ordering for publication is READY, LIMITED, WARMING_UP, DEGRADED, NO_DATA, UNAVAILABLE. **DEGRADED** may carry a value but must name the degradation. **NO_DATA** and **UNAVAILABLE** carry no numeric value.

### Health-day and DST rules

- The health day is the local calendar date of the chosen main-sleep end in the user timezone snapshot.
- All depletion and freshness durations use UTC instants.
- A timezone change does not relabel an already persisted result. New calculations use the current lifecycle-authorized timezone and store it.
- Ambiguous or nonexistent local wall times are never used for elapsed arithmetic.
- For scheduling only, a duplicated local delivery time selects the first occurrence; a nonexistent local time advances to the first valid instant after the gap.
- The persisted unique identity includes user, health day, UTC as-of bucket, algorithm version, and input generation. DST cannot create a duplicate identity.

### Persistence and reproducibility

Persist a result whenever it is used in a Morning Brief, Q&A answer, episode, decision, or user-visible explanation. Optional periodic checkpoints may be persisted at most once per 15-minute bucket.

Each stored result contains:

- exact input row identities and source version timestamps;
- ingestion timestamps used by the as-of fence;
- factor values, omitted-factor reasons, baselines, and intermediate depletion terms;
- algorithm, constants, and baseline versions;
- canonical input generation and lifecycle generation;
- deterministic input hash and result hash;
- invalidation timestamp and reason, when superseded by corrected inputs.

Reproduction loads the stored input manifest rather than today’s “latest” rows. If an historical source version is unavailable, the API must say **NOT_REPRODUCIBLE_FROM_RETAINED_INPUTS** rather than silently recomputing a different value.

Late-arriving data never leaks backward into what was knowable at an earlier as-of instant. It creates a new result at a later as-of and may supersede the current interpretation within the 45-day horizon. A source correction invalidates current dependents and creates a newly versioned result, while the immutable snapshot actually shown to the user remains available as historical audit with its old manifest and an invalidation annotation.

### Property and example tests

The implementation gate requires:

- identical normalized inputs produce byte-identical normalized output and hashes;
- score is always an integer from 0 through 100;
- later as-of instants cannot increase the score when the eligible input identities and source versions are unchanged;
- every increase must be explained by a newly qualified nap or an explicit changed input identity/source version in provenance;
- added nonnegative strain cannot increase the score;
- a qualified nap cannot add more than 12 and all naps cannot add more than 15;
- missing factors are omitted and reduce confidence rather than becoming zero;
- current-day data never leaks into an earlier-day baseline;
- future-ingested or future-ended data cannot affect an earlier as-of calculation;
- cycle and workout strain are never double-counted;
- DST spring-forward and fall-back examples use correct elapsed time;
- stale, tombstoned, cross-tenant, and lifecycle-stale rows are rejected;
- boundary examples cover every threshold and rounding half case;
- a stored fixture for each algorithm version reproduces forever.

## 4. Data quality and meaningful change

### Quality envelope

Every Phase 4 observation carries a quality envelope, not just a value:

- status from the shared readiness vocabulary;
- completeness ratio;
- freshness age and freshness status;
- source-validity result;
- lifecycle-validity and authorization-generation result;
- baseline count, sample-sufficiency result, and lookback;
- source discrepancy flags;
- lifecycle and input generations;
- algorithm version;
- missing-input reasons;
- numeric confidence;
- source provenance references.

No downstream component may reinterpret a missing value as zero, normal, unchanged, or negative evidence.

### Metric registry

Meaningful-change rules live in a versioned metric registry, not scattered constants. Each metric entry defines:

- unit and valid range;
- absolute and relative magnitude floors;
- baseline method and minimum samples;
- open and close robust-z thresholds;
- minimum persistence and debounce;
- material-severity threshold;
- staleness limit;
- direction semantics;
- whether a single severe observation may open an episode;
- compatible evidence methods;
- user-facing caveats.

Changing a rule creates a new registry version and decision-policy version.

### Deterministic change calculation

For observation x and an earlier-only baseline:

1. Validate range, provenance, lifecycle, as-of, and freshness.
2. Calculate absolute_delta = x − baseline_median.
3. Calculate relative_delta only when the registry denominator floor is met.
4. Calculate robust_z using the median/MAD method in Section 3 and the IQR fallback.
5. Require the metric’s absolute or relative magnitude floor.
6. Require the open robust-z threshold.
7. Apply persistence, unless the metric permits a single observation at its material-severity threshold.
8. Compare the semantic observation against current and recent episode history.
9. Compare it with recent delivered semantic claim/action hashes.
10. Produce a normalized meaningfulness score 0–1 from magnitude, persistence, recency, novelty, and quality.

Meaningful change is necessary but not sufficient for interruption. Confidence and actionability remain separate deterministic fields so a large but unactionable or poorly supported change can open an episode without sending a message.

Default registry behavior, used only when a metric-specific entry is absent, is:

- at least 7 valid baseline samples;
- open at absolute robust_z of 2.5;
- close below absolute robust_z of 1.5;
- persistence in two eligible observations separated by at least 30 minutes and no more than 36 hours;
- single-observation opening only at absolute robust_z of 4.0 and confidence at least 0.80.

A default rule cannot authorize a notification; notification-capable metrics require an explicit registry entry and actionability definition.

### Hysteresis and correction behavior

The lower close threshold prevents flapping. Observations between close and open thresholds maintain the episode’s current state but do not escalate it.

Source correction, journal correction, or deletion:

- increments the Phase 4 input generation in the same transaction as the mutation;
- invalidates overlapping derived results;
- recomputes under the original as-of boundary where retained inputs permit;
- appends correction events rather than erasing episode history;
- may resolve or invalidate an episode;
- never sends a retraction automatically. A separately evaluated decision may propose a correction message when materially useful and safe.

### Missing and degraded data

Missingness is itself typed:

- **NOT_COLLECTED**;
- **NOT_AUTHORIZED**;
- **NOT_YET_SYNCED**;
- **STALE**;
- **SOURCE_DELETED**;
- **INSUFFICIENT_BASELINE**;
- **RECONCILIATION_DISCREPANCY**;
- **NOT_APPLICABLE**.

Missingness can create a data-quality episode only when a product rule says the user can take a useful action, such as reconnecting an expired authorization. It must not create a physiological anomaly.

### Significant decision

**Decision:** Replace mean/standard-deviation anomaly assumptions for Phase 4 meaningfulness with median/MAD plus a defined IQR fallback, while retaining existing analytics unchanged.

**Alternative rejected:** Reuse all current calculations in [src/analyze.js](../src/analyze.js) and [src/dailyMetrics.js](../src/dailyMetrics.js) as the Phase 4 definition.

**Rationale:** Those modules are valuable evidence producers but do not by themselves supply a unified quality envelope, versioned thresholds, hysteresis, durable episodes, or strict as-of contracts.

**Compatibility impact:** Existing reports and dormant Phase 3 outputs remain unchanged. Phase 4 may cite an existing calculation only through a versioned evidence adapter.

**Failure mode controlled:** Outliers, partial data, and recomputation noise must not create repeated “new” events.

## 5. Observation Episode state machine

### Episode identity

An episode groups semantically continuous change. Its fingerprint is the hash of:

- tenant user ID;
- domain and metric registry key;
- direction;
- algorithm major version;
- source subject, such as body_energy or recovery;
- local health-window family.

The fingerprint does not include the latest value, timestamp, message text, evidence score, or input generation. Those belong to episode revisions.

At most one active episode exists for a tenant and fingerprint. Active means a state other than RESOLVED, EXPIRED, or INVALIDATED.

Each episode record exposes:

- tenant-qualified ID and explicit episode type;
- semantic fingerprint, subject, direction, and health window;
- current state, severity, confidence, novelty, and explained/unexplained status;
- first observed, last observed, and last materially changed instants;
- current observation and evidence-version membership;
- last context-question decision and delivery;
- last notification decision and delivery;
- stabilization, resolution, expiry, and invalidation boundaries;
- current episode revision and input generation.

Severity is the ordinal band declared by the metric registry and can fall only after the close threshold is crossed. Episode confidence is the minimum of the latest qualifying observation confidence and the highest current compatible evidence confidence; before a separate evidence item exists, it equals the observation confidence and is labelled observation-only. Novelty is true only when the state, severity band, explained status, semantic claim hash, or recommended-action hash differs materially from the last delivered episode revision. Explained status requires a linked current evidence item or confirmed context fact and stores which uncertainty it resolves.

### States

| State | Meaning |
|---|---|
| OPEN | First qualified meaningful change accepted |
| UPDATING | New observations merged without material escalation |
| ESCALATED | Severity, persistence, or actionability materially increased |
| EXPLAINED | Evidence or confirmed context supplies a useful non-causal explanation |
| STABILIZING | Values crossed the close threshold but the resolution hold has not elapsed |
| RESOLVED | Resolution hold completed |
| EXPIRED | Observation window elapsed without enough current evidence |
| INVALIDATED | Corrections or provenance failure make the episode unsupported |

OPEN, UPDATING, ESCALATED, EXPLAINED, and STABILIZING are active. RESOLVED, EXPIRED, and INVALIDATED are terminal for that episode row, except the explicit reopen rule below.

### Legal transitions

~~~mermaid
stateDiagram-v2
    [*] --> OPEN
    OPEN --> UPDATING
    OPEN --> ESCALATED
    OPEN --> EXPLAINED
    OPEN --> STABILIZING
    UPDATING --> UPDATING
    UPDATING --> ESCALATED
    UPDATING --> EXPLAINED
    UPDATING --> STABILIZING
    ESCALATED --> UPDATING
    ESCALATED --> EXPLAINED
    ESCALATED --> STABILIZING
    EXPLAINED --> UPDATING
    EXPLAINED --> ESCALATED
    EXPLAINED --> STABILIZING
    STABILIZING --> UPDATING
    STABILIZING --> ESCALATED
    STABILIZING --> RESOLVED
    OPEN --> EXPIRED
    UPDATING --> EXPIRED
    EXPLAINED --> EXPIRED
    OPEN --> INVALIDATED
    UPDATING --> INVALIDATED
    ESCALATED --> INVALIDATED
    EXPLAINED --> INVALIDATED
    STABILIZING --> INVALIDATED
~~~

Every transition appends an immutable episode event containing old and new state, reason code, input generation, evidence references, actor type, and deterministic transition key.

### Open, merge, split, and reopen

- **Open:** the first observation satisfying Section 4 creates OPEN.
- **Merge:** the same fingerprint merges while windows overlap or the gap is at most 36 elapsed hours. Each source observation can be a member once.
- **Update:** a merged observation that changes summary but not severity moves or remains UPDATING.
- **Escalate:** requires a registry-defined severity crossing, materially greater persistence, or newly actionable evidence. A recomputation with equivalent semantics cannot escalate.
- **Explain:** requires a current evidence item or user-confirmed context linked to the episode. “Explained” never means causal.
- **Stabilize:** requires all current qualifying observations below the close threshold.
- **Resolve:** requires STABILIZING for the registry’s resolution hold, default 24 elapsed hours, with no new open-threshold observation.
- **Expire:** applies when the metric observation window ends or required data remains unavailable beyond the registry expiry, default 7 days.
- **Invalidate:** applies when every supporting observation becomes invalid or cross-tenant/provenance/lifecycle validation fails.
- **Split:** opposite direction, different domain, non-overlapping causal hypothesis, or an algorithm-major incompatibility creates a different fingerprint and episode.
- **Reopen:** a recurrence within 7 days of RESOLVED creates a new episode linked by **reopens_episode_id**. It does not mutate the terminal row. This preserves immutable historical delivery and decision references.

### Concurrency

Episode mutation uses:

- a unique partial index for one active tenant/fingerprint;
- an expected episode revision in every update;
- a unique membership key for each source observation;
- a unique transition key;
- retry on uniqueness conflict by re-reading the winner;
- lifecycle and input-generation fences before commit.

Two workers processing the same invalidation must converge on one episode revision. No worker may send as part of that retry.

### Notification relationship

Episodes are evidence organization, not notification records. A notification is considered only on a meaningful transition such as OPEN, ESCALATED, or a materially useful EXPLAINED transition. UPDATING alone does not make a new notification novel.

A daily recomputation cannot repeat a notification when episode revision, semantic claim hash, and recommended-action hash are unchanged. A new calendar day is not novelty. Last-question and last-notification references are updated only from terminal delivery outcomes, not from mere proposals.

## 6. Structured Journal and Context Discovery

### Context fact model

The existing **journal_events** table is **extended**, not replaced. Each logical fact gains:

- **logical_fact_id**: stable tenant-scoped identity;
- **revision**: monotonically increasing integer;
- **fact_status**: ACTIVE, SUPERSEDED, or DELETED;
- **supersedes_event_id**;
- **source_event_key**: idempotency key from Telegram update or future source;
- **question_id** and optional **episode_id**;
- **parser_version** and **normalizer_version**;
- **extraction_confidence**;
- **raw_answer_excerpt**: the minimum relevant answer span, trimmed and bounded to 500 Unicode code points;
- **recorded_timezone**;
- **invalidated_at** and reason.

The existing category, subtype, value, unit, severity, note, source, occurred_at, and health_date fields remain the normalized fact payload. Existing rows are backfilled with deterministic logical IDs and revision 1.

### Factor taxonomy and typed values

Phase 4 v1 reuses and versions the categories in [src/journal.js](../src/journal.js) **CATEGORIES**:

- intake/exposure: alcohol, caffeine, late_meal, food, supplement, medication;
- condition/context: sickness, stress, late_sleep;
- mobility/environment: travel, flight, location;
- activity/recovery action: exercise_note, sauna, massage;
- custom: requires a bounded subtype or text value and can never independently support a promoted insight.

The fact value shape is closed:

- presence;
- numeric value plus validated unit;
- ordinal severity 1–5;
- categorical subtype;
- bounded text value;
- point, interval, or whole-health-day time scope.

Unknown units or ambiguous categories are not silently normalized. Taxonomy additions require a new taxonomy/normalizer version.

### Time scope and health-day alignment

Facts store event start, optional event end, recorded timezone, time-scope type, health date, and alignment status.

- If a relevant main-sleep wake boundary is current, health-date alignment uses that boundary.
- Otherwise the existing 04:00 local fallback in **healthDateFor** is used and alignment is **PROVISIONAL**.
- When a later canonical sleep supplies the true boundary, reanalysis deterministically realigns affected facts, increments input generation when the health date changes, and invalidates dependents.
- Interval facts are eligible only for outcome windows they actually precede or overlap under the registered lag rule.
- A timezone change never rewrites a fact’s recorded local time silently; realignment creates a new fact revision or explicit alignment revision.

### Ambiguous answers

The deterministic validator returns one of ACCEPT, REJECT, or REQUIRE_CLARIFICATION.

REQUIRE_CLARIFICATION is mandatory when:

- multiple factor categories remain plausible;
- occurrence time could change the health day;
- a unit is missing where the numeric value would otherwise be misleading;
- mutually inconsistent values are present; or
- parser confidence is below 0.75.

An ambiguous candidate may be retained only as bounded pending-question context until expiry. It is not an ACTIVE journal fact and cannot enter evidence. The LLM may propose the clarification wording but cannot promote the candidate or create an insight.

### Idempotent ingestion

For a non-null source event key, tenant plus source plus source event key is unique. Replaying an inbound Telegram update, webhook-like context import, or retry returns the prior logical fact result.

LLM parsing may propose a candidate object, but deterministic code must:

- validate the schema and allowed vocabulary;
- normalize unit, time, timezone, category, and range;
- bind the authenticated tenant;
- reject unsupported or unsafe content;
- persist the candidate and invalidation in one transaction.

No LLM-provided tenant ID, database ID, health day, lifecycle generation, or delivery authorization is trusted.

### Correction

A correction:

1. locks the current ACTIVE logical fact revision;
2. validates the replacement under the current deterministic normalizer;
3. inserts a new revision with the same logical_fact_id;
4. marks the old revision SUPERSEDED;
5. increments the Phase 4 input generation;
6. writes invalidation covering every evidence item, episode, insight, decision, and answer that referenced the old revision;
7. commits all six effects atomically.

The prior normalized revision may remain for audit and reproducibility, but current reads exclude it. The old raw excerpt is redacted after correction; the new active revision retains only its own minimal excerpt.

### Deletion

A deletion:

1. resolves the authenticated tenant and active logical fact;
2. writes a minimal tombstone containing only tenant, logical_fact_id, source-event hash, deletion time, and idempotency key;
3. deletes all journal-event revisions for that logical fact, including raw text and normalized health content;
4. increments the Phase 4 input generation and writes invalidation in the same transaction.

A deletion tombstone must not contain category, subtype, value, unit, severity, note, answer text, health date, evidence summary, or embedding. It exists only to make deletion replay safe and prevent resurrection.

### Context questions

**pending_questions** remains the Telegram conversation-state mechanism and is **reused** for one open interaction. A new typed **context_questions** record is the analytical provenance:

- candidate set and scores;
- selected question;
- policy and template versions;
- linked episode and decision;
- uncertainty the answer is expected to reduce;
- source facts already known;
- delivery message ID;
- answer status;
- answer fact ID;
- expiry and lifecycle generation.

The context question is not opened in **pending_questions** until its outbound message is DELIVERED or has a provider-confirmed accepted message ID. AMBIGUOUS delivery does not open a second question or trigger a retry; it enters reconciliation/manual-safe handling.

### Known context and question eligibility

A candidate is ineligible when:

- an ACTIVE current fact already supplies the same context for the relevant window;
- a semantically equivalent question is open;
- the user answered or declined the same category inside its versioned fatigue window;
- the answer cannot change evidence interpretation, episode state, or the next decision;
- the question is merely a mechanical reaction to an anomaly;
- it requests sensitive detail unnecessary for the stated decision;
- lifecycle, tenant, or notification-pause authorization fails.

Corrections and deletions immediately change the known-context set after commit through the invalidation pipeline.

The user-facing journal read lists current ACTIVE facts with logical fact ID, normalized value, occurrence time, health-date alignment, source, and parser confidence. Correction and deletion commands must target that tenant-qualified logical ID; the UI or bot must not require a database row ID or expose another tenant’s candidate.

### Significant decision

**Decision:** Extend **journal_events** for fact revision and add typed question provenance instead of overloading **pending_questions.context_json**.

**Alternative rejected:** Store every correction, question score, and episode link only in generic JSON.

**Rationale:** Current journal data is useful and tenant-scoped, while question lifecycle and evidence provenance require indexed invariants, idempotency, and deletion semantics.

**Compatibility impact:** Existing journal readers continue to see revision-1 rows during dual-read migration. Phase 4 readers select ACTIVE facts only. Legacy pending-question behavior remains until the context-question flag is enabled.

**Failure mode controlled:** Retried answers, corrected context, or deleted facts cannot continue to influence evidence invisibly.

## 7. Evidence Engine

### Durable model

The Evidence Engine persists immutable **evidence_runs** and **evidence_items**. A run records:

- tenant, method, subject key, and requested as-of instant;
- exact observation window and health-day timezone snapshot;
- input generation, input manifest hash, and lifecycle generation;
- algorithm and metric-registry versions;
- eligible, excluded, exposed, and unexposed sample counts;
- missingness profile;
- multiple-testing family and correction method;
- completion status and deterministic error code.

An evidence item records:

- run and tenant identity;
- typed claim and direction;
- effect estimate and unit;
- uncertainty interval or deterministic bound;
- raw and adjusted significance where applicable;
- sample counts and effective sample size;
- quality and recency;
- known confound flags;
- input provenance references;
- causal status, always **ASSOCIATION_ONLY** for observational Phase 4 evidence;
- invalidation and supersession metadata.

Runs and items are append-only. Correction and deletion mark them invalidated; they do not rewrite the historical result.

### Evidence methods

V1 supports these registered methods:

- current value versus robust personal baseline;
- monotonic trend over a declared window;
- exposed-versus-unexposed journal-context association;
- same-user similar-day comparison;
- correlation with Pearson and Spearman estimates when their assumptions are reported;
- deterministic Body Energy driver decomposition;
- data-quality and missingness explanation.

Every method declares its minimum samples, inclusion rules, effect-size floor, freshness limit, and caveats. An unregistered ad hoc statistic cannot promote an insight or authorize a notification.

Personal baselines default to the earlier-only 30-valid-day target within 45 health days in Section 3. Trend methods declare window length, minimum distinct health days, slope unit, and serial-correlation caveat. They cannot inherit a window implicitly from a caller.

### Lag alignment

Each context/outcome method declares a finite set of tested lags before execution, such as same health day, next health day, or a bounded 0–24-hour interval. Exposure and outcome are aligned using stored UTC instants plus their recorded timezone/health-date mapping. The run records every tested lag in the multiple-comparison family. It may not select the best-looking lag and omit the rest.

### Temporal integrity

The following are mandatory:

- Baselines contain only observations strictly earlier than the target health day.
- An evidence item’s as-of read cannot see a row ingested after that instant.
- Exposure must precede or overlap the defined outcome window; future context cannot explain an earlier outcome.
- Timezone and health-day mapping are stored with the run.
- Recomputed results use a new run ID and link to the superseded run.
- Training or calibration data, if later introduced, must be separated from evaluation data by user and time.

### Association guardrails

An exposed-versus-unexposed context association is a **candidate** only when:

- each group has at least 3 usable days;
- total usable days are at least 10;
- the configured minimum effect size is met;
- neither group has more than 40 percent missing outcome data;
- quality is at least LIMITED; and
- direction and units are valid.

It becomes **repeated evidence** only when:

- each group has at least 5 usable days;
- total usable days are at least 20;
- at least two non-overlapping evidence windows or registered replication slices agree in direction;
- the repeated observations span at least 7 elapsed days;
- the effect remains above the registered floor;
- no hard confound flag is present.

It becomes **insight-supporting evidence** only when, in addition:

- the run belongs to a declared multiple-testing family;
- Benjamini–Hochberg false-discovery-rate adjustment is at most 0.10;
- at least one supporting run ends within the last 30 days;
- the effect direction is compatible with the existing insight;
- all linked evidence contract versions are compatible.

These are minimum statistical guardrails, not proof of causation. A metric registry may require stricter thresholds.

### Multiple comparisons and recency

All hypotheses evaluated from one invalidation generation and subject family form one multiple-testing family. The run stores every tested hypothesis, including non-selected results. Selection cannot hide failed comparisons.

Recency uses a 30-day half-life for ranking:

recency_weight = 2 ^ (−age_days ÷ 30)

Recency changes ranking and confidence, never the raw statistic or historical result. Expired evidence remains in audit history but is excluded from current reads.

### Evidence confidence

Evidence confidence is a versioned ranking score, not a frequentist probability or medical certainty:

evidence_confidence = clamp(0, 1,
0.25 × data_quality +
0.20 × sample_sufficiency +
0.20 × replication +
0.15 × effect_stability +
0.10 × recency +
0.10 × multiplicity_control −
0.15 × soft_confound_fraction)

The components are deterministic 0–1 values defined by the method registry. Any hard confound caps confidence below 0.40. A missing uncertainty estimate caps it below 0.60. The item exposes each component, the score, and LOW, MEDIUM, or HIGH label using the Section 3 label thresholds.

### Confounds

Evidence items explicitly flag:

- low or differential sample count;
- differential missingness;
- autocorrelation;
- overlapping journal exposures;
- seasonality or weekday imbalance;
- recent travel or timezone change when known;
- source reconciliation discrepancy;
- medication, illness, menstrual, alcohol, or other context only when the user supplied it;
- algorithm-version mixing;
- survivorship from deleted or corrected facts.

Unknown context is labelled unknown, never inferred.

### Persistence boundary

Every evidence item used in an episode transition, insight transition, proactive decision, Morning Brief claim, or Q&A claim must be durable before the consumer commits. A basic raw-data answer may be assembled without a statistical run, but any derived comparison or association exposed to the user must reference a durable evidence item.

### Reuse and isolation

Existing functions in [src/analyze.js](../src/analyze.js), [src/evidence.js](../src/evidence.js), and the analytics modules may be wrapped as registered methods after their input and output contracts satisfy this section. Their current persisted output is not automatically Phase 4 evidence.

The dormant worker tables and worker entry points documented in [docs/analytics-decoupling.md](analytics-decoupling.md) are not the Phase 4 queue. Phase 4 uses separate invalidation and job records so rollout cannot accidentally wake Phase 3.

## 8. Insight Memory lifecycle

### Existing-state compatibility

The current status vocabulary in [src/healthMemory.js](../src/healthMemory.js) is **reused**:

- HYPOTHESIS;
- EMERGING;
- SUPPORTED;
- WEAKENED;
- RETIRED.

Phase 4 adds an indexed **lifecycle_disposition** for terminal meaning:

- REJECTED;
- REFUTED;
- EXPIRED;
- INVALIDATED;
- SUPERSEDED;
- USER_DISMISSED.

An active insight has no terminal disposition. A RETIRED insight must have exactly one disposition. This preserves current consumers while making rejected, refuted, expired, corrected, and superseded memory unambiguous.

### Identity and versioning

An insight key is tenant plus normalized subject, outcome, direction, exposure category, algorithm family, and evidence-contract major version. At most one non-retired current insight exists for a key.

Each transition creates a new immutable **insight_revision** record and updates the current pointer with compare-and-swap on revision and input generation. The revision stores exact supporting and contradicting evidence-item IDs.

### Lifecycle

~~~mermaid
stateDiagram-v2
    [*] --> HYPOTHESIS
    HYPOTHESIS --> EMERGING
    HYPOTHESIS --> RETIRED
    EMERGING --> SUPPORTED
    EMERGING --> WEAKENED
    EMERGING --> RETIRED
    SUPPORTED --> WEAKENED
    SUPPORTED --> RETIRED
    WEAKENED --> EMERGING
    WEAKENED --> SUPPORTED
    WEAKENED --> RETIRED
~~~

Rules:

- **HYPOTHESIS** may be created from candidate evidence for tracking, but is not a user-established finding.
- **HYPOTHESIS → EMERGING** requires repeated evidence under Section 7.
- **EMERGING → SUPPORTED** requires insight-supporting evidence under Section 7 and a second compatible supporting evidence item that is not the same resample.
- HYPOTHESIS can never transition directly to SUPPORTED.
- A single day, single journal answer, single anomaly, or user confirmation cannot promote an insight.
- User confirmation can improve context quality or answerability but is not statistical replication.
- User refutation creates or corrects context and may set USER_DISMISSED for proactive use, but it does not by itself statistically REFUTE an insight.
- Contradictory current evidence moves EMERGING or SUPPORTED to WEAKENED before retirement unless provenance invalidation requires immediate retirement.
- **REJECTED** means a candidate did not meet promotion gates before its evaluation window ended.
- **REFUTED** means sufficient current evidence materially contradicts the claim.
- **EXPIRED** means all supporting evidence aged out without current replication.
- **INVALIDATED** means corrections, deletions, provenance failure, or lifecycle fences removed necessary support.
- **SUPERSEDED** means a compatible newer algorithm or more specific insight replaces it.
- **USER_DISMISSED** suppresses proactive use but does not falsify evidence.

### Expiry and currentness

Default evidence expiry for proactive use is 90 days unless the metric registry specifies less. Expiry evaluation is deterministic and appends a revision. Historical Q&A may describe an expired insight only when the user explicitly requests history and the response labels it expired.

Current reads require:

- tenant match;
- non-RETIRED status;
- no terminal disposition;
- compatible evidence version;
- lifecycle generation current for delivery-sensitive use;
- no invalidated supporting item;
- latest applicable input generation processed.

### Language contract

HYPOTHESIS and EMERGING language uses “may be associated” or “we are still checking.” SUPPORTED uses “has been repeatedly associated in your data.” No status permits “causes,” “prevents,” “diagnoses,” or equivalent causal/medical wording.

### Concurrency and failure

Insight writes use unique current-key constraints, expected revision, and deterministic transition IDs. If two runs compete, one wins and the other re-evaluates against the winner. A partially written revision cannot be visible as current. An evidence invalidation and insight retirement must share a transaction when both are known in the same write unit; otherwise the currentness read fence excludes the stale insight until the repair job finishes.

## 9. Meaningfulness and proactive decision policy

### Exact action space

Every Phase 4 proactive evaluation produces exactly one of:

- **NO_NOTIFICATION**
- **NOTIFY**
- **ASK_ONE_HIGHEST_VALUE_QUESTION**
- **DEFER_OBSERVATION**

No alias, implicit fifth action, LOG_ONLY action, or transport state is permitted in the decision column.

### Ordered eligibility gates

The policy evaluates:

1. authenticated tenant ownership of every input and destination;
2. ACTIVE lifecycle, READY onboarding, and current lifecycle/auth generations;
3. notification-pause preference and a valid bound delivery destination;
4. current input generation and absence of blocking invalidation;
5. source validity and freshness;
6. completeness, sample sufficiency, and quality state;
7. confidence threshold;
8. magnitude, persistence, and meaningful episode transition;
9. novelty against recent episode and delivered semantic history;
10. actionability and interruption value;
11. recent question state, known context, and fatigue;
12. delivery eligibility and expiry;
13. question value and notification value independently;
14. deterministic conflict resolution;
15. durable decision creation.

Failure at gates 1 or 2 produces NO_NOTIFICATION with a typed suppression reason. A likely-to-resolve quality or persistence shortfall produces DEFER_OBSERVATION. A valid but non-novel or non-actionable result produces NO_NOTIFICATION.

### Meaningfulness for proactive use

A proactive candidate must be tied to OPEN, ESCALATED, or a materially new EXPLAINED episode transition. It must:

- meet its metric registry threshold;
- be current and quality-eligible;
- differ semantically from prior delivered content, not merely numerically;
- have a user action, useful interpretation, or high-value uncertainty to resolve;
- avoid repeating an acknowledged, dismissed, or unchanged message.

Notification novelty is based on episode revision, semantic claim hash, recommended-action hash, and previously delivered message records. Text variation does not create novelty.

### Notification eligibility

NOTIFY is eligible only when all are true:

- the episode transition is material and novel;
- evidence supports the claim language;
- a concrete, proportionate, non-medical action or interpretation exists;
- asking a question is not required to avoid a materially misleading statement;
- timeliness matters enough that waiting for the Morning Brief would reduce usefulness;
- the same semantic action has not already been delivered for the episode revision.

Sudden deterioration may pass on one severe registered observation only when the Section 4 exception is enabled for that metric. Its output remains a wellness signal, never diagnosis, emergency detection, or assurance of safety.

### Question candidate score

Eligible question candidates are scored from normalized 0–1 components:

question_value =

- 0.30 × uncertainty_reduction;
- plus 0.25 × probability_answer_changes_decision;
- plus 0.20 × episode_relevance;
- plus 0.10 × user_answerability;
- plus 0.10 × recency;
- minus 0.20 × known_context;
- minus 0.15 × repeat_fatigue.

The score is clamped 0–1. A candidate must score at least 0.60 and satisfy Section 6. Ties are broken by higher probability of changing the decision, then lower sensitivity, then stable candidate key.

At most one question is selected. The selected question, all candidate scores, and exclusion reasons are persisted.

### Independent evaluation and conflict resolution

Question and notification eligibility are evaluated independently from the same episode snapshot.

- If neither is eligible and more evidence is expected soon, choose DEFER_OBSERVATION.
- If neither is eligible and waiting adds no expected value, choose NO_NOTIFICATION.
- If only one is eligible, choose its corresponding action.
- If both are eligible, choose NOTIFY only when delay could reduce the usefulness of a concrete action and the notification can be truthful without the answer.
- Otherwise choose ASK_ONE_HIGHEST_VALUE_QUESTION when its answer has at least a 0.50 modeled probability of changing the next interpretation or action.
- If both remain eligible after those rules, a stable policy priority registered for the metric resolves the tie; no LLM resolves it.

If no question passes validation, the policy performs a fresh independent notification evaluation. This is not a downgrade. Once an ASK decision is committed, a later validation, delivery, or timeout failure cannot mutate it to NOTIFY. A new trigger and new decision are required.

### No normal-operation cap

Phase 4 has no daily, hourly, topic, or message-count cap in normal operation. It replaces use of **ANTI_SPAM_POLICY.DAILY_PROACTIVE_CAP** and the cap branch in **decide** for Phase 4 decisions.

Safety controls are still required:

- semantic novelty;
- one open context question;
- lifecycle and pause authorization;
- episode transition requirements;
- provider retry bounds;
- an abnormal-volume circuit breaker.

The circuit breaker is not a product quota. It trips only on evidence of runaway behavior, such as more than 8 Phase 4 proactive delivery proposals for one tenant in a rolling 24 hours or a system-wide anomaly rate above its operational threshold. It suppresses delivery, emits an operational incident, and requires automatic or operator-confirmed recovery. A trip is visible as **ABNORMAL_VOLUME_CIRCUIT_BREAKER**, never “daily cap reached.”

### Decision durability

A decision stores:

- exact action;
- episode ID and revision;
- evidence IDs;
- policy, registry, template, and algorithm versions;
- input and lifecycle generations;
- all gate results;
- all question candidates and scores;
- notification score and actionability reason;
- semantic claim and recommended-action hashes;
- deterministic decision key;
- created, superseded, invalidated, and expiry timestamps.

The unique decision key is tenant plus episode revision plus policy version plus input hash. Replays return the existing decision.

### Significant decision

**Decision:** Replace the Phase 4 use of daily count caps and automatic ASK-to-NOTIFY conversion with quality, episode, novelty, and actionability gates.

**Alternative rejected:** Keep the current cap and treat NOTIFY as a harmless fallback whenever a question cannot be asked.

**Rationale:** A count cap can suppress the only important event or permit low-value events up to the cap. A failed question does not imply that an unqualified assertion is safe.

**Compatibility impact:** Legacy proactive behavior can remain behind its existing flag. Phase 4 decisions never call **downgradeAskToNotify**.

**Failure mode controlled:** Mechanical anomaly messages, repeated low-value output, and unsupported assertions after question failure.

## 10. Event-driven invalidation and reanalysis

### Required separation

The pipeline is:

~~~mermaid
flowchart LR
    A[Canonical or journal mutation] --> B[Phase 4 invalidation]
    B --> C[Coalesced recomputation job]
    C --> D[Observations and quality]
    D --> E[Episode transition]
    E --> F[Evidence and insight update]
    F --> G[Proactive decision]
    G --> H[Outbound proposal]
    H --> I[Delivery dispatcher]
    I --> J[Telegram provider]
~~~

Each arrow crosses a durable boundary. Trigger code cannot skip directly to decision or delivery. Reanalysis code cannot call Telegram.

### Trigger contract

Eligible triggers are:

- actual semantic changes to canonical WHOOP rows;
- canonical tombstones;
- reconciliation corrections;
- journal create, correction, and deletion;
- user answers to a delivered context question;
- timezone or relevant preference changes;
- lifecycle, authorization, capability, or resource-access changes relevant to computation or delivery;
- algorithm or registry rollout backfills.

An idempotent no-op canonical write does not increment the Phase 4 generation.

### Transactional invalidation

When a canonical or journal write changes semantics, the same **processing.transaction** must:

- commit the source change;
- increment the tenant Phase 4 input generation;
- merge the affected health-date range, subject keys, and reason codes into **phase4_invalidations**;
- enqueue or advance the corresponding **phase4_jobs** generation.

This extends the safe invalidation pattern in [src/analyticsInvalidation.js](../src/analyticsInvalidation.js) but does not enqueue the existing analytics worker classes.

### Job model

Jobs are coalesced by tenant and job kind. A job contains requested generation, completed generation, affected range, reason set, attempt, next-attempt time, lease owner, and lease expiry.

The worker:

1. claims with a bounded lease;
2. captures requested generation and lifecycle generation;
3. performs provider-free calculations from a stable read snapshot;
4. commits derived writes only if lifecycle, authorization, capability, and input-generation fences still pass;
5. advances completed generation;
6. immediately requeues when a newer requested generation arrived during work.

Retry backoff is bounded and observable. Poison jobs move to a repair-required state without blocking other tenants.

The default retry schedule is 1 minute, 5 minutes, 15 minutes, 1 hour, and 6 hours. After five failed claims for the same requested generation, the job becomes REPAIR_REQUIRED and emits an operational alert. A newer input generation can create a fresh attempt only after the prior typed error is re-evaluated.

In shadow-reanalysis mode, the worker may persist artifacts marked SHADOW but cannot create an outbound proposal. In shadow-decision mode, it may persist a decision but cannot create an outbound message. Removing the SHADOW mark requires recomputation under the enabled production contract; a shadow row is never silently promoted.

### Reanalysis contract

Reanalysis may:

- write or invalidate Body Energy results;
- write evidence runs and items;
- transition episodes and insights;
- create a proactive decision;
- create an outbound proposal.

It may not:

- send Telegram messages;
- mutate lifecycle or authorization truth;
- fetch user data from a provider while holding a database transaction;
- activate or call the dormant Phase 3 analytics worker;
- reinterpret a deletion tombstone as health context;
- publish a result from a stale generation.

Provider refresh and WHOOP canonicalization remain in their existing ingestion/reconciliation layers.

### Scheduling

The existing scheduler may invoke a lightweight Phase 4 queue drain only after the relevant feature flag is enabled. This is an additive call in the existing application process, not a cron-frequency change and not a call to the dormant analytics drain. The same worker can also be prompted after an inbound event, but durable queue state remains the source of truth.

### Failure behavior

- Crash before commit: lease expiry permits safe replay.
- Crash after source commit but before worker claim: durable invalidation remains.
- New input during calculation: commit fence fails and newer generation remains queued.
- Evidence failure: episode may remain current only if its prior evidence is still current; otherwise current reads exclude it.
- Decision failure: no delivery proposal exists.
- Delivery failure: analysis remains valid and delivery state handles retry or ambiguity.

## 11. Morning Brief

### Eligibility and identity

An eligible user is:

- lifecycle ACTIVE;
- onboarding READY at the current lifecycle and auth generations;
- linked to an active private Telegram destination;
- not notification-paused;
- assigned a valid IANA timezone.

Account PAUSED or DISABLED remains authoritative. **notifications_paused** is a separate user preference that suppresses proactive delivery without changing account ingestion lifecycle.

The delivery identity is:

user_id + report_type MORNING_BRIEF_V1 + local_health_date

There is exactly one logical claim for that identity. A provider delivery start may repeat only after a definite non-acceptance; an ambiguous start is never retried automatically. Provider ambiguity is reported honestly because no distributed system can prove that a second send would not duplicate an accepted Telegram message.

### Per-user delivery policy

Preferences support:

- **AFTER_WAKE**: default for migrated users, 30 elapsed minutes after a usable main-sleep end;
- **FIXED_LOCAL_TIME**: user-selected wall time;
- fallback local time: default 10:00 when AFTER_WAKE has no usable wake anchor;
- timezone: current lifecycle-authorized user timezone;
- notification-pause state.

All fields are tenant-scoped and auditable. A user may change them without changing account lifecycle.

For a duplicated local time at fall-back, choose the first occurrence. For a nonexistent spring-forward time, choose the first valid instant after the gap. Once a claim exists, a timezone change cannot create a second claim for its health date.

### Missing data never cancels

The brief is eligible at its delivery time even when sleep, recovery, Body Energy, evidence, or journal data is missing. Missing data changes content, never existence.

Each expected section renders one of:

- a current value and provenance;
- a degraded value and explicit caveat;
- “not available yet” with the typed missingness reason;
- “not available for this account” for a known unavailable capability.

It must not wait indefinitely for a scored recovery. A later data arrival may update Q&A and episodes but does not create a second Morning Brief for the same health day.

### Required content order

1. Health-day and as-of timestamp.
2. Body Energy with quality, confidence, drivers, and OS-authored label, or explicit no-data state.
3. Sleep/recovery/current-load facts with provenance.
4. At most one current repeated association or insight, labelled non-causal.
5. Current actionable observation, if one is eligible.
6. One concise data-quality statement.

The Morning Brief does not ask a context question inline in v1. A separately eligible question follows the proactive decision and outbound state machine, preventing one report send from creating two conversational intents.

### Delivery reuse

Morning Brief **reuses** the exact report-claim crash boundary in [src/reportDelivery.js](../src/reportDelivery.js):

- durable claim before send;
- atomic transition to DELIVERY_STARTED;
- lifecycle recheck immediately before start;
- definite failure release/retry;
- ambiguous outcome terminal for automatic retry;
- delivered message ID recording;
- sent-run uniqueness.

The current report’s content-readiness gate is **replaced for MORNING_BRIEF_V1** by this section. Existing report types are unchanged.

### Liveness

The scheduler retries an unstarted claim throughout its health day and until the next health day’s preferred delivery instant. If the service was unavailable beyond that point, the old claim becomes EXPIRED_SYSTEM_OUTAGE and the newest due brief is evaluated. The expiry is an operational failure, not a data-readiness cancellation, and must be observable.

Morning Brief scheduling is independent of opportunistic episode notifications. A proactive delivery neither satisfies nor delays the daily brief, and the brief claim does not consume any proactive eligibility.

## 12. Outbound delivery state machine

### Separation of records

One table must not pretend all delivery classes have identical identity:

- Morning Brief continues to use **report_claims** and **report_runs** because their user/report/local-date key and delivery-start boundary are exact.
- Phase 4 episode notifications and context questions use new **outbound_messages** and **outbound_delivery_attempts**.
- A later follow-up resulting from an answer uses the same generic outbox with message class ANSWER_FOLLOW_UP and a new decision; answering never sends inline.
- **telegram_operations** remains the receipt for replies to inbound updates.
- **proactive_events** remains legacy history and is not the Phase 4 outbox.

### Message states

| State | Meaning |
|---|---|
| PROPOSED | Immutable payload and source decision persisted |
| ELIGIBLE | Latest lifecycle, pause, currentness, and novelty checks passed |
| CLAIMED | Dispatcher owns a bounded lease; provider call has not begun |
| DELIVERY_STARTED | Pre-send transaction committed; provider outcome may become ambiguous |
| DELIVERED | Provider confirmed acceptance and message ID is stored |
| FAILED_DEFINITE | Provider proved non-acceptance; bounded retry may be scheduled |
| AMBIGUOUS | Acceptance cannot be proven either way; no automatic retry |
| SUPPRESSED | Authorization, pause, novelty, or policy prevented start |
| INVALIDATED | Source decision became stale before DELIVERY_STARTED |
| FAILED_TERMINAL | Definite retries exhausted |

Legal transitions:

~~~mermaid
stateDiagram-v2
    [*] --> PROPOSED
    PROPOSED --> ELIGIBLE
    PROPOSED --> SUPPRESSED
    PROPOSED --> INVALIDATED
    ELIGIBLE --> CLAIMED
    ELIGIBLE --> SUPPRESSED
    ELIGIBLE --> INVALIDATED
    CLAIMED --> ELIGIBLE
    CLAIMED --> SUPPRESSED
    CLAIMED --> INVALIDATED
    CLAIMED --> DELIVERY_STARTED
    DELIVERY_STARTED --> DELIVERED
    DELIVERY_STARTED --> FAILED_DEFINITE
    DELIVERY_STARTED --> AMBIGUOUS
    FAILED_DEFINITE --> ELIGIBLE
    FAILED_DEFINITE --> FAILED_TERMINAL
~~~

DELIVERED, AMBIGUOUS, SUPPRESSED, INVALIDATED, and FAILED_TERMINAL are terminal. A message cannot be invalidated after DELIVERY_STARTED because the provider may already have it.

### Identity and payload

The unique idempotency key is tenant plus message class plus source decision ID plus semantic payload hash. The record stores:

- authenticated destination reference, never caller-supplied chat ID;
- exact text or structured Telegram payload;
- content and semantic hashes;
- decision, episode, question, and evidence references;
- lifecycle, input, policy, and template versions;
- state and expected revision;
- expiry;
- attempt counters and terminal reason.

Payload is frozen before PROPOSED commits. Retry sends the same payload; it does not regenerate text under newer context.

### Claim and send protocol

1. Claim ELIGIBLE with owner and lease.
2. Recheck user ACTIVE, READY, destination binding, notifications not paused, message expiry, decision currentness, and no prior delivery.
3. In a transaction, insert the attempt and set DELIVERY_STARTED with exact attempt ID.
4. Commit.
5. Call Telegram outside the transaction.
6. On confirmed acceptance, store DELIVERED and provider message ID.
7. On definite non-acceptance, store FAILED_DEFINITE and retry only the registered retryable errors with bounded backoff.
8. On timeout, connection loss after request write, malformed success, or process crash after step 4, set or recover as AMBIGUOUS and do not automatically resend.

A startup repair changes expired CLAIMED records back to ELIGIBLE because no provider call began. Expired DELIVERY_STARTED records become AMBIGUOUS.

### Question-specific behavior

A DELIVERED question creates or activates its **pending_questions** row idempotently. A definite terminal failure leaves no open pending question. An ambiguous outcome reserves the question semantic key so a competing question is not sent; it does not assume the user received it.

An answer can trigger invalidation and reanalysis. Any useful follow-up requires a new durable decision and an ANSWER_FOLLOW_UP proposal. The inbound answer handler and reanalysis worker cannot send the follow-up directly.

### No direct-send rule

Only the delivery dispatcher owns a Telegram send capability for Phase 4 outbound messages. Calculation, episode, evidence, insight, reanalysis, policy, Q&A read, and Morning Brief composition modules receive no Telegram client.

## 13. Q&A read boundary

### Scoped context service

All Phase 4 Q&A reads go through one **ScopedHealthContext** service. Its required input is:

- authenticated internal user ID derived from the inbound Telegram binding;
- perspective classification;
- exact as-of instant;
- purpose and requested subjects;
- maximum health-day range;
- lifecycle generation.

It never accepts an arbitrary user ID, Telegram chat ID, or WHOOP ID from model output or question text.

### Mandatory authorization order

The route order is:

1. authenticate private Telegram sender and resolve tenant;
2. enforce lifecycle and resource access;
3. classify perspective as SELF, THIRD_PARTY, or GENERAL;
4. build the permitted context scope;
5. load current tenant-scoped facts and derived artifacts;
6. generate a deterministic answer plan;
7. optionally use an LLM for wording within the plan;
8. apply claim, provenance, medical-language, and currentness guards;
9. persist cited user-visible derived evidence where required;
10. reply through the existing inbound-operation receipt.

THIRD_PARTY and GENERAL scopes cannot load personal health context, even if the question contains evidence-related terms.

### Required correction to current routing

The current evidence shortcut in [src/bot/router.js](../src/bot/router.js) is evaluated before the general intent and perspective plan. Phase 4 must **replace that ordering** so every evidence query passes the perspective gate before **handleEvidence** or any successor reads tenant health data.

This is defense in depth: current tenant lookup still prevents reading another user’s row, but semantic perspective authorization must be uniform and auditable.

### Read-currentness rules

The context service returns only:

- canonical rows current under tombstone and source-version rules;
- ACTIVE journal facts;
- non-invalidated Body Energy results compatible with requested as-of;
- current episodes;
- non-invalidated evidence items;
- promoted EMERGING or SUPPORTED insights under Section 8 by default;
- delivered-message history needed for novelty;
- explicit missingness and generation lag.

If requested derived data is behind the current input generation, the answer either computes a pure current result synchronously within a bounded budget or says analysis is updating. It never serves a stale insight as current.

A user who explicitly asks what the system is still testing may receive a HYPOTHESIS, clearly labelled unpromoted and never phrased as a finding.

### Clarification boundary

Q&A asks a clarification instead of answering when:

- SELF versus another person is ambiguous;
- the requested date or window would materially change the answer;
- two metrics or units match the user’s phrase;
- the only available result is incompatible with the requested as-of or algorithm version;
- a missing user fact could make the proposed interpretation misleading and no safe limited answer exists.

The clarification is an inbound conversational reply using **telegram_operations**, not a proactive decision or Phase 4 outbound proposal. Q&A must never trigger proactive delivery, enqueue a notification, or call the scheduler.

### Answer contract

Every health answer distinguishes:

- source fact;
- OS calculation;
- observational association;
- user-provided context;
- unavailable or stale data.

Body Energy answers include algorithm version, as-of, quality, confidence, and “calculated by Kelvin Health OS, not WHOOP.” Association answers include sample counts, window, effect, quality, and a non-causal label.

The LLM may reorder or phrase approved claims. It may not introduce a metric, causal statement, diagnosis, treatment instruction, unapproved third-party context, or uncited numeric value.

### Tenant and administrative isolation

There is no administrator or family bypass. Operational interfaces may inspect job IDs, states, timings, hashes, and reason codes, but not plaintext health content. A support or admin role cannot use Q&A to browse tenants.

### Significant decision

**Decision:** Create one mandatory scoped read boundary and move perspective authorization ahead of every specialized Q&A handler.

**Alternative rejected:** Depend on each handler to remember tenant filtering and perspective rules.

**Rationale:** Tenant SQL predicates prevent many leaks but do not express whether a self-health answer is semantically permitted for a general or third-party question.

**Compatibility impact:** Existing deterministic queries can be adapted behind the service. Inbound deduplication and action receipts remain unchanged.

**Failure mode controlled:** A specialized evidence route cannot bypass the uniform privacy and currentness policy.

## 14. Additive post-v20 schema and migration proposal

### Migration posture

The current schema is version 20 in [src/schema.js](../src/schema.js). Phase 4 migrations begin at v21 and are additive. They must not rebuild, drop, rename, or reinterpret a populated v20 table.

[src/migrations.js](../src/migrations.js) does not wrap the entire migration sequence in one global transaction. A process can therefore stop after DDL or backfill work but before the schema-version row is written. Every Phase 4 migration step must be safe to rerun after any prior statement succeeded.

### Cross-cutting entity contract

**input_generation** is the Phase 4 computation generation. Any artifact derived from WHOOP data also stores the current authorization generation; anything used for a user-visible action stores lifecycle generation. Currentness compares all applicable generations, not timestamps alone.

| Entity family | Tenant owner/key | Required fences | Mutable versus immutable | Time, version, quality | Retention/deletion |
|---|---|---|---|---|---|
| User state/preferences | user_id in primary key | lifecycle checked on use | Preferences mutable with version; generations monotonic | updated_at and preference version | While account exists |
| Journal facts | user_id in every fact/revision key | lifecycle on write; input generation advanced | Revisions immutable after supersession; current status mutable transactionally | event time, health date, timezone, parser/normalizer version, confidence | Section 15; deletion removes health content |
| Context questions | user_id plus question_id | lifecycle and input generation | Candidate decision immutable; answer/status transitions revisioned | expiry, policy/template version, scores | 400 days after terminal state; raw answer follows journal rules |
| Body Energy | user_id plus result_id | lifecycle, auth, input generation | Result immutable; invalidation marker append-like | as-of, health date, algorithm versions, quality/confidence/provenance | 400 days subject to references |
| Evidence | user_id on run and item keys | lifecycle, auth, input generation | Completed runs/items immutable; invalidation marker only | window, as-of, algorithm/evidence versions, quality/provenance | 400 days subject to current insights |
| Episodes | user_id plus episode ID | lifecycle, auth, input generation | Current pointer/state optimistic; observations/events immutable | observation times, health range, registry version, confidence | 400 days after terminal |
| Insights | user_id plus insight ID/key | lifecycle, auth, input generation | Current pointer optimistic; revisions immutable | expiry, evidence/algorithm versions, confidence in evidence links | 400 days after retirement |
| Invalidation/jobs | user_id plus job kind | claim captures lifecycle/auth/requested generation | Coalesced mutable queue state with immutable generation ordering | lease and retry timestamps, job version | Error detail 30 days; current queue row while account exists |
| Decisions | user_id plus decision ID | lifecycle, auth, input generation | Immutable except invalidation/expiry marker | episode revision, policy/evidence/template versions, gate results | 400 days |
| Messages/attempts | user_id in every identity | lifecycle/auth/input at proposal and pre-send | Payload and attempts immutable; state CAS | expiry, template/policy version, provider timestamps | Plaintext 90 days; metadata 400 days |

All cache keys repeat user_id plus artifact ID or semantic key, version, and applicable generation. An artifact ID alone is never a cache key.

### Existing storage mapping

| Existing storage or symbol | Phase 4 treatment | Reason |
|---|---|---|
| **users**, **user_telegram**, lifecycle generation | REUSE | Authoritative tenant, lifecycle, timezone, and destination binding |
| **transitionUserLifecycle** | REUSE | Sole lifecycle transition path and READY demotion behavior |
| **user_onboarding**, capability/access tables | REUSE | ACTIVE plus READY authorization gate |
| Canonical **whoop_*** tables and tombstones | REUSE | Authoritative source data and freshness protection |
| **processing.transaction** | REUSE | Atomic source mutation plus invalidation |
| **journal_events** | EXTEND | Preserve current normalized facts while adding revisions and source idempotency |
| **pending_questions** | REUSE narrowly | Conversation transport state, not analytical provenance |
| **health_insights** | EXTEND | Preserve status compatibility while adding insight key, evidence version, current revision, expiry, and disposition |
| **report_claims**, **report_runs** | REUSE for MORNING_BRIEF_V1 | Exact user/report/local-date identity and safe delivery-start boundary |
| **telegram_processed_updates**, **telegram_operations** | REUSE | Inbound idempotency and reply receipts |
| **ai_usage** | REUSE | LLM usage audit without storing unrestricted prompt content |
| **analytics_invalidation**, **analytics_work_state** | DO NOT OVERLOAD | Phase 3 workers must stay dormant |
| **proactive_events** | DO NOT OVERLOAD | It combines legacy decision and send behavior and lacks the new delivery state machine |
| **briefing_evaluations** | DO NOT OVERLOAD | It is not an episode, evidence, or decision ledger |
| **pending_questions.context_json** | DO NOT OVERLOAD | Lifecycle invariants require typed indexed columns |
| **report_claims** | DO NOT OVERLOAD for episode messages | Its local-date report identity does not fit episode revisions |
| WHOOP webhook ledger | DO NOT OVERLOAD | Provider event ingestion is not a derived-work queue |

### V21: tenant state and preferences

**phase4_user_state**

- primary key: user_id;
- input_generation, default 0;
- last_completed_generation, default 0;
- created_at and updated_at;
- invariant: generations are nonnegative and completed is not greater than input.

**user_notification_preferences**

- primary key: user_id;
- notifications_paused boolean;
- morning_brief_mode: AFTER_WAKE or FIXED_LOCAL_TIME;
- morning_brief_local_time;
- after_wake_delay_minutes;
- fallback_local_time;
- preference_version;
- created_at and updated_at.

Rows are created lazily or deterministically backfilled for current users. Defaults are the Section 11 defaults. Lifecycle remains in **users**; notification pause must not be added as another lifecycle status.

### V22: structured journal and context

Add nullable columns to **journal_events**:

- logical_fact_id;
- revision;
- fact_status;
- supersedes_event_id;
- source_event_key;
- question_id;
- episode_id;
- parser_version;
- normalizer_version;
- extraction_confidence;
- raw_answer_excerpt;
- recorded_timezone;
- time_scope;
- event_end_at;
- health_date_alignment;
- alignment_version;
- invalidated_at;
- invalidation_reason.

Backfill legacy rows with:

- logical_fact_id = deterministic namespace plus existing tenant and event ID;
- revision = 1;
- fact_status = ACTIVE;
- normalizer_version = legacy-v20;
- recorded_timezone from the stored user timezone when deterministically available, otherwise null with a legacy provenance marker.

Indexes:

- unique user, logical_fact_id, revision where logical_fact_id is non-null;
- unique user, source, source_event_key where source_event_key is non-null;
- one ACTIVE revision per user and logical_fact_id;
- user, fact_status, health_date;
- user, invalidated_at.

**journal_event_tombstones**

- primary key: user_id plus logical_fact_id;
- source_event_hash;
- deletion_idempotency_key;
- deleted_at;
- no health-content columns.

**context_questions**

- primary key: user_id plus question_id;
- unique decision ID;
- episode ID and revision;
- selected candidate key;
- deterministic candidate-set hash;
- question template and policy versions;
- expected uncertainty reduction and decision-change probability;
- sensitivity and fatigue class;
- outbound message ID;
- pending-question ID;
- status, expiry, answered_at;
- answer logical_fact_id;
- lifecycle generation;
- authorization and input generations;
- created_at and updated_at.

The full candidate diagnostics may be stored as bounded immutable JSON on the question or decision, but status, selected key, scores used for querying, and relationship IDs are typed.

### V23: Body Energy, evidence, episodes, and memory

**body_energy_results**

- primary key: user_id plus result_id;
- unique user, health_date, as_of_bucket_utc, algorithm_version, input_generation;
- exact as_of_utc, wake_at_utc, timezone, health_date;
- nullable integer value;
- quality state, confidence, confidence label;
- algorithm, constants, baseline, and metric-registry versions;
- input generation, lifecycle generation, and authorization generation;
- input manifest JSON, driver JSON, missingness JSON;
- input hash and result hash;
- invalidated_at and reason;
- created_at.

JSON is appropriate here for an immutable bounded manifest whose hash and version are typed. It is not used for lifecycle state.

**evidence_runs**

- primary key: user_id plus run_id;
- deterministic run key unique per tenant;
- subject key, method, window start/end, as-of, timezone;
- algorithm, registry, and evidence-contract versions;
- input, lifecycle, and authorization generations;
- input manifest hash;
- sample and exclusion counts;
- multiple-testing family;
- state: STARTED, COMPLETED, FAILED, INVALIDATED;
- error code, started_at, completed_at, invalidated_at.

**evidence_items**

- primary key: user_id plus evidence_item_id;
- unique user, run_id, item_key;
- typed claim key, direction, unit;
- effect, lower and upper bound;
- raw and adjusted significance;
- exposed, unexposed, effective sample counts;
- quality, recency weight, causal status;
- bounded provenance and confound JSON;
- invalidated_at, supersedes_item_id, created_at.

**observation_episodes**

- primary key: user_id plus episode_id;
- fingerprint and revision;
- domain, subject key, direction;
- state and severity;
- opened_at, updated_at, stabilization_started_at, resolved_at, expires_at;
- health-window start/end and timezone;
- current input generation;
- lifecycle and authorization generations;
- latest evidence item ID;
- reopens_episode_id;
- semantic summary hash;
- created_at.

Index:

- unique user and fingerprint for active states OPEN, UPDATING, ESCALATED, EXPLAINED, STABILIZING;
- user, state, updated_at;
- user, subject key, health-window end.

**episode_observations**

- primary key: user_id, episode_id, observation_key;
- source type, source ID, source version;
- observed_at, health_date;
- normalized value, unit, robust-z, meaningfulness;
- quality and input generation;
- added_at, invalidated_at.

**episode_evidence**

- primary key: user_id, episode_id, evidence_item_id;
- episode revision and relationship type;
- linked_at and unlinked_at.

**episode_events**

- primary key: user_id plus episode_event_id;
- unique deterministic transition key;
- episode ID, from state, to state, reason;
- expected and resulting revision;
- input generation;
- bounded evidence-reference JSON;
- actor type and created_at.

Add nullable columns to **health_insights**:

- insight_key;
- current_revision;
- evidence_contract_version;
- lifecycle_disposition;
- expires_at;
- invalidated_at;
- lifecycle_generation;
- auth_generation;
- input_generation.

Add a unique partial index for one non-RETIRED current insight per tenant and insight key after backfill validation.

**insight_revisions**

- primary key: user_id, insight_id, revision;
- status and lifecycle disposition;
- normalized claim and claim hash;
- evidence contract version;
- bounded supporting and contradicting evidence ID lists;
- transition reason;
- input and lifecycle generations;
- created_at.

### V24: invalidation, decisions, and delivery

**phase4_invalidations**

- primary key: user_id;
- requested_generation;
- minimum and maximum affected health dates;
- bounded reason-code set;
- bounded subject-key set;
- updated_at.

This is a coalesced current-work marker, not health history.

**phase4_jobs**

- primary key: user_id plus job_kind;
- requested and completed generations;
- affected range and reason set;
- state, attempt, next_attempt_at;
- lease owner and lease expiry;
- claimed lifecycle and authorization generations;
- last typed error and updated_at.

Permitted job kinds are explicit, including RECOMPUTE_DERIVED and REPAIR_CURRENTNESS. No Phase 3 worker class is accepted.

**phase4_proactive_decisions**

- primary key: user_id plus decision_id;
- unique deterministic decision key;
- exact action constrained to the four values in Section 9;
- episode ID and revision;
- input, lifecycle, and authorization generations;
- policy, metric-registry, evidence, and template versions;
- gate results and candidate diagnostics as bounded immutable JSON;
- selected question key;
- notification, question, semantic claim, and action hashes;
- decision reason;
- invalidated_at, expires_at, created_at.

**outbound_messages**

- primary key: user_id plus message_id;
- unique tenant and idempotency key;
- message class: EPISODE_NOTIFICATION, CONTEXT_QUESTION, or ANSWER_FOLLOW_UP;
- decision, episode, question IDs;
- authenticated destination binding ID;
- immutable payload, payload hash, semantic hash;
- state and revision;
- lifecycle, authorization, and input generations;
- attempt count, next_attempt_at, expires_at;
- lease owner and expiry;
- provider message ID;
- terminal reason;
- created_at, updated_at.

**outbound_delivery_attempts**

- primary key: user_id plus attempt_id;
- unique user, message ID, attempt number;
- state, request hash, provider status class;
- delivery_started_at, completed_at;
- provider message ID;
- typed error and ambiguity reason.

The request hash excludes secrets and includes the immutable destination binding and payload.

Required secondary indexes are:

- context questions by user/status/expiry, user/episode, and user/outbound message;
- Body Energy by user/health date/as-of descending and user/input generation/invalidation;
- evidence runs by user/subject/as-of and user/state/input generation;
- evidence items by user/run, user/claim key/created time, and user/invalidation;
- episode observations by user/source type/source ID/version, episode evidence by user/evidence item, and episode events by user/episode/created time;
- insight revisions by user/insight/revision descending and health insights by user/status/expiry;
- Phase 4 invalidations by updated time and jobs by state/next-attempt and lease expiry;
- decisions by user/episode/revision, user/action/created time, and user/invalidation;
- outbound messages by state/next-attempt, lease expiry, source decision, and semantic hash;
- delivery attempts by user/message/attempt number and state/completed time.

Every index begins with user_id unless it is an operational queue index whose selected rows return only opaque tenant IDs and are immediately re-scoped before health access.

### Referential integrity decision

Current v20 tables do not declare SQL foreign keys. New Phase 4 records therefore use tenant-qualified composite references and mandatory application validation rather than relying on partially enabled foreign-key behavior. Every child row carries user_id, and parent lookup uses user_id plus parent ID.

An offline integrity audit must detect orphans and cross-tenant ID collisions. A future all-schema foreign-key migration may replace this decision, but Phase 4 must not create a false impression that only some relationships are database-enforced.

### Restart-safe migration procedure

Every version follows this sequence:

1. Inspect **schema_version**, SQLite metadata, and **PRAGMA table_info**.
2. Create missing tables and indexes with IF NOT EXISTS where SQLite supports it.
3. Before ALTER TABLE ADD COLUMN, check that the column is absent.
4. Backfill with deterministic values and WHERE target_column IS NULL.
5. Run backfills in bounded tenant/key ranges; record resumable checkpoints when one statement is not safely bounded.
6. Validate duplicate candidates and invariant violations before creating a unique index.
7. Create the unique index only after validation.
8. Run postcondition queries for required columns, indexes, counts, nulls, and illegal states.
9. Insert the schema-version row only after every postcondition passes.

If a process stops after step 2, 4, or 7, rerunning begins from inspection and converges without duplicate facts, new random IDs, or data loss. A failed postcondition leaves the version unapplied and the Phase 4 flags off.

Application compatibility order is expand, dual-write, backfill, dual-read verification, switch reads, then optionally stop legacy writes. No contraction or column removal is part of Phase 4.

Rollback disables Phase 4 readers, workers, and delivery flags while leaving additive schema and durable records intact. A migration defect is repaired by a new idempotent forward-fix migration; production-like populated data is never rolled back by dropping columns or reshaping tables.

### Significant decision

**Decision:** Use dedicated typed Phase 4 tables and additive extensions rather than repurposing analytics work state, proactive events, or generic JSON.

**Alternative rejected:** Minimize migrations by storing the entire Phase 4 model in **proactive_events.reason_json** or **pending_questions.context_json**.

**Rationale:** Episode uniqueness, evidence immutability, decision action constraints, delivery ambiguity, correction invalidation, and tenant-currentness need independent indexed state.

**Compatibility impact:** More additive tables and migrations, but no v20 data rewrite and no dormant-worker activation.

**Failure mode controlled:** Partially applied migrations, unqueryable lifecycle state, and one legacy record being treated simultaneously as evidence, decision, and delivery.

## 15. Tenant, privacy, and retention

### Tenant isolation

Every Phase 4 table is tenant-scoped by internal user_id. Every primary, unique, join, update, and delete path includes user_id. External IDs are resolved through existing identity mappings before any health query.

Cross-tenant batch processing may enumerate opaque user IDs, but each tenant is processed in a separate scoped store. Derived input manifests cannot reference a row owned by another tenant. A cross-tenant reference is a hard invariant violation that invalidates the artifact and raises an operational alert.

There is no family or administrator read surface. Operational staff receive only opaque IDs, state, timing, version, count, and reason-code metadata unless a separate, user-authorized support policy is designed later.

### Ownership and fencing

Before a read or write, the scoped store verifies tenant ownership and the lifecycle required for the purpose. Provider-derived computation additionally checks authorization generation, capability, and resource access. Delivery-sensitive reads check ACTIVE, READY, current destination binding, and notification pause immediately before provider start.

Derived rows carry input, lifecycle, and authorization generations as specified in Section 14. A mismatch makes the row non-current even if its timestamp is recent. Caches use tenant, semantic/artifact identity, algorithm version, and all applicable generations. No cache is keyed only by metric, health date, Telegram ID, or WHOOP ID.

Every join repeats user_id on both sides. Store APIs do not accept a child artifact ID without the authenticated user ID. Batch code receives an opaque tenant ID, constructs a fresh scoped store, and cannot reuse another tenant’s in-memory context.

Every lease identity includes user_id, work/message key, owner token, claimed generation, and expiry. Lease takeover requires compare-and-swap on that complete identity. A lease never conveys authorization to read another tenant or to bypass a newer lifecycle/auth generation.

### Data minimization

- Body Energy stores only inputs needed to reproduce a user-visible checkpoint.
- Journal raw text is limited to the relevant 500-code-point answer span, not the surrounding chat.
- Evidence provenance stores row identifiers, source versions, and bounded summaries, not copies of full canonical records.
- Episode and insight summaries use normalized claims and hashes.
- Delivery logs exclude tokens, authorization headers, webhook secrets, and unrestricted prompts.
- LLM calls receive only the minimum tenant-scoped facts for the permitted task.
- Deleted journal tombstones contain no health content.

### Retention defaults

| Data class | Retention |
|---|---|
| Canonical WHOOP records and existing audit data | Existing repository policy; Phase 4 does not change it |
| Active journal normalized fact | While active or until the account’s existing retention policy removes it |
| Raw journal answer excerpt | 90 days maximum, or immediate redaction on correction/deletion |
| Deleted-journal tombstone | While the tenant account exists, to prevent resurrection; contains no health content |
| Body Energy checkpoints | 400 days, unless referenced by a retained user-visible artifact |
| Evidence runs/items and episode history | 400 days after terminal state; longer only while referenced by a current insight |
| Retired insight revisions | 400 days after retirement |
| Outbound plaintext payload | 90 days after terminal delivery state |
| Outbound metadata, hashes, and reason codes | 400 days |
| Phase 4 job error detail | 30 days; aggregate operational metrics may remain without health content |
| LLM request/response content | Not stored as unrestricted logs; approved normalized result only |

Retention jobs are tenant-aware, idempotent, and cannot delete provenance still required by a current user-visible artifact. When an artifact outlives detailed inputs, it must become non-reproducible and non-current rather than pretending to retain support.

Full-account erasure is explicitly outside Phase 4. These defaults do not create an admin browsing entitlement.

### Correction and deletion propagation

Currentness is fail-closed. Immediately after a committed correction or deletion:

- the old journal fact is excluded from reads;
- its input generation is stale;
- linked evidence, episodes, insights, decisions, and unstarted outbound messages are excluded by generation even before repair completes;
- the repair job appends explicit invalidation or transition records;
- a DELIVERED or AMBIGUOUS message is not erased from transport history, but its plaintext follows delivery retention and any later answer must acknowledge corrected context when relevant.

### Logs and observability

Metrics use counts, durations, states, quality labels, algorithm versions, and reason codes. Logs may include opaque tenant and artifact IDs but not raw health values, answer text, notification text, access tokens, or provider payloads.

## 16. LLM boundary

### Permitted uses

An LLM may:

- propose a structured journal parse from a bounded user answer;
- generate wording variants from an already approved deterministic claim plan;
- compress approved provenance into concise language;
- generate the wording of a deterministically selected context-question template;
- classify user intent or perspective, subject to deterministic authorization and safe fallback.

### Prohibited uses

An LLM may not:

- calculate Body Energy, baselines, effects, confidence, or meaningfulness;
- choose episode or insight transitions;
- create evidence statistics;
- choose the proactive action or question winner;
- authorize a read or delivery;
- supply a tenant, destination, lifecycle, or source-record identity;
- decide whether data is current;
- infer unreported sensitive context;
- claim causality, diagnosis, medication changes, or treatment;
- mutate a normalized fact without deterministic schema validation;
- access another tenant or an administrator-wide health context.

### Structured-output gate

Every LLM result is untrusted input. The application:

1. parses against a closed versioned schema;
2. rejects unknown fields and invalid enum values;
3. validates ranges, units, timestamps, and lengths;
4. binds server-owned identity and provenance;
5. verifies every numeric claim against deterministic source data;
6. applies prohibited-language and medical-claim guards;
7. persists model, prompt-template, schema, and validator versions;
8. falls back to deterministic copy or no output on failure.

Prompt injection in journal text or Q&A is treated as user content, never an instruction to expand access or change policy.

### Minimum context

The LLM receives a purpose-specific projection. For example, question wording receives the selected candidate key and allowed neutral facts, not the entire health history. Q&A wording receives an approved claim plan and citations, not database access.

No access token, webhook secret, Telegram secret, external authorization code, raw database connection, or cross-tenant batch is included.

### Failure and availability

LLM unavailability cannot block:

- canonical ingestion;
- journal deletion or correction;
- invalidation;
- Body Energy calculation;
- Morning Brief delivery with deterministic templates;
- episode, evidence, insight, or decision transitions.

If safe deterministic wording is unavailable for an optional proactive message, the message is SUPPRESSED with a typed reason. It is never improvised from an unvalidated model response.

## 17. Feature flags and rollout

### Default-off flags

Every new flag is false when absent, malformed, or unsupported:

- **PHASE4_SCHEMA_WRITES**
- **PHASE4_JOURNAL_REVISIONS**
- **PHASE4_BODY_ENERGY_SHADOW**
- **PHASE4_EVIDENCE_SHADOW**
- **PHASE4_EPISODES_SHADOW**
- **PHASE4_REANALYSIS_WORKER**
- **PHASE4_INSIGHT_MEMORY**
- **PHASE4_PROACTIVE_DECISIONS_SHADOW**
- **PHASE4_OUTBOUND_DELIVERY**
- **PHASE4_MORNING_BRIEF**
- **PHASE4_QA_CONTEXT**

Dependencies are enforced in code. For example, outbound delivery requires schema writes, reanalysis, episodes, evidence, and non-shadow decisions. An invalid flag combination fails closed and emits configuration diagnostics.

There is no flag that aliases or enables the Phase 3 analytics worker. Phase 4 names, job kinds, and drain functions remain separate.

### Rollout sequence

1. **Calculation-only, local:** deploy additive schema support with every behavior flag off, then run pure calculations on synthetic fixtures.
2. **Historical replay, local/staging:** dual-write or import synthetic/populated-v20 fixtures and compare deterministic replay without queue or delivery.
3. **Shadow reanalysis, staging:** enable Body Energy, evidence, episodes, and the Phase 4 queue for explicit non-production test tenants.
4. **Shadow decisions, no sends:** persist decision results and proposed diagnostics while outbound proposal and dispatcher flags remain off.
5. **Controlled test-user delivery:** enable proposals and dispatcher for explicitly authorized internal test tenants, then a small deterministic canary.
6. **Morning Brief and Q&A canary:** enable each independently for the approved cohort after its own review.
7. **Freeze candidate:** freeze algorithm/policy/template versions, run the Final Gate, and prohibit expansion while independent review is open.
8. **Authorized expansion:** expand only after separate product, privacy, security, statistical, Architecture Owner, and independent Final Gate authorization.

Tenant cohorts are stable hashes or explicit allowlists, never inferred from health status.

No item in this sequence is authorized by this ADR alone. Production flags remain off until separately approved, and no rollout step changes the production scheduler cadence.

### Kill switches

Independent switches must stop:

- queue claims;
- outbound claims;
- Morning Brief claims;
- LLM calls;
- Q&A derived reads.

Stopping claims does not delete queued work. A delivery kill switch does not mark messages delivered or failed. Canonical ingestion, correction, deletion, lifecycle, and privacy operations continue.

### Rollout metrics

Required metrics include:

- generation lag and poison-job count;
- Body Energy quality distribution, no-data reasons, and replay mismatch count;
- episode open/merge/split/flap rates;
- evidence invalidation and multiple-testing-family completeness;
- insight transition and expiry rates;
- decision action distribution and reason codes;
- question answer, decline, correction, and deletion rates;
- proposals per tenant with abnormal-volume breaker trips;
- delivery definite failure and ambiguity rates;
- Morning Brief due, claimed, delivered, ambiguous, and outage-expired counts;
- stale-read blocks and cross-tenant invariant violations.

Health values and message text are excluded from operational metrics.

## 18. Test strategy and final gate

### Unit and property tests

Body Energy:

- formula fixtures, bounds, rounding, missing-factor behavior, confidence, freshness;
- monotonic depletion and strain properties;
- qualified-nap uniqueness and bounds;
- exact reproduction from stored manifests;
- algorithm-version separation.

Time and scheduling:

- IANA timezone changes;
- spring-forward nonexistent time;
- fall-back duplicated time;
- UTC elapsed hours across both transitions;
- health-day and one-claim identity.

Meaningfulness and episodes:

- robust baseline and zero-scale fallback;
- open/close hysteresis;
- merge, split, resolution, expiry, reopen, invalidation;
- concurrent identical opens converge;
- stale generation cannot commit.

Journal and context:

- source replay returns the same fact;
- correction creates one active revision and invalidates old consumers;
- deletion removes all health content and leaves only the permitted tombstone;
- known context excludes redundant questions;
- exactly one highest-value eligible question.

Evidence and insights:

- future leakage prevention;
- sample and effect floors;
- complete multiple-testing families and Benjamini–Hochberg fixtures;
- no single-day or single-answer promotion;
- compatible-version enforcement;
- reject, refute, expire, invalidate, and supersede behavior.

Policy:

- exact four-action exhaustive output;
- no normal count-cap branch;
- ASK failure never mutates to NOTIFY;
- question and notification evaluated independently;
- semantic novelty and actionable-transition behavior;
- abnormal circuit breaker has an explicit incident reason.

Delivery:

- crash before claim, after claim, before start, after start, after provider acceptance, and before result commit;
- definite versus ambiguous provider failures;
- payload immutability across retry;
- lifecycle, pause, and stale-decision suppression;
- pending question opens only after confirmed delivery;
- no direct Telegram capability in reanalysis modules.

Privacy and Q&A:

- cross-tenant property tests across every store method;
- third-party and general evidence questions cannot load self context;
- specialized handlers cannot precede the perspective gate;
- deleted, superseded, expired, invalidated, or generation-stale artifacts are absent;
- logs and metrics contain no raw health or answer text.

### Migration tests

For every post-v20 migration:

- clean v20 to target;
- empty database to target;
- a populated v20 fixture;
- stop after each DDL, column, backfill, and index statement, then rerun;
- rerun after complete success;
- duplicate/invalid legacy fixture fails before unique index and before version row;
- old application version can still read required v20 fields during expand;
- new application with behavior flags off changes no user-visible behavior.

### Integration and end-to-end tests

- webhook or sync semantic change to invalidation to recomputation to episode to decision to proposal, with no send;
- journal answer, correction, and deletion through complete propagation;
- active-ready-unpaused Morning Brief with complete, partial, and wholly missing health data;
- pause or lifecycle change at every delivery boundary;
- reconciliation correction of a previously messaged episode;
- inbound Q&A reply deduplication with durable evidence citations;
- two workers contending for the same job, episode, decision, and message;
- Phase 3 worker spies prove zero invocation.

### Non-production verification

No test uses production credentials or production data. Provider calls are faked. Database fixtures are synthetic or explicitly anonymized. Network access is unnecessary for the required suite.

### Required implementation gate

Before each implementation commit:

- run the complete repository test suite under explicit Node 22;
- run stage-specific property, migration, concurrency, privacy, and failure-injection tests;
- confirm no skipped or focused tests;
- confirm schema version and migration rerun tests;
- inspect changed-file scope;
- perform a security/privacy review for new read and write paths;
- perform an independent correctness review for formula or state-machine changes.

Before any user-facing flag:

- all preceding stages are complete;
- shadow replay mismatch is zero for fixed fixtures;
- no unresolved cross-tenant or deleted-data finding exists;
- delivery ambiguity and abnormal-volume behavior are exercised;
- runbook and kill switches are verified;
- product wording and privacy review are approved;
- Phase 3 remains demonstrably dormant.

The measurable Phase 4 Final Gate is:

- 0 known Critical findings;
- 0 known High findings;
- 0 substantive Medium findings;
- no migration or data-integrity blocker;
- no multi-user isolation blocker;
- no duplicate-send blocker;
- no lifecycle, authorization, or computation-fencing blocker;
- no unsupported physiology publication;
- no unsafe notification behavior.

This is a release gate, not a claim that the system is 100 percent bug-free.

### Stage 1 documentation gate

This architecture stage changes only this document. Its gate is:

- all 19 required sections present;
- internal paths and named behaviors checked against the baseline;
- formulas, states, migrations, ownership, and failure behavior explicit;
- complete existing test suite passes under Node 22;
- clean diff contains no source, schema, test, configuration, workflow, or package change;
- local commit only, with no push or deployment.

## 19. Implementation stages and dependency graph

### Dependency graph

~~~mermaid
flowchart TD
    S1[Stage 1 ADR] --> S2[Stage 2 additive storage and stores]
    S2 --> S3[Stage 3 Body Energy and quality]
    S2 --> S4[Stage 4 journal revisions and context]
    S3 --> S5[Stage 5 evidence episodes and insights]
    S4 --> S5
    S5 --> S6[Stage 6 invalidation and reanalysis]
    S6 --> S7[Stage 7 decisions and outbound delivery]
    S7 --> S8[Stage 8 Morning Brief and Q&A]
    S8 --> S9[Stage 9 shadow canary and enablement]
~~~

### Stage 1: architecture decision record

**Depends on:** frozen v20 baseline.

**Files/subsystems likely touched:** this document only.

**Migration impact:** none.

**Output:** one implementation-ready ADR.

**Tests:** complete existing Node 22 suite and documentation/path validation.

**Review:** verify all contracts against current symbols, v20 storage, current delivery behavior, and dormant-worker boundaries.

**Independent review gate:** Architecture Owner review, then Session B read-only review.

**Explicit non-goals:** source, schema, test, scheduler, configuration, deployment, or production changes.

**Exit gate:** Section 18 Stage 1 gate.

### Stage 2: additive storage and tenant-scoped stores

**Depends on:** Stage 1.

**Files/subsystems likely touched:** [src/schema.js](../src/schema.js), [src/migrations.js](../src/migrations.js), new tenant-scoped Phase 4 stores, and migration tests.

**Migration impact:** additive v21–v24 objects and nullable v20 extensions exactly as Section 14; no destructive reshape.

**Work:**

- implement v21–v24 restart-safe migrations in [src/migrations.js](../src/migrations.js) and additive definitions in [src/schema.js](../src/schema.js);
- add tenant-scoped store modules for Phase 4 state;
- add application-enforced composite reference validation and integrity audit;
- leave all behavior flags off.

**Tests:** partial migration interruption, populated v20 backfill, rerun idempotence, uniqueness, tenant isolation, old-read compatibility.

**Output:** disabled schema/store foundation with integrity audit.

**Review focus:** no table reshape, no random backfill identity, no Phase 3 worker wiring, no user-visible behavior.

**Independent review gate:** migration/data-integrity and multi-user-isolation review.

**Explicit non-goals:** calculators, reanalysis, Q&A, message proposals, sends, or flag activation.

**Exit gate:** migrations converge from every tested interruption point and full Node 22 suite passes.

### Stage 3: Body Energy and shared quality

**Depends on:** Stage 2.

**Files/subsystems likely touched:** new Body Energy and quality modules/stores, plus adapters around [src/store.js](../src/store.js), [src/time.js](../src/time.js), and [src/readiness.js](../src/readiness.js).

**Migration impact:** use v23 Body Energy tables from Stage 2; no new migration unless the ADR is amended first.

**Work:**

- implement a pure versioned calculator in a new domain module;
- implement earlier-only robust baselines, quality envelope, provenance manifests, and result persistence;
- add synchronous bounded reads for shadow evaluation;
- expose no user-facing value yet.

**Existing boundaries reused:** canonical reads from **createHealthStore**, timezone utilities in [src/time.js](../src/time.js), readiness vocabulary in [src/readiness.js](../src/readiness.js).

**Tests:** every Section 3 property, DST fixtures, retained-input replay, canonical tombstone/freshness/lifecycle filters.

**Output:** calculation-only, persisted shadow results with provenance.

**Review focus:** no LLM or journal input, no future leakage, no double-counted strain, label never implies WHOOP ownership.

**Independent review gate:** formula, physiology-language, reproducibility, and temporal-integrity review.

**Explicit non-goals:** user display, episodes, proactive decisions, or delivery.

**Exit gate:** fixed-fixture determinism is byte-identical and shadow results have complete provenance.

### Stage 4: structured journal and context

**Depends on:** Stage 2.

**Files/subsystems likely touched:** [src/journal.js](../src/journal.js), journal store/router paths, context-question store, inbound processing, and their tests.

**Migration impact:** use v22 journal columns and context tables from Stage 2; no destructive rewrite.

**Work:**

- dual-write logical fact identity and source idempotency;
- implement correction and deletion transactions;
- add context-question provenance while retaining **pending_questions** as conversation state;
- add current ACTIVE-fact reads.

**Existing boundaries reused:** [src/journal.js](../src/journal.js), inbound update idempotency in [src/bot/updateProcessor.js](../src/bot/updateProcessor.js), shared transactions.

**Tests:** replay, concurrent corrections, delete-versus-answer race, minimal tombstone inspection, raw excerpt bounds, immediate fail-closed reads.

**Output:** tenant-scoped versioned facts, correction/deletion, and typed question provenance behind flags.

**Review focus:** deletion leaves no health content, LLM parse remains a candidate only, existing journal readers remain compatible.

**Independent review gate:** privacy/deletion, parser-authority, and cross-user review.

**Explicit non-goals:** evidence promotion, proactive questions, outbound delivery, or account erasure.

**Exit gate:** correction/deletion currentness and idempotency pass under concurrency.

### Stage 5: evidence, episodes, and insight memory

**Depends on:** Stages 3 and 4.

**Files/subsystems likely touched:** new evidence/episode stores and domain modules, [src/evidence.js](../src/evidence.js), [src/healthMemory.js](../src/healthMemory.js), and approved adapters around [src/analyze.js](../src/analyze.js).

**Migration impact:** use v23 evidence, episode, and insight structures; no Phase 3 table repurpose.

**Work:**

- register evidence methods and persist runs/items;
- implement metric registry and meaningful-change calculation;
- implement episode and insight state machines with optimistic concurrency;
- adapt eligible existing analysis functions without enabling Phase 3.

**Existing boundaries reused:** deterministic card presentation in [src/evidence.js](../src/evidence.js), status concepts in [src/healthMemory.js](../src/healthMemory.js), selected calculations in [src/analyze.js](../src/analyze.js).

**Tests:** temporal integrity, multiple comparisons, episode race convergence, insight promotion floors, correction invalidation.

**Output:** deterministic shadow evidence, episodes, and versioned insight memory.

**Review focus:** associations remain non-causal, single observations never promote, current uniqueness is enforced.

**Independent review gate:** statistical, state-machine, concurrency, and causal-language review.

**Explicit non-goals:** queue activation, proactive decision, Telegram, or user-facing publication.

**Exit gate:** complete historical replay produces stable episode/evidence/insight results without messages.

### Stage 6: invalidation and reanalysis

**Depends on:** Stage 5.

**Files/subsystems likely touched:** canonical/journal mutation adapters, new Phase 4 invalidation/job stores and drain, [src/processingTransaction.js](../src/processingTransaction.js), and scheduler integration behind a flag.

**Migration impact:** use v24 invalidation/job tables; no scheduler-schema or Phase 3 worker change.

**Work:**

- add Phase 4 generation writes to actual semantic canonical and journal changes;
- implement coalesced jobs, lease claims, fences, backoff, and repair;
- add an independently named Phase 4 drain behind a default-off flag;
- keep provider calls outside database transactions.

**Existing boundaries reused:** [src/analyticsInvalidation.js](../src/analyticsInvalidation.js) as a transactional pattern only, and [src/processingTransaction.js](../src/processingTransaction.js).

**Tests:** change/no-change distinction, crash recovery, generation race, coalescing, poison tenant isolation, Phase 3 zero-invocation assertions.

**Output:** disabled-by-default event-to-current-derived-state pipeline.

**Review focus:** trigger to invalidation to recomputation boundaries remain durable and no path owns Telegram.

**Independent review gate:** lifecycle/auth/computation fencing, lease/crash recovery, and dormant-Phase-3 review.

**Explicit non-goals:** message delivery, scheduler cadence change, production flag enablement, or provider fetch inside a transaction.

**Exit gate:** event and replay paths converge to identical derived state in shadow mode.

### Stage 7: decisions and outbound delivery

**Depends on:** Stage 6.

**Files/subsystems likely touched:** new policy, decision, outbound store, dispatcher, Telegram adapter, plus [src/accountLifecycle.js](../src/accountLifecycle.js), [src/attention.js](../src/attention.js), and [src/reportDelivery.js](../src/reportDelivery.js) boundaries.

**Migration impact:** use v24 decision/outbound tables; legacy proactive rows are not migrated into Phase 4 decisions.

**Work:**

- implement the exact four-action policy;
- implement deterministic question scoring and independent notification evaluation;
- remove Phase 4 dependence on count caps and **downgradeAskToNotify**;
- implement message proposal, dispatcher, attempts, and ambiguity recovery;
- connect no production cohort yet.

**Existing boundaries reused:** lifecycle checks in [src/accountLifecycle.js](../src/accountLifecycle.js) and the pre-send boundary pattern in [src/reportDelivery.js](../src/reportDelivery.js).

**Tests:** exhaustive decisions, no downgrade, failure injection around every provider boundary, stale/lifecycle suppression, abnormal circuit breaker.

**Output:** shadow decisions and mocked, then explicitly controlled test-user delivery.

**Review focus:** only dispatcher can send; normal operation has no numeric message cap; ambiguous sends never automatically repeat.

**Independent review gate:** notification safety, duplicate-send, ambiguity, and provider-boundary review.

**Explicit non-goals:** general production delivery, Morning Brief, Q&A reads, or normal-operation count caps.

**Exit gate:** outbound proposal shadowing is stable and mocked delivery is crash-safe.

### Stage 8: Morning Brief and Q&A

**Depends on:** Stage 7.

**Files/subsystems likely touched:** [src/daily.js](../src/daily.js), [src/reportDelivery.js](../src/reportDelivery.js), [src/healthQuery.js](../src/healthQuery.js), [src/bot/router.js](../src/bot/router.js), notification preferences, and presentation tests.

**Migration impact:** use v21 preferences and existing report tables; no new delivery-table unification.

**Work:**

- add MORNING_BRIEF_V1 eligibility, schedule, missing-data rendering, and report claims;
- add notification preferences;
- introduce **ScopedHealthContext** and place perspective authorization before all specialized reads;
- use validated deterministic plans with optional LLM wording.

**Existing boundaries reused:** [src/daily.js](../src/daily.js) scheduling concepts, [src/reportDelivery.js](../src/reportDelivery.js), [src/healthQuery.js](../src/healthQuery.js), and [src/bot/router.js](../src/bot/router.js) after correcting route order.

**Tests:** complete/partial/no-data briefs, exactly one health-day claim, DST, pause/lifecycle races, perspective bypass regression, currentness lag.

**Output:** flag-gated Morning Brief and scoped Phase 4 Q&A.

**Review focus:** missing data never cancels, Body Energy attribution is explicit, no cross-tenant or third-party personal read.

**Independent review gate:** product-language, privacy, scheduling, missing-data, and Q&A-boundary review.

**Explicit non-goals:** dashboard/mobile UI, family sharing, emergency monitoring, or opportunistic brief suppression.

**Exit gate:** end-to-end synthetic users receive at most one correct brief and authorized Q&A answers under failure injection.

### Stage 9: shadow, canary, and enablement

**Depends on:** Stage 8 and all reviews.

**Files/subsystems likely touched:** feature configuration, metrics, runbooks, cohort controls, and non-production/load test harnesses; scheduler cadence remains untouched.

**Migration impact:** none expected; any newly discovered schema need requires a reviewed forward migration.

**Work:**

- follow the Section 17 rollout sequence;
- validate metrics, alerts, runbooks, kill switches, and rollback;
- obtain product-language, statistical, privacy, and security approval;
- expand cohorts only through explicit gates.

**Tests:** production-like synthetic load, queue backlog recovery, provider ambiguity drill, kill switches, rollback with new tables retained, no Phase 3 activation.

**Output:** reviewed freeze candidate and, only after separate authorization, controlled expansion.

**Independent review gate:** Architecture Owner, Session B, product, privacy, security, and statistical Final Gate approval.

**Explicit non-goals:** implicit production authorization, push/deploy from the architecture workflow, destructive rollback, or Phase 3 activation.

**Exit gate:** every Section 18 user-facing gate passes. Rollback disables readers/workers/delivery without destructive schema rollback.

### Blocking product decisions

There are no unresolved product decisions blocking implementation of the disabled shadow stages. This ADR adopts:

- AFTER_WAKE plus 30 minutes with 10:00 local fallback for migrated Morning Brief users;
- the exact Body Energy v1 formula and quality thresholds in Section 3;
- the evidence and insight minimums in Sections 7 and 8;
- the question threshold and abnormal-only circuit breaker in Section 9;
- the privacy-minimizing retention defaults in Section 15.

Before Stage 9 user-facing enablement, product, privacy, and statistical reviewers must approve the user-facing wording and may choose new versioned constants. Any change to these adopted semantics requires an ADR amendment and new version; it is not an undocumented implementation choice.

### Residual risks

- Telegram does not provide application-controlled send idempotency, so a post-request failure can remain AMBIGUOUS. The design prioritizes avoiding duplicate health messages.
- Current body-measurement provenance is insufficient for Body Energy v1 and is deliberately excluded.
- Observational evidence remains vulnerable to unknown confounds even with statistical guardrails; language and promotion rules mitigate but cannot eliminate that limitation.
- Application-enforced referential integrity requires strong store encapsulation and regular audits because the existing schema does not use SQL foreign keys.
- Exactly-once Morning Brief is an application identity and provider-start guarantee; provider ambiguity and prolonged outage are explicit terminal outcomes.
- Legacy proactive and report paths coexist during rollout. Flag dependency tests and semantic idempotency keys are required to prevent double delivery.

### Final architecture verdict

The architecture is ready for staged implementation only under the dependency graph, default-off flags, additive migrations, Node 22 gates, and no-direct-send rule in this record. Phase 3 analytics workers remain dormant unless a separate future decision explicitly activates them.
