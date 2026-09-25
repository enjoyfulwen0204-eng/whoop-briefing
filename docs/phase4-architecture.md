# WHOOP Personal Health OS Phase 4 Architecture Decision Record

Status: Foundation Stages 1–4 aggregate review passed; Stage 5 Intelligence Core RC1 repairs implemented SHADOW-only and awaiting independent Stage 5 RC1 review; Stages 6–8 not started

Decision date: 2026-09-19; locked-decision amendment and targeted repair 1: 2026-09-25

Original V1.2 production baseline from which Phase 4 branched: v20 schema at commit ecbd23287cac591e76741771d77caa3d814f84a3. The current isolated Phase 4 development branch already implements the default-off v21–v24 Foundation migrations.

Architecture version: phase4-adr-v1-repair-5

This record defines the authoritative contracts for Phase 4. Foundation Stages 1–4 and the additive v21–v24 persistence exist on the isolated Phase 4 branch, remain default-off and SHADOW-only, and have passed their aggregate Foundation review. Under the subsequent explicit Stage 5 implementation authorization, the deterministic evidence, episode, and insight-memory runtime and its RC1 blocker repairs are now implemented SHADOW-only and await independent Stage 5 RC1 review. The 2026-09-25 amendment itself remains a documentation-only historical boundary: it authorized no source, schema, test, scheduler, workflow, configuration, deployment, production, or feature-flag change. Quick Actions, Owner Monitoring, display-name isolation, and mixed scheduler/watchdog behavior remain unimplemented later-stage work; Section 17 remains controlling.

Amendment precedence and audit classification:

| Topic | Classification after this amendment | Controlling disposition |
|---|---|---|
| Foundation Stage 1 gate and eight-commit plan | HISTORICAL BUT CLEAR | Retained as the provenance of implemented Stages 1–4; no longer phrased as future work |
| Foundation current state, disabled flags, SHADOW authority, aggregate review | CURRENT | Foundation exists; all behavior stays disabled; aggregate review passed before Stage 5 authorization |
| Categorical family/administrator prohibition | SUPERSEDED | Replaced only for Kelvin's explicit selected-user Owner Monitoring capability; ordinary and unrestricted access remains prohibited |
| All-day Cloudflare primary / GitHub emergency-only assumptions | SUPERSEDED | Replaced by Section 10's Asia/Taipei morning Cloudflare window and normal GitHub hourly background role |
| Quick Actions, display-name isolation, Owner Monitoring, v25/v26, mixed watchdog | CURRENT REQUIREMENT; NOT IMPLEMENTED | Assigned to future Stages 6–8 and default-off authority; v25 belongs to Stage 7 Quick Actions and v26 to Stage 8 Owner Monitoring |
| Raw real-time physiology positioning | CURRENT | Explicitly rejected; event-driven plus longitudinal positioning controls |
| Production activation or delivery | CURRENT PROHIBITION | This documentation amendment grants none |
| Materially contradictory current statement | CONTRADICTORY | None may remain; the 2026-09-25 amendment controls if historical wording is read out of context |

## 1. Scope, non-goals, and implementation stages

### Scope

Phase 4 adds a deterministic Personal Health OS layer above the existing tenant-scoped WHOOP ingestion, journal, evidence, memory, Telegram, and daily-report foundations. Its product surfaces are:

- Body Energy v1, an OS-authored 0–100 estimate with provenance and confidence.
- Meaningful-change detection and durable Observation Episodes.
- Structured context capture with correction and deletion.
- Buttons-first Structured Journal Quick Actions with free-text fallback.
- Durable evidence and insight lifecycles.
- A proactive decision policy with an exact four-action output.
- Event-driven reanalysis separated from delivery.
- A once-per-local-health-day Morning Brief.
- A tenant-scoped Q&A read boundary for all Phase 4 claims.
- Crash-safe outbound delivery for Phase 4 questions and notifications.
- Explicit Owner Monitoring for Kelvin over selected enrolled users, limited initially to Daily Summary, Important Alerts, and Weekly Summary.
- Per-user display-name authority for every user-facing and owner-directed message.
- Mixed scheduler and watchdog behavior for the Asia/Taipei morning window and the existing hourly background path.

### Product positioning

Phase 4 is **event-driven and longitudinal proactive intelligence**, not raw real-time physiological monitoring. WHOOP public API inputs are processed records such as recovery, sleep, workout, cycle, and body measurement. Phase 4 combines those records with historical personal baselines, Structured Journal context, durable evidence/insight memory, and event invalidations.

The product does not claim or require a continuous raw heart-rate or PPG stream, minute-by-minute physiological surveillance, real-time medical monitoring, or a real-time safety SLA. Event-driven HTTP ingress may wake the service, but background proactive computation outside the morning window may wait for a later scheduled run. This positioning does not weaken the durable backlog or daily Morning Brief contracts below.

### Non-goals

Phase 4 does not:

- deploy to production, enable production flags, or apply the scheduler target to production in this documentation stage;
- present Body Energy as a WHOOP metric, medical diagnosis, or physiological measurement;
- provide medical diagnosis, treatment, emergency monitoring, or assurance of safety;
- infer causality from observational associations;
- enable ordinary-user, family, coach, employer, support, or unrestricted administrator health-data browsing; the narrow Owner Monitoring capability in Section 13 is the only approved cross-user exception;
- perform population-health inference, cohort comparison, or cross-tenant model training;
- enable the dormant Phase 3 analytics workers or route Phase 4 work through them;
- replace WHOOP as the authoritative source for WHOOP records;
- change webhook authentication, reconciliation semantics, OAuth identity, or lifecycle truth;
- change Cloudflare, GitHub Actions, Render, or watchdog runtime configuration as part of this ADR-only alignment; Section 10 nevertheless defines the locked future target;
- send directly from analysis, evidence, episode, or decision code;
- introduce a normal-operation notification quota;
- build a new mobile application, broad health dashboard, or unrelated platform rewrite;
- implement full-account erasure; account-erasure policy remains outside this phase;
- retain deleted health content in a tombstone;
- use an LLM to calculate metrics, decide lifecycle transitions, or authorize delivery;
- allow arbitrary LLM calculation or invention of missing health facts.

### Compatibility posture

The following foundations are **reused**:

- internal tenant identity and lifecycle in [src/identityStore.js](../src/identityStore.js), especially **transitionUserLifecycle**;
- lifecycle and delivery authorization in [src/accountLifecycle.js](../src/accountLifecycle.js);
- canonical WHOOP records and freshness protection in [src/store.js](../src/store.js);
- webhook durability and authoritative refetch in [src/whoopWebhookIngest.js](../src/whoopWebhookIngest.js) and [src/whoopWebhookProcessor.js](../src/whoopWebhookProcessor.js);
- shared write transactions and invalidation hooks in [src/processingTransaction.js](../src/processingTransaction.js) and [src/analyticsInvalidation.js](../src/analyticsInvalidation.js);
- the pre-provider commit pattern in [src/reportDelivery.js](../src/reportDelivery.js), without reusing its row lifecycle;
- deterministic evidence-card presentation in [src/evidence.js](../src/evidence.js);
- current insight transition concepts in [src/healthMemory.js](../src/healthMemory.js);
- Telegram inbound deduplication and serialized conversation handling in [src/bot/updateProcessor.js](../src/bot/updateProcessor.js).

The following foundations are **extended**:

- v20 with additive, restart-safe migrations;
- journal records with logical fact identity, provenance, correction, and deletion;
- health insight records with durable evidence linkage, expiry, and terminal disposition;
- a typed Phase 4 outbox for every Phase 4 message class plus per-tenant legacy cutover;
- invalidation writes with a separate Phase 4 generation and job queue;
- Q&A routing with a mandatory scoped context service and perspective gate.

The following behaviors are **replaced for Phase 4 only**:

- the normal-operation cap in **ANTI_SPAM_POLICY.DAILY_PROACTIVE_CAP** and the early cap return in [src/attention.js](../src/attention.js);
- **downgradeAskToNotify** in [src/attention.js](../src/attention.js);
- direct Telegram sending in the current proactive path;
- the current daily-report readiness behavior when it would omit a Morning Brief solely because data is missing;
- generic JSON as the authoritative representation of question, episode, evidence, or delivery lifecycle state.

Legacy behavior remains unchanged until the default-off, per-tenant/message-family atomic cutover selects Phase 4. A flag alone cannot transfer delivery ownership.

### Requirement and engineering-decision provenance

Confirmed product requirements are the Morning Brief entitlement, OS ownership of Body Energy, correction/deletion/undo behavior, buttons-first Quick Actions, Owner Monitoring, per-user display-name isolation, the mixed scheduler target, event-driven/longitudinal positioning, association-only language, dormant Phase 3, no normal message cap, one highest-value question, no ASK-to-NOTIFY conversion, and strict ordinary-user tenant privacy. This ADR does not reopen them.

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
| Delivery-start crash boundary | [src/reportDelivery.js](../src/reportDelivery.js) | REUSE the commit-before-provider pattern only; REPLACE row lifecycle with typed outbox |
| Specialized evidence Q&A ordering | [src/bot/router.js](../src/bot/router.js) | REPLACE with perspective-first scoped reads |
| Migration sequencing | [src/migrations.js](../src/migrations.js) **runMigrations** | EXTEND with restart-safe additive steps |

Key alternatives and failure behavior are frozen as follows:

| Decision and class | Selected design | Alternative considered | Safety, compatibility, and failure behavior |
|---|---|---|---|
| Body Energy calculation — engineering | ADD a two-domain non-overlapping calculator over [src/store.js](../src/store.js) canonical reads | Combine Recovery with sleep/HRV/RHR or ask an LLM | Duplicated physiological evidence is excluded; missing inputs produce one deterministic quality state |
| Episode persistence — engineering | ADD dedicated episode, membership, and event records | Treat each [src/proactiveAgent.js](../src/proactiveAgent.js) run or **proactive_events** row as an episode | Preserves history and concurrent uniqueness; replays converge instead of repeating daily messages |
| Evidence persistence — engineering | ADD immutable envelopes with purgeable run/item content around eligible [src/analyze.js](../src/analyze.js) calculations | Compute all evidence transiently | Retained claims are reproducible; purged content is never reconstructed |
| Insight lifecycle — engineering | EXTEND [src/healthMemory.js](../src/healthMemory.js) statuses with revisions/disposition | Replace legacy statuses or promote directly from one observation | Preserves compatibility and prevents one-day/competing-current promotion |
| Phase 4 work queue — confirmed product plus engineering | EXTEND the transaction pattern but ADD separate jobs | Reuse **analytics_work_state** and its dormant workers | Cannot implicitly activate Phase 3; a failed job is isolated and repairable |
| Morning Brief identity — confirmed product plus engineering | ADD typed semantic reservation and outbox; retain [src/reportDelivery.js](../src/reportDelivery.js) as legacy history only | Reuse report_claims or send from opportunistic logic | Daily identity survives later decisions and ambiguity without cross-path duplication |
| Phase 4 delivery — engineering | ADD one typed outbox/attempt ledger with class-specific semantic keys and atomic cutover | Reuse **proactive_events** or **report_claims** | Post-start crash is AMBIGUOUS and permanently occupies the semantic reservation |
| Normal notification policy — confirmed product | REPLACE Phase 4 use of **DAILY_PROACTIVE_CAP** and **downgradeAskToNotify** | Retain them as principal controls | Meaningfulness decides normal behavior; abnormal loops trip an incident breaker without changing action |
| Q&A authorization — confirmed privacy plus engineering | REPLACE specialized-first routing in [src/bot/router.js](../src/bot/router.js) with one scoped read boundary | Depend on handler-specific tenant predicates | Perspective and currentness are uniform; uncertain scope clarifies or fails closed |
| Referential integrity — engineering | ADD tenant-qualified application checks and an integrity audit | Introduce isolated SQL foreign keys into only new tables | Matches v20 behavior and avoids partially enforced assumptions; detected orphans invalidate artifacts |
| Migration recovery — engineering | EXTEND [src/migrations.js](../src/migrations.js) with introspection, deterministic backfill, and forward fixes | Assume the version is globally atomic or roll back destructively | Partial application safely reruns; flags remain off on failed postconditions |
| Journal deletion — confirmed product plus engineering | EXTEND [src/journal.js](../src/journal.js) facts and physically remove deleted health content with a minimal tombstone | Soft-delete health payload indefinitely | Deleted data is immediately unreadable; tombstone prevents replay without preserving health content |
| Quick Actions — confirmed product plus engineering | REUSE Structured Journal facts and revisions; ADD versioned, tenant-bound interaction state only where callback safety requires it | Create a parallel button-event journal or classify every button through an LLM | Deterministic button values become ordinary Journal evidence exactly once; presentation labels never become analytical authority |
| Owner Monitoring — confirmed product plus engineering | ADD a dual-principal owner capability, followed-user configuration, authorization envelope, and audited owner route over approved synthesized outputs | Weaken tenant predicates or grant generic admin queries | Ordinary users remain self-only; every cross-user read/send proves owner, followed subject, enabled class, and reason |
| Display-name authority — confirmed product plus engineering | Resolve names from the message recipient's tenant-scoped identity in the fixed precedence in Section 11 | Global owner-name constant or last-rendered user cache | A recipient cannot inherit Kelvin's or another user's name |
| Mixed scheduler — confirmed product plus engineering | Cloudflare 10-minute morning window plus normal GitHub hourly background scheduling, both invoking the canonical replay-safe runner | All-day Cloudflare polling or treating GitHub as emergency-only | Lower idle cost without losing durable pending work; watchdog expectations vary by schedule window |
| Retention defaults — engineering | Versioned bounded retention in Section 15 | Indefinite derived payload and message retention | Minimizes sensitive data; loss of reproducibility becomes explicit rather than fabricated |

### Stage outline

Implementation is divided into dependency-ordered stages. Stages 2–4 are the eight-commit Foundation Pack, with complete disabled v21–v24 persistence before stores/Body/Journal runtime. Section 19 is the normative stage graph and aggregate gate list.

1. Stage 1 ADR and independent repair gate.
2. Additive persistence and tenant-scoped stores.
3. Body Energy and quality calculation.
4. Structured Journal, exposure, and context discovery foundation.
5. Evidence, episodes, and insight memory.
6. Event-driven invalidation, reanalysis, mixed scheduler, and cadence-aware watchdog.
7. Proactive decisions, Quick Actions, semantic reservations, and mocked delivery.
8. Shadow Morning Brief, display-name isolation, Q&A, and Owner Monitoring.
9. Shadow evaluation, freeze candidate, and Final Gate evidence package.

No real delivery, production migration, merge, deploy, canary, or production flag is permitted before the Section 17 conjunctive gate.

## 2. Domain vocabulary

The following terms are normative:

- **Canonical health event**: a tenant-scoped WHOOP sleep, recovery, cycle, workout, or body-measurement row whose freshness and tombstone rules are enforced by **createHealthStore**. It is source truth, not an episode or insight.
- **Health day**: the local calendar date assigned using the user timezone snapshot and the rules in the relevant contract. A health day is an identity key, not an elapsed-time unit.
- **As-of instant**: an exact UTC instant. A result may use only information ingested and effective at or before this instant.
- **Input generation**: a monotonically increasing tenant-scoped number changed by an eligible canonical or journal mutation. It makes derived-state freshness explicit.
- **Health observation**: a versioned, quality-labelled fact derived from canonical data, structured context, or an earlier deterministic result. It is one measurement or assertion, not a durable episode.
- **Meaningful change**: an observation change that crosses the versioned magnitude, quality, persistence, and hysteresis gates in Section 4.
- **Observation Episode**: the durable lifecycle that groups related meaningful observations without treating every sample or recomputation as a new event.
- **Evidence run**: an execution record with an immutable non-health envelope and purgeable health content for a versioned method over an explicit input window.
- **Evidence item**: one typed result from an evidence run, including population, effect estimate, uncertainty, quality, provenance, and causal status.
- **Candidate insight**: a HYPOTHESIS retained for evaluation after candidate evidence; it is not a published personal relationship.
- **Promoted insight**: an EMERGING or SUPPORTED insight that met the repeated-evidence contract and may be used with status-appropriate association language.
- **Rejected, refuted, or expired insight**: a historical RETIRED insight whose disposition respectively records failure to meet promotion gates, sufficient contradictory evidence, or loss of current support with time.
- **Context fact**: a normalized journal assertion with logical identity, provenance, and revision state.
- **Quick Action**: a versioned Telegram button interaction whose deterministic canonical selection creates or updates a Structured Journal fact without unnecessary LLM classification.
- **Context question**: the single highest-value eligible question selected to reduce decision-relevant uncertainty.
- **Decision**: a durable evaluation producing exactly one action from the Phase 4 action space.
- **Outbound message**: a versioned delivery proposal linked to a decision, Morning Brief, or explicit Owner Monitoring authorization; content is immutable across retry but may be synchronously redacted for correction/deletion while state/hash history remains.
- **Morning Brief**: the once-per-active-ready-unpaused-user, once-per-local-health-day report that explicitly represents missing data rather than disappearing.
- **Current**: not deleted, superseded, invalidated, expired, lifecycle-stale, or based on an older input generation than the read contract permits.
- **Invalidation**: a durable declaration that a derived scope may no longer be current. Invalidation does not itself recompute or send.
- **Reanalysis**: deterministic recomputation of invalidated derived state. Reanalysis does not itself deliver.
- **OS-authored**: calculated by this application. The user-visible name and provenance must not imply WHOOP authorship.
- **Tenant**: one internal **users.id**. Telegram chat IDs and WHOOP user IDs are external identifiers, never tenant primary keys.
- **Owner principal**: Kelvin's specifically configured internal identity plus a server-issued Owner Monitoring capability. A name, Telegram handle, model claim, or ordinary administrator role is not owner authority.
- **Follow subscription**: the durable, revisioned selection that permits the owner principal to receive one or more approved monitoring classes for one enrolled subject user.
- **Definite delivery failure**: a provider result proving the message was not accepted.
- **Ambiguous delivery outcome**: delivery may have occurred, but the application cannot prove either success or failure. It must not be blindly retried.
- **Delivery attempt**: a provider-call envelope created before the call, with explicit terminal state transitions; health content is prohibited and any accidental copy must be purged.

The concepts relate as follows:

~~~mermaid
flowchart TD
    C[Canonical health event] --> O[Health observation]
    J[Structured journal fact] --> O
    O --> R[Evidence run]
    R --> I[Evidence item]
    I --> E[Observation Episode]
    E --> M[Candidate or promoted insight]
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

The repaired first contract is:

- algorithm version: **body-energy-v1.2.0**;
- constants version: **body-energy-constants-v3**;
- baseline version: **robust-baseline-v1**;
- attainable initial-charge range: integers 40 through 100; attainable intraday range: integers 0 through 100;
- internal arithmetic: full-precision IEEE 754 numbers; no intermediate rounding; initial charge and final intraday publication each use JavaScript Math.round at their respective output boundary;
- deterministic manifest encoding: sorted object keys, finite numbers serialized with JavaScript JSON.stringify round-trip precision, normalized negative zero, explicit nulls; no six-decimal truncation before calculation or hashing;
- exact result time: integer UTC milliseconds plus its canonical ISO timestamp; optional 15-minute checkpoint scheduling never replaces exact identity;
- retrospective recomputation horizon after an eligible correction: 45 local health days.

A constants change requires a new constants version. A formula or input-semantic change requires a new algorithm version. Historical results are never silently rewritten under the same version.

All coefficients, weights, thresholds, and horizons in Body Energy v1 are versioned engineering calibration defaults. They are not presented as evidence-derived medical constants.

Earlier draft formulas are withdrawn. **body-energy-v1.2.0** below is the only normative formula.

### Accepted canonical inputs

Only records visible to the tenant and current under canonical freshness/tombstone rules may enter v1:

| Input | Role | Eligibility |
|---|---|---|
| Main sleep | Required wake anchor | Exact main-sleep selector below |
| Sleep Performance | Required sleep domain; sole measure | Finite percentage 0–100 from the selected scored main sleep |
| HRV | Required autonomic component | Matched recovery; finite positive value and usable earlier-only personal baseline |
| Resting heart rate | Required inverse autonomic component | Same matched recovery; finite positive value and usable earlier-only personal baseline |
| Current cycle strain | Preferred post-wake load | Selected only by the exact current-cycle rule below |
| Completed workout strain | Mutually exclusive load fallback | Used only when no usable current-cycle strain exists |
| Completed scored nap | Recharge | Nap sleep ending after the main wake anchor and no later than as-of, 20–180 minutes |
| WHOOP Recovery score | Contextual comparison only | May be shown in provenance when current; never enters value, confidence, quality, or a weighted driver |

Body measurements are excluded from the v1 score. Their current storage uses synchronization-time day semantics and lacks an equivalent WHOOP source update timestamp, so using them would weaken reproducibility. They may be displayed as non-score provenance only after a later contract resolves that ambiguity.

Sleep debt is not an additional factor because it overlaps the chosen sleep-adequacy domain. WHOOP Recovery is excluded from the numeric model regardless of its upstream composition, so v1 cannot duplicate it with HRV, RHR, or sleep signals. This ADR makes no undocumented claim about WHOOP’s proprietary metric composition.

In-progress workouts, future-ended records, deleted records, records rejected by ownership fences, records whose retained canonical version was written after as-of, and unverified free text are excluded.

### Exact main-sleep and recovery selectors

These are new scoped adapters over actual v20 columns in [src/schema.js](../src/schema.js) and [src/store.js](../src/store.js), not claims that getSleeps/getRecoveries already enforce the contract. There is no invented recovery end-time or source revision column.

The main-sleep selector accepts authenticated user_id, exact as_of, timezone snapshot, and optional target_health_date:

1. Read whoop_sleeps for that user only; require nap = 0, score_state = SCORED, finite start_at/end_at with start_at < end_at <= as_of, and elapsed end-to-as_of at most 36 hours.
2. Exclude any matching ACTIVE whoop_resource_tombstones row on (user_id, resource_type = sleep, resource_id = whoop_sleeps.id). Never infer non-deletion from row presence alone.
3. Require parseable synced_at <= as_of; updated_at must be parseable and <= as_of when non-null. A null updated_at permits a captured row but adds SOURCE_VERSION_UNKNOWN and DEGRADED; synced_at is the local-write fence, not a fabricated source version.
4. Compute localDate(end_at, timezone_snapshot) using src/time.js. It must equal target_health_date when supplied. Otherwise choose the most recent candidate and assign its computed date. The stored health_date is the ingestion-time projection; capture it and the computed date. A mismatch adds HEALTH_DATE_REALIGNMENT/DEGRADED and schedules realignment; it never licenses using a different day's recovery. Do not substitute the server date or a recovery's date-only match.
5. Order by end_at descending, then updated_at descending (null last), then id ascending with binary string comparison. Choose the first row before testing its Sleep Performance; an invalid score does not cause fallback to an older sleep. Require sleep_performance_percentage finite in [0,100]; otherwise sleep_domain is missing.
6. Require current resource-access/lifecycle/auth fences and sleep synchronization evidence as defined below. Pending/unscored rows cannot be scored by this model; record their exclusion reason.

Recovery is exactly whoop_recoveries WHERE user_id matches AND sleep_id = selected whoop_sleeps.id. Its (user_id, sleep_id) primary key yields at most one row: no date-based, cycle-based, or “latest recovery” substitution and no arbitrary tie. Duplicate results from an adapter are an invariant failure. Require score_state = SCORED, user_calibrating = 0, no ACTIVE recovery tombstone whose resource_id = sleep_id, the same synced_at/updated_at as-of fences, and finite positive hrv_rmssd_milli and resting_heart_rate. Null user_calibrating is unverified source validity and blocks the numeric domain. Recovery health_date is relinked from sleep by relinkRecoveryDates; use the selected sleep's computed health day, record any stored mismatch as DEGRADED, and never invent recovery.start_at/end_at. recovery_score has numeric weight zero.

Freshness for each required resource is from whoop_sync_state for that user and resource = sleep or recovery: require last_success_at and updated_at parseable and <= as_of. The retained synchronization record cannot attest an older as-of if updated_at is later. Missing evidence or age >24 hours gives NO_DATA and null. Age >90 minutes through 24 hours gives DEGRADED; a fresh sync does not make an unscored/missing row valid. Canonical synced_at proves row availability, not successful whole-resource freshness. The 36-hour main-wake bound and the 24-hour sync bound are independent.

Current reads always take the retained canonical version protected by freshnessGuard: older updated_at cannot replace newer; a null incoming version cannot replace a known one. Equal-version replays can refresh synced_at, so historical replay uses captured manifests, never pretends that v20 stores revision history. A correction affecting score, end time, date, or matched recovery invalidates the old result and creates a new result revision at a new as-of; it cannot trigger a retroactive outbound notification.

### Personal baselines

HRV and RHR component baselines use earlier health days only:

- target: 30 valid daily values;
- lookback: 45 health days;
- minimum for a usable standardized factor: 7 values;
- center: median;
- scale: median absolute deviation multiplied by 1.4826;
- fallback when median absolute deviation is zero: interquartile range divided by 1.349;
- non-finite or nonpositive values are excluded;
- standardized values are winsorized to the closed interval −3 through +3;
- if both scale methods are zero or unavailable, the required component is unavailable with BASELINE_SCALE_UNAVAILABLE and no numeric Body Energy;
- values from the current health day never enter its baseline.

For each earlier local health day in [target day −45, target day −1], choose one main sleep with the same tenant, main/scored/tombstone/as-of ordering above, but without the current-day 36-hour age bound. Match its recovery by sleep_id with the same scored/calibration/version fences. Historical physiological-event age is not synchronization age; the required current sleep/recovery resource-sync snapshot supplies freshness. For each component take its latest 30 valid daily values, never duplicate a day, and persist all values and exclusions. No source with synced_at or updated_at after as_of enters a baseline.

Median is the midpoint of the sorted middle pair for even n. For IQR use linear quantiles: h=(n−1)p, Q(p)=x[floor(h)]+(h−floor(h))×(x[ceil(h)]−x[floor(h)]), p=0.25 and 0.75. robust_z=(current−median)/scale; use MAD×1.4826 when positive, else (Q(.75)−Q(.25))/1.349 when positive, else no standardized component. All arithmetic retains full precision.

Per-component baseline readiness is:

- **BASELINE_WARMING_UP**: fewer than 7 valid earlier days;
- **BASELINE_LIMITED**: 7–29 valid earlier days;
- **BASELINE_MATURE**: 30 valid earlier days.

### Initial charge: non-overlapping domains

There are exactly two top-level domains:

1. **sleep_domain**, required, weight 0.65;
2. **autonomic_domain**, required, weight 0.35.

Sleep adequacy uses one and only one input:

- sleep_domain = selected main sleep's sleep_performance_percentage when finite in [0,100];
- otherwise sleep_domain is missing and Body Energy has no numeric value;
- observed duration, sleep need, sleep debt, and Recovery score never supply a numeric sleep substitute.

Autonomic component scores are:

- hrv_score = clamp(0, 100, 50 + (50 ÷ 3) × clamp(−3, 3, robust_z_hrv));
- rhr_score = clamp(0, 100, 50 − (50 ÷ 3) × clamp(−3, 3, robust_z_rhr)).

Each robust z-score requires at least 7 valid earlier-day baseline samples under the baseline contract. The autonomic domain is:

- autonomic_domain = (hrv_score + rhr_score) / 2 only when both exist;
- missing if either current component or either minimum/scale baseline is unavailable.

There is no imputation, partial numeric charge, or weight renormalization:

domain_mean = 0.65 × sleep_domain + 0.35 × autonomic_domain

initial_charge_unrounded = clamp(40, 100, 40 + 0.60 × domain_mean)

initial_charge = Math.round(initial_charge_unrounded)

Both domains span [0,100], so domain_mean spans [0,100] and attainable initial integers span 40–100. Neutral domains of 50 give 70. If either domain is missing, initial_charge and intraday value are null; depletion and naps cannot manufacture a value. Required data arriving later changes null to valid, never one partial numeric value into another. Context-only Recovery arriving or changing cannot affect value, confidence, or quality.

### Time depletion and physiological load

Elapsed time is measured in UTC instants, never local-clock hours:

wake_hours = max(0, elapsed_seconds(wake_at, as_of) ÷ 3600)

time_depletion =

- 1.60 × min(wake_hours, 8), plus
- 2.30 × max(wake_hours − 8, 0).

### Exact current-cycle selection

A current-cycle value is usable only through a new tenant-scoped store query designed for this contract. The selector:

1. filters by authenticated user_id;
2. excludes tombstoned or source-invalid rows;
3. requires cycle.start_at at or before as_of;
4. requires the wake boundary to fall inside the cycle interval, treating a null end as open at as_of;
5. requires absolute elapsed difference between cycle.start_at and wake_at to be at most the versioned two-hour **cycle_wake_tolerance**;
6. requires the retained canonical row and its successful cycle synchronization evidence to be at or before as_of;
7. requires synchronization age no greater than six hours;
8. requires strain finite and within 0–21;
9. chooses the greatest start_at, then stable canonical cycle ID as tie-break.

An open/incomplete current cycle is eligible under the same rules. Freshness older than 90 minutes adds a degradation reason; older than six hours makes the cycle unusable.

The v20 store API is not assumed to expose this selector or every required timestamp. Until the Stage 2/3 store contract can return and test these exact fields, current-cycle load is unavailable and the implementation must use the workout fallback or report missing load. It must not approximate the query with a date-only lookup.

When a usable current-cycle strain is present:

normalized_cycle_strain = clamp(0, 21, cycle_strain)

load_depletion = 0.85 × normalized_cycle_strain ^ 1.25

### Mutually exclusive workout fallback

Only when no usable cycle exists, select completed, tenant-owned, non-tombstoned workouts satisfying:

- workout.start_at is at or after wake_at;
- workout.end_at is at or before as_of;
- retained canonical version and successful workout synchronization are at or before as_of;
- successful workout synchronization age is no greater than six hours;
- strain is finite and within 0–21; an out-of-range value is excluded rather than clamped.

Then:

load_depletion = min(24, 0.75 × sum(workout_strain ^ 1.15))

A workout that starts before wake and ends after wake is excluded; nonlinear strain is never prorated without a future registered method. An ongoing workout is excluded until completed and creates **ONGOING_WORKOUT_EXCLUDED** provenance. If neither load source is usable, load_depletion is 0 with **LOAD_UNAVAILABLE** and the primary quality cannot exceed DEGRADED.

Cycle and workout load are mutually exclusive and never added. Negative strain deltas and source corrections do not create negative depletion; a corrected lower strain can increase a newly recomputed result, but provenance must identify the correction.

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

body_energy = Math.round(clamp(0, initial_charge, raw))

The upper clamp to initial_charge ensures that naps restore part of the day’s depleted estimate without converting the score into a higher-than-morning recovery claim.

### Freshness, quality, and confidence

Freshness is calculated per selected resource from the elapsed time between as-of and that resource’s latest successful synchronization evidence at or before as-of. It is not the age of the physiological event. The aggregate freshness component is the minimum for required sleep, matched recovery, and selected load. Missing required synchronization contributes 0; missing load is DEGRADED. Required sleep or recovery synchronization older than 24 hours is NO_DATA. Preserve the separate six-hour load eligibility bound above.

Freshness component:

- 1.00 at 90 minutes or newer;
- linearly declines to 0.50 at 6 hours;
- linearly declines to 0.20 at 24 hours;
- 0 after 24 hours.

Completeness is:

completeness =
0.65 × (valid sleep_domain ? 1 : 0) +
0.35 × (valid current HRV/RHR components ÷ 2)

Baseline is the mean of the two clamp(0,1,valid_baseline_days/30) components; an unusable scale/component contributes 0. Source validity is 1.00 when hard ownership/lifecycle/auth/tombstone/as-of checks pass without warnings, 0.50 for a registered soft warning, and 0 for a failed required-source check. Confidence is diagnostic even for null results and never authorizes filling a missing domain. Any required-source failure prevents a value; unusable load follows the unchanged load fallback contract.

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

Exactly one primary quality state is selected by the first matching row:

| Precedence | Primary state | Deterministic condition | Numeric value |
|---|---|---|---|
| 1 | UNAVAILABLE | Lifecycle/auth invalid, or required sleep/HRV/RHR capability known unsupported | No |
| 2 | NO_DATA | No selected scored main sleep or matched scored recovery; required sync absent or older than 24 hours | No |
| 3 | DEGRADED | Source discrepancy, invalid required value/calibration/version evidence, required freshness >90 minutes, load unavailable, or poor selected-source validity | Only if both required domains are usable |
| 4 | WARMING_UP | No higher state matched and either observed autonomic component has fewer than 7 baseline days or no positive robust scale | No |
| 5 | LIMITED | No higher state matched and Sleep Performance/HRV/RHR is absent, either baseline has 7–29 samples, or confidence <0.80 | Only if both required domains are usable |
| 6 | AVAILABLE | Both required domains valid, usable load, both baselines at least 30 days, freshness <=90 minutes, no discrepancy, confidence >=0.80 | Yes |

Multiple reason codes remain attached, but the primary state is mutually exclusive. F-02 ordering is preserved: insufficient baseline plus stale data (<=24 hours) is DEGRADED, now with null; partial inputs plus poor source quality is DEGRADED/null; unsupported required capability is UNAVAILABLE; no main sleep is NO_DATA unless unsupported. Missing current numeric components alone are LIMITED/null. Invalid/out-of-range components are DEGRADED/null. Numeric eligibility is checked independently before the first-match quality table; a DEGRADED label never licenses partial scoring.

### Executable scale and missingness examples

~~~javascript
const clamp = (lo, hi, x) => Math.min(hi, Math.max(lo, x));
const initial = (sleep, autonomic) => {
  if (![sleep, autonomic].every(x =>
    Number.isFinite(x) && x >= 0 && x <= 100)) return null;
  return Math.round(clamp(40, 100, 40 + 0.60 * (0.65 * sleep + 0.35 * autonomic)));
};
for (const [mean, expected] of [[0,40], [25,55], [50,70], [75,85], [100,100]]) {
  if (initial(mean, mean) !== expected) throw new Error("scale");
}
if (initial(null, 50) !== null || initial(50, null) !== null) throw new Error("missing");
if (initial(75, 50) !== 80 || initial(100, 100) !== 100) throw new Error("round");
~~~

Manual checks: 40+.60×{0,25,50,75,100}={40,55,70,85,100}; sleep75/autonomic50 gives mean66.25, unrounded79.75, initial80. With initial40 and enough elapsed depletion, final0 is attainable; with both domains100 at wake and zero strain, final100 is attainable. Math.round(70.5)=71; no intermediate rounding is permitted.

Unless stated otherwise, fixtures have current resources, valid zero-load cycle, and mature nonzero-scale baselines:

| Fixture | Initial/value at wake | Primary quality and reasons |
|---|---|---|
| No main sleep | null | NO_DATA / MAIN_SLEEP_MISSING |
| Selected scored sleep has absent Sleep Performance | null | LIMITED / SLEEP_PERFORMANCE_MISSING; no numeric substitute |
| Matched recovery lacks HRV | null | LIMITED / HRV_MISSING |
| Matched recovery lacks RHR | null | LIMITED / RHR_MISSING |
| HRV baseline n=6; all current values present | null | WARMING_UP / INSUFFICIENT_BASELINE |
| Either robust scale remains zero | null | WARMING_UP / BASELINE_SCALE_UNAVAILABLE |
| Recovery sync age 2 hours, both domains50 | 70 | DEGRADED / RECOVERY_STALE |
| Recovery sync age 25 hours | null | NO_DATA / RECOVERY_SYNC_EXPIRED |
| Corrected same-sleep performance50→75; autonomic50 | old70, new80 | New revision/source version; old manifest not overwritten except purge; no retroactive send |
| Missing HRV arrives, completing domains50/50 | null→70 | LIMITED→AVAILABLE; new as-of/generation |
| Contextual Recovery score absent→90 with domains50/50 | 70→70 | Quality/confidence unchanged; no optional numeric domain exists |

### Health-day and DST rules

- The health day is the local calendar date of the chosen main-sleep end in the user timezone snapshot.
- A null/NO_DATA result with no eligible wake anchor still needs a persistence day: use the explicit requested health date when provided, otherwise localDate(as_of_utc, timezone). Record day_assignment = REQUESTED_UNANCHORED or AS_OF_UNANCHORED in its manifest; an anchored result records MAIN_SLEEP_END. This identity label never supplies a missing input or implies a sleep observation.
- All depletion and freshness durations use UTC instants.
- A timezone change does not relabel an already persisted result. New calculations use the current lifecycle-authorized timezone and store it.
- Ambiguous or nonexistent local wall times are never used for elapsed arithmetic.
- For scheduling only, a duplicated local delivery time selects the first occurrence; a nonexistent local time advances to the first valid instant after the gap.
- The persisted unique identity is (user_id, health_date, as_of_epoch_ms, algorithm_version, input_generation, execution_mode). UTC milliseconds distinguish exact instants, including across DST; local display time is not an identity.

### Persistence and reproducibility

Persist a result whenever it is used in a Morning Brief, Q&A answer, episode, decision, or user-visible explanation. That consumer cites the exact (user_id, execution_mode, result_id), never a bucket or a mutable latest pointer.

**Exact result identity (mandatory).** The unique key is exactly (user_id, health_date, as_of_epoch_ms, algorithm_version, input_generation, execution_mode). as_of_epoch_ms is a safe integer UTC millisecond instant; as_of_utc must equal new Date(as_of_epoch_ms).toISOString(). Fractional milliseconds, invalid dates, and inconsistent representations reject the write. Repeating this entire tuple returns the same result_id and captured manifest; competing identical writes converge on the winner. A conflicting manifest/value for the same tuple is a deterministic-computation invariant failure, not permission to overwrite or add another revision dimension. input_manifest_hash is provenance, not identity. Different exact instants within one bucket are different rows; a new input_generation permits a new revision at the same exact instant. Algorithm and mode are explicit dimensions, with no implicit revision number.

**Optional checkpoints (separate throttling).** body_energy_checkpoints is a separate v23 reference table, not the result uniqueness index. checkpoint_kind is PERIODIC_15M; checkpoint_bucket_start is the UTC epoch-ms multiple of 900000. Its canonical checkpoint_as_of_epoch_ms is bucket start + 900000 (the closing instant); the scheduler computes only closed buckets, never rounds an arbitrary Q&A request into one. A partial unique checkpoint index on (user_id, execution_mode, checkpoint_kind, checkpoint_bucket_start, algorithm_version, input_generation) WHERE checkpoint_kind = 'PERIODIC_15M' makes concurrent workers converge. Each checkpoint references the exact result at its canonical instant. A Q&A calculation at that same instant may supply that result; the separate reference is inserted without changing its immutable content. If the historical inputs are unavailable, record no successful checkpoint; never substitute now while labeling it the closing instant.

Reusing a checkpoint returns its original exact as_of_utc, age/freshness and result_id; it is not an exact answer for the caller's later instant. Exact Q&A/publication reads calculate or select the exact requested tuple. A 12:00:00 result and a 12:14:00 result can coexist even though both requests fall in the 12:00 bucket. Neither a checkpoint claim nor a cache hit may replace either result's timestamp, value, manifest or citations.

Each stored result contains:

- result_id, user_id, health_date, execution_mode, as_of_epoch_ms and matching as_of_utc;
- exact normalized input values, row identities, and source version timestamps captured at calculation time;
- ingestion timestamps used by the as-of fence;
- factor values, omitted-factor reasons, baselines, and intermediate depletion terms;
- algorithm, constants, and baseline versions;
- canonical input generation and lifecycle generation;
- input_manifest_hash and result hash, and created_at;
- invalidation timestamp and reason, when superseded by corrected inputs.

Historical audit reproduces a persisted result from its captured input manifest while content is retained. The non-health envelope is immutable except defined state transitions; redaction/purge is the sole exception to append-only health content. Purged manifests return CONTENT_REDACTED, never reconstructed health data. Later recalculation uses current eligible canonical rows at a new as-of or new input generation and creates a new result. Same-instant recalculation still obeys as-of source visibility; a post-as-of correction cannot masquerade as the overwritten historical input.

V20 canonical tables retain the latest row, not every overwritten source revision. If an older source row was overwritten before a Body Energy manifest captured it, the earlier source state cannot be reconstructed. The API must return **NOT_REPRODUCIBLE_FROM_RETAINED_INPUTS** and must never substitute today’s row while claiming historical reconstruction.

Every published or shadow result, including null, persists its complete input manifest. Late-arriving data creates a later-as-of result and may invalidate current dependents within 45 days; it never triggers retroactive outbound notification. Correction provenance links new and invalidated results. The shown snapshot is not rewritten by recalculation, but mandated correction/deletion redaction under Section 15 takes precedence over historical reproducibility.

### User-visible publication gate

Implementation behind default-off calculation flags may begin after its implementation stage is authorized, but no Body Energy value may be published in Q&A, Morning Brief, proactive output, test-user delivery, canary delivery, or production until all are complete:

- shadow calibration on non-production data;
- correlation matrix across candidate inputs;
- input and domain ablation analysis;
- coefficient and boundary sensitivity analysis;
- score distribution and range-use analysis;
- missingness and quality-state analysis;
- explicit confirmation that one underlying source cannot dominate through duplicated evidence;
- Architecture Owner approval;
- independent Final Gate approval;
- the conjunctive release gate in Section 17.

### Property and example tests

The implementation gate requires:

- identical normalized inputs produce byte-identical normalized calculation output; persisted hashes additionally require the same stable artifact hash context (Section 14), never a new random salt on replay;
- score is always an integer from 0 through 100;
- later as-of instants cannot increase the score when the eligible input identities and source versions are unchanged;
- every increase must be explained by a newly qualified nap or an explicit changed input identity/source version in provenance;
- added nonnegative strain cannot increase the score;
- a qualified nap cannot add more than 12 and all naps cannot add more than 15;
- either required domain/component/baseline missing produces null, never a reweighted numeric value;
- Recovery score, Sleep Performance, HRV, and RHR fixtures prove each numeric input belongs to exactly one domain;
- sleep duration/need/debt never substitutes for Sleep Performance;
- exact matched-sleep recovery, both-component normalization, quantiles, and required-domain arrival behavior;
- current-day data never leaks into an earlier-day baseline;
- future-ingested or future-ended data cannot affect an earlier as-of calculation;
- cycle and workout strain are never double-counted;
- crossing-wake and ongoing workouts are excluded without nonlinear proration;
- current-cycle selection is tenant-scoped, as-of-correct, tombstone-safe, deterministic, and refuses a date-only store approximation;
- every overlap in the quality-precedence table produces exactly one primary state and all applicable reason codes;
- DST spring-forward and fall-back examples use correct elapsed time;
- stale, tombstoned, cross-tenant, and lifecycle-stale rows are rejected;
- boundary examples cover every threshold and rounding half case;
- a stored fixture for each algorithm version reproduces while its input content is retained; purge returns CONTENT_REDACTED;
- pre-snapshot overwritten canonical revisions return NOT_REPRODUCIBLE_FROM_RETAINED_INPUTS rather than reconstructed values;
- correlation, ablation, sensitivity, distribution, missingness, and duplicate-source-dominance publication gates fail closed.

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

The primary quality vocabulary is UNAVAILABLE, NO_DATA, DEGRADED, WARMING_UP, LIMITED, and AVAILABLE. A metric contract supplies an ordered decision table, as Body Energy does in Section 3, so exactly one primary state is returned while multiple reason codes may coexist. READY remains an onboarding/lifecycle term and is not a Phase 4 data-quality state.

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
6. Require the open robust-z threshold. Inclusive/exclusive threshold comparisons use a
   scale-aware machine-epsilon normalization so a mathematical boundary is not changed by
   binary floating-point representation; the tolerance must not move a materially distinct value.
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

The **episode_family_key** is the same identity without direction. It prevents unintentionally active opposite-direction episodes for one tenant/metric/window family.

The fingerprint does not include the latest value, timestamp, message text, evidence score, or input generation. Those belong to episode revisions.

At most one active episode exists for a tenant and fingerprint. Active means a state other than RESOLVED, EXPIRED, or INVALIDATED.

Each episode record exposes:

- tenant-qualified ID and explicit episode type;
- semantic fingerprint, subject, direction, and health window;
- current state, severity, confidence, novelty, and explained/unexplained status;
- first observed, last observed, and last materially changed instants;
- current observation and evidence-version membership;
- last question reference;
- last delivered-notification reference;
- last ambiguous-attempt reference;
- resolution reason;
- stabilization, resolution, expiry, and invalidation boundaries;
- current episode revision and input generation.

Severity is the ordinal band declared by the metric registry and can fall only after the close threshold is crossed. Episode confidence is the minimum of the latest qualifying observation confidence and the highest current compatible evidence confidence. Novelty is true only when the state, severity band, explained status, semantic claim hash, or recommended-action hash differs materially from the last delivered episode revision. Explained status requires a linked current evidence item and, where applicable, a current confirmed context fact; it stores which uncertainty is resolved.

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
    STABILIZING --> EXPLAINED
    STABILIZING --> RESOLVED
    OPEN --> RESOLVED: direction reversal
    UPDATING --> RESOLVED: direction reversal
    ESCALATED --> RESOLVED: direction reversal
    EXPLAINED --> RESOLVED: direction reversal
    OPEN --> EXPIRED
    UPDATING --> EXPIRED
    ESCALATED --> EXPIRED
    EXPLAINED --> EXPIRED
    STABILIZING --> EXPIRED
    OPEN --> INVALIDATED
    UPDATING --> INVALIDATED
    ESCALATED --> INVALIDATED
    EXPLAINED --> INVALIDATED
    STABILIZING --> INVALIDATED
~~~

Only changes between different states are state transitions. An update retaining any active state is a **same_state_revision**, with no self-arrow in this diagram. It follows the separate rule below the table, including for ESCALATED, EXPLAINED, and STABILIZING.

Every state transition appends an episode event containing old/new state, reason code, input generation, evidence references, actor type, and deterministic event key. The non-health envelope is immutable except defined state transitions; redaction/purge is the sole exception to append-only health content.

The normative legal-transition table is:

| From | Permitted to | Required condition |
|---|---|---|
| OPEN | UPDATING, ESCALATED, EXPLAINED, STABILIZING | New durable evidence; EXPLAINED additionally requires current explanatory evidence/context |
| UPDATING | ESCALATED, EXPLAINED, STABILIZING | New durable evidence and registered threshold result |
| ESCALATED | UPDATING, EXPLAINED, STABILIZING | New durable evidence; de-escalation requires close-threshold evidence |
| EXPLAINED | UPDATING, ESCALATED, STABILIZING | New evidence changes interpretation |
| STABILIZING | UPDATING, ESCALATED, EXPLAINED, RESOLVED | Resolution only after the hold; EXPLAINED requires current explanation |
| Any active state | EXPIRED | Registry expiry boundary reached, including ESCALATED and STABILIZING |
| Any active state | INVALIDATED | Supporting provenance/currentness failed |
| Any active state | RESOLVED | Only STABILIZING completion or atomic DIRECTION_REVERSAL |
| RESOLVED, EXPIRED, INVALIDATED | none | Terminal; recurrence creates a linked new episode |

**same_state_revision** is not a legal-transition-table entry. For every active state it increments revision via CAS, updates only current observation/evidence membership, last_observed_at, derived severity/confidence/explanation and permitted summary fields, and appends event_kind = SAME_STATE_REVISION with from_state = to_state. Its deterministic key is (user_id, episode_id, source_change_key), where source_change_key is the sorted captured source-ID/version/content-digest set plus event kind; replays reuse the committed event and revision. A no-change replay increments nothing. It does not reset stabilization_started_at while remaining STABILIZING, clear last_question_id/notification/ambiguity history, bypass hysteresis, create novelty by itself, or reopen terminal states.

Remaining ESCALATED only creates a semantic event under MATERIAL_ESCALATION: current severity ordinal strictly exceeds the highest severity ordinal of all previous semantic events for this episode, and the metric's normal open/persistence or registered severe-observation exception passes on newly observed evidence. Equivalent recalculation, lower-then-returning severity, confidence drift, and algorithm rollout do not qualify. EXPLAINED and STABILIZING same-state revisions create no semantic notification event. A material escalation in either must make a legal transition to ESCALATED first.

### Open, merge, split, and reopen

- **Open:** observation selection first creates a candidate observation, then a durable evidence run/item. Only that evidence item can create OPEN.
- **Merge:** the same fingerprint merges while windows overlap or the semantic
  `last_observed_at` gap is at most 36 elapsed hours, inclusive. A larger gap
  terminalizes the stale active episode as `EXPIRED` with an auditable continuity-gap
  event before a new episode is opened. Each source observation can be a member once.
- **Update:** a merged observation may legally move to UPDATING; if the state remains unchanged it is a same_state_revision, never a self-transition.
- **Escalate:** requires a registry-defined severity crossing, materially greater persistence, or newly actionable evidence. A recomputation with equivalent semantics cannot escalate.
- **Explain:** requires current explanatory evidence and any supporting user-confirmed context to be linked before the transition commits. “Explained” never means causal.
- **Stabilize:** requires all current qualifying observations below the close threshold.
- **Resolve:** requires STABILIZING for the registry’s resolution hold, default 24 elapsed hours, with no new open-threshold observation.
- **Expire:** applies when the metric observation window ends or required data remains unavailable beyond the registry expiry, default 7 days.
- **Invalidate:** applies when every supporting observation becomes invalid or cross-tenant/provenance/lifecycle validation fails.
- **Split:** a different domain, non-overlapping hypothesis, or algorithm-major incompatibility creates a different family. Opposite direction uses the reversal rule, not an independent split.
- **Reopen:** a recurrence within 7 days of RESOLVED creates a new episode linked by **reopens_episode_id**. It does not mutate the terminal row. This preserves immutable historical delivery and decision references.

### Direction reversal

An opposite-direction observation does nothing while it is only threshold oscillation between the old close threshold and the opposite open/persistence threshold. Once the opposite direction independently satisfies its open and persistence rules, one tenant/family transaction:

1. locks the current active episode family and expected revision;
2. transitions the prior episode to RESOLVED with **DIRECTION_REVERSAL**;
3. opens the opposite-direction episode with its durable evidence item;
4. links the two episode IDs;
5. commits both transition events and the family uniqueness change atomically.

The family-level active uniqueness constraint prevents both directions remaining active.

### Concurrency

Episode mutation uses:

- a unique partial index for one active tenant/fingerprint;
- a unique partial index for one active tenant/episode_family_key;
- an expected episode revision in every update;
- a unique membership key for each source observation;
- a unique transition key;
- retry on uniqueness conflict by re-reading the winner;
- lifecycle and input-generation fences before commit.

Two workers processing the same invalidation must converge on one episode revision. No worker may send as part of that retry.

### Notification relationship

Episodes are evidence organization, not notification records. Only the Section 12 finite semantic-event registry can produce a notification candidate. UPDATING and same_state_revision alone do not create novelty.

A daily recomputation cannot repeat a notification when episode revision, semantic claim hash, and recommended-action hash are unchanged. A new calendar day is not novelty.

**last_delivered_notification_id** changes only for DELIVERED episode notifications. SUPPRESSED, FAILED_TERMINAL, and INVALIDATED do not count as user notification. **last_question_id** changes for a committed question decision and records its delivery state; **last_ambiguous_attempt_id** separately records an AMBIGUOUS question or notification attempt so later decisions preserve the semantic reservation without claiming the user was notified.

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
- **raw_answer_excerpt**: the minimum relevant genuine user-authored answer span, trimmed and bounded to 500 Unicode code points; required by the user-text provenance path and null for a `TRUSTED_REGISTRY` button fact unless the user supplied supplemental text;
- **recorded_timezone**;
- **invalidated_at** and reason.

The actual v20 fields category, subtype, numeric_value, text_value, unit, severity, note, source, event_at, and health_date remain the normalized fact payload. Existing rows are backfilled with deterministic logical IDs and revision 1; there is no v20 occurred_at column.

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

### Quick Actions: buttons first, free-text fallback

Structured Journal plus Quick Actions is a Phase 4 must-have. A constrained interaction presents Telegram buttons whenever a closed, safe value set exists; free text remains available for `other/add note`, unsupported detail, correction, and unconstrained journal entry. A button callback maps directly through a versioned server-owned action registry and the deterministic Journal validator. It must not call an LLM merely to rediscover the category or value already encoded by the selected action.

Presentation labels are localization and UX. Canonical category, factor, subtype/value, polarity, unit, and taxonomy/normalizer version are the evidence contract. Analytics reads canonical fields only and never groups by button text. The initial presentation-to-canonical registry covers at least:

| Presentation category | Example labels | Canonical Journal mapping |
|---|---|---|
| Exercise | Running; Golf; Strength training; Walking; Cycling; Other | `exercise_note` plus registered subtype `running`, `golf`, `strength_training`, `walking`, `cycling`, or validated other detail |
| Alcohol | None; 1 drink; 2–3 drinks; 4+ drinks; Other/add note | `alcohol` plus explicit-negative or registered categorical/numeric range value for the displayed context window |
| Caffeine | None; Morning; Afternoon; Evening; Other/add note | `caffeine` plus explicit-negative or registered time-of-day subtype for the displayed context window |
| Stress | Low; Normal; High; Very high | `stress` plus registered ordinal/categorical value; the normalizer version fixes any ordinal mapping |
| Meals | Normal; Late meal; Heavy meal; Skipped meal; Other/add note | registered `food`/`late_meal` factor plus normalized subtype |
| Sleep Context | Screen before bed; Room hot; Nap; Late bedtime; Other/add note | registered sleep-context factor such as `screen_before_bed`, `sleep_environment_hot`, `nap`, or `late_sleep` |
| Travel / Illness | Travelling; Jet lag; Long-distance travel; Feeling ill; Other/add note | registered `travel`, `flight`, or `sickness` factor and subtype |
| Other | Add note | bounded free-text fallback through the existing candidate/validation path; never independently promotion-eligible as an unregistered custom factor |

Those English strings are non-normative. Changing a label or localization does not change stored evidence. Adding or changing a canonical value requires a new registered taxonomy/normalizer version and compatible evidence handling.

### Quick Action data and callback contract

A completed selection creates no competing event type. It creates an ordinary Structured Journal logical fact and uses the existing revision, invalidation, correction, deletion, source-link, privacy, and evidence rules. The accepted fact or its interaction provenance preserves, as applicable:

- authenticated tenant/user identity and destination binding;
- effective occurrence in existing `event_at` (the `occurred_at` semantic), optional interval end, context health date, and recorded IANA timezone;
- `answered_at`/callback receipt time separately from the effective context time;
- canonical category, subtype/value, polarity, unit, and taxonomy/normalizer version;
- source kind `quick_action`, `bot_question`, `free_text`, or `manual` (a versioned implementation may use one `free_text_manual` enum only when the underlying provenance still distinguishes typed free text from a manual/operator entry);
- interaction, question/request, Telegram update/callback, and source-event lineage where applicable;
- logical fact ID, revision, correction/deletion status, and invalidation generation.

`source_kind` is Journal-side provenance on each fact revision, not merely a transport-table attribute. The future v25 contract distinguishes at least `quick_action`, `bot_question`, `free_text`, and `manual`; downstream Journal and Evidence readers receive it with the fact. A correction records the source kind and provenance of the new assertion rather than silently inheriting a transport label from the prior revision.

### Trusted registry provenance and validator relationship

The existing deterministic Journal validator's user-text mode remains authoritative for free text, manual text entry, and any value derived from a typed answer. That mode still requires genuine `sourceText`, a minimal `raw_answer_excerpt`, and field-level text/excerpt support for category/factor, subtype, value, unit, ordinal/severity, and polarity. Quick Actions add a second deterministic provenance mode named **`TRUSTED_REGISTRY`**; they do not weaken or bypass the validator.

In `TRUSTED_REGISTRY` mode, a server-owned validation context supplies the canonical category/factor, subtype/value, unit when applicable, ordinal/severity when applicable, polarity when applicable, and taxonomy/normalizer versions from one allowlisted registry choice. The mode is valid only when the action is server-issued, registry-versioned, interaction-bound, authenticated-user-bound, unexpired, and replay-safe. The validator still enforces the closed Journal taxonomy, value shape, unit/range rules, temporal rules, tenant/interaction ownership, and idempotency. A caller-supplied candidate, Telegram label, callback text, model output, or arbitrary API field cannot select this provenance mode or assert canonical health values.

For a button-origin fact, `raw_answer_excerpt` is null/absent unless the user supplied genuine supplemental text. The implementation must not fabricate a phrase such as “I drank 2–3 drinks” to satisfy text-excerpt validation. If an `other/add note` flow includes user-authored detail, only that actual text may be retained as the bounded excerpt and the user-text rules apply to every field derived from it; the registry remains the authority for the button-selected fields.

The minimum durable Journal-side provenance is conceptually:

- provenance mode and `source_kind`;
- registry/action identifier and registry version;
- server-issued canonical choice identifier;
- interaction identifier and authenticated callback/update receipt identity;
- optional presentation-label snapshot for audit only, never analytical authority;
- authenticated actor/user identity;
- effective occurrence/context time and timezone;
- separate answered/clicked time.

This must answer: “this Journal fact exists because user X clicked server-issued action Y from registry version Z.” The server resolves an opaque callback token/action identifier to the stored interaction and then to the authoritative registry entry before constructing the validation context:

`callback token/action ID → authenticated interaction → versioned registry entry → canonical structured value`

Telegram callback payload text and client-visible presentation labels are never parsed or trusted as canonical health data. A missing, changed, disabled, or mismatched registry entry fails closed; it cannot fall back to free-text synthesis.

Self-initiated “I am running now” resolves its effective occurrence (`event_at`) from the authenticated action at receipt time in the user's recorded timezone. A bot question such as “Did you drink yesterday?” carries a server-owned target interval/context date and timezone from interaction creation; clicking today sets `answered_at` today but does not rewrite `event_at`/the occurred-at semantic or the context date to the click time. The validator rejects an expired interaction, invalid timezone snapshot, or ambiguous target instead of using the callback timestamp as a universal occurrence time.

Every callback is replay-safe:

1. The issued interaction is opaque, versioned, time-bounded, and bound server-side to one user, execution mode, destination, interaction revision, action registry version, and target-time semantics.
2. The private Telegram sender is authenticated before lookup; payload-supplied tenant, category, time, or destination fields are never trusted.
3. Telegram update/callback receipt identity and the interaction's semantic completion key are admitted durably. A double-click, provider retry, or process replay returns the prior result and cannot create a second fact, revision, receipt, or invalidation.
4. A callback for another user/destination, a replaced menu revision, an expired target, or a terminal interaction is rejected as stale. Replaying the same completed choice may return its fixed acknowledgment; a conflicting later choice must use correction rather than silently overwrite evidence.
5. Journal fact creation, source lineage, input-generation advance, and interaction completion commit atomically or not at all.

The user-facing **Undo** for a recent Quick Action is a convenience command over the existing authenticated deletion/tombstone operation. “Correct” uses the existing new-revision/supersession operation. Neither introduces a second durable meaning for undo, bypasses T0/T1/T2 privacy fencing, or releases a consumed source idempotency key. Replayed undo/correction returns the existing operation result.

### Tri-state exposure semantics

Every factor/outcome comparison uses exactly:

- **EXPOSED**: an ACTIVE affirmative structured fact covers the registered factor and window;
- **CONFIRMED_UNEXPOSED**: an ACTIVE explicit negative fact covers that factor/window, or an ACTIVE versioned coverage confirmation names the factor set and window;
- **UNKNOWN**: neither condition is proven.

Absence of a Journal entry is always UNKNOWN. Logging a different factor does not confirm non-exposure. UNKNOWN days are excluded from both exposed and unexposed sample counts.

Storage is explicit:

- **journal_events.exposure_state** stores EXPOSED or CONFIRMED_UNEXPOSED on an accepted fact;
- **journal_events.coverage_window_id** is required for a negative derived from a coverage confirmation;
- a new **journal_coverage_windows** row stores user_id, coverage_window_id, factor_set_version, exact UTC start/end, local health-date range, recorded timezone, source-event key, confirmation text hash, parser/normalizer versions, lifecycle/input generations, and ACTIVE/SUPERSEDED/DELETED status;
- UNKNOWN is a derived query result and is never persisted as if it were a negative fact.

The parser may propose an affirmative or explicit-negative candidate. Deterministic validation must resolve the factor, polarity, window, and source. Negation ambiguity returns REQUIRE_CLARIFICATION. A coverage answer confirms only the enumerated factor set and exact displayed interval; it cannot imply non-exposure for unlisted factors or adjacent days.

Correction supersedes the fact or coverage window and reclassifies affected days after invalidation. Deletion removes its health-bearing content and makes those days UNKNOWN unless another current explicit source proves exposure state. Health-date realignment applies the Section 6 time rules and invalidates every affected classification.

To control burden and selection bias, coverage confirmation is eligible only through the one-question utility policy, cannot be mechanically requested every day, and carries repeat/fatigue penalties. Evidence must disclose the ratio of EXPOSED, CONFIRMED_UNEXPOSED, and UNKNOWN days.

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

A correction first durably admits the Section 15 purge fence; then one content transaction:

1. locks the current ACTIVE logical fact revision;
2. validates the replacement under the current deterministic normalizer;
3. inserts a new revision with the same logical_fact_id;
4. marks the old revision SUPERSEDED;
5. executes the Section 15 direct-copy redaction matrix for the old content;
6. increments the Phase 4 input generation;
7. writes invalidation covering every evidence item, episode, insight, decision, answer, and unsent outbound payload that referenced the old revision;
8. commits all effects atomically.

The prior revision may retain only non-health audit metadata and hashes. Its old normalized values, note/text, and raw excerpt are redacted after correction; the new active revision retains only its own minimal current content.

### Deletion

A deletion first durably admits the Section 15 purge fence; then one content transaction:

1. resolves the authenticated tenant and active logical fact;
2. writes a minimal tombstone containing only tenant, logical_fact_id, source-event hash, deletion time, and idempotency key;
3. executes the Section 15 tenant-scoped health-plaintext purge matrix, including all direct copies and pending unsent payloads;
4. deletes all journal-event revisions for that logical fact, including raw text and normalized health content;
5. increments the Phase 4 input generation and writes invalidation in the same transaction;
6. records a purge ledger row whose generation makes stale caches and derived reads fail closed.

A deletion tombstone must not contain category, subtype, value, unit, severity, note, answer text, health date, evidence summary, or embedding. It exists only to make deletion replay safe and prevent resurrection.

### Context questions

**phase4_question_interaction_slots**, keyed by (user_id, execution_mode), is the exclusive interaction authority from selection through answer/expiry. **pending_questions** is only its LIVE Telegram conversation projection, never the exclusivity mechanism. A new typed **context_questions** record is the analytical provenance:

- candidate set and scores;
- selected question;
- policy and template versions;
- linked episode, nullable selecting decision, and canonical question_request_id/cycle identity from Section 12;
- uncertainty the answer is expected to reduce;
- source facts already known;
- delivery message ID;
- answer status;
- answer fact ID;
- expiry and lifecycle generation.

The context question is not opened in **pending_questions** until DELIVERED or a provider-confirmed accepted message ID proves receipt of that same slot/request, with current content/authorization fences. Unconfirmed AMBIGUOUS delivery retains the occupied slot and routes only an explicitly matching structured answer through that slot, without inventing an OPEN pending row. Section 12 defines the fixed answer window, atomic selection, ambiguity handling and legacy coexistence.

### Known context and question eligibility

A candidate is ineligible when:

- an ACTIVE current fact already supplies the same context for the relevant window;
- any question occupies this tenant/mode's interaction slot, even for another episode, factor, kind or target window (an idempotent continuation of the same request is not a new selection);
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

**Compatibility impact:** Existing journal readers continue to see revision-1 rows during dual-read migration. Phase 4 readers select ACTIVE facts only. Before LIVE question cutover, every legacy pending/open/send entry point must honor the same LIVE interaction guard; superseding a pending row after two sends is forbidden. Pre-cutover legacy-only behavior remains otherwise unchanged.

**Failure mode controlled:** Retried answers, corrected context, or deleted facts cannot continue to influence evidence invisibly.

## 7. Evidence Engine

### Durable model

The Evidence Engine persists **evidence_runs** and **evidence_items** with immutable non-health envelopes and in-place purgeable content. A run records:

- tenant, method, subject key, and requested as-of instant;
- exact observation window and health-day timezone snapshot;
- input generation, input manifest hash, and lifecycle generation;
- algorithm and metric-registry versions;
- eligible, excluded, EXPOSED, CONFIRMED_UNEXPOSED, and UNKNOWN sample counts;
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

The non-health envelope is immutable except defined state transitions; redaction/purge is the sole exception to append-only health content. Correction/deletion invalidates affected runs/items and synchronously purges their values, statistics, claims, and manifests using the exact Section 14 columns and Section 15 transaction. Audit preserves no recoverable health content; recomputation creates a new run, never fills a redacted row.

### Evidence methods

V1 supports these registered methods:

- current value versus robust personal baseline;
- monotonic trend over a declared window;
- EXPOSED-versus-CONFIRMED_UNEXPOSED journal-context association;
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
- Journal association reads resolve the fact revision and coverage revision that were
  authoritative at the requested as-of instant. A later assertion or correction cannot
  leak backward. When privacy purge has removed required historical content, replay fails
  closed with `CONTENT_REDACTED` rather than reconstructing or adopting a later revision.
- Exposure must precede or overlap the defined outcome window; future context cannot explain an earlier outcome.
- Timezone and health-day mapping are stored with the run.
- Recomputed results use a new run ID and link to the superseded run.
- Training or calibration data, if later introduced, must be separated from evaluation data by user and time.

### Association guardrails

An exposed-versus-unexposed context association first constructs the complete declared
comparison-health-date universe independently of outcome availability. Each day receives
one exposure state (EXPOSED, CONFIRMED_UNEXPOSED, or UNKNOWN) and, separately, one outcome
state (PRESENT, MISSING, or INVALID). EXPOSED and CONFIRMED_UNEXPOSED days with missing or
invalid outcomes remain in their group missingness denominator. UNKNOWN days are excluded
from both comparison groups, reported, and never silently placed in the unexposed group.

The effect is not calculated at all unless:

- each group has at least 5 usable days;
- total classified usable days are at least 20;
- at least 25 percent of otherwise eligible days are classified rather than UNKNOWN;
- the configured minimum effect size is met;
- neither group has more than 40 percent missing outcome data;
- primary quality is LIMITED or AVAILABLE; and
- direction and units are valid.

If those floors fail, association-method readiness is **INSUFFICIENT_EXPOSURE_CLASSIFICATION**; no comparative effect is emitted. The overall quality envelope still uses its deterministic precedence. A separately registered non-comparative observation method may run, but it cannot be labelled exposed-versus-unexposed evidence.

The comparison becomes **candidate evidence** when those floors pass. It becomes **repeated evidence** only when:

- each group has at least 8 usable days;
- total classified usable days are at least 30;
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

Every run records the canonical sorted comparison dates, as-of-authoritative Journal
revision identities, exposure-state source IDs, coverage-window IDs, outcome present/missing/
invalid counts by classified group, classification version, UNKNOWN-day count, and selection/
ascertainment-bias flags. Hypotheses and unordered source collections are canonicalized by
stable semantic keys before manifests, hashes, run keys, or item keys are derived.

### Versioned UNKNOWN-fraction promotion confound

**unknown-promotion-confound-v1** defines **MAX_UNKNOWN_FRACTION_FOR_PROMOTION_V1 = 0.50**:

unknown_fraction = UNKNOWN eligible observation-days / all eligible observation-days in the registered factor/outcome comparison window.

Eligibility is determined before exposure classification using the method's outcome availability, quality, lag, and window rules. Each eligible day counts once; EXPOSED and CONFIRMED_UNEXPOSED are classified days, never UNKNOWN. Days outside that eligibility/window never enter either count. This denominator is distinct from the classified sample count.

- Denominator 0 blocks promotion with NO_ELIGIBLE_OBSERVATION_DAYS.
- Fraction >0.50 blocks repeated/insight-supporting evidence and any promotion with UNKNOWN_FRACTION_EXCEEDED, regardless of sufficient classified samples.
- Fraction =0.50 passes this confound only; every other sample, replication, multiplicity, and confound gate must still pass.
- Candidate evidence may remain observable below promotion level if the earlier candidate-comparison floors pass.
- Correction/deletion recomputes eligibility and exposure states, then both counts and fraction; old support is invalidated and any dependent promoted claim becomes non-current until re-evaluation.
- Neither LLM wording nor user confirmation can override a blocked promotion.

Persist unknown_eligible_days, eligible_observation_days, unknown_fraction (null for denominator 0), max_unknown_fraction_for_promotion = 0.50, and promotion_confound_version = unknown-promotion-confound-v1 with every comparison evidence run. 0.50 is a conservative engineering default requiring shadow evaluation, not a statistically established optimum.

Boundary fixtures (all other gates independently controlled): 0/100 passes; 49/100 passes; 50/100 passes; 51/100 blocks; 100/100 blocks; 0/0 blocks. Deleting an explicit negative in 50/100 makes 51/100 and blocks if outcome eligibility remains; correcting one UNKNOWN to a valid explicit negative restores 50/100. Removing an ineligible outcome day recomputes the denominator instead of counting it UNKNOWN.

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

The components are deterministic 0–1 values defined by the method registry. Any hard confound caps confidence below 0.40. A missing uncertainty estimate caps it below 0.60. The evidence item durably exposes the confidence method/version, every component, the score, and LOW, MEDIUM, or HIGH label using the Section 3 label thresholds. Episode confidence is derived from the qualifying observation confidence and compatible durable evidence confidence; insight promotion consumes the stored compatible confidence and fails closed when it is absent or malformed.

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

Populated v20 health_insights are **LEGACY_UNVERIFIED**, read-only except mandatory redaction, and excluded from Phase 4 current/promoted/proactive reads. Migration does not invent evidence versions, dispositions, or supporting items. A legacy-history surface may label an unredacted, source-linked one as legacy/unverified; it is not a Phase 4 ScopedHealthContext input or a LIVE artifact merely because it survived migration. Eligible Phase 4 memory is recomputed through Section 10 and may retain only its opaque legacy source ID.

### Identity and versioning

An insight key is tenant/mode plus normalized subject, outcome, direction, exposure category, algorithm family, and evidence-contract major version. At most one non-retired current insight exists for a key within that execution_mode.

Each transition creates a new **insight_revision** and updates the current pointer with compare-and-swap on revision/input generation. The revision stores supporting/contradicting evidence IDs. The non-health envelope is immutable except defined state transitions; redaction/purge is the sole exception to append-only health content. Section 14 specifies in-place redaction, including the fixed sentinel for v20 health_insights.statement NOT NULL.

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
- User refutation creates or corrects context but does not by itself statistically REFUTE an insight. An explicit request to stop using or surfacing the insight invokes the USER_DISMISSED transition below.
- Contradictory current evidence moves EMERGING or SUPPORTED to WEAKENED before retirement unless provenance invalidation requires immediate retirement.
- **REJECTED** means a candidate did not meet promotion gates before its evaluation window ended.
- **REFUTED** means sufficient current evidence materially contradicts the claim.
- **EXPIRED** means all supporting evidence aged out without current replication.
- **INVALIDATED** means corrections, deletions, provenance failure, or lifecycle fences removed necessary support.
- **SUPERSEDED** means a compatible newer algorithm or more specific insight replaces it.
- **USER_DISMISSED** suppresses proactive use but does not falsify evidence.

**USER_DISMISSED is one atomic legal transition:** HYPOTHESIS, EMERGING, SUPPORTED, or WEAKENED becomes RETIRED while lifecycle_disposition becomes USER_DISMISSED in the same compare-and-swap transaction and revision. An active status can never carry USER_DISMISSED. Re-enabling later does not clear the terminal disposition; compatible new evidence creates a new linked insight version.

### Expiry and currentness

Default evidence expiry for proactive use is 90 days unless the metric registry specifies less. Expiry evaluation is deterministic and appends a revision. Historical Q&A may describe an expired insight only when the user explicitly requests history and the response labels it expired.

Current reads require:

- tenant match;
- not LEGACY_UNVERIFIED;
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

A proactive candidate must be tied to an OPENED, ESCALATED, EXPLAINED, or MATERIAL_ESCALATION semantic event under Section 12. It must:

- meet its metric registry threshold;
- be current and quality-eligible;
- differ semantically from prior delivered content, not merely numerically;
- have a user action, useful interpretation, or high-value uncertainty to resolve;
- avoid repeating an acknowledged, dismissed, or unchanged message.

Notification novelty uses registered semantic claim/action meaning and the durable event; revision numbers or text variation alone are not novelty. CONSUMED (including AMBIGUOUS) and CLOSED reservations suppress later decisions even when last_delivered_notification_id did not change.

### Notification eligibility

NOTIFY is eligible only when all are true:

- the episode transition is material and novel;
- evidence supports the claim language;
- a concrete, proportionate, non-medical action or interpretation exists;
- asking a question is not required to avoid a materially misleading statement;
- timeliness matters enough that waiting for the Morning Brief would reduce usefulness;
- its canonical semantic event has no CONSUMED or CLOSED reservation and is not already owned by another RESERVED message.

Sudden deterioration may pass on one severe registered observation only when the Section 4 exception is enabled for that metric. Its output remains a wellness signal, never diagnosis, emergency detection, or assurance of safety.

### Executable question utility v1

V1 uses **question_utility_v1**, a deterministic bounded heuristic. It is not information gain and none of its components is a statistical probability.

Before scoring, a candidate is ineligible when its episode/evidence snapshot is stale, an equivalent question is open, exact current context already answers it, no closed validated answer schema exists, a required component below is missing, or answerability is 0.

U, D, R, T, K, and P require their named current stores; a missing read makes the candidate ineligible. Missing/invalid template data makes A=0 and therefore ineligible. Missing fatigue history sets F=1 until repaired. No missing component is imputed as favorable.

Every component is clamped to [0,1]:

| Component | Exact source and lookup |
|---|---|
| unresolved_uncertainty U | Episode/evidence gap registry: 1.00 when an UNKNOWN factor separates competing explanation branches; 0.50 when it can only refine confidence/severity; 0 when known or irrelevant |
| decision_impact D | Exactly counterfactual_decision_impact_v1 below, using three branch signatures and first-match precedence |
| episode_relevance R | 1.00 for the current episode’s registered factor/outcome/window; 0.50 for the same domain and overlapping window; 0 otherwise |
| answerability A | Template registry: 1.00 for a bounded binary answer; 0.75 for at most four choices; 0.50 for one short typed value with known unit; 0 for free-form, ambiguous, or unnecessarily sensitive requests |
| temporal_relevance T | From episode last_material_change_at: 1.00 at 24 hours or less; 0.75 through 72 hours; 0.50 through 7 days; 0.25 through 30 days; 0 after 30 days |
| known_context K | ACTIVE fact/coverage overlap: 1.00 exact answer, 0.50 partial overlapping context, 0 none; K=1 makes the candidate ineligible |
| repeat_penalty P | Question history: 1.00 for the same semantic question answered/declined in 30 days, 0.50 for the same factor category in 14 days, 0 otherwise; an open equivalent is already ineligible |
| fatigue_penalty F | min(1, eligible context questions delivered in the prior 7 days ÷ 3); missing history fails closed to 1 until repaired |

**counterfactual_decision_impact_v1** is a pure, deterministic, side-effect-free, non-recursive registered evaluator. For each candidate, use one immutable in-memory as_of/input snapshot, identical versions and clock in all three branches. Overlay only the hypothetical validated answer: YES = EXPOSED, NO = CONFIRMED_UNEXPOSED for the exact displayed factor/window, UNKNOWN = no new fact, never NO. Ambiguous/invalid answer schemas make the candidate ineligible rather than guessing a branch.

The candidate registry must supply an exact structured YES/NO/UNKNOWN projection for the displayed factor/window. A non-binary/typed-value template without that projection is ineligible for this evaluator; no synthetic quantity is invented merely to score D.

Evaluate normal downstream evidence eligibility, episode explanation rules, and action rules with **question_selection_enabled = false**, ASK_ONE_HIGHEST_VALUE_QUESTION removed from the action set, persistence disabled, and delivery disabled. The evaluator receives read-only values and pure functions, no stores, job queue, model, scheduler, or send capability. It cannot create questions, decisions, jobs, outbox rows, or messages; no branch may call question_utility_v1 or recursively evaluate D. Factor the ordinary non-question action rules into a shared leaf evaluator; do not call the top-level proactive policy.

Each branch returns a signature:

- evidence_eligibility: INELIGIBLE, CANDIDATE, REPEATED, or INSIGHT_SUPPORTING, using Section 7 gates;
- episode_explained_status: EXPLAINED or UNEXPLAINED, using current supporting evidence/context;
- action: NO_NOTIFICATION, NOTIFY, or DEFER_OBSERVATION.

D is first-match only:

1. 1.00 if YES.action differs from NO.action.
2. 0.75 if YES/NO actions match but differ from UNKNOWN.action.
3. 0.50 if all actions match but YES/NO differ in evidence_eligibility or episode_explained_status.
4. 0.25 if YES/NO signatures match but differ from UNKNOWN in either non-action field.
5. 0.00 otherwise.

~~~javascript
function impactD(yes, no, unknown) {
  const interpretationDiffers = (a, b) =>
    a.evidence_eligibility !== b.evidence_eligibility ||
    a.episode_explained_status !== b.episode_explained_status;
  if (yes.action !== no.action) return 1;
  if (yes.action !== unknown.action) return 0.75;
  if (interpretationDiffers(yes, no)) return 0.50;
  if (interpretationDiffers(yes, unknown)) return 0.25;
  return 0;
}
~~~

Persist the evaluator version and all three signatures, not merely their hash. Tests must exercise all five results, overlapping differences (action takes precedence), branch-order invariance, unchanged input snapshots, UNKNOWN never negative, and spies proving zero question-scoring recursion, store writes, LLM calls, queue/proposal creation, or delivery.

question_utility_v1 =
clamp(0, 1,
0.25 × U +
0.30 × D +
0.15 × R +
0.15 × A +
0.15 × T −
0.20 × K −
0.15 × P −
0.10 × F)

U, D, R, A, T, K, P, and F are all persisted with source versions. A candidate must score at least 0.60. Ties are broken by higher D, then U, then lower sensitivity class, then stable candidate key. Exactly one winner is required for ASK; no eligible winner means no ASK.

The heuristic version, weights, lookup tables, and threshold are engineering calibration defaults. Shadow evaluation must report candidate distribution, winner stability, answer/decline rates, counterfactual branch changes, and user burden before publication; it must not relabel the heuristic as modeled probability or information gain.

### Independent evaluation and conflict resolution

Question and notification eligibility are evaluated independently from the same episode snapshot.

- If neither is eligible and more evidence is expected soon, choose DEFER_OBSERVATION.
- If neither is eligible and waiting adds no expected value, choose NO_NOTIFICATION.
- If only one is eligible, choose its corresponding action.
- If both are eligible, choose NOTIFY only when delay could reduce the usefulness of a concrete action and the notification can be truthful without the answer.
- Otherwise choose ASK_ONE_HIGHEST_VALUE_QUESTION when question_utility_v1 is at least 0.60 and D is at least 0.75.
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

The non-health envelope is immutable except defined state transitions; redaction/purge is the sole exception to append-only health content. In-place purge removes rationale, gate/utility values, candidate diagnostics and branch signatures; action, opaque identities and invalid state remain. A redacted decision cannot be replayed into a proposal or recomputed in place.

### Significant decision

**Decision:** Replace the Phase 4 use of daily count caps and automatic ASK-to-NOTIFY conversion with quality, episode, novelty, and actionability gates.

**Alternative rejected:** Keep the current cap and treat NOTIFY as a harmless fallback whenever a question cannot be asked.

**Rationale:** A count cap can suppress the only important event or permit low-value events up to the cap. A failed question does not imply that an unqualified assertion is safe.

**Compatibility impact:** Legacy proactive behavior can remain behind its existing flag. Phase 4 decisions never call **downgradeAskToNotify**.

**Failure mode controlled:** Mechanical anomaly messages, repeated low-value output, and unsupported assertions after question failure.

## 10. Event-driven invalidation and reanalysis

Phase 4 consumes processed WHOOP records and application events; it does not poll or infer a continuous raw HR/PPG stream. A webhook is an invalidation/refetch signal, not a physiological sample. Historical baselines and durable pending work allow the same canonical runner to converge whether it was prompted by ingress, the morning high-frequency schedule, or the hourly background schedule.

### Required separation

The pipeline is:

~~~mermaid
flowchart LR
    A[Canonical or journal mutation] --> B[Phase 4 invalidation]
    B --> C[Coalesced recomputation job]
    C --> D[Observations and quality]
    D --> E[Deterministic evidence run]
    E --> F[Episode transition]
    F --> G[Insight-memory update]
    G --> H[Proactive decision]
    H --> I[Outbound proposal]
    I --> J[Delivery dispatcher]
    J --> K[Telegram provider]
~~~

Each arrow crosses a durable boundary. Trigger code cannot skip directly to decision or delivery. Reanalysis code cannot call Telegram.

### Trigger contract

Eligible triggers are:

- actual semantic changes to canonical WHOOP rows;
- canonical tombstones;
- reconciliation corrections;
- journal create, correction, and deletion;
- accepted structured answers to the matching AWAITING_ANSWER or AMBIGUOUS_WAIT slot;
- timezone or relevant preference changes;
- lifecycle, authorization, capability, or resource-access changes relevant to computation or delivery;
- algorithm or registry rollout backfills.

An idempotent no-op canonical write does not increment the Phase 4 generation.

### Transactional invalidation

When a canonical or journal write changes semantics, the same **processing.transaction** must:

- commit the source change;
- advance the shared source_generation and each existing mode's input_generation once, recording source_generation_seen;
- merge allowed health scope and finite reasons into mode-qualified **phase4_invalidations**, retaining FULL_TENANT_RECOMPUTE dominance after redaction;
- enqueue or advance corresponding same-mode **phase4_jobs** generations. Do not create unauthorized LIVE state merely because a source changed.

This extends the safe invalidation pattern in [src/analyticsInvalidation.js](../src/analyticsInvalidation.js) but does not enqueue the existing analytics worker classes.

### Job model

Jobs are coalesced by (user_id, execution_mode, job_kind). A job contains requested generation, completed generation, SCOPE kind/revision, nullable health range, reason set, attempt, next-attempt time, lease owner and lease expiry. FULL_TENANT_RECOMPUTE takes precedence over empty ranges and completed-generation equality.

The worker:

1. claims with a bounded lease;
2. captures execution_mode, requested/scope/purge/lifecycle/auth generations;
3. performs provider-free calculations from a stable read snapshot;
4. commits derived writes only if lifecycle, authorization, capability, and input-generation fences still pass;
5. advances only its own mode's completed generation after the entire requested scope succeeds;
6. immediately requeues when a newer requested generation arrived during work.

Retry backoff is bounded and observable. Poison jobs move to a repair-required state without blocking other tenants.

The default retry schedule is 1 minute, 5 minutes, 15 minutes, 1 hour, and 6 hours. After five failed claims for the same requested generation, the job becomes REPAIR_REQUIRED and emits an operational alert. A newer input generation can create a fresh attempt only after the prior typed error is re-evaluated.

In shadow-reanalysis mode, the worker may persist SHADOW evidence/episodes but cannot create an outbound proposal. In shadow-decision mode it may persist SHADOW decisions; only the separate shadow-proposal evaluator may create non-dispatchable SHADOW outbound_messages. All use the durable execution_mode column and Section 14 mode-qualified keys, not a process flag or JSON label. No UPDATE from SHADOW to LIVE is allowed; LIVE requires separately authorized recomputation and fresh LIVE rows after the conjunctive gate.

### Reanalysis contract

Reanalysis follows one normative order and may:

1. select observations and write or invalidate Body Energy results;
2. write the deterministic evidence run/items;
3. transition the episode using those durable evidence items;
4. update Insight Memory;
5. create a proactive decision;
6. create an outbound proposal.

No final episode transition occurs before its evidence item exists. An implementation may build an in-memory grouping candidate during observation selection, but that candidate is not an episode state and is not persisted as OPEN or EXPLAINED.

It may not:

- send Telegram messages;
- mutate lifecycle or authorization truth;
- fetch user data from a provider while holding a database transaction;
- activate or call the dormant Phase 3 analytics worker;
- reinterpret a deletion tombstone as health context;
- publish a result from a stale generation.

Provider refresh and WHOOP canonicalization remain in their existing ingestion/reconciliation layers.

### Scheduling

The locked scheduler timezone is **Asia/Taipei**. The target schedule is:

- **Morning High-Frequency Window:** from 08:00 inclusive to 12:00 exclusive, Cloudflare invokes the canonical scheduler every 10 minutes.
- **Outside the morning window:** Cloudflare cron does not run. Its absence is intentional, not a failure.
- **Background cadence:** the existing GitHub hourly scheduler invokes background work independently. Outside the morning window it is the expected scheduled driver; it does not call or wake Render merely to drain background work.
- **Event-driven ingress:** Telegram webhook, WHOOP webhook ingress, OAuth callback, and any other explicitly supported HTTP ingress may wake Render on demand and enqueue or prompt eligible work. The request path still crosses the durable invalidation/job boundary and cannot send directly from analysis.

Cloudflare Cron Triggers are evaluated in UTC. Asia/Taipei is fixed at UTC+8 and has no daylight-saving-time transition, so the intended production trigger is exactly **`*/10 0-3 * * *`**: 00:00–03:50 UTC, which maps to 08:00–11:50 Asia/Taipei. **`*/10 8-11 * * *` is incorrect** because it would run at 16:00–19:50 Asia/Taipei. This expression is a future deployment target only; this documentation repair does not change Cloudflare configuration.

Scheduler verification is two-layered. Tests must prove the application/local-time predicate's inclusive 08:00 and exclusive 12:00 boundaries, and deployment/runbook verification must independently read the actual Cloudflare trigger and assert that it equals `*/10 0-3 * * *`. Passing only the in-code window predicate is insufficient to approve scheduler activation.

The morning window improves Morning Brief timing and morning intelligence responsiveness. It does not turn the Morning Brief into a universal 08:00 send: Section 11's per-user timezone, due/eligibility, wake/readiness, missing-data, lifecycle, and semantic-reservation rules remain authoritative.

This is one global Asia/Taipei high-frequency window, not a per-user window. A user whose own local Morning Brief due time falls outside it may be detected or delivered by the normal GitHub hourly path rather than Cloudflare's 10-minute path and can therefore experience higher latency. Phase 4 v1 accepts that cost/latency trade-off and does not promise equal high-frequency Morning Brief latency across timezones. Per-user Cloudflare windows are outside the current scope; a later version may revisit them if multi-timezone usage warrants it.

The scheduler entry points call the same idempotent, lease-fenced canonical runner. Concurrent Cloudflare, GitHub, webhook, or retry invocations converge through the existing queue, generation, reservation, and transport invariants. They never use the dormant Phase 3 drain.

Outside the morning window, proactive/background computation may wait approximately until a later GitHub scheduled run. GitHub scheduled workflows do not provide an exact hourly SLA, so product copy and monitoring must not promise completion within exactly one hour. Event-driven ingress can improve latency but is not a real-time monitoring guarantee.

### Durable backlog and cadence-aware watchdog

Cadence affects when work is attempted, never whether it remains owed. Webhook ledger items, invalidations, reanalysis jobs, scheduled maintenance, reconciliation state, and other admitted work remain durable across a delayed, missed, failed, or overlapping scheduled invocation. The next successful canonical run scans and catches up eligible pending work; “delayed” must never be represented as “completed” or discarded.

Watchdog evaluation first resolves the current Asia/Taipei schedule window and scheduler class:

- During 08:00–12:00, Cloudflare's 10-minute primary cadence is expected and monitored with a tolerance that permits ordinary execution and reporting delay.
- Outside 08:00–12:00, Cloudflare inactivity is normal. The watchdog must not emit `scheduler_primary_stale` solely because no Cloudflare heartbeat exists.
- Outside the morning window, GitHub hourly is the expected background cadence. Its stale threshold includes realistic GitHub scheduling jitter, job duration, and heartbeat-reporting delay rather than treating the nominal cron minute as an SLA.
- A missing heartbeat alert identifies the expected scheduler class, evaluated window, last successful canonical run, durable backlog age, and tolerance policy version. A successful event-driven run may reduce backlog but does not fabricate a missing scheduled heartbeat.

The exact operational tolerance is versioned in implementation/runbook configuration and reviewed with observed scheduler behavior; this ADR fixes the behavioral boundary, not an unjustified minute constant.

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

The semantic reservation identity is:

user_id + message_family MORNING_BRIEF_V1 + local_health_date

There is exactly one typed Phase 4 reservation for that identity. A provider delivery start may repeat only after a definite non-acceptance; an ambiguous start permanently occupies the semantic reservation and is never retried automatically. Provider ambiguity is reported honestly because no distributed system can prove that a second send would not duplicate an accepted Telegram message.

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

### Recipient display-name authority

Every message renderer resolves its recipient name inside the authenticated recipient's tenant scope. The authority order is:

1. a non-empty explicit user-chosen display name;
2. the bound recipient's Telegram `first_name` from authenticated Telegram identity;
3. the bound recipient's WHOOP profile first name;
4. a neutral greeting that contains no person's name.

The canonical `users.display_name` may satisfy step 1 only when its provenance establishes that it is an explicit value for that same user. Legacy, placeholder, copied, global, or unproven values must be re-resolved or treated as absent. Name resolution is completed before any optional wording model call, and the model cannot substitute a different identity.

Kelvin is never a universal or default recipient name. Kelvin's name may appear in another user's message only as an intentional reference to the system owner, never as that user's greeting or identity. Caches and templates key recipient identity by internal user ID plus the relevant identity/binding generation; a process-global name, previous-user value, or batch-loop variable cannot be a fallback.

An owner-directed monitoring message has two named roles: the authenticated recipient is Kelvin, while the monitored subject may be identified explicitly (for example, “Alice — Daily Summary”). Naming the subject does not change the recipient or tenant semantics of the delivery route.

### Phase 4 delivery

MORNING_BRIEF_V1 uses the typed Phase 4 outbox and semantic reservation in Section 12. It does not reuse or reinterpret **report_claims**. Existing **report_claims** and **report_runs** remain legacy V1.2 delivery records until a tenant/message-family cutover completes.

The current report’s content-readiness behavior is replaced only after the authoritative delivery mode for that tenant and MORNING_BRIEF_V1 is PHASE4. Before cutover, Phase 4 cannot create a Morning Brief reservation or claim.

### Liveness

The scheduler retries an unstarted typed outbox message throughout its health day and until the next health day’s preferred delivery instant. If the service was unavailable beyond that point, the message becomes SUPPRESSED with **EXPIRED_SYSTEM_OUTAGE** and its reservation becomes CLOSED, never reusable for that date. The expiry is an operational failure, not a data-readiness cancellation, and must be observable.

Morning Brief scheduling is independent of opportunistic episode notifications. A proactive delivery neither satisfies nor delays the daily brief, and the brief claim does not consume any proactive eligibility.

## 12. Outbound delivery state machine

### Separation of records

The typed Phase 4 outbox handles every Phase 4 message class:

- MORNING_BRIEF_V1;
- EPISODE_NOTIFICATION;
- CONTEXT_QUESTION;
- ANSWER_FOLLOWUP;
- OWNER_DAILY_SUMMARY;
- OWNER_IMPORTANT_ALERT;
- OWNER_WEEKLY_SUMMARY.

Each class has its own semantic-key builder, while lifecycle and provider-attempt behavior are shared. A follow-up decision references an existing accepted answer event; only a new answer semantic event can authorize a new ANSWER_FOLLOWUP identity. Answering never sends inline.

For an owner class, `outbound_messages.user_id` is the recipient owner and the message must reference one current dual-principal Owner Monitoring authorization envelope. The envelope—not a generic outbox join—identifies the followed subject and the approved current synthesized artifact or bounded deterministic summary plan. Owner classes do not become available to ordinary tenant callers, and absence of either permitted source produces no message.

- **report_claims** and **report_runs** remain legacy V1.2 delivery mechanisms until atomic cutover.
- **telegram_operations** remains the receipt for replies to inbound updates.
- **proactive_events** remains legacy history and is not the Phase 4 outbox.

### Message states

| State | Meaning |
|---|---|
| PROPOSED | Immutable payload and its source decision, brief identity, or owner authorization persisted |
| ELIGIBLE | Latest lifecycle, pause, currentness, and novelty checks passed |
| CLAIMED | Dispatcher owns a bounded lease; provider call has not begun |
| DELIVERY_STARTED | Pre-send transaction committed; provider outcome may become ambiguous |
| DELIVERED | Provider confirmed acceptance and message ID is stored |
| FAILED_DEFINITE | Provider proved non-acceptance; bounded retry may be scheduled only while content/currentness/purge fences pass |
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

### Semantic reservation and message identity

**semantic-key-v1** encodes the following arrays as compact JSON with strings in the given order (no delimiter concatenation). IDs are opaque server-generated durable IDs, never supplied by a model:

| Class | Canonical key builder |
|---|---|
| Morning Brief | JSON.stringify([user_id, "MORNING_BRIEF_V1", local_health_date]) |
| Episode notification | JSON.stringify([user_id, "EPISODE_NOTIFICATION", episode_semantic_event_id]) |
| Context question | JSON.stringify([user_id, "CONTEXT_QUESTION", question_request_id]) |
| Answer follow-up | JSON.stringify([user_id, "ANSWER_FOLLOWUP", answer_event_id, followup_kind]) |
| Owner Daily Summary | JSON.stringify([owner_user_id, subject_user_id, "OWNER_DAILY_SUMMARY", subject_local_health_date]) |
| Owner Important Alert | JSON.stringify([owner_user_id, subject_user_id, "OWNER_IMPORTANT_ALERT", subject_semantic_event_id]) |
| Owner Weekly Summary | JSON.stringify([owner_user_id, subject_user_id, "OWNER_WEEKLY_SUMMARY", subject_local_week_key]) |

No key contains a decision/job/attempt ID, lifecycle/auth/input generation, algorithm/policy version, payload/content hash, wording/template version, or recomputation timestamp. Those are provenance only. The key builder cannot be version-bumped to resend the same semantics. A migration must reuse the durable IDs and existing keys.

The durable reservation namespace is (user_id, execution_mode, message_family, semantic_key), where `user_id` is the transport recipient (the owner for owner classes). execution_mode partitions SHADOW simulation from LIVE authority without changing these canonical builders. Mode is immutable, never a knob for retrying a LIVE event. All references and uniqueness tuples in this section additionally include execution_mode as specified in Section 14; a SHADOW reservation never blocks a LIVE reservation, or vice versa.

**Episode semantic event creation.** In the same CAS transaction as the accepted episode transition/revision, insert one **episode_semantic_events** row, unique on (user_id, episode_id, resulting_revision). Allowed event_kind values are:

- OPENED: newly observed evidence opens a new live episode under the normal persistence/severity gates, including a qualified direction reversal or recurrence;
- ESCALATED: legal transition into ESCALATED on newly observed evidence that passes the registered material rule; the same severity/claim/action already represented by an earlier semantic event is not new;
- EXPLAINED: legal transition into EXPLAINED resolves a previously unresolved registered uncertainty using new current evidence/context; re-entering with an already represented explanation creates no event;
- MATERIAL_ESCALATION: only the Section 5 same-state ESCALATED severity-increase rule.

No other transition/revision creates an event. No event is created solely by daily recomputation, payload revision, correction/backfill, algorithm migration, lifecycle change, or new decision. The transaction compares all prior episode semantic events, not only delivered history; creation of a genuinely new meaning is independent of whether the previous event was sent. Semantic comparisons use registered severity ordinal, explained uncertainty key, claim key, and action key, not prose. Once committed, later decisions and payload proposals reference the existing episode_semantic_event_id. If purged content prevents proving novelty, fail closed; deletion is not permission to issue a replacement event. Algorithm-major replacement episodes carry predecessor links and inherit prior semantic-event barriers.

**Question request creation.** In the atomic selection transaction below, before decision/outbox insertion, allocate or reuse **question_request_id** in context_questions under uniqueness on (user_id, execution_mode, episode_id, factor_question_kind, target_window_start_utc, target_window_end_utc, question_cycle_ordinal). factor_question_kind is a registered closed factor/template kind, not wording; windows are exact UTC half-open intervals from the candidate registry. The first cycle ordinal is 1. The tenant/mode slot serializes different requests, while tuple uniqueness deduplicates the same request. Retries, rescoring, expiry, algorithm/lifecycle changes, and later decisions never increment the ordinal.

A further ordinal for the same tuple is permitted only by an explicit authenticated user request to revisit that context after the prior cycle is terminal and its slot is unoccupied, never while AMBIGUOUS_WAIT/in flight; atomically record its unique source-update receipt in question_cycle_source_key and allocate previous+1. Replay of that receipt returns the existing request. Ordinary policy never creates a new ordinal to evade fatigue or a consumed/closed reservation. A genuinely different episode/factor/window is a different tuple but still must acquire the same tenant/mode slot and pass all known-context/fatigue gates. Request ID allocation precedes decision linkage within the transaction; selected_decision_id may remain null only for a shadow selection-only evaluation. It grants no provider capability.

**Answer event creation.** When an accepted structured answer revision commits with its journal fact/coverage mutation, create one **structured_answer_events.answer_event_id**, unique on (user_id, logical_answer_id, answer_revision), and link source-update receipt and question_request_id. logical_answer_id is the stable question-response lineage. Compare normalized polarity, factor, value/unit, exact target window, and coverage set with the current answer revision. Equivalent wording, retry, or parser-version-only changes reuse the same answer event. A semantically changed accepted correction creates the next revision/event; deletion creates no answer event. A receipt for any superseded/redacted revision returns a no-op, never resurrects it.

The finite **followup_kind** registry is INTERPRETATION_UPDATE (current evidence/explanation meaning changed) or OBSERVATION_PLAN (only the next observation plan changed). Select at most one kind per answer event, with INTERPRETATION_UPDATE taking precedence, and persist selected_followup_kind once before the first proposal. No later decision may choose the other kind to bypass a reservation. No qualifying change means no follow-up. A new decision for an existing answer event always reuses its kind and key.

**Reservation lifecycle.** Reserve the canonical key transactionally before delivery ownership; LIVE reservation plus first message creation is atomic. Selection-only SHADOW question evaluation is the explicit exception: request/reservation/slot commit without a message and can only attach its same-mode simulation proposal later. States are RESERVED, CONSUMED, and CLOSED. DELIVERED or AMBIGUOUS permanently sets CONSUMED. SUPPRESSED/INVALIDATED before start, and FAILED_TERMINAL after only definite non-acceptance, set CLOSED. Neither CONSUMED nor CLOSED is released, deleted, or recreated for that semantic event. INVALIDATED cannot acquire an alternate key or payload version. Reservation and semantic-event identity metadata remain for the tenant's lifetime, independent of 400-day message-history retention. Source deletion purges content, never the reservation.

One reservation owns at most one outbound message (unique user_id, reservation_id); its outbox idempotency key is the canonical semantic key, not message version. Candidate wording may change before first proposal only. After PROPOSED, retry uses the same payload and same message; a stale/corrected proposal is invalidated and closed, not replaced. This deliberately favors non-duplication over replacement delivery. Only an explicitly new semantic event or the next Morning Brief date creates a new key. The record stores:

- authenticated destination reference, never caller-supplied chat ID;
- exact text or structured Telegram payload;
- content and semantic hashes;
- decision, episode, question, and evidence references;
- lifecycle, input, policy, and template versions;
- state and expected revision;
- expiry;
- attempt counters and terminal reason.

Payload is frozen before PROPOSED commits. Retry sends the same payload; it does not regenerate text under newer context. The non-health envelope is immutable except defined state transitions; redaction/purge is the sole exception to append-only health content. Once redacted, that message can never be sent/retried.

### Ambiguous-send and later-decision examples

| Class/event | First attempt | Replay/later decision |
|---|---|---|
| u1, MORNING_BRIEF_V1, 2026-09-19 | Provider accepts, response lost; AMBIGUOUS and CONSUMED | Changed schedule/timezone, new decision, resumed lifecycle, and revised text still hit the same date key; zero second sends |
| u1, EPISODE_NOTIFICATION, event-e7 | Decision d1 sends and loses response; CONSUMED | Decision d2 from new generation references event-e7; suppressed without new event or message |
| u1, CONTEXT_QUESTION, request-q4 | AMBIGUOUS | q4's key stays CONSUMED forever and the tenant/mode slot stays AMBIGUOUS_WAIT through its answer deadline; q5 for another episode/factor/window also cannot send during that window |
| u1, ANSWER_FOLLOWUP, answer-a3, INTERPRETATION_UPDATE | AMBIGUOUS | d9 then d10 reference a3 and its fixed kind; both reuse CONSUMED. Equivalent answer wording reuses a3. A genuine corrected answer creates a4 and must independently pass policy |
| Any class, invalidated before start | CLOSED; payload purged | Later decision cannot mint an alternative key/version; same event remains closed |

For every class a crash after DELIVERY_STARTED but before outcome commit recovers to AMBIGUOUS/CONSUMED, including after pause/reauthorization. Proven non-acceptance alone permits bounded retry of the same message while RESERVED for non-question classes. CONTEXT_QUESTION uses the stricter terminal non-acceptance rule below, never an automatic replacement question. Tenant u2's identities remain independent.

### Exact lifecycle behavior

- **PROPOSED:** payload and reservation committed; no delivery eligibility yet.
- **ELIGIBLE:** current lifecycle/auth/pause/currentness checks passed.
- **CLAIMED:** one dispatcher lease owns the message; provider call has not begun. Lease expiry may return it to ELIGIBLE.
- **DELIVERY_STARTED:** attempt row and state committed before the provider call. This state is never deleted, invalidated, or reopened.
- **DELIVERED:** provider acceptance and message ID confirmed; reservation CONSUMED.
- **AMBIGUOUS:** acceptance cannot be determined; reservation CONSUMED and state permanently non-retryable.
- **FAILED_DEFINITE:** provider proved non-acceptance; the same unredacted/current message may return to ELIGIBLE under bounded retry. Failed purge/lifecycle/currentness eligibility ends it as FAILED_TERMINAL/CLOSED instead.
- **FAILED_TERMINAL:** all outcomes were definite non-acceptance and retries ended; terminal, with reservation CLOSED.
- **SUPPRESSED:** policy/lifecycle/pause prevented an unstarted send; terminal, reservation CLOSED, payload subject to purge policy.
- **INVALIDATED:** source became stale before DELIVERY_STARTED; terminal, reservation CLOSED, payload subject to purge policy.

A lifecycle or authorization transition may move PROPOSED, ELIGIBLE, or CLAIMED to SUPPRESSED or INVALIDATED. It must not delete, reopen, or make retryable DELIVERY_STARTED, DELIVERED, or AMBIGUOUS history. Pause/resume, disable/reactivate, reauthorization, destination change, or generation change can never turn AMBIGUOUS into retryable work.

### Claim and send protocol

1. Claim ELIGIBLE with owner and lease.
2. Recheck user ACTIVE, READY, destination binding, notifications not paused, message expiry, decision currentness, durable execution_mode = LIVE throughout the parent chain, and no prior delivery. For a question, require its matching RESERVED slot and revision.
3. In a transaction, insert the LIVE-only attempt and set DELIVERY_STARTED with exact attempt ID; atomically move a question's matching slot to DELIVERY_STARTED and set its deadline.
4. Commit.
5. Call Telegram outside the transaction.
6. On confirmed acceptance, store DELIVERED and provider message ID.
7. On definite non-acceptance, store FAILED_DEFINITE and retry only the registered retryable errors with bounded backoff for non-question classes. A question immediately proceeds to FAILED_TERMINAL/CLOSED and the slot cancellation below.
8. On timeout, connection loss after request write, malformed success, or process crash after step 4, set or recover as AMBIGUOUS and do not automatically resend.

A startup repair changes expired CLAIMED records back to ELIGIBLE because no provider call began. Expired DELIVERY_STARTED records become AMBIGUOUS.

### Question-specific behavior

**Exclusive slot.** phase4_question_interaction_slots has exactly one row per (user_id, execution_mode), initially FREE with revision 0. Occupied states are RESERVED, DELIVERY_STARTED, AMBIGUOUS_WAIT and AWAITING_ANSWER. FREE, RESOLVED, EXPIRED and CANCELLED_PRE_SEND are unoccupied. The latter three retain the previous request/outcome until the next acquisition CAS; the context request and reservation preserve permanent history. Reacquisition increments revision, replaces only current slot references/timestamps and clears prior-cycle timestamps. It cannot reopen the previous consumed/closed request.

**Atomic selection.** A short tenant/mode transaction validates input/lifecycle/auth/purge generations and authoritative family mode, CAS-acquires an unoccupied slot, allocates/reuses the request and ordinal, selects the decision, reserves its semantic key and creates its frozen outbound proposal when proposal evaluation is enabled. All effects commit together or none do. Selection-only SHADOW evaluation may reserve the slot/request with outbound_message_id null; a later proposal attaches only by CAS to that same request. LIVE selection always includes its outbound proposal. An occupied different request rejects the whole transaction (including request, decision and reservation inserts), even when its episode/factor/kind/window and semantic key are all different. Same-request replay returns the committed result without extending a deadline. No check-then-insert outside this transaction is sufficient.

**Normative transitions and window (question-slot-v1).** Answer window is 30 UTC minutes; equality with answer_deadline is expired. reserved_at is selection time; an unstarted reservation expires at reserved_at + 30 minutes by CANCELLED_PRE_SEND with RESERVATION_EXPIRED, not evidence of a user nonresponse. All transitions CAS user/mode/revision/request. Recheck durable content/lifecycle/auth/purge fences for start, answer interpretation and pending projection. Non-health transport settlement and expiry remain permitted after pause/lifecycle change or purge, without reopening health access; a confirmed outcome may record AWAITING_ANSWER while projection is withheld and the slot waits for expiry.

| From | Event | To and atomic effects |
|---|---|---|
| Any unoccupied state | New eligible selection wins CAS | RESERVED; write request/decision/reservation/proposal as above |
| RESERVED | Start authorized provider call | DELIVERY_STARTED; set delivery_started_at and answer_deadline = delivery_started_at + 30 minutes in the attempt/start transaction |
| RESERVED | Definite pre-send failure, pause/disable/auth change, source invalidation or reservation expiry | CANCELLED_PRE_SEND; cancellation_reason, closed request and CLOSED reservation; unstarted outbox SUPPRESSED (INVALIDATED for stale source); no OPEN pending row |
| DELIVERY_STARTED | Confirmed provider acceptance | AWAITING_ANSWER; delivered_at; answer_deadline = max(existing deadline, delivered_at + 30 minutes); reservation CONSUMED; create one matching pending projection |
| DELIVERY_STARTED | Crash, uncertain acceptance or lost response | AMBIGUOUS_WAIT; ambiguous_at set once at first durable classification; answer_deadline = max(existing deadline, ambiguous_at + 30 minutes); reservation permanently CONSUMED; no resend and no ordinary pending projection |
| DELIVERY_STARTED | Proven non-acceptance | CANCELLED_PRE_SEND with PROVIDER_DEFINITE_NON_ACCEPTANCE (name means no accepted question); outbox FAILED_DEFINITE then FAILED_TERMINAL, reservation CLOSED; no retry |
| AWAITING_ANSWER or AMBIGUOUS_WAIT | Matching validated structured answer before deadline | RESOLVED; resolved_at and accepted answer/fact/coverage receipt commit atomically; matching pending projection ANSWERED if present |
| AWAITING_ANSWER or AMBIGUOUS_WAIT | Deadline reached without accepted answer | EXPIRED; expired_at and matching pending projection EXPIRED; CONSUMED reservation remains forever |

DELIVERY_STARTED cannot time out directly to FREE/EXPIRED; classify it as AMBIGUOUS_WAIT first and retain the full conservative window. Restart never resets ambiguous_at or extends an already classified deadline. If a late provider success confirms the same ambiguous request before expiry, record delivered_at/provider ID and move it to AWAITING_ANSWER, extend to max(existing deadline, delivered_at + 30 minutes), and project that same question only; this confirms transport, never resends. Confirmation after terminal slot resolution/expiry only updates transport history and cannot reopen the slot or pending row. The outbox's AMBIGUOUS terminal non-retryability is unchanged.

Recheck the matching slot before DELIVERY_STARTED, on lifecycle/auth changes, scheduler retry/lease takeover, and before every pending-question open/update. Pause/disable may cancel RESERVED but must not free DELIVERY_STARTED, AMBIGUOUS_WAIT or AWAITING_ANSWER early; pause/resume cannot issue a replacement during their window. Changed auth/lifecycle prevents stale answer interpretation, but not non-health expiry. Purge redacts question content and pending fields while retaining an occupied post-start slot through its deadline; without current unredacted matching context, an answer cannot reconstruct the erased question. Expiry does not release its semantic reservation.

**Conversation projection and routing.** Existing [openPendingQuestion](../src/botStore.js) supersedes all OPEN rows for a tenant; it is not safe for Phase 4. The compatibility adapter must instead verify the authoritative LIVE slot and upsert only its linked request, unique (user_id, execution_mode, context_question_id) where non-null; a different OPEN interaction causes rollback, never silent supersession. Ordinary implicit replies may resolve only the slot's AWAITING_ANSWER request and matching pending ID/destination binding. AMBIGUOUS_WAIT accepts only an explicit opaque question reference (validated button token or reply-to ID that can be proven to match), authenticated to the same tenant/mode; generic unrelated chat is not an answer. No match means no answer/fact/follow-up and the slot remains occupied.

Answer receipt lookup precedes routing. Replay returns the same answer event or redacted no-op, never resolves a newer occupant. A subsequent correction targets the tenant-qualified fact/answer lineage and may create a semantically changed answer event, but never reopens or releases an unrelated current slot. Answer/expiry race uses the same slot CAS and durable transaction clock. SHADOW answers use synthetic receipts and SHADOW normalized answer content only, never real pending rows, Telegram receipts or canonical Journal mutations.

**Legacy coexistence/cutover.** LIVE acquisition also serializes against any legacy OPEN pending interaction (including the multi-step experiment flow) and legacy question send in flight. Before PHASE4 question cutover, deploy the compatibility guard to every legacy open/resolve/expire/send path; inability to enumerate/guard a path blocks cutover. Under the same tenant lock, import a legacy active interaction into the LIVE slot with origin LEGACY, legacy_pending_question_id/legacy_operation_id, and no invented Phase 4 question request. Confirmed legacy OPEN uses its existing expires_at, an in-flight send uses DELIVERY_STARTED, and ambiguous legacy transport uses the conservative AMBIGUOUS_WAIT window plus a lifetime LEGACY_BARRIER reservation. An unclassifiable legacy send defers cutover, never assumes FREE. The mode cannot finish cutover while that slot is occupied. Legacy resolves/expires by slot CAS; no legacy path may supersede a Phase 4 occupant. A user-started multi-step flow advances only after resolving its own step and acquiring the next under this guard. Post-cutover legacy proactive question sending is prohibited. These changes do not alter unrelated inbound Q&A replies, which cannot create a proactive question slot.

SHADOW slots are independent, may model these transitions without a provider/real attempt, and never block or mutate LIVE conversation state. LIVE slot allocation itself requires the Section 14 server-owned capability; before the release gate, cutover is tested only with synthetic in-memory authority and fake transport.

An answer can trigger invalidation and reanalysis. A useful follow-up requires a durable decision referencing the canonical answer_event_id/followup_kind; a later decision is not a new semantic identity. The inbound answer handler and reanalysis worker cannot send the follow-up directly.

### Atomic legacy-to-Phase-4 cutover

**tenant_delivery_modes** is keyed by user_id, execution_mode and message_family and has LEGACY, CUTOVER_PENDING, or PHASE4 mode. It is default LEGACY; LIVE cannot enter PHASE4 while the delivery flag/gate is off. SHADOW may simulate cutover only within its namespace, never owning a legacy sender or destination.

Cutover occurs at a deterministic boundary: the next local health-day boundary for MORNING_BRIEF_V1 and the next semantic transition after the recorded cutover instant for other families. One transaction:

1. locks the tenant/message-family mode and destination binding;
2. verifies lifecycle/auth generations;
3. checks legacy **report_claims**, **report_runs**, or **proactive_events** for the boundary semantic key;
4. creates explicit legacy-backed semantic barriers for already DELIVERED or AMBIGUOUS legacy semantics without reinterpreting those legacy rows as outbox rows;
5. defers cutover if any legacy claim/send is in flight or any unresolved ambiguous legacy state could overlap the new boundary;
6. records the boundary and changes mode to PHASE4;
7. commits before either scheduler path may create new work.

Both the legacy scheduler path and Phase 4 scheduler/dispatcher must read the authoritative mode in the same transaction that creates a legacy claim or Phase 4 reservation. Exactly one mode owns each tenant/message family. PHASE4 may revert to LEGACY only when no Phase 4 message for that family has reached DELIVERY_STARTED and no CONSUMED reservation exists; reversal uses compare-and-swap and a later deterministic boundary.

Legacy barrier construction uses a versioned deterministic mapper over legacy report type/local date or proactive idempotency/episode semantics. If a legacy row lacks enough typed identity to prove non-overlap, cutover defers rather than guessing.

Cutover is default-off. It is not a data migration that rewrites legacy rows.

### Existing V1.2 risk

The current [src/reportDelivery.js](../src/reportDelivery.js) **report_claims** reclaim/lifecycle interaction may permit a duplicate when Telegram accepted a send whose result became ambiguous and a later lifecycle transition makes work claimable again. This is a potential existing V1.2 production-hardening defect, not evidence that a duplicate occurred.

Before any Phase 4 delivery implementation or cutover, a narrow deterministic test must reproduce or falsify: provider acceptance, lost response, lifecycle transition, and reclaim. This ADR does not authorize a production fix, production access, or any Stage 2 work.

### No direct-send rule

Only the delivery dispatcher owns a Telegram send capability for Phase 4 outbound messages. Calculation, episode, evidence, insight, reanalysis, policy, Q&A read, and Morning Brief composition modules receive no Telegram client.

## 13. Q&A read boundary

### Scoped context service

All Phase 4 Q&A reads go through one **ScopedHealthContext** service. Its required input is:

- authenticated internal user ID derived from the inbound Telegram binding;
- server-owned execution_mode = LIVE for the product service (a separate non-publishing evaluator binds SHADOW); caller/model mode fields are rejected;
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

The current evidence shortcut in [src/bot/router.js](../src/bot/router.js) is evaluated before the general intent and perspective plan. Phase 4 must **replace that ordering** so intent and perspective authorization complete before **handleEvidence** or any successor performs specialized evidence access.

This is a semantic authorization and correctness gap. Current tenant lookup still scopes the handler to the authenticated caller, and this review has not established a cross-tenant disclosure path or confirmed privacy breach. Phase 4 nevertheless requires uniform, auditable perspective-first authorization.

### Read-currentness rules

The context service returns only:

- canonical rows current under tombstone and source-version rules;
- ACTIVE journal facts;
- non-invalidated LIVE Body Energy results at the exact requested as_of_epoch_ms and current input generation/version; any explicitly permitted checkpoint summary instead discloses its original exact time/freshness;
- current episodes;
- non-invalidated evidence items;
- promoted EMERGING or SUPPORTED insights under Section 8 by default;
- delivered-message history needed for novelty;
- explicit missingness and generation lag.

If requested derived data is behind the current input generation, the answer either computes a pure current result synchronously within a bounded budget or says analysis is updating. It never serves a stale insight as current.

All derived reads and their entire parent chains require the service's explicit mode and Section 14 currentness/purge rules. A SHADOW result cannot become a product answer after restart or a flag change. Canonical/shared assertions use their explicitly allowed source-root path, not a mixed-mode derived join.

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

### Ordinary isolation and Owner Monitoring

Ordinary Q&A has no administrator, family, or third-party bypass. User A resolves only user A; user B resolves only user B. Support/operations roles may inspect allowed operational metadata but cannot use Q&A or a generic tenant selector to browse health content.

The one approved cross-user path is **Owner Monitoring**. Kelvin is the system owner and may select enrolled users to follow. Enrollment plus Kelvin's explicit follow configuration is the product authorization; no separate per-user approval workflow is required. Every followed user still receives their own normal Telegram experience, and follow state never changes that user's identity, destination, preferences, lifecycle, or self-only Q&A scope.

Owner Monitoring v1 supports exactly these notification classes per followed user:

- `DAILY_SUMMARY`;
- `IMPORTANT_ALERT`;
- `WEEKLY_SUMMARY`.

The owner may enable or disable each class independently. V1 may consume only either (A) an approved, current synthesized artifact within the permitted notification class or (B) an approved deterministic summary plan whose declared inputs are explicitly inside that class's allowed data scope. If neither exists, **no owner message is produced**. There is no fallback to raw WHOOP rows, Journal browsing, arbitrary SQL/admin access, broad user-health joins, or open-ended owner Q&A over a subject.

“Important Alert” means a high-value Phase 4 longitudinal/event-driven alert under the approved policy. It is not an emergency, medical, continuous-monitoring, or exact-latency service and remains subject to the Section 10 cadence outside the morning window.

Owner authority is a server-issued capability bound to Kelvin's configured internal user ID and current authenticated destination/lifecycle. It cannot be inferred from the string “Kelvin,” a Telegram username, a role claimed in text, an environment value supplied to a model, or ordinary administrator access. A cross-user monitoring operation requires all of the following conjunctive predicates in one auditable authorization decision:

1. authenticated owner principal and current owner destination;
2. enrolled subject user and current subject lifecycle/privacy fences;
3. an active, revisioned follow subscription for that owner/subject/notification class;
4. an approved current synthesized artifact or deterministic summary plan within the class's data scope;
5. captured owner and subject generations, subscription revision, purpose, reason code, and exact as-of;
6. a dedicated owner-monitoring route whose store/API accepts both principals explicitly and rejects every ordinary-user caller.

Failure, absence, staleness, or mismatch of any applicable predicate fails closed before a cross-user read or owner-directed message is authorized. Destination ownership and audit provenance are authorization requirements, not after-the-fact logging. The deterministic summary-plan option does not authorize a broad query: its input types, subject, time range, notification class, and output claim schema are allowlisted and recorded before execution.

The subject-scoped reader first selects only an allowed approved synthesized artifact or executes an approved bounded deterministic summary plan under the subject's normal currentness and purge rules. It then creates a dual-principal authorization envelope. Only that envelope may hand an approved claim bundle to the owner-recipient outbox; generic joins and direct cross-tenant source references remain forbidden. The transport destination belongs to Kelvin, while the envelope retains the monitored subject identity for content attribution, purge traversal, and audit. Subject correction/deletion invalidates or redacts linked unsent owner content under the same privacy rules; already accepted Telegram copies retain the Section 15 external-copy limitation.

Durable audit state must answer, without plaintext log scraping:

- which enrolled user Kelvin followed at any point in time;
- which of the three notification classes were enabled and the subscription revision/effective interval;
- when and through which authenticated owner operation follow state changed;
- which subject produced each owner-directed summary/alert and which approved artifact/plan it used;
- which owner capability, subscription revision, purpose, and reason authorized the cross-user read and send;
- the owner destination, message/attempt outcome, and relevant owner/subject lifecycle, auth, input, and purge generations.

Revocation prevents new owner authorization envelopes immediately. It does not falsify immutable historical authorization/transport metadata, and it does not create a new right for ordinary users. No LLM selects the followed user, expands data scope, or authorizes an owner send.

### Significant decision

**Decision:** Create one mandatory scoped read boundary and move perspective authorization ahead of every specialized Q&A handler.

**Alternative rejected:** Depend on each handler to remember tenant filtering and perspective rules.

**Rationale:** Tenant SQL predicates prevent many leaks but do not express whether a self-health answer is semantically permitted for a general or third-party question.

**Compatibility impact:** Existing queries can be adapted behind the service. Inbound operation identity/idempotency remains, with Section 15 additive content redaction and no-op replay; receipt health payload is not immutable.

**Failure mode controlled:** A specialized evidence route cannot bypass perspective semantics or currentness policy; cross-tenant ownership checks remain independently mandatory.

**Owner Monitoring decision:** Add a dual-principal, subscription- and capability-gated path over approved synthesized outputs. Do not weaken tenant predicates or reuse ordinary Q&A/admin access. This supersedes earlier categorical “no family or administrator access” language only for Kelvin's explicit Owner Monitoring capability; all broader cross-user access remains prohibited.

## 14. Additive post-v20 schema and migration proposal

### Migration posture

The original V1.2 production baseline schema is version 20 in [src/schema.js](../src/schema.js). The isolated Phase 4 branch implements additive v21–v24 Foundation migrations; future locked-scope work begins at v25. No Phase 4 migration may rebuild, drop, rename, or reinterpret a populated v20 table.

[src/migrations.js](../src/migrations.js) does not wrap the entire migration sequence in one global transaction. A process can therefore stop after DDL or backfill work but before the schema-version row is written. Every Phase 4 migration step must be safe to rerun after any prior statement succeeded.

The completeness invariant applies to **every** Phase 4 schema version, including v25 and later: its version row must not be recorded until every table/object, additive column, index, trigger, backfill, validation, and postcondition assigned to that version is complete. Stage/version ownership is fixed below so a later stage never depends on a partially installed earlier or same-numbered version.

### Cross-cutting entity contract

**input_generation** is the Phase 4 computation generation within (user_id, execution_mode), owned by phase4_computation_state. Shared source mutation advances phase4_user_state.source_generation once and increments each existing mode's input_generation once in the same transaction; mode-specific algorithm changes increment only that mode. No SHADOW completion can advance LIVE currentness. Any artifact derived from WHOOP data also stores the current authorization generation; anything used for a user-visible action stores lifecycle generation. Currentness compares all applicable generations, not timestamps alone.

### Durable execution-mode contract

**M** means execution_mode TEXT NOT NULL DEFAULT 'SHADOW' CHECK (execution_mode IN ('SHADOW','LIVE')). Every table in the mode/key matrix below receives M in its listed version. Mode is a typed immutable column, never a JSON tag. Store APIs require an explicit server-owned execution context: missing/unknown mode rejects health access/publication, even though omitted SQL inserts default safely to SHADOW. Null/unknown stored mode or mixed-mode parent chains are corrupt/non-publishable. Schema CHECKs reject invalid values; a BEFORE UPDATE trigger rejects any execution_mode change (including LIVE to SHADOW). Live delivery attempts additionally CHECK (execution_mode = 'LIVE'), so default/omitted mode cannot create an attempt.

The LIVE write factory requires a non-serializable server-owned capability issued only after all four Section 17 gate conditions and the named operation authorization are verified. Request bodies, user messages, LLM output and an environment flag cannot issue it. Pre-gate processes have no LIVE factory/provider capability. Local tests inject a separate synthetic factory bound to an in-memory fixture and fake transport; it cannot open a real database or destination. Privacy/control adapters may redact/invalidate already existing LIVE rows without publication capability, but cannot insert LIVE computation/output, advance completion or send. Fresh LIVE computation state and outputs are created only by the authorized LIVE factory, not by backfilling SHADOW data.

**Exact mode/key expansion.** The following matrix is normative wherever shorter table descriptions below say “user plus ID” or omit mode. All listed primary/unique indexes include execution_mode exactly as shown; ordinary secondary health indexes start (user_id, execution_mode). Parent lookup, update/delete/CAS predicates, leases, current pointers, caches, source-change lookup digests and computation-run identities repeat that same pair. No ID-only or user-only fallback is allowed.

All new primary-key components are explicitly NOT NULL, including composite TEXT IDs (do not rely on SQLite's implicit primary-key nullability). Nullable health-bearing unique-key components are required while PRESENT and cleared only under the specified purge contract; their keyed lookup barriers remain unique afterward.

| Version / table(s) receiving M | Exact primary/identity key | Mode-qualified unique/current key in addition to primary key |
|---|---|---|
| v21 phase4_computation_state | (user_id, execution_mode) | None; each mode has its own input/last_completed generation |
| v22 context_questions (including bounded candidate-set diagnostics) | (user_id, execution_mode, question_request_id) | (user_id, execution_mode, request_lookup_key); typed episode/factor/window/ordinal tuple from Section 12 while PRESENT; (user_id, execution_mode, question_cycle_source_key) when non-null; (user_id, execution_mode, selected_decision_id) when non-null |
| v22 structured_answer_events | (user_id, execution_mode, answer_event_id) | (user_id, execution_mode, logical_answer_id, answer_revision); (user_id, execution_mode, source_update_id) |
| v22 pending_questions additive extension | Existing id PK unchanged; validated owner/mode lookup (user_id, execution_mode, id) | Unique (user_id, execution_mode, context_question_id) WHERE context_question_id IS NOT NULL; only LIVE may hold a Phase 4 Telegram projection |
| v23 body_energy_results | (user_id, execution_mode, result_id) | Exact tuple and result_lookup_key described below |
| v23 body_energy_checkpoints | (user_id, execution_mode, checkpoint_id) | Partial checkpoint uniqueness from Section 3; (user_id, execution_mode, checkpoint_lookup_key) |
| v23 evidence_runs | (user_id, execution_mode, run_id) | (user_id, execution_mode, deterministic_run_key) |
| v23 evidence_items | (user_id, execution_mode, evidence_item_id) | (user_id, execution_mode, run_id, item_key) |
| v23 observation_episodes | (user_id, execution_mode, episode_id) | Separate unique indexes on (user_id, execution_mode, episode_family_key) and (user_id, execution_mode, fingerprint), each WHERE state IN ('OPEN','UPDATING','ESCALATED','EXPLAINED','STABILIZING') |
| v23 episode_observations | (user_id, execution_mode, episode_id, observation_key) | None |
| v23 episode_evidence | (user_id, execution_mode, episode_id, evidence_item_id) | None |
| v23 episode_events | (user_id, execution_mode, episode_event_id) | (user_id, execution_mode, deterministic_event_key) |
| v23 episode_semantic_events | (user_id, execution_mode, episode_semantic_event_id) | (user_id, execution_mode, episode_id, resulting_revision) |
| v23 health_insights additive extension | Existing id PK unchanged; validated (user_id, execution_mode, id) | (user_id, execution_mode, insight_key) WHERE insight_key IS NOT NULL AND status <> 'RETIRED' AND legacy_classification = 'PHASE4'; current_revision points only to same-mode revision |
| v23 insight_revisions | (user_id, execution_mode, insight_id, revision) | None |
| v24 phase4_invalidations | (user_id, execution_mode) | None |
| v24 phase4_jobs | (user_id, execution_mode, job_kind) | None; mode belongs to complete lease identity |
| v24 phase4_proactive_decisions | (user_id, execution_mode, decision_id) | (user_id, execution_mode, deterministic_decision_key) |
| v24 tenant_delivery_modes | (user_id, execution_mode, message_family) | None; SHADOW cutover has no legacy authority |
| v24 outbound_semantic_reservations | (user_id, execution_mode, reservation_id) | (user_id, execution_mode, message_family, semantic_key) |
| v24 phase4_question_interaction_slots | (user_id, execution_mode) | None; one occupied request maximum per tenant/mode |
| v24 outbound_messages (SHADOW proposals and LIVE outbox) | (user_id, execution_mode, message_id) | (user_id, execution_mode, idempotency_key); (user_id, execution_mode, reservation_id) |
| v24 outbound_delivery_attempts | (user_id, execution_mode, attempt_id) | (user_id, execution_mode, message_id, attempt_number); LIVE-only CHECK |

No separate question-candidate table or calculation-run table is implicit: candidate snapshots are context_questions/phase4_proactive_decisions content, calculation runs are body_energy_results/evidence_runs plus phase4_jobs. They inherit the container's mode. A SHADOW proposal is never eligible for dispatcher selection, attempt insertion or a real pending_questions projection. Simulated transport outcomes remain in the SHADOW proposal/slot with simulation-only reason codes; they do not create outbound_delivery_attempts.

**Mode-neutral roots and privacy graph.** users/lifecycle/destination identity, notification preferences, canonical WHOOP sources/tombstones, real Journal revisions/coverage/tombstones, independently authored experiment fields, inbound telegram_operations receipts, and the tenant privacy ledger/fence are shared authorities, not mode-owned derived outputs. SHADOW may read eligible source projections but may not mutate these real roots/preferences/receipts or legacy analytics. Synthetic shadow answers stay in SHADOW structured_answer_events.normalized_answer_json, with logical_fact_id/fact_revision/coverage_window_id null; no real source is fabricated. LIVE accepted answers atomically write their shared authenticated assertion and same-mode answer event. Source-root references require tenant validation plus the allowlisted root type, not a fabricated root mode. Legacy copied/derived records remain unverified and cannot become LIVE evidence merely because mode was backfilled.

phase4_source_links adds artifact_execution_mode and source_execution_mode, each NOT NULL CHECK in ('SHADOW','LIVE','SHARED'); its composite PK is (user_id, artifact_execution_mode, artifact_type, artifact_id, source_execution_mode, source_type, source_id, relationship). SHARED denotes only the enumerated roots or legacy privacy targets, not permission to consume legacy derived artifacts as Phase 4 parents. PHASE4-to-PHASE4 references require equal mode; a SHADOW child cannot cite a LIVE parent or vice versa. Privacy traversal intentionally follows an authenticated source into **both** modes in one T1; source deletion is not a simulation. privacy_artifact_id includes execution_mode for mode-owned rows; purge targets store that opaque ID and artifact_execution_mode, with both in their PK. This permits cross-mode purge without cross-mode health reads.

**Reader precedence and restart.** Morning Brief, production Q&A and dispatcher queries explicitly require LIVE and a completely LIVE derived ancestry, current mode generations, R/source/purge fences and release capability where applicable. Shadow evaluators explicitly require SHADOW; no “latest regardless of mode,” fallback, or promotion UPDATE exists. Mode-qualified cache keys, job claims and leases survive restart; LIVE claims cannot select SHADOW pending work. Recalculation after an algorithm change writes a new version/generation in the selected mode and changes only its pointers. A fresh LIVE run after authorization recomputes from current roots, not copied SHADOW results, decisions, reservations, slots or current pointers. Purge invalidates both modes and fences every reader, including caches, until completion.

The non-health envelope is immutable except defined state transitions; redaction/purge is the sole exception to append-only health content. “Immutable” never prohibits mandatory purge. This ADR chooses **in-place nullable/redactable content** for every retained health-bearing entity, with exact physical-deletion exceptions in the expansion table; there is no deferred content-table choice. Journal deletion physically removes fact revisions after writing its minimal tombstone. Legacy NOT NULL content uses the sentinel map below; no table rebuild or nullability alteration is needed.

**Redaction column set R** means these exact additive columns on every table named in the expansion table below (not an implementation option):

- content_state TEXT NOT NULL DEFAULT LEGACY_UNLINKED: PRESENT, LEGACY_UNLINKED, PURGE_PENDING, or REDACTED; new rows explicitly PRESENT, legacy backfill LEGACY_UNLINKED until linkage is verified;
- health_content_redacted_at TEXT NULL;
- health_content_redaction_reason TEXT NULL: SOURCE_CORRECTED, SOURCE_DELETED, RETENTION_EXPIRED, UNATTRIBUTED_LEGACY, or INCIDENT_COPY;
- source_subject_deleted_at TEXT NULL, set for deletion, not correction;
- purge_generation INTEGER NOT NULL DEFAULT 0;
- source_linkage_state TEXT NOT NULL DEFAULT LEGACY_UNLINKED: COMPLETE, LEGACY_UNLINKED, or DISCONNECTED;
- content_digest_salt TEXT NULL: random per-artifact salt used in keyed content digests; erased with content.
- privacy_artifact_id TEXT NULL during additive backfill, required/unique per table and owner afterward: deterministic keyed opaque token of (table name, tenant/scope, original primary key); never retain a health-date or measurement timestamp as an audit “opaque ID.”

REDACTED requires health_content_redacted_at, health_content_redaction_reason and the triggering purge_generation, and prohibits every listed health field except a fixed non-health sentinel. PURGE_PENDING/LEGACY_UNLINKED cannot be health-read. COMPLETE requires phase4_source_links for all dependencies; DISCONNECTED follows purge and unlinking. Markers themselves contain no health narrative.

**Exact R expansion and content architecture by version**

| Version | Tables receiving every R column | Purge mechanism |
|---|---|---|
| v21 | None: phase4_user_state, phase4_computation_state, user_notification_preferences, phase4_migration_checkpoints contain operational metadata only | Tenant purge counter/fence below; no health content |
| v22 existing | journal_events, pending_questions, telegram_operations, proactive_events, health_insights | In-place R/sentinels; journal all revisions physically removed on deletion |
| v22 legacy inventory extensions | whoop_capabilities, healthspan_metrics, healthspan_snapshots, prediction_runs, prediction_models, analytics_daily_state, analytics_invalidation, analytics_work_state, analytics_runs, report_runs, report_claims, briefing_evaluations, whoop_sync_state, whoop_webhook_events, whoop_reconciliation_state, whoop_reconciliation_runs, user_onboarding, ai_usage, system_heartbeats, proactive_agent_state | R plus in-place redaction except physical deletion for healthspan_metrics, healthspan_snapshots, prediction_runs, prediction_models, analytics_daily_state (D in Section 15); scopes use the exact SCOPE extension below; no worker activation or transport-state reset |
| v22 new | journal_coverage_windows, context_questions, structured_answer_events, health_purge_replacements, experiment_field_groups | In-place nullable content plus R; experiments uses per-column-leaf R within named groups, not a row-wide marker; replacement staging deleted after content transaction; durable question/answer identities survive |
| v23 new | body_energy_results, body_energy_checkpoints, evidence_runs, evidence_items, observation_episodes, episode_observations, episode_evidence, episode_events, episode_semantic_events, insight_revisions | In-place nullable content plus R |
| v24 new | phase4_invalidations, phase4_jobs, phase4_proactive_decisions, outbound_messages, outbound_delivery_attempts | In-place nullable content plus R; attempt health content prohibited, markers support incident redaction |

The v23 health_insights additions extend its R columns already installed in v22, not a duplicate add. phase4_source_links, health_plaintext_purges, health_purge_targets, journal_event_tombstones, tenant_delivery_modes, phase4_question_interaction_slots, and outbound_semantic_reservations contain no health content and do not receive R. Slot answer-deadline/transport timestamps are interaction timing, never a physiological target window. Canonical whoop_sleeps/recoveries/cycles/workouts/body_measurements remain v20 source tables; source deletion physically removes canonical payload under authoritative tombstone policy rather than fabricating redacted physiological rows.

**Envelope/content classification (normative for column lists below).** Only opaque IDs and references after unlinking, keyed non-reconstructable hashes, algorithm/method versions, CAS/input/lifecycle/auth/purge generations, creation/transport timestamps, finite transport/audit state/reason codes, and semantic reservation identities belong to retained envelopes. All normalized values, health dates/windows/subject/direction labels, factor sets, severity/novelty/confidence, statistics (including p/q, effects, intervals, counts and UNKNOWN fractions), quality/confound details, claim/explanation text, utility components/branch signatures, JSON manifests/context, payloads and free-text errors are purgeable. Exact health-window keys needed for question dedup are retained only as keyed opaque lookup digests after redaction; their typed timestamps/factor kind become null. Generic creation times may remain; physiological observation times may not.

Content/input/claim hashes are HMAC-SHA-256 with an application-held audit key plus per-artifact random content_digest_salt, not unsalted hashes of enumerable health values. Purge destroys the salt and every health preimage. Dedup lookup keys use a separate server-held key over the complete identity tuple and may be retained solely as opaque replay barriers; no health-value enumeration API exists. Legacy health-derived fingerprints are scrubbed or converted to keyed lookup digests before being eligible for retention. No hashes are a recovery mechanism.

Allocate/reuse the artifact's hash context only after its deterministic identity is resolved; retries/uniqueness conflicts read the winner's existing salt. Pure calculators receive this explicit context only for persistence hashing, never as a numeric input. Stored-fixture replay uses the same context and is byte-identical; independently allocated artifacts can have different audit digests for identical health values. Decision/run lookup and source_change_key use stable keyed identity digests of captured source IDs/versions/input generation, not a fresh output artifact's salted digest. Key rotation must retain lookup compatibility and cannot mint new semantic events/reservations.

| Entity family | Tenant owner/key | Required fences | Mutable versus immutable | Time, version, quality | Retention/deletion |
|---|---|---|---|---|---|
| User state/preferences | user_id in primary key | lifecycle checked on use | Preferences mutable with version; generations monotonic | updated_at and preference version | While account exists |
| Journal facts | user_id in every fact/revision key | lifecycle on write; input generation advanced | Revision content append-only except purge; current status transactional | event time, health date, timezone, parser/normalizer version, confidence | Section 15; deletion removes health rows |
| Context questions/answer events | user_id plus request/event ID | lifecycle and input generation | Envelope stable; content purgeable; status transitions CAS | expiry, policy/template version, scores | Content 400 days; semantic identity tenant lifetime |
| Body Energy | user_id plus result_id | lifecycle, auth, input generation | Envelope stable; result/manifest append-only except purge | as-of, health date, versions, quality/provenance | 400 days subject to references and purge |
| Evidence | user_id on run and item keys | lifecycle, auth, input generation | Envelope stable; completed statistics append-only except purge | window, as-of, versions, quality/provenance | 400 days subject to current insights and purge |
| Episodes | user_id plus episode ID | lifecycle, auth, input generation | Current state CAS; revision/event content append-only except purge | observation times, health range, registry version, confidence | Content 400 days after terminal; semantic IDs tenant lifetime |
| Insights | user_id plus insight ID/key | lifecycle, auth, input generation | Current pointer CAS; revision content append-only except purge | expiry, evidence versions, support | 400 days after retirement or earlier purge |
| Invalidation/jobs | user_id plus job kind | claim captures lifecycle/auth/requested generation | Coalesced mutable queue state with immutable generation ordering | lease and retry timestamps, job version | Error detail 30 days; current queue row while account exists |
| Decisions | user_id plus decision ID | lifecycle, auth, input generation | Envelope stable except invalidation/expiry; content append-only except purge | episode revision, policy/evidence/template versions, gate results | 400 days or earlier purge |
| Reservations/messages/attempts | user_id in every identity | delivery mode plus lifecycle/auth/input/purge at proposal and pre-send | Reservation/state CAS; payload frozen except mandatory purge | expiry, versions, provider timestamps | Plaintext 90 days; detailed metadata 400 days; reservation/semantic identity tenant lifetime |

All derived cache keys repeat user_id, execution_mode, artifact ID or semantic key, version, and applicable generations. Shared-root projections also include the consuming mode. An artifact ID alone is never a cache key.

### Existing storage mapping

| Existing storage or symbol | Phase 4 treatment | Reason |
|---|---|---|
| **users**, **user_telegram**, lifecycle generation | REUSE | Authoritative tenant, lifecycle, timezone, and destination binding |
| **transitionUserLifecycle** | REUSE | Sole lifecycle transition path and READY demotion behavior |
| **user_onboarding**, capability/access tables | REUSE | ACTIVE plus READY authorization gate |
| Canonical **whoop_*** tables and tombstones | REUSE | Authoritative source data and freshness protection |
| **processing.transaction** | REUSE | Atomic source mutation plus invalidation |
| **journal_events** | EXTEND | Preserve current normalized facts while adding revisions and source idempotency |
| **pending_questions** | EXTEND narrowly | Conversation state plus R/sentinel/source linkage, not analytical provenance |
| **health_insights** | EXTEND | Preserve status compatibility while adding insight key, evidence version, current revision, expiry, and disposition |
| **report_claims**, **report_runs** | LEGACY READ-ONLY AT CUTOVER | V1.2 delivery history and barriers only; never Phase 4 outbox rows |
| **telegram_processed_updates**, **telegram_operations** | REUSE receipt identity; EXTEND operations | Completed action receipt survives content purge; owner_user_id is explicit |
| **ai_usage** | REUSE | LLM usage audit without storing unrestricted prompt content |
| **analytics_invalidation**, **analytics_work_state** | EXTEND only for privacy-safe scope redaction | Preserve Phase 3 queue generations, add full-tenant scope marker; never use as Phase 4 jobs or activate their worker |
| **experiments** | EXTEND with field-group sidecar | Keep independent authored assertions while redacting linked or unproven derived groups |
| **proactive_events** | DO NOT OVERLOAD | It combines legacy decision and send behavior and lacks the new delivery state machine |
| **briefing_evaluations** | DO NOT OVERLOAD | It is not an episode, evidence, or decision ledger |
| **pending_questions.context_json** | DO NOT OVERLOAD | Lifecycle invariants require typed indexed columns |
| **report_claims** | DO NOT OVERLOAD for any Phase 4 message | Lifecycle ambiguity and cross-path ownership require the typed outbox |
| WHOOP webhook ledger | DO NOT OVERLOAD | Provider event ingestion is not a derived-work queue |

### Version-by-version compatibility

Schema versions advance independently; v21 through v24 are not one atomic installation.

| Version | Version row advances only after | Stores available | Phase 4 behavior allowed | Flags that remain off |
|---|---|---|---|---|
| v21 | Complete tenant state, mode-qualified computation state, preferences, migration checkpoints, indexes, backfills, CHECKs/triggers and postconditions | Disabled metadata persistence | Migration/contract fixtures only | All Phase 4 flags |
| v22 | Complete Journal/coverage/tombstone/source-link/purge/question/answer objects; M/R extensions; legacy SCOPE and experiment field groups; owner/backfill/sentinel/replay postconditions | Disabled structured context and privacy persistence | Migration/contract fixtures only; no T0 admission, dual-write or correction/deletion runtime | All Phase 4 flags |
| v23 | Complete Body Energy/results/checkpoints, evidence, episodes/memberships/events/semantic events, insight revisions/current pointers; M/R and legacy classification postconditions | Disabled calculation/intelligence persistence | Migration/contract fixtures only; no partial “Body-only v23” | All Phase 4 flags |
| v24 | Complete invalidations/jobs/SCOPE, decisions, modes, reservations, interaction slots, outbox and LIVE-only attempts; every M/R/key/index/trigger postcondition | Complete disabled Phase 4 persistence | Only subsequent authorized Foundation internal commits may implement stores/calculation/Journal using all v21–v24 objects; flags remain off | All Phase 4 flags; no dispatcher/provider wiring in Foundation |

For each version, partial DDL/backfill leaves the prior schema-version row unchanged and all features requiring the incomplete version off. Rerun introspects and resumes. A Phase 4 writer/worker binary requires its exact declared **EXPECTED_SCHEMA_VERSION**; behind or ahead makes Phase 4 startup fail closed. The dedicated migration command may run from an earlier supported version. A defect after version advancement is repaired by a new reviewed forward-fix version, never by editing the meaning of an applied version.

The runner advances one version at a time: it records v21 only after v21 postconditions, then v22, v23, and v24 in order. It never records v24 as a shortcut for partially or fully applied earlier DDL.

Complete disabled v21–v24 persistence precedes any Foundation privacy T0/T1 wiring, stores, Body Energy or Journal revision runtime. T1 requires v24 full-tenant invalidations, jobs, slot/outbox fencing and therefore must not run with v22/v23 alone. Missing any required postcondition rejects purge admission before T0. Version advancement is not feature activation. Section 19 fixes the eight internal commit boundaries; this repair authorizes none of them.

### V21: tenant state and preferences

**phase4_user_state**

- primary key: user_id;
- source_generation INTEGER NOT NULL DEFAULT 0, tenant-wide monotonic source mutation counter (not completion);
- purge_generation INTEGER NOT NULL DEFAULT 0, incremented at durable purge admission;
- pending_purge_count INTEGER NOT NULL DEFAULT 0; authoritative read/write/send fence while positive;
- created_at and updated_at;
- invariant: generations/counters are nonnegative; no shared last_completed_generation exists.

**phase4_computation_state**

- M; primary key (user_id, execution_mode);
- input_generation INTEGER NOT NULL DEFAULT 0, last_completed_generation INTEGER NOT NULL DEFAULT 0;
- source_generation_seen INTEGER NOT NULL DEFAULT 0; algorithm_set_version TEXT NOT NULL; revision INTEGER NOT NULL DEFAULT 0; created_at, updated_at;
- CHECK last_completed_generation <= input_generation, all generations nonnegative; completion requires captured source_generation_seen = current tenant source_generation and a same-mode generation/lease CAS;
- deterministic migration backfill creates SHADOW state only; the authorized LIVE factory later inserts fresh LIVE state at input_generation 1, last_completed_generation 0 and current source_generation_seen, then queues a LIVE FULL_TENANT_RECOMPUTE. No copying SHADOW completion/pointers;
- shared source changes fan out to existing mode rows; mode-only algorithm changes increment only their own input_generation. Purge increments existing mode generations and invalidations without minting unauthorized LIVE rows.

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

**phase4_migration_checkpoints**

- primary key: target_version plus step_key;
- last deterministic tenant/key cursor, postcondition state, and updated_at;
- contains no health values;
- used only for restart-safe bounded backfills and removed or retained as non-health audit after completion.

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
- exposure_state;
- coverage_window_id;
- invalidated_at;
- invalidation_reason.

Also add every R column. Existing required event_at, health_date, category and source use Section 15 sentinels for redacted superseded rows; deletion physically removes them, so no deleted logical fact leaves even a sentinel health row.

Backfill legacy rows with:

- logical_fact_id = deterministic namespace plus existing tenant and event ID;
- revision = 1;
- fact_status = ACTIVE;
- normalizer_version = legacy-v20;
- exposure_state = EXPOSED only for a recognized affirmative legacy fact; otherwise null, which reads as UNKNOWN;
- no legacy row is backfilled as CONFIRMED_UNEXPOSED and no coverage window is invented;
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

**journal_coverage_windows**

- primary key: user_id plus coverage_window_id;
- exact UTC start/end, health-date start/end, recorded timezone;
- factor_set_version and bounded factor-key set;
- source event key and confirmation text hash;
- parser, normalizer, lifecycle, authorization, and input versions;
- ACTIVE, SUPERSEDED, or DELETED status plus revision/CAS;
- no inference from an absent fact.
- every R column; start/end/dates/timezone, factor set, source text and answer confidence are nullable purgeable content.

**phase4_source_links**

- primary key: user_id, artifact_execution_mode, artifact_type, artifact_id, source_execution_mode, source_type, source_id, relationship;
- every health-bearing derived artifact links to its journal fact, coverage window, canonical row, or earlier artifact;
- linked_at, unlinked_at, purge_id; purge clears reconstructive relationships after complete traversal, leaving only opaque artifact/purge linkage;
- source_type = TENANT_LEGACY with source_id = user_id is the explicit conservative dependency for attributable legacy copies whose exact inputs cannot be established;
- index by user/source type/source ID for purge traversal;
- no health plaintext.

artifact_id is privacy_artifact_id for R-bearing rows. A canonical UUID is already opaque; timestamp/date-keyed source identities (notably body measurements) use a deterministic keyed token of their full tenant/table/primary-key tuple, never the raw time. Canonical adapters compute the token on read/delete without adding a v20 column. Purge deletes traversed edge rows after recording opaque affected identities in health_purge_targets and completing redaction. Do not null a composite primary-key field or leave a reconstructive relationship disguised as a tombstone. Ordinary non-purge supersession can use unlinked_at.

**health_plaintext_purges**

- primary key: user_id plus purge_id;
- unique user_id/purge_generation;
- unique user_id/deletion_or_correction_idempotency_key;
- target source type/ID, purge_generation, requested_source_generation (the shared tenant counter; per-mode queue generations are recorded by their own rows);
- state: ADMITTED, DB_REDACTED, CACHE_CONFIRMED, COMPLETE; no failed state releases the fence;
- admitted_at, db_redacted_at, cache_confirmed_at, completed_at, updated_at, attempt, last_error_code;
- operation_kind CORRECTION, DELETION, RETENTION, or INCIDENT; source_update_id and replacement_receipt_id (opaque only, never replacement text);
- no deleted health plaintext.

**health_purge_targets**

- primary key: user_id, purge_id, artifact_execution_mode, artifact_type, artifact_id;
- artifact_execution_mode TEXT NOT NULL CHECK in ('SHADOW','LIVE','SHARED'), matching the validated target's privacy-graph namespace;
- state PENDING, REDACTED, or REMOVED; completed_at;
- opaque table/record identity only, no values, health windows or source explanations;
- inserted/completed in T1 before graph edges are deleted; provides the audit marker for physically removed rows and prevents losing deletion coverage.

**health_purge_replacements**

- primary key: user_id plus purge_id; used only for an accepted correction awaiting its content transaction;
- replacement_kind TEXT NOT NULL CHECK in ('JOURNAL_FACT','JOURNAL_COVERAGE','EXPERIMENT_FIELDS'); normalized_replacement_json (nullable bounded validated new fact/coverage or experiment column patch, never old content), replacement_source_key, parser_version, normalizer_version, created_at, expires_at;
- EXPERIMENT_FIELDS carries the tenant-owned experiment ID, exact group/field names, expected current field revisions, new values and server-bound provenance for changed columns only. T1 uses the field-leaf CAS/replacement rule below; a synthetic analysis replacement stages only its newly computed result, never old result_json. Missing new source validity on retry rejects completion and keeps the fence; no LLM rerun;
- every R column; expires_at is admission plus 30 days, normally deleted synchronously in the next transaction;
- source links refer to the new user assertion/source update, not the old corrected revision; only the purge worker may read it behind a pending fence;
- a deletion of the logical subject also removes any staged replacement, so a racing correction cannot resurrect it;
- expiry destroys the staged content, records REPLACEMENT_EXPIRED and keeps the purge admission/fence until authenticated resubmission or explicit conversion to deletion; never claim a corrected fact committed when it did not.

**context_questions**

- M; primary key: user_id, execution_mode, question_request_id; question_id in API prose is an alias for this ID, not another identity;
- nullable selected_decision_id, unique when non-null;
- factor_question_kind, target_window_start_utc, target_window_end_utc, question_cycle_ordinal, question_cycle_source_key;
- request_lookup_key: keyed tuple digest; unique user_id/request_lookup_key, plus typed tuple uniqueness while PRESENT; unique user_id/question_cycle_source_key when non-null;
- episode ID and revision;
- selected candidate key;
- deterministic candidate-set hash;
- question template and policy versions;
- question_utility_version and typed U, D, R, A, T, K, P, F components;
- utility score, eligibility threshold, counterfactual branch hash;
- counterfactual_evaluator_version; branch_signatures_json with YES/NO/UNKNOWN signatures;
- sensitivity and fatigue class;
- outbound message ID;
- pending-question ID;
- status TEXT NOT NULL mirrors the last slot state for this request, with CHECK in ('RESERVED','DELIVERY_STARTED','AMBIGUOUS_WAIT','AWAITING_ANSWER','RESOLVED','EXPIRED','CANCELLED_PRE_SEND'); expires_at TEXT NOT NULL, answered_at TEXT NULL;
- expires_at starts at reserved_at + 30 minutes and thereafter mirrors that request's slot answer_deadline; update request/slot/pending projections in the same transition transaction. Terminal request status persists even when the slot acquires another request; answered_at equals resolved_at only for an accepted answer;
- answer logical_fact_id;
- lifecycle generation;
- authorization and input generations;
- created_at and updated_at.
- every R column; selected candidate, diagnostics, utility components, branch signatures and target context fields are nullable health content.

Full candidate diagnostics are bounded, purgeable JSON; status, selected key, queried scores and relationship IDs remain typed. All content is append-only after selection except purge.

**structured_answer_events**

- M; primary key: user_id, execution_mode, answer_event_id;
- logical_answer_id, answer_revision; unique user_id/logical_answer_id/answer_revision;
- question_request_id, logical_fact_id, fact_revision, coverage_window_id;
- unique user_id/source_update_id for accepted revision receipt;
- normalized_answer_json, answer_semantics_hash, selected_followup_kind (null, INTERPRETATION_UPDATE, OBSERVATION_PLAN);
- supersedes_answer_event_id, input/lifecycle/auth generations, committed_at;
- every R column; normalized answers and reconstructive source links purge; opaque answer-event identity, selected kind, receipt and revision barrier remain.

**Exact v22 legacy extensions**

- pending_questions: every R column plus M, context_question_id, source_logical_fact_id, input_generation, slot_revision INTEGER NULL. Apply redaction to question, context_json, original_message, answer_text, and intent, not only answer fields. Existing v20 rows have null context_question_id and retain legacy identity; default SHADOW does not reclassify them as simulated or publishable Phase 4 records. Legacy guard uses their explicit origin/legacy ID, not inferred mode. Its legacy_pending_question_id reference is a transport coexistence barrier, never a Phase 4 derived parent or a LIVE health projection of that default-SHADOW row. Only an authorized new LIVE projection may set a non-null context_question_id, and the matching LIVE slot must authorize it. SHADOW projections never use this real conversation table.
- telegram_operations: every R column plus owner_user_id TEXT NULL, operation_state TEXT NOT NULL DEFAULT COMMITTED, source_update_key TEXT NULL; unique owner_user_id/source_update_key when non-null, index owner_user_id/content_state/update_id. Keep existing update_id primary key and result_json NOT NULL.
- proactive_events: every R column; keep delivery/idempotency state while purging signals_json, reason_json, message_text and other health fields listed in Section 15.
- health_insights: every R column now, preserving statement NOT NULL; v23 adds lifecycle fields below.
- Every table in the v22 legacy inventory expansion row receives every R column. No “implementation decides” marker or external side-table choice remains.

For system_heartbeats (key scope/component) and null-owner diagnostic rows in ai_usage/whoop_webhook_events, no new internal tenant is inferred. Only verified attributable rows receive source links; unowned free-text detail is nulled in privacy backfill and future writes permit non-health enum codes only. Their operational index is content_state/purge_generation plus their existing key, not a nonexistent user_id column on system_heartbeats. proactive_agent_state receives R so its health-date/fingerprint copies are explicitly purgeable without toggling enabled or lifecycle state.

### Privacy-safe persisted work scope (v22 legacy; v24 Phase 4)

**Chosen strategy: additive in-place scope redaction.** V20 analytics_invalidation.affected_from/affected_to and analytics_work_state.range_from/range_to are already nullable TEXT in [schema.js](../src/schema.js); no rebuild or replacement table is needed. These are physiological health-date ranges, not harmless scheduling timestamps. [analyticsWorkStore.js](../src/analyticsWorkStore.js) merges them, clears them on settlement and exposes them through freshness; [analyticsWorker.js](../src/analyticsWorker.js) falls back to an anchor when a range is null. Those existing interpretations are insufficient after privacy redaction and must be guarded before privacy activation, without invoking the worker.

**SCOPE** adds these exact columns to each of the four tables below: scope_kind TEXT NOT NULL DEFAULT 'FULL_TENANT_RECOMPUTE' CHECK in ('NONE','HEALTH_DATE_RANGE','FULL_TENANT_RECOMPUTE'); scope_revision INTEGER NOT NULL DEFAULT 0; health_scope_redacted_at TEXT NULL; health_scope_redaction_reason TEXT NULL CHECK in ('SOURCE_CORRECTED','SOURCE_DELETED','RETENTION_EXPIRED','UNATTRIBUTED_LEGACY','INCIDENT_COPY') when non-null; full_scan_cursor TEXT NULL (opaque source-row identity only, never a date/timestamp or encoded range). purge_generation comes from R, not a second column. V22 analytics_work_state additionally receives claimed_scope_revision INTEGER NULL and claimed_purge_generation INTEGER NULL, matching the v24 job claim fields. Full-tenant scope carries no subject/factor/resource-derived scope text; finite reason codes alone may remain. Source linkage uses each row's R.privacy_artifact_id and phase4_source_links; unknown legacy ranges link TENANT_LEGACY. Purge unlinks after recording targets/redaction, as for other content.

| Version/table | Existing/new date fields to clear | Requested/completed generation authority |
|---|---|---|
| v22 analytics_invalidation | existing affected_from, affected_to; clear resources/reasons if health-bearing, replace diagnostic reason with finite HEALTH_SCOPE_REDACTED | existing generation is requested; completion belongs to each work class |
| v22 analytics_work_state | existing range_from, range_to; summary_json = {}, last_error_detail = null; range_generation = null | requested from analytics_invalidation.generation; existing done_generation is completed |
| v24 phase4_invalidations | nullable affected_from, affected_to, subject_key | requested_generation = same-mode input_generation |
| v24 phase4_jobs | nullable affected_from, affected_to, subject_key, health-bearing error detail | requested_generation and completed_generation; completed never changes merely because scope is purged |

For HEALTH_DATE_RANGE, both mapped date fields are non-null with from <= to, content_state = PRESENT and complete provenance. NONE and FULL_TENANT_RECOMPUTE require both null; FULL also requires subject_key null where present. On new tables enforce these with CHECKs; on legacy tables use additive insert/update validation triggers plus store checks (no table reshape). Backfill valid attributable existing ranges as HEALTH_DATE_RANGE with complete or conservative legacy links; otherwise FULL_TENANT_RECOMPUTE. NONE may be backfilled only if all work classes demonstrably caught up and no range remains. An unproven range is nulled during backfill, marked UNATTRIBUTED_LEGACY and replaced with FULL, never treated as completed.

**T1 scope replacement.** After T0 durably fences the tenant, the same T1 that purges a linked source nulls every linked/coalesced date range (and unknown TENANT_LEGACY ranges) in all four tables and both Phase 4 modes, sets scope_kind = FULL_TENANT_RECOMPUTE, increments scope_revision, sets health_scope_redacted_at/reason/purge_generation and R redaction markers, and clears full_scan_cursor and any claimed owner/lease/generation. If the aggregate range contained other sources too, widening to FULL safely retains their work without retaining the deleted interval. Preserve existing legacy generation exactly; a separate real canonical mutation may advance it normally, but privacy redaction never lowers it, fabricates done_generation, or marks SUCCESS. Phase 4 requested generations take the new same-mode input_generation from the source mutation and never decrease; completed generations remain unchanged. Keep dirty_since/pending status and create missing class job envelopes where required, without claiming/running anything. Repeated T1 is idempotent under its purge ledger; no double generation increment.

**Reader/worker precedence (mandatory compatibility adapter):** (1) missing privacy/SCOPE schema or positive tenant pending_purge_count fails closed; (2) FULL_TENANT_RECOMPUTE means PENDING regardless of null date fields or requested == completed, and takes precedence over carried partial ranges, prior success summaries and freshness-by-generation; (3) HEALTH_DATE_RANGE may expose only current PRESENT/linked dates; (4) NONE is current only if all applicable completed generations caught up and normal fences pass. getAnalyticsInvalidation/getAnalyticsWorkState, getAnalyticsFreshness/getAnalyticsDailyState, pending/claim/settle/range mutators and the Phase 4 equivalents must implement this precedence. Health/Q&A readers expose no redacted range or old materialization; internal queue readers may see the non-health FULL marker/generations even when R is REDACTED. No fallback to anchorDate, empty range, “zero days processed,” or already_current can satisfy FULL.

Claim identity adds scope_revision and purge_generation; any old partial lease loses its CAS after scope replacement. A separately authorized future worker must enumerate **all retained current tenant sources** for FULL, recompute affected derived families from those sources, and invalidate unsupported outputs; it cannot consult the erased interval. Keep FULL throughout processing, storing at most an opaque source-row cursor; no old physiological range returns on restart. Only successful whole-pass completion with unchanged user/mode/requested generation/scope_revision/lifecycle/auth/purge fences may atomically set scope_kind = NONE, clear cursor, and advance the appropriate completed generation. New source mutation during a pass invalidates its completion and restarts the full scan. Phase 3 has no activation in this ADR: its FULL marker may remain pending indefinitely until a separate future authorization, and no Phase 4 adapter calls activatePhase3, drainAnalytics or processAnalyticsForUser. Phase 4's later authorized worker consumes its own FULL rows only.

Crash after T0 but before scope replacement leaves the entire tenant fenced; restart resumes the same T1. Crash after T1 sees only null ranges/FULL and unchanged completion, then resumes T2, not the dormant worker. Queue scope is the sole mutable-content reset exception: a later legitimate computation may write newly derived current scope under new provenance, never rehydrate an erased historical range or bypass a FULL pass.

### Field-scoped experiment provenance (v22)

The actual write paths are [experimentFlow.js](../src/bot/experimentFlow.js), [experiments.js](../src/experiments.js) and createExperiment/updateExperiment in [analysisStore.js](../src/analysisStore.js). The Telegram flow collects name, hypothesis, intervention, target metric and duration directly from answers, writes protocol_json with duration_days/created_via, and deterministically derives planned baseline/start dates. Start/complete update dates/status. analyzeExperiment writes result_json from supplied daily rows; renderStatus computes a transient result without persisting it. The current schema has **no separate source_context or generated_summary column**. Journal/Q&A integration is not automatically proven by a name, a matching value or the mere existence of an experiment row.

**Chosen representation:** additive **experiment_field_groups** sidecar, with no v20 experiments table reshape. Provenance has a per-column leaf inside each named group, so a copied hypothesis cannot cause deletion of an independently authored name. Its primary key is (user_id, experiment_id, field_group, field_name, field_revision), with field_group TEXT NOT NULL, field_name TEXT NOT NULL, field_revision INTEGER NOT NULL DEFAULT 1, is_current INTEGER NOT NULL DEFAULT 1 CHECK in (0,1), unique (user_id, privacy_artifact_id), source_kind TEXT NOT NULL, assertion_id TEXT NULL, source_update_key TEXT NULL, writer_kind TEXT NOT NULL, provenance_state TEXT NOT NULL DEFAULT 'QUARANTINED', supersedes_privacy_artifact_id TEXT NULL, created_at/updated_at and **every R column**. A partial unique index on (user_id, experiment_id, field_name) WHERE is_current = 1 selects one current leaf. Unique (user_id, assertion_id) WHERE assertion_id IS NOT NULL resolves each authored assertion revision to exactly one leaf; CHECKs enforce the exact group/column mapping and closed source_kind/writer_kind/provenance_state enums below. No duplicate value_json is stored: health values remain only in the mapped experiments column, a projection of its current leaf. Current-leaf revision CAS and source links commit with create/update/redaction of that column. Source links target the leaf's privacy_artifact_id (which includes field_revision), never the whole experiment as a substitute for scope. assertion_id is a tenant-qualified opaque authored root revision, not a Journal logical_fact_id. The root resolver validates that leaf's owner, currentness, DIRECT/source_kind and unredacted content; no separate assertion table is assumed. An authored-operation key is an opaque provenance receipt, not a dependency on copied Journal content.

| field_group (closed enum) | Exact owned v20 columns | Provenance rule |
|---|---|---|
| DEFINITION | name, hypothesis, target_metrics | Each direct authored column may be EXPERIMENT_DIRECT_ASSERTION; a copied/generated column requires its own dependencies, without tainting independent siblings |
| INTERVENTION_PROTOCOL | intervention, protocol_json | Direct authored intervention/duration protocol may be EXPERIMENT_DIRECT_ASSERTION; embedded/copied context makes that containing column dependent, not the entire group |
| SCHEDULE | baseline_start, baseline_end, start_date, end_date | User start/stop and deterministic dates from their chosen protocol may be EXPERIMENT_DIRECT_ASSERTION; observed/analytically inferred physiological dates require actual source links |
| DERIVED_RESULT | result_json, including copied name, summaries, counts, statistics and any nested source context | Never a direct assertion merely because the experiment was user-created; link all daily/WHOOP/Journal/context inputs and each definition/protocol/schedule group read |

source_kind is one of EXPERIMENT_DIRECT_ASSERTION, JOURNAL_DERIVED, WHOOP_DERIVED, QA_DERIVED, ANALYSIS_DERIVED, MIXED_DERIVED, LEGACY_UNPROVEN. writer_kind is a finite server-set value EXPERIMENT_FLOW, EXPERIMENT_API, EXPERIMENT_ANALYSIS or LEGACY_BACKFILL. provenance_state is DIRECT, LINKED, QUARANTINED or REDACTED. Direct requires a verified authored operation/import attestation and assertion root; linked requires every dependency. Generated summaries or copied source context use the leaf containing the actual column; there is no invented summary/context storage column. Different columns within DEFINITION or INTERVENTION_PROTOCOL can have different origins and independent purge outcomes. If origins mix inside a single text/JSON column, use MIXED_DERIVED and all dependencies, purging that column as one unit. New APIs must keep copied analysis/context in result_json rather than append it to an independently authored name/protocol; they cannot silently widen a direct assertion's loss boundary.

**Legacy classification is field scoped.** Verified authored creation/start/stop receipts or an authenticated non-health provenance attestation establish independent definition/protocol/schedule roots without depending on the retention of receipt plaintext. The known flow's protocol shape alone is not sufficient proof: generic createExperiment can write the same shape. Proven Journal copies link exact facts/revisions; proven WHOOP outputs link canonical sources and use their authoritative deletion policy; derived result_json with incomplete provenance is quarantined and immediately redacted ({}), not retained indefinitely behind a hidden flag. Other ambiguous health-bearing leaves are also QUARANTINED with R REDACTED and fixed sentinels/nulls; do not infer independence from missing links. Proven independent columns survive even if another leaf in the same group is unproven. Migration postconditions require exactly **ten current** classified sidecar leaves at field_revision 1 per legacy experiment (3 DEFINITION, 2 INTERVENTION_PROTOCOL, 4 SCHEDULE, 1 DERIVED_RESULT), including empty columns, complete roots/links for readable content, and no unproven plaintext. No live/proactive/evidence/Q&A reader may use quarantined content.

**Read/write/delete contract.** getExperiment/listExperiments and every render/analysis caller use a field-scoped projection: validate owner and each sidecar leaf before exposing its column. A retained direct name can still be listed when hypothesis or DERIVED_RESULT is redacted; analysis rejects missing required fields rather than interpreting {} as valid results or reconstructing old values. createExperiment and each updateExperiment/start/complete/analyze write declare each changed column's origin server-side, commit sidecars/source links atomically, and never inherit source_kind solely from the row's previous classification. Source correction/deletion traverses and P-redacts only linked derived/copied leaves plus their dependents. An unrelated Journal deletion leaves all independent EXPERIMENT_DIRECT_ASSERTION fields and independent WHOOP canonical inputs unchanged. A WHOOP deletion purges its linked results under source policy, not unrelated authored protocols. Direct assertion correction/deletion requires an authenticated request targeting that experiment/group/field; explicit whole-experiment deletion purges all ten fields across four groups and their dependents (name sentinel, JSON {}, other nullable health fields null), preserving only opaque experiment identity/status, leaf revision and deletion barriers. Neither operation is full-account erasure.

For partially readable experiments, R belongs to each sidecar field leaf, not experiments as a whole. T0's tenant fence still applies to all reads. Sentinel mapping applies **only to targeted columns**: DEFINITION.name becomes [HEALTH_CONTENT_REDACTED], hypothesis null, target_metrics {}; INTERVENTION_PROTOCOL.intervention null/protocol_json {}; SCHEDULE dates null; DERIVED_RESULT.result_json {}. Purging one leaf never marks its independent siblings REDACTED. Old readers that blindly parse/render these fields must not run after privacy admission; the Foundation compatibility commit installs these projections before Journal purge can be enabled. No experiment source health content is copied into sidecar audit metadata or hashes.

**Replacement is a new leaf, not rehydration.** Any changed column first fences/purges its previous current leaf and dependents using T0/T1. In T1, CAS the expected current field_revision, mark that leaf is_current = 0 while leaving its R REDACTED forever, insert field_revision + 1 with a new privacy_artifact_id/assertion revision and complete current provenance, and update only that experiments projection column. All four operations are atomic. A later fresh derived analysis after source deletion follows the same new-leaf rule and can use only retained current sources; it cannot refill the old leaf or cite its old source links. Purging a historical non-current leaf never clears a newer projection column. Whole-experiment deletion purges all current/historical leaf dependencies and leaves all ten current columns redacted; replay cannot create a new leaf from a deleted assertion. No retained artifact is repopulated in place.

All Phase 4-capable readers/writers, including legacy stores used during coexistence, must enforce R and the purge fence before Stage 4 correction/deletion is enabled. Flags off cannot bypass privacy. Old binaries may inspect the additive schema but must not run against it after a purge has been admitted; rollback requires the redaction-aware compatibility binary. This is not a production upgrade authorization.

### V23: Body Energy, evidence, episodes, and memory

**body_energy_results**

- M; primary key: user_id, execution_mode, result_id;
- unique (user_id, health_date, as_of_epoch_ms, algorithm_version, input_generation, execution_mode); no as-of bucket in result identity;
- as_of_epoch_ms INTEGER NULL, canonical as_of_utc TEXT NULL; PRESENT requires integer milliseconds, matching ISO representation and non-null health_date;
- result_lookup_key TEXT NOT NULL, unique (user_id, execution_mode, result_lookup_key): opaque keyed digest of exactly the canonical tuple, solely to preserve the same replay barrier after health_date/as-of purge; not an extra revision dimension;
- wake_at_utc TEXT NULL, timezone TEXT NULL, health_date TEXT NULL;
- value INTEGER NULL;
- quality_state TEXT NULL constrained to UNAVAILABLE, NO_DATA, DEGRADED, WARMING_UP, LIMITED, AVAILABLE while PRESENT; confidence and confidence label;
- algorithm, constants, baseline, and metric-registry versions;
- input generation, lifecycle generation, and authorization generation;
- input_manifest_json, driver_json, missingness_json;
- input_manifest_hash and result hash;
- invalidated_at and reason;
- created_at.

Add every R column and supersedes_result_id. PRESENT requires non-null exact time/day, algorithm_version, input_generation, input_manifest_hash, input_manifest_json, quality_state and created_at even when value is null; no manifest-less null result is persisted. Health value, quality/confidence, physiological times/date/timezone, manifest, drivers and missingness are nullable for purge. JSON is a bounded captured manifest, append-only except purge, never lifecycle state.

**body_energy_checkpoints**

- M; primary key (user_id, execution_mode, checkpoint_id); every R column;
- checkpoint_kind TEXT NOT NULL CHECK = 'PERIODIC_15M'; checkpoint_bucket_start INTEGER NULL, checkpoint_as_of_epoch_ms INTEGER NULL, result_id TEXT NULL, algorithm_version TEXT NOT NULL, input_generation INTEGER NOT NULL, created_at TEXT NOT NULL;
- partial unique index from Section 3; checkpoint_lookup_key TEXT NOT NULL unique (user_id, execution_mode, checkpoint_lookup_key), keyed over that same checkpoint tuple and retained only as a purge-safe barrier;
- PRESENT requires bucket-start multiple of 900000, exact checkpoint_as_of_epoch_ms = checkpoint_bucket_start + 900000 and same-user/mode/version/generation exact-result parent with as_of_epoch_ms equal to that instant;
- result/reference insertion is atomic and append-only except purge; purging the parent purges checkpoint time/reference fields, destroys its salt and keeps only opaque checkpoint identity/barrier. Never point it to a different replacement result;
- Body Energy result reads check result_lookup_key before insertion; a previously redacted exact identity returns CONTENT_REDACTED. Nulling physiological identity fields cannot enable recreation under the same tuple. New generation/version/time is required for a genuinely new eligible calculation.

**evidence_runs**

- M; primary key: user_id, execution_mode, run_id;
- deterministic_run_key unique per tenant/execution_mode;
- subject key, method, window start/end, as-of, timezone;
- algorithm, registry, and evidence-contract versions;
- input, lifecycle, and authorization generations;
- input manifest hash;
- sample and exclusion counts;
- unknown_eligible_days, eligible_observation_days, unknown_fraction, max_unknown_fraction_for_promotion, promotion_confound_version;
- exposure_classification_version, factor_set_version, input_manifest_json and missingness_json;
- multiple-testing family;
- state: STARTED, COMPLETED, FAILED, INVALIDATED;
- error code, started_at, completed_at, invalidated_at.
- every R column; run windows, subjects, manifests, counts/fraction and health-derived diagnostics are nullable; method/threshold version and the non-health constant 0.50 may remain.

**evidence_items**

- M; primary key: user_id, execution_mode, evidence_item_id;
- unique user_id, execution_mode, run_id, item_key;
- typed claim key, direction, unit;
- effect, lower and upper bound;
- raw and adjusted significance;
- EXPOSED, CONFIRMED_UNEXPOSED, UNKNOWN, and effective sample counts;
- exposure-classification and factor-set versions;
- quality, recency weight, causal status;
- bounded provenance and confound JSON;
- invalidated_at, supersedes_item_id, created_at.
- every R column; claim/effect/interval/significance/count/quality/recency/confound/provenance content is nullable.

**observation_episodes**

- M; primary key: user_id, execution_mode, episode_id;
- fingerprint, episode_family_key, and revision/CAS;
- domain, subject key, direction;
- state, severity, current_confidence, current_novelty;
- explained status and evidence/context reference;
- opened_at, first_observed_at, last_observed_at, last_material_change_at, updated_at;
- stabilization_started_at, resolved_at, expires_at;
- health-window start/end and timezone;
- current input generation;
- lifecycle and authorization generations;
- latest evidence item ID;
- last_question_id;
- last_delivered_notification_id;
- last_ambiguous_attempt_id;
- resolution_reason;
- reopens_episode_id;
- reverses_episode_id;
- semantic summary hash;
- created_at.

Index:

- unique user_id, execution_mode and fingerprint for active states OPEN, UPDATING, ESCALATED, EXPLAINED, STABILIZING;
- unique user_id, execution_mode and episode_family_key for those active states, preventing opposite directions concurrently within each mode;
- user, state, updated_at;
- user, subject key, health-window end.

observation_episodes also has every R column, explanation_json, current_context_json, last_semantic_event_id and max_semantic_severity_ordinal. All health labels, windows, summaries and current metrics are nullable on purge; retain only opaque fingerprint/family replay barriers and terminal/invalidation state. Purge does not manufacture a new active episode or notification.

**episode_observations**

- M; primary key: user_id, execution_mode, episode_id, observation_key;
- source type, source ID, source version;
- observed_at, health_date;
- normalized value, unit, robust-z, meaningfulness;
- quality and input generation;
- added_at, invalidated_at.
- every R column; observation time/date/value/unit/robust-z/meaningfulness/quality and source-version details purge.

**episode_evidence**

- M; primary key: user_id, execution_mode, episode_id, evidence_item_id;
- episode revision and relationship type;
- linked_at and unlinked_at.
- every R column; purge unlinks the relationship; only opaque row/purge audit remains.

**episode_events**

- M; primary key: user_id, execution_mode, episode_event_id;
- unique user_id/execution_mode/deterministic_event_key;
- event_kind STATE_TRANSITION or SAME_STATE_REVISION;
- episode ID, from state, to state, reason;
- expected and resulting revision;
- input generation;
- bounded evidence-reference JSON;
- actor type and created_at.
- every R column; health-bearing evidence references/transition explanations purge.

**episode_semantic_events**

- M; primary key: user_id, execution_mode, episode_semantic_event_id;
- unique user_id/execution_mode/episode_id/resulting_revision;
- episode_id, resulting_revision, episode_event_id;
- event_kind OPENED, ESCALATED, EXPLAINED, or MATERIAL_ESCALATION;
- nullable severity_ordinal, explained_uncertainty_key, claim_key, recommended_action_key and semantic_content_hash;
- predecessor_semantic_event_id, created_at; provenance input/lifecycle/auth/algorithm versions are not semantic key components;
- every R column; health comparison fields purge; opaque identity/episode lineage and reservation barrier survive for tenant lifetime.

Add nullable columns to **health_insights**:

- insight_key;
- current_revision;
- evidence_contract_version;
- lifecycle_disposition;
- expires_at;
- invalidated_at;
- lifecycle_generation;
- auth_generation;
- input_generation;
- legacy_classification.

Add M and the exact unique partial index for one non-RETIRED PHASE4 current insight per tenant/mode/insight_key from the mode/key matrix after backfill validation. New Phase 4 rows set legacy_classification = PHASE4; existing rows remain LEGACY_UNVERIFIED despite the safe SHADOW column default.

Populated v20 **health_insights** rows are not backfilled as Phase 4 current/promoted insights. Beyond v22 privacy/linkage columns they receive only **legacy_classification = LEGACY_UNVERIFIED** and remain historical records subject to mandatory redaction. They have no invented evidence contract, disposition, current revision, or Phase 4 insight key. Only unredacted, linked content may be described as legacy/unverified history. Purge replaces statement, insight_type and subject with the fixed sentinel, evidence_json with {}, and clears sample_count/effect_size/confidence; never retain copied health text because a row is historical.

**insight_revisions**

- M; primary key: user_id, execution_mode, insight_id, revision;
- status and lifecycle disposition;
- normalized claim and claim hash;
- evidence contract version;
- bounded supporting and contradicting evidence ID lists;
- transition reason;
- input, lifecycle, and authorization generations;
- created_at;
- every R column; normalized claim and health-bearing support/contradiction details are nullable purgeable content. Its revision ID, terminal state/disposition and non-reconstructive digests remain.

### V24: invalidation, decisions, and delivery

**phase4_invalidations**

- M; primary key: user_id, execution_mode;
- requested_generation;
- SCOPE; affected_from TEXT NULL, affected_to TEXT NULL;
- bounded reason-code set;
- subject_key TEXT NULL (one optional registered scope label; multiple subjects coalesce to full-tenant scope);
- updated_at.

This is a coalesced current-work marker, not health history.

phase4_invalidations includes every R column. FULL_TENANT_RECOMPUTE is authoritative even while its old content is REDACTED and its dates are null. Only the exact SCOPE protocol may reset mutable queue scope; no old artifact is restored.

**phase4_jobs**

- M; primary key: user_id, execution_mode, job_kind;
- requested_generation and completed_generation;
- SCOPE; affected_from TEXT NULL, affected_to TEXT NULL, subject_key TEXT NULL and finite reason set;
- state, attempt, next_attempt_at;
- lease_owner TEXT NULL and lease_expires_at TEXT NULL;
- claimed lifecycle and authorization generations; claimed_scope_revision INTEGER NULL, claimed_purge_generation INTEGER NULL;
- last typed error and updated_at.
- every R column; affected range/subject detail is nullable, error must be a finite non-health code. Queue-envelope readers honor FULL before R health-content predicates; a full pass, not clearing fields or toggling R to PRESENT, is required for completion.

Permitted job kinds are explicit, including RECOMPUTE_DERIVED and REPAIR_CURRENTNESS. No Phase 3 worker class is accepted.

**phase4_proactive_decisions**

- M; primary key: user_id, execution_mode, decision_id;
- unique user_id/execution_mode/deterministic_decision_key;
- exact action constrained to the four values in Section 9;
- episode ID and revision;
- input, lifecycle, and authorization generations;
- policy, metric-registry, evidence, and template versions;
- gate results and candidate diagnostics as bounded purgeable JSON;
- episode_semantic_event_id, question_request_id, answer_event_id, selected_followup_kind as applicable;
- counterfactual_evaluator_version, branch_signatures_json;
- selected question key;
- notification, question, semantic claim, and action hashes;
- decision reason;
- invalidated_at, expires_at, created_at.
- every R column; rationale, diagnostics, branch signatures and health-derived scores nullable; never rehydrate a REDACTED decision.

**tenant_delivery_modes**

- M; primary key: user_id, execution_mode, message_family;
- mode LEGACY, CUTOVER_PENDING, or PHASE4;
- deterministic cutover boundary and timezone;
- mode revision/CAS, lifecycle/auth generations;
- changed_at and non-health reason code;
- unique authoritative mode per tenant/execution_mode/family.

**outbound_semantic_reservations**

- M; primary key: user_id, execution_mode, reservation_id;
- unique user_id, execution_mode, message_family, semantic_key;
- state RESERVED, CONSUMED, or CLOSED;
- origin PHASE4 or LEGACY_BARRIER and optional legacy row reference;
- message ID, canonical event/request/answer ID or local_health_date, followup_kind;
- consumed outcome DELIVERED or AMBIGUOUS, closed_reason, created_at, consumed_at, closed_at;
- no payload or health plaintext.
- retain for tenant lifetime; detailed outbox retention never frees a key.

**phase4_question_interaction_slots**

- M; primary key (user_id, execution_mode); revision INTEGER NOT NULL DEFAULT 0;
- state TEXT NOT NULL DEFAULT 'FREE' CHECK in ('FREE','RESERVED','DELIVERY_STARTED','AMBIGUOUS_WAIT','AWAITING_ANSWER','RESOLVED','EXPIRED','CANCELLED_PRE_SEND');
- question_request_id TEXT NULL, outbound_message_id TEXT NULL; origin TEXT NOT NULL DEFAULT 'PHASE4' CHECK in ('PHASE4','LEGACY'); legacy_pending_question_id INTEGER NULL, legacy_operation_id TEXT NULL;
- lifecycle_generation INTEGER NULL, auth_generation INTEGER NULL;
- reserved_at TEXT NULL, delivery_started_at TEXT NULL, delivered_at TEXT NULL, answer_deadline TEXT NULL, resolved_at TEXT NULL, expired_at TEXT NULL, ambiguous_at TEXT NULL, updated_at TEXT NOT NULL;
- cancellation_reason TEXT NULL constrained to finite RESERVATION_EXPIRED, PRE_SEND_FAILURE, PROVIDER_DEFINITE_NON_ACCEPTANCE, PAUSED, LIFECYCLE_CHANGED, AUTH_CHANGED, SOURCE_INVALIDATED, CONTENT_REDACTED;
- occupied PHASE4 requires question_request_id and captured lifecycle/auth generations; LIVE PHASE4 requires outbound_message_id; legacy guard instead requires at least one verified legacy reference. FREE has no active references;
- post-start occupied states require delivery_started_at/answer_deadline; AMBIGUOUS_WAIT requires ambiguous_at; AWAITING_ANSWER requires delivered_at; RESOLVED requires resolved_at; EXPIRED requires expired_at; CANCELLED_PRE_SEND requires cancellation_reason;
- no health text, factor, target-window or physiology columns; transport IDs/deadlines/reasons only. No R. Source purge cancels RESERVED or redacts linked content while keeping occupied post-start transport state until Section 12 resolution/expiry;
- index (user_id, execution_mode, state, answer_deadline); operational expiry index (execution_mode, state, answer_deadline, user_id) returns opaque owners for immediate scoped CAS;
- every state change increments revision once. A stale owner cannot release a new occupant or extend its deadline; RESERVED acquisition is serialized before any provider boundary.

**outbound_messages**

- M; primary key: user_id, execution_mode, message_id;
- unique user_id/execution_mode/idempotency_key;
- unique user_id/execution_mode/reservation_id;
- message class: MORNING_BRIEF_V1, EPISODE_NOTIFICATION, CONTEXT_QUESTION, or ANSWER_FOLLOWUP;
- required semantic reservation ID and semantic key version;
- decision, episode, question_request_id, episode_semantic_event_id, answer_event_id, followup_kind;
- destination_binding_id TEXT NULL; LIVE requires a current authenticated binding, SHADOW requires null and cannot carry a real destination. Synthetic LIVE fixtures use only in-memory fake bindings;
- nullable payload_json, payload_text, payload_hash, semantic_hash; frozen across retry except mandatory purge;
- state and revision;
- lifecycle, authorization, and input generations;
- attempt count, next_attempt_at, expires_at;
- lease_owner TEXT NULL and lease_expires_at TEXT NULL;
- provider message ID;
- terminal reason;
- created_at, updated_at.
- every R column; payloads redacted in place, no separate payload_redacted_at alias.

**outbound_delivery_attempts**

- M plus CHECK (execution_mode = 'LIVE'); primary key: user_id, execution_mode, attempt_id;
- unique user_id/execution_mode/message_id/attempt_number;
- state, request hash, provider status class;
- delivery_started_at, completed_at;
- provider message ID;
- typed error and ambiguity reason.
- every R column; no provider_response_text/body or request plaintext column is permitted. Provider response bodies are parsed transiently for allowlisted status/message ID, then discarded. Unexpected body copies in diagnostic fields use the same incident purge.

The request hash excludes secrets and includes the destination binding and payload hash. Attempts never copy payload plaintext.

Required secondary indexes additionally include each R table's tenant/content_state/purge_generation, receipt owner/update ID, question request lookup/cycle-source key, structured answers by source receipt and question request, and episode semantic events by tenant/episode/revision. Required secondary indexes are:

- journal coverage by user/status/health-date range, source links by user/source, and purges by user/state/updated time;
- context questions by user/status/expiry, user/episode, and user/outbound message;
- Body Energy by user/health date/as-of descending and user/input generation/invalidation;
- evidence runs by user/subject/as-of and user/state/input generation;
- evidence items by user/run, user/claim key/created time, and user/invalidation;
- episode observations by user/source type/source ID/version, episode evidence by user/evidence item, and episode events by user/episode/created time;
- insight revisions by user/insight/revision descending and health insights by user/status/expiry;
- Phase 4 invalidations by updated time and jobs by state/next-attempt and lease expiry;
- decisions by user/episode/revision, user/action/created time, and user/invalidation;
- delivery modes by user/family/mode and cutover boundary;
- semantic reservations by user/family/key/state and origin/legacy reference;
- outbound messages by state/next-attempt, lease expiry, reservation, source decision, and semantic hash;
- delivery attempts by user/message/attempt number and state/completed time.

For every M table the above secondary indexes expand to (user_id, execution_mode, ...); jobs/outbox queue/lease indexes are (execution_mode, state, next_attempt_at, user_id) and (execution_mode, lease_expires_at, user_id). LIVE dispatcher queries explicitly bind execution_mode = LIVE and never scan SHADOW proposals. Additional exact privacy indexes are (user_id, scope_kind, scope_revision) on the two legacy SCOPE tables, (user_id, execution_mode, scope_kind, requested_generation) on Phase 4 SCOPE tables, and (user_id, provenance_state, field_group) on experiment_field_groups. Every health index begins with user_id; operational queue indexes may return only opaque tenant IDs for immediate owner/mode re-scoping. No global queue selection returns health content.

### V25 and v26 future additive locked-scope extensions (not implemented)

V21–v24 are completed Foundation versions and must not be reopened, renumbered, or silently extended. The locked requirements added on 2026-09-25 require reviewed forward migrations before implementation. Version ownership is dependency ordered and indivisible:

- **Stage 7 owns v25:** Quick Action interaction transport plus Journal-side `TRUSTED_REGISTRY` and `source_kind` provenance.
- **Stage 8 owns v26:** Owner Monitoring subscriptions, authorization, notification state/preferences, and owner-outbox linkage.

No v25 or v26 source, migration, or runtime behavior exists at the current checkpoint. A v25 version row cannot be recorded until all v25 objects, columns, indexes, triggers, backfills, and postconditions below are complete; the same all-or-nothing rule applies independently to v26. Stage 8 cannot place its tables in v25 or start v26 before complete v25 postconditions pass.

**Display-name schema stance**

Display-name isolation preferentially uses the existing tenant-scoped identity model: the same user's explicit `users.display_name`, authenticated Telegram identity, WHOOP profile identity, and neutral fallback in Section 11. Stage 8 does not receive a schema migration merely to implement that resolution order. Existing values with unproven provenance are treated as legacy/unverified and cannot outrank a mechanically proven same-user source or the neutral fallback. Only if Stage 8 implementation proves the current identity schema insufficient may a later, separately reviewed additive migration add source provenance or an identity generation; neither v25 nor v26 reserves such a change now.

**v25 Journal-side provenance extension**

The accepted Structured Journal fact/revision, not only its interaction row, durably carries:

- `source_kind` with at least `quick_action`, `bot_question`, `free_text`, and `manual`, plus a conservative `legacy_unverified` disposition for a row whose source cannot be mechanically proven;
- provenance mode `USER_TEXT`, `TRUSTED_REGISTRY`, or `LEGACY_UNVERIFIED`;
- for `TRUSTED_REGISTRY`, registry/action identifier, registry version, server-issued canonical choice identifier, interaction/callback receipt identity, optional presentation-label snapshot, authenticated actor/user identity, effective context time/timezone, and answered/clicked time;
- the existing logical-fact/revision, source-event, question/interaction, correction/deletion, and purge lineage.

Existing rows receive a restart-safe deterministic backfill. Mechanically proven bot-question, free-text, or manual provenance may receive that exact source kind and `USER_TEXT`; every ambiguous legacy row receives `legacy_unverified`/`LEGACY_UNVERIFIED`. No existing row is inferred to be `quick_action` or `TRUSTED_REGISTRY`, and null/default behavior must fail closed rather than confer registry trust. Journal/Evidence readers can distinguish these dispositions without joining transport state.

`raw_answer_excerpt` remains the actual bounded user-authored span for `USER_TEXT`. It is null for a pure registry selection and contains only genuine supplemental user text when present. V25 extends the deterministic validator with the Section 6 trusted server context; it does not relax existing free-text evidence checks or permit caller-selected canonical facts.

**v25 `quick_action_interactions`**

- primary key: user_id plus interaction_id; execution mode and authenticated destination binding are explicit;
- registry action identifier, action-registry/taxonomy version, server-issued canonical choice identifier, interaction revision, parent interaction/question request, allowed-choice digest, selected canonical choice, target-time rule, exact target interval/context date/timezone, created/expires/answered times, state and CAS revision;
- source-event semantic completion key and provider update/callback receipt hash; unique user/mode/semantic completion key and unique accepted provider callback identity;
- states ISSUED, AWAITING_DETAIL, COMPLETED, STALE, CANCELLED, or UNDONE; terminal replay cannot create another Journal fact;
- resulting Journal logical fact/revision and correction/deletion operation reference;
- every category/value/target/detail field is purgeable health content under R; the opaque interaction, receipt/idempotency barrier, transport times, terminal state, and non-health reason survive according to Section 15.

This table is interaction transport/provenance, not a journal. Accepted content exists authoritatively in `journal_events`; no analytics query treats the interaction row as evidence. V25 indexes support interaction replay/staleness, registry/version lookup, Journal provenance traversal, and unique callback/semantic completion. V25 remains default-off and must pass interruption, source-kind backfill, validator-boundary, privacy, tenant/mode, and replay tests before Quick Action behavior can use it.

**v26 `owner_follow_subscriptions` and `owner_follow_subscription_events`**

- explicit owner_user_id and subject_user_id, constrained so the stable configured owner principal corresponding to Kelvin—not a name comparison—is used and the subject is a distinct enrolled user;
- one current row per owner/subject/notification class, where the class is DAILY_SUMMARY, IMPORTANT_ALERT, or WEEKLY_SUMMARY;
- ENABLED/DISABLED state, monotonic revision, effective interval, authenticated owner operation receipt, changed_at, finite reason code, and any class-specific owner notification preference/state;
- append-only event history records every transition and prior/new revision. No health payload is stored.

**v26 `owner_monitoring_authorizations`**

- primary identity includes owner_user_id, subject_user_id, execution_mode, authorization_id; uniqueness binds the owner message semantic reservation to one authorization;
- notification class, subscription revision, purpose/reason, exact as-of, approved synthesized artifact or bounded deterministic summary-plan references and versions, and content/provenance hash;
- captured owner lifecycle/destination generation and subject lifecycle/auth/input/purge generations;
- authorization state, created/expires/invalidated times, linked owner outbound message/reservation and transport outcome reference;
- the only permitted cross-user source linkage is the typed owner/subject linkage declared here. It is indexed by both principals and participates in subject correction/deletion traversal; health-bearing labels, summaries, dates, and reconstructive references use R and are purged/redacted under Section 15.

V26 extends `outbound_messages` and `outbound_semantic_reservations` additively for the three owner message classes and nullable `owner_monitoring_authorization_id`. For owner classes, outbox `user_id` is the owner recipient; the authorization envelope supplies the distinct subject. Non-owner classes require that field null. The dispatcher conjunctively revalidates owner capability, followed subject, subscription revision/class, both principals' current fences, approved synthesized artifact or bounded plan, owner destination, and audit provenance immediately before start. Any failed predicate produces no message. No ordinary outbox caller may supply a subject user ID.

V26 indexes support current follow selection, follow history, authorizations by owner/subject/class/as-of, subject purge traversal, and owner-outbox authorization lookup. Every composite identity carries both principals where applicable. V26 remains default-off and must pass interruption, backfill, authorization, fail-closed data-scope, privacy, multi-user, and SHADOW/LIVE tests before any Owner Monitoring behavior flag can use it.

### Store invariant matrix

Every ordinary store method receives authenticated user_id and server-owned execution context separately from payload data. It verifies every derived parent with user_id/execution_mode/parent ID inside the write transaction; cross-tenant, cross-mode, missing, stale or generation-mismatched parents reject the write. Shared roots use the explicit root allowlist above, never an omitted-mode fallback. The future v26 Owner Monitoring store is the sole dual-principal exception: it requires both owner and subject plus the complete Section 13 capability/subscription envelope and is not exposed through an ordinary store interface.

| Store | Create invariants | Update invariants | Delete/invalidate invariants |
|---|---|---|---|
| Phase 4 user state/preferences | Existing user parent; lifecycle generation readable; deterministic defaults | Preference version CAS; generations monotonic | Account lifecycle only; no child cascade by unscoped ID |
| Display-name resolution (existing identity stores unless later proven insufficient) | Same-user proven candidates only; legacy source unverified | Fixed precedence; neutral on unproven data; use existing binding/profile generations | Remove/re-resolve one user's candidate only; never fall through to another user's value |
| Journal facts/coverage/tombstones/purge | Existing tenant; unique source key; validator accepted in USER_TEXT or server-issued TRUSTED_REGISTRY mode; coverage window exact | Active revision CAS; correction creates revision with its own source kind/provenance; input generation increments | Source-link traversal, synchronous plaintext purge, minimal tombstone, generation increment |
| Quick Action interactions | Authenticated own destination; issued registry revision and exact target semantics | Interaction/source-key CAS; one terminal selection and one Journal fact | Stale/cancel/undo retains replay barrier; Journal content follows existing purge/tombstone contract |
| Context questions/slots/pending links/answer events | Current same-mode episode; acquire tenant/mode slot with request/reservation/proposal atomically; accepted answer revision unique | Slot/request/revision CAS; confirmed same LIVE question before pending projection; explicit ambiguous answer matching | Cancel unstarted; post-start slot waits through answer/expiry; purge content, retain receipt/reservation barriers |
| Body Energy results | Current tenant/lifecycle/auth/input/purge generations; captured manifest; deterministic key | Numeric result append-only except purge; invalidation CAS | Purge full manifest/value/quality; opaque audit remains |
| Evidence runs/items | Current observations/source links; run completes before publication | Completed statistics append-only except purge; invalidation CAS | Purge values/counts/statistics/text and invalidate; opaque audit remains |
| Episodes/memberships/events | Current durable evidence; family uniqueness; scoped parents | Revision CAS; legal state changes or separate same_state_revision; semantic event atomic | Terminalize/invalidate and purge all health fields; semantic barrier survives |
| Insights/revisions | Current compatible evidence; legacy rows prohibited as parents | Expected revision CAS; legal status/disposition pair; USER_DISMISSED atomic | Retire/invalidate and purge health text; revision metadata remains |
| Invalidations/jobs | Existing tenant/mode; requested generation monotonic | Owner/lease/generation/scope_revision/purge CAS; FULL overrides null ranges | Null linked scope and set FULL; preserve requested/completed progress, no fake success or worker activation |
| Experiment field groups | Tenant-owned experiment; ten column leaves in exact four groups; verified roots or complete input links | Leaf revision CAS; column/sidecar writes atomic; reject unproven readable content | Purge only dependent fields; explicit experiment delete covers its own roots, not other tenant/source assertions |
| Decisions | Current episode/evidence and exact policy versions | Envelope stable except invalidation/expiry CAS; content append-only except purge | Purge rationale/diagnostics/branch signatures; no action mutation |
| Delivery modes/reservations | Existing tenant/destination; family mode CAS; semantic key tenant-qualified | Cutover boundary CAS; CONSUMED reservation never released | Reversible only before any Phase 4 DELIVERY_STARTED; legacy barrier retained |
| Outbox/attempts | Authoritative PHASE4 mode, current parents/purge fence, reservation atomic | Message/lease CAS; attempt outcome transitions; payload only purgeable | Unstarted invalidation closes key; started/delivered/ambiguous history preserved with no plaintext |
| Owner follow/authorization | Configured owner plus distinct enrolled subject; enabled class and explicit dual-principal capability | Subscription revision and both-principal generation CAS; append-only follow events | Revocation blocks new envelopes; subject purge traverses authorization and unsent owner payload |

Orphan prevention is a synchronous primary store responsibility. The offline integrity audit is defense in depth and can quarantine a corrupt artifact; it is not the mechanism that makes ordinary writes safe.

### Referential integrity decision

Current v20 tables do not declare SQL foreign keys. New Phase 4 records therefore use tenant/mode-qualified composite references and mandatory application validation rather than relying on partially enabled foreign-key behavior. Every derived child row carries user_id and execution_mode; parent lookup repeats both plus parent ID. Shared-root and legacy privacy exceptions are explicitly enumerated above. Integrity audits also check mixed-mode chains.

An offline integrity audit must detect orphans and cross-tenant ID collisions as defense in depth. A future all-schema foreign-key migration may replace this decision, but Phase 4 must not create a false impression that only some relationships are database-enforced.

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

**Rationale:** Episode uniqueness, evidence-envelope stability with purgeable content, decision action constraints, delivery ambiguity, correction invalidation, and tenant-currentness need independent indexed state.

**Compatibility impact:** Additive schema, deterministic linkage backfills and mandated privacy redaction; no v20 table reshape and no dormant-worker activation. Privacy-compatible readers are required before purge is enabled.

**Failure mode controlled:** Partially applied migrations, unqueryable lifecycle state, and one legacy record being treated simultaneously as evidence, decision, and delivery.

## 15. Tenant, privacy, and retention

### Tenant isolation

Every ordinary Phase 4 table/path is tenant-scoped by internal user_id. Every primary, unique, join, update, and delete path includes user_id. External IDs are resolved through existing identity mappings before any health query.

Cross-tenant batch processing may enumerate opaque user IDs, but each tenant is processed in a separate scoped store. Ordinary derived input manifests cannot reference a row owned by another tenant. A cross-tenant reference is a hard invariant violation that invalidates the artifact and raises an operational alert unless it is the exact dual-principal Owner Monitoring authorization envelope defined in Sections 13–14.

There is no ordinary family, support, administrator, or generic owner read surface. Operational staff receive only opaque IDs, state, timing, version, count, and reason-code metadata. Kelvin's Owner Monitoring capability is a distinct narrow product path over selected users and approved synthesized outputs; it does not weaken or bypass the ordinary tenant store.

### Ownership and fencing

Before a read or write, the scoped store verifies tenant ownership and the lifecycle required for the purpose. Provider-derived computation additionally checks authorization generation, capability, and resource access. Delivery-sensitive reads check ACTIVE, READY, current destination binding, and notification pause immediately before provider start.

Derived rows carry execution_mode, input, lifecycle, and authorization generations as specified in Section 14. A mismatch makes the row non-current even if its timestamp is recent. Caches use tenant, execution_mode, semantic/artifact identity, algorithm version, and all applicable generations. No cache is keyed only by metric, health date, Telegram ID, or WHOOP ID.

Every ordinary join repeats user_id on both sides. Store APIs do not accept a child artifact ID without the authenticated user ID. Batch code receives an opaque tenant ID, constructs a fresh scoped store, and cannot reuse another tenant’s in-memory context. Owner Monitoring uses only its dedicated dual-principal join and never exposes that join primitive to an ordinary reader.

Every Phase 4 lease identity includes user_id, execution_mode, work/message key, owner token, claimed generation, scope_revision/purge generation where applicable, and expiry. Lease takeover requires compare-and-swap on that complete identity. A lease never conveys authorization to read another tenant/mode or to bypass a newer lifecycle/auth generation.

### Data minimization

- Body Energy stores only inputs needed to reproduce an exact cited result; optional checkpoint references do not change result identity.
- Journal raw text is limited to the relevant 500-code-point answer span, not the surrounding chat.
- Evidence provenance stores row identifiers, source versions, and bounded summaries, not copies of full canonical records.
- Episode and insight summaries use normalized claims and hashes.
- Delivery logs exclude tokens, authorization headers, webhook secrets, and unrestricted prompts.
- LLM calls receive only the minimum tenant-scoped facts for the permitted task.
- Deleted journal tombstones contain no health content.

### Health-plaintext inventory and deletion matrix

This inventory was checked against the v20 definitions in [src/schema.js](../src/schema.js), canonical writes in [src/store.js](../src/store.js), [src/botStore.js](../src/botStore.js), receipt/replay in [src/db.js](../src/db.js) and [src/bot/updateProcessor.js](../src/bot/updateProcessor.js), [src/analysisStore.js](../src/analysisStore.js), [src/proactiveStore.js](../src/proactiveStore.js), and [src/analyticsWorkStore.js](../src/analyticsWorkStore.js). V20 does not already provide this comprehensive purge contract.

“Health plaintext” includes structured numbers, physiological times/windows, statistical counts and health-derived JSON, not just prose. The **R** columns in Section 14 are the exact redaction marker for all retained rows below. **E** below means only the Section 14 non-health envelope survives (opaque ID/owner, algorithm/version, safe creation/transport times, finite state/reason, non-reconstructive keyed hash). E never includes health-derived scores/counts, subject labels, context windows, or reconstructive links.

These exact action codes define correction, deletion, replay and markers for every matrix entry:

- **P (purge retained row):** on correction purge old copied/derived content and invalidate it; on deletion purge every reachable revision. Set R to REDACTED, null every nullable listed health field, apply the exact required sentinel below, destroy content_digest_salt, unlink health dependencies. E only survives. No health read, regeneration, send, or in-place rehydration from a redacted row; a new artifact requires current non-deleted sources.
- **J (journal):** correction creates a new ACTIVE revision and P-redacts the old one. Deletion physically removes all revisions and retains only journal_event_tombstones plus the purge ledger. Source-update replay is no-op and cannot resurrect the fact.
- **D (disposable derived row):** correction/deletion physically removes the entire row after recording opaque row identity in purge linkage/ledger; no transport idempotency depends on it. Recompute only from current sources into a new row/generation, never from historical payload. R records pending state until deletion; completion lives in the purge ledger.
- **O (operation receipt):** P plus the exact Telegram no-op replay contract below; keep completed action identity and transport evidence for tenant lifetime.
- **S (source canonical):** unrelated journal corrections/deletions do not erase independent WHOOP source facts. An authoritative WHOOP correction updates the canonical row under freshness rules and P/D-purges old derived copies. Authoritative deletion removes its entire canonical row including raw_json, keeps the existing minimal source tombstone, and purges dependents. Baseline snapshots are copies, not exempt. No deleted source may be re-fetched by a replay; only the existing authoritative recreation contract may supersede a source tombstone.
- **G (diagnostic only):** health text is prohibited in new writes; use finite allowlisted codes, never raw Error.message/provider bodies. Existing nullable free-text/JSON fields are conservatively P-redacted on linked correction/deletion, even when not provably health-bearing. Retain operational E only. Diagnostics are not a source for health reconstruction.
- **C (cache/log):** no new persistent health cache/log. Generation fence blocks reads immediately; evict in-memory content on purge. Detected external log copies require incident cleanup and verified erasure/expiry before claiming complete storage deletion.

Normal retention below is an upper bound absent earlier correction/deletion; “400d/current” means 400 days after terminal state, extended only while a current artifact actually requires it. “No replay content” explicitly means plaintext is unnecessary for dedup; keep its envelope if replay identity is required.

For experiments, “group-scoped P” in this inventory means traversal to the exact column leaves in Section 14. Group names organize the inventory; they never authorize wiping an independent sibling column or the entire row.

| Current/proposed table.store and exact health-bearing fields | Direct/derived and source linkage | Retention | Action / replay need / survives |
|---|---|---|---|
| whoop_sleeps: raw_json; health_date/start_at/end_at/timezone_offset/nap/score_state; respiratory_rate, sleep_performance_percentage, sleep_consistency_percentage, sleep_efficiency_percentage; total_sleep_milli, light_sleep_milli, slow_wave_sleep_milli, rem_sleep_milli, awake_milli, no_data_milli, in_bed_milli, disturbance_count, sleep_cycle_count, sleep_need_baseline_milli, sleep_debt_milli, sleep_need_recent_strain_milli, sleep_need_recent_nap_milli | Direct provider source (user_id,id); source links use sleep/id | Existing canonical policy, until source deletion | S; canonical payload not required for replay; source tombstone only |
| whoop_recoveries: raw_json, health_date, score_state, recovery_score, hrv_rmssd_milli, resting_heart_rate, spo2_percentage, skin_temp_celsius, user_calibrating | Direct provider source (user_id,sleep_id), matched sleep | Existing canonical policy | S; tombstone/opaque source IDs only |
| whoop_cycles: raw_json, start_at, end_at, timezone_offset, score_state, strain, kilojoule, average_heart_rate, max_heart_rate | Direct provider source (user_id,id) | Existing canonical policy | S; no health replay payload retained after delete |
| whoop_workouts: raw_json, health_date/start_at/end_at/timezone_offset, sport_name/sport_id, score_state, strain, average_heart_rate/max_heart_rate, kilojoule, percent_recorded, distance_meter, altitude_gain_meter/altitude_change_meter, zone_zero_milli through zone_five_milli | Direct provider source (user_id,id) | Existing canonical policy | S; no health replay payload retained after delete |
| whoop_body_measurements: recorded_at, height_meter, weight_kilogram, max_heart_rate, raw_json | Direct provider source keyed by tenant/recorded_at; not a Body Energy input | Existing canonical policy | S when source/account policy authorizes removal; journal deletion does not erase independent measurements |
| journal_events current and all revisions: event_at, health_date, category, subtype, numeric_value, text_value, unit, severity, note, raw_answer_excerpt, extraction_confidence, recorded_timezone, time_scope, event_end_at, alignment fields, exposure_state, future v25 source-kind/registry provenance | Authenticated user fact; USER_TEXT excerpt or server-issued TRUSTED_REGISTRY lineage; logical_fact_id/revision and source receipt | ACTIVE values; genuine excerpt <=90d; pure button excerpt null | J; values unnecessary for idempotency; tombstone/receipt only |
| journal_coverage_windows: factor-key set, UTC/date window, timezone, confirmation text/hash preimage | Direct user coverage; source receipt/fact linkage | ACTIVE, then <=400d | P; opaque coverage/receipt E |
| pending_questions.question | Derived generated health question; context request and every source fact/evidence | Answer/expiry or 30d, whichever first | P; question NOT NULL sentinel; pending status terminal, never reopens |
| pending_questions.context_json | Direct/derived parser context including copied health fields; all context inputs and answer facts | <=30d | P, {}; no replay content; E |
| pending_questions.original_message | Direct user text; source update plus known fact/question links | <=30d | P, null; E |
| pending_questions.answer_text | Direct answer; accepted answer event/logical fact or pending-clarification source | Normalization/expiry or 30d | P, null; receipt/answer status E |
| pending_questions.intent | Potential health-subject label; same links | <=30d | P, null; E |
| telegram_operations.result_json, including reply and any nested generated/user health text or structured values | Derived/direct inbound result; owner_user_id, source update, every Q&A input or answer fact | Health reply <=90d from committed_at | O; receipt COMMITTED survives, health reply unnecessary for replay after redaction |
| proactive_events.message_text | Derived legacy message; journal_event_id, pending_question_id and evidence/canonical inputs | <=90d from terminal or created_at if terminal unknown | P, null; preserve keyed idempotency barrier, decision/delivery E |
| proactive_events.reason_json, proactive_events.signals_json, health_date, outcome when narrative | Derived legacy health rationale/signals; same links | <=400d, prose <=90d | P; JSON {}, health_date sentinel, outcome null; no replay health content |
| health_insights.statement, health_insights.evidence_json, subject, insight_type, sample_count, effect_size, confidence | Derived current/legacy claim; evidence/source IDs, conservative legacy dependency if unknown | 400d/current | P; statement/subject/type sentinel, evidence_json {}, numeric/confidence null; status RETIRED with Phase 4 INVALIDATED disposition when applicable |
| healthspan_metrics: metric_key, value, unit, window_days, sample_count, coverage, availability, source, confidence, detail | Derived canonical/capability data via analysisStore; full inputs or TENANT_LEGACY | <=400d | D; no replay content; opaque purge audit only |
| healthspan_snapshots: snapshot_date, score, score_kind, contributors_json, coverage, status | Derived healthspan inputs | <=400d | D; no replay content |
| prediction_runs: target_date, target_metric, features_json, predicted_value, predicted_low, predicted_high, n_train, actual_value, error, status | Derived canonical/model inputs | <=400d | D; no replay content |
| prediction_models: target_metric, features_json, train_start/end, test_start/end, n_train/n_test, mae/rmse/r2, interval_coverage, baseline_kind/mae, beats_baseline, maturity, qualified, unqualified_reason | Derived training/evaluation inputs, not exempt model content | <=400d | D; no replay content; Phase 3 remains dormant |
| experiments.DEFINITION: name, hypothesis, target_metrics; experiment_field_groups group metadata | Verified direct EXPERIMENT_DIRECT_ASSERTION root or actual copied/generated dependencies; never blanket TENANT_LEGACY for a proven root | Active then <=400d | Group-scoped P only on its own assertion deletion/correction, retention, or a linked copied source; unrelated Journal deletion leaves independent columns intact |
| experiments.INTERVENTION_PROTOCOL: intervention, protocol_json; SCHEDULE: baseline_start/end, start_date/end_date | Independently authored protocol/planned schedule roots where verified; otherwise actual source links; ambiguous groups quarantined/redacted | Active then <=400d | Group-scoped P; null text/dates and {} JSON only in targeted groups; independent groups remain readable |
| experiments.DERIVED_RESULT: result_json and all nested generated summary/source-context/statistical content | Derived WHOOP/daily/Journal/Q&A inputs and experiment field groups actually read; no invented summary/context columns | <=400d; unproven content immediately redacted | Group-scoped P, result_json {}; redact linked or ambiguous output, not independent definition/protocol; whole-experiment deletion purges all groups and own assertions |
| analytics_daily_state.metrics_json, health_date, daily_status | Derived canonical daily cache | <=400d | D entire row avoids primary-key collisions on health-date redaction; no worker activation |
| analytics_invalidation.affected_from/affected_to and any health-bearing resources/reasons | Copied physiological mutation range, linked source or TENANT_LEGACY; not scheduling-only metadata | Pending work; linked deletion/correction immediately overrides retention | P + SCOPE: null dates, FULL_TENANT_RECOMPUTE, scope redaction markers; preserve generation, no health-range replay or Phase 3 activation |
| analytics_work_state.summary_json, last_error_detail, range_from/to; analytics_runs.detail_json, error_detail | Derived summary/diagnostic input scope; full inputs or TENANT_LEGACY | Summaries <=400d, errors <=30d | P/G + SCOPE on work row; JSON {}, null detail/ranges; clear stale lease/cursor, preserve done_generation and requested work; FULL is pending, not completion |
| whoop_capabilities.latest_value, sample_count, non_null_count, detail | Derived canonical values (including sport/nap details), not merely capability enums | Until next probe, maximum 400d | P; null these fields, current eligibility invalidated; access/lifecycle truth unchanged |
| report_runs.detail, health_date, sleep_id/cycle_id after dependency unlinking; report_claims.delivery_detail; briefing_evaluations.reason/detail, target_health_date, observation_age_minutes | Derived readiness/provider diagnostics; report source inputs or TENANT_LEGACY | Detail <=30d, copied health scope <=400d | P/G; null health fields; report_type/local_date and actual delivery barriers E survive |
| whoop_sync_state.last_error; whoop_webhook_events.last_error_detail; whoop_reconciliation_state.last_error_detail; whoop_reconciliation_runs.error_detail; user_onboarding.failure_detail | Potential health-bearing provider/error text; scoped operation/source, or TENANT_LEGACY | <=30d | G; null; retain typed errors, source transport keys and lifecycle/sync state, no new source fetch from purge |
| ai_usage.detail; system_heartbeats.last_detail | Potential model/provider error or operational narrative; tenant/source when available | <=30d | G; null; usage token/cost counts and heartbeat timings E remain; null-owner rows never assigned by guessed identity |
| context_questions: candidate diagnostics, selected factor/window, utility and U/D/R/A/T/K/P/F, branch_signatures_json, question/prompt normalized context | Derived episode/evidence/fact/template inputs; request ID and complete links | <=400d; prose <=30d | P; null scores and context, not just text; opaque request lookup/ordinal/receipt E for tenant lifetime |
| structured_answer_events.normalized_answer_json and answer semantic preimage | Direct normalized accepted answer; fact/coverage and source receipt | Fact-active, then <=400d | P; opaque answer event/revision, selected kind and receipt E survive |
| health_purge_replacements.normalized_replacement_json | Direct validated new correction assertion; source update and purge ID | Until synchronous content commit, hard maximum 30d | J/P staging exception; delete staging on commit or subject deletion; no old-health replay |
| body_energy_results: value, confidence/quality, wake/health-date/as_of_epoch_ms/as_of_utc, input_manifest_json, driver_json, missingness_json and baseline/intermediate values; body_energy_checkpoints.bucket/as-of/result reference | Derived exact selected canonical rows/snapshot versions; checkpoint links exact result | 400d/current | P; CONTENT_REDACTED on replay; mode/opaque lookup barrier E only, no physiological-time identity retained in plaintext |
| evidence_runs/items: captured input manifest, subject/window/timezone, counts/fraction, missingness, claim/summary, direction/unit, effect/bounds, p/q, effective n, quality/recency/confound/provenance JSON | Derived every canonical/fact/coverage input | 400d/current | P all health statistics; no historical reconstruction; E incl method/constant versions only |
| observation_episodes, episode_observations, episode_evidence, episode_events, episode_semantic_events: health labels/window/times, normalized values, robust-z, severity/confidence/novelty, explained status, explanation_json/current_context_json, claim/action keys, evidence/context relationship details | Derived observation/evidence/fact membership | <=400d after terminal | P; E retains terminal states, opaque event IDs and reservation lineage only |
| insight_revisions: normalized claim, support/contradiction details, health explanation | Derived evidence IDs and transitive inputs | <=400d after retirement | P; revision/status/disposition E |
| phase4_proactive_decisions: gate results, candidate diagnostics, branch signatures, utility values, rationale/actionability text | Derived episode/evidence/question/answer inputs | <=400d, narrative <=90d | P; action/decision/event IDs and invalid state E; no proposal replay |
| phase4_invalidations/phase4_jobs: affected_from/affected_to, subject_key, health-bearing error details if detected | Derived mutation scope/source links, separately mode-qualified | Pending work; errors <=30d | P/G + SCOPE in T1 across both modes: FULL_TENANT_RECOMPUTE, null dates, markers, monotonic request and unchanged completion; no old-artifact reconstruction or early fence release |
| proactive_agent_state.last_checked_health_date, last_fingerprint | Derived legacy health cursor/hash; tenant canonical inputs | Until next check, maximum 400d | P; null both on source purge; preserve enabled/lifecycle/operational E |
| outbound_messages.payload_json/payload_text and all copied health context | Derived decision/evidence/facts plus semantic event | <=90d after terminal | P; unsent INVALIDATED/CLOSED; started/sent/ambiguous state retained, no resend; E only |
| outbound_delivery_attempts and transient provider response text/body | Health text prohibited; linked message | Response bodies zero retention | G; no body column, no plaintext replay need; state/status/message ID/timings E only |
| Q&A/prompt/context caches, LLM input/output transient envelopes | Derived source plan or direct user input; tenant/source IDs and all generations | In-memory <=15 minutes; no persistent prompt trace | C; invalidate/evict, return updating/redacted not old answer |
| stdout/stderr application logs, traces, captured error/provider bodies | Health content prohibited; source/artifact correlation only | Non-health logs <=30d | C/G; incident cleanup for existing copies; no health reconstruction |

**Fixed non-health sentinel map.** Required text uses exactly [HEALTH_CONTENT_REDACTED]: health_insights.statement/subject/insight_type, pending_questions.question, experiments.name **only when its DEFINITION/name leaf is purged**, proactive_events.health_date, and superseded journal_events.event_at/health_date/category/source. JSON fields targeted for purge become exactly {} (not an object containing original text); nullable health text/numbers/times become null. Unrelated experiment fields remain untouched with their own sidecar R. The disposable tables above use D instead of risking collisions in required health-date/metric keys. All new health-bearing columns are nullable after purge; exact Body Energy time/date fields are mandatory while PRESENT. R markers plus exclusion predicates prevent sentinels being interpreted as valid health facts.

### Legacy linkage completeness and non-health exclusions

New health-bearing writes commit phase4_source_links atomically with content and cannot be published without complete linkage. Link source updates even when no journal fact is created: a Q&A receipt links every cited/read canonical or derived source, and pending unparsed text links its source update. Correction/deletion traverses direct and transitive dependencies before unlinking anything.

For attributable legacy derived/copied content with incomplete provenance, v22 records TENANT_LEGACY for that owner; any source correction/deletion for that tenant conservatively purges those dependent rows/groups. Do not pretend that an absent link proves non-dependence. Independent canonical WHOOP rows and verified EXPERIMENT_DIRECT_ASSERTION groups are not TENANT_LEGACY Journal dependents. Experiments follow Section 14's field-scoped backfill: ambiguous derived groups are immediately quarantined/redacted, without erasing proven independent groups. Unattributable legacy reply/diagnostic content is quarantined and redacted to fixed non-health sentinels during the local migration rehearsal and eventual specifically authorized migration; never infer ownership from a currently rebound chat. Privacy backfill completion is a migration postcondition.

The schema scan also covered identity/OAuth/token/link-code tables; telegram_processed_updates and telegram_state.value (current writer uses only the polling offset); resource_locks; error_notifications; schema/migration checkpoints; source tombstones; reconciliation operational cursors/discrepancies. Identity/transport IDs, finite codes and actual scheduling timestamps are non-health metadata. This exclusion does **not** include analytics_invalidation affected dates, analytics_work_state remaining ranges, Phase 4 health scope or proactive_agent_state.last_checked_health_date/last_fingerprint: those are covered by the matrix and must be cleared on linked purge. A cursor describing a physiological event/window is health content even when used by a scheduler. No exemption authorizes reading secrets or changing identity/lifecycle truth.

Logger secret redaction in [src/logger.js](../src/logger.js) is not health-text redaction. Current store log calls can include journal category, insight subject, experiment name, or provider error strings. Stage 4 must remove health fields from these paths and enforce a field allowlist before privacy activation. Existing external logs/backups are not verified erased by this ADR. Deletion status must distinguish DB_REDACTED, cache completion and external-copy verification; inability to verify an external retained copy is a disclosed residual/activation blocker, never a fabricated success.

### Telegram receipt redaction and exact replay contract

V20 telegram_operations.result_json is NOT NULL and contains the durable action result, including reply; [src/db.js](../src/db.js) currently returns it before rerunning the action. telegram_operations has no tenant column today. V22 adds owner_user_id separately: telegram_processed_updates.user_id is used as a conversation key such as tg:<chat_id>, not proof of internal tenant ownership.

Backfill owner_user_id only from a valid server-written result_json.userId that resolves to an existing tenant, never from message text or today's chat binding. Unknown ownership leaves it null and redacts the content with UNATTRIBUTED_LEGACY; keep update_id as a global opaque inbound barrier. New authenticated operations bind owner_user_id server-side and source_update_key to the update receipt in the action transaction.

On correction, source deletion or retention expiry:

1. Keep update_id, committed_at, operation_state = COMMITTED, owner_user_id, delivery attempt counters/timestamps and actual transport outcome.
2. Replace the entire result_json, not only reply, with exactly {"reply":null,"redacted":true,"reason":"HEALTH_CONTENT_REDACTED"}. Set every applicable R marker and disconnect source links only after traversal.
3. An unstarted ACTION_READY operation becomes NOT_REQUIRED. A started/delivered/ambiguous operation keeps actual transport history; an unresolved start may recover to AMBIGUOUS, never retryable. Redaction is not proof of delivery.
4. Receipt lookup checks content_state before any route classification requiring health access, Q&A, LLM, mutation, typing/send path, or follow-up scheduling. A REDACTED receipt returns internal result {"reply":null,"redacted":true,"reason":"HEALTH_CONTENT_REDACTED"}, completes/acknowledges the duplicate update as a no-op with replied=false, and calls none of those paths. COMMITTED action never runs again even if telegram_processed_updates was pruned.
5. Pre-send CAS checks content_state = PRESENT and tenant purge_generation/pending_purge_count alongside the existing lease/lifecycle fence; a stale in-memory reply cannot send after redaction wins the race. A call already started has the external-copy limitation below.

Receipt identity/COMMITTED state and redaction markers remain for tenant lifetime. A new user question has a different inbound update identity and may be answered from current undeleted sources; replay of the original update cannot recreate deleted text. Tests must spy on router, Q&A, LLM, source mutation, scheduler and sender and prove all zero calls after redaction, both with and without a processed-update row.

### Retention defaults

| Data class | Retention |
|---|---|
| Canonical WHOOP records | Existing source policy; Phase 4 does not use journal deletion to erase independent canonical facts |
| Active journal normalized fact | While active or until the account’s existing retention policy removes it |
| Raw journal answer excerpt | 90 days maximum, or immediate redaction on correction/deletion |
| Deleted-journal tombstone | While the tenant account exists, to prevent resurrection; contains no health content |
| Body Energy exact results and optional checkpoint references | 400 days, unless referenced by a retained user-visible artifact; lookup barriers survive content purge |
| Evidence runs/items and episode history | 400 days after terminal state; longer only while referenced by a current insight |
| Retired insight revisions | 400 days after retirement |
| Outbound plaintext payload | 90 days after terminal delivery state |
| Outbound metadata, hashes, and reason codes | 400 days |
| Semantic reservations, semantic-event/request/answer IDs and keyed replay barriers | Tenant lifetime, with health content already purged at its shorter limit |
| telegram_operations completed receipt and redaction envelope | Tenant lifetime; result health content at most 90 days |
| Pending question content | Answer/expiry or 30 days, whichever first |
| Legacy derived analytics/experiment field groups/capability copies | Matrix limits; linked copies purge, independent experiment assertions are not unrelated Journal dependents |
| Purge replacement staging | Content transaction completion, hard maximum 30 days |
| Phase 4 job error detail | 30 days; aggregate operational metrics may remain without health content |
| LLM request/response content | Not stored as unrestricted logs; approved normalized result only |

Retention jobs are tenant-aware and idempotent. Source correction/deletion always overrides retention and “still referenced” exceptions; purge invalidates dependents instead of retaining deleted health content. Ordinary retention cannot silently remove support for a current artifact: first make it non-current/non-reproducible. Replay/reservation barriers outlive payload/history retention and are never freed by cleanup.

Full-account erasure is explicitly outside Phase 4. These defaults do not create an admin browsing entitlement.

### Correction, deletion, and purge transaction

Correction/deletion has a **durable admission transaction followed immediately by one synchronous content transaction**, not a fence that would vanish on rollback:

1. **Admission T0:** authenticate tenant/target/source-update idempotency; serialize on phase4_user_state. Increment purge_generation once, insert health_plaintext_purges ADMITTED, increment pending_purge_count, and commit. For correction only, persist the already validated new assertion in health_purge_replacements in T0; never store deleted old text in the ledger. Replaying T0 returns the same purge ID/generation. Do not acknowledge deletion complete yet.
2. **Content T1:** in one tenant-scoped transaction, lock the target revision and shared source generation; traverse complete source links across **both execution modes**, including TENANT_LEGACY copies but excluding unrelated independent experiment assertions. Apply J/P/D/O/G and field-scoped experiment redaction before unlinking. Delete Journal facts or insert the staged corrected ACTIVE revision and supersede/redact old revisions. Invalidate evidence/episodes/insights/decisions, redact pending/Telegram receipts and legacy copies. Invalidate unstarted outbox rows, CLOSE their reservations and cancel RESERVED question slots. For started/sent/ambiguous rows preserve transport/reservation truth and occupied answer-window slots, purge payload, prohibit retry and never free the slot early. Delete correction staging. Increment shared source_generation and each existing mode's input_generation once, set source_generation_seen, write that mode's FULL_TENANT_RECOMPUTE invalidations/jobs, and replace linked legacy/Phase 4 physiological ranges exactly per SCOPE. Preserve completed progress and existing legacy requested generation; never activate Phase 3. Commit ledger state DB_REDACTED. All redacted rows/groups record the same purge_generation/reason and deletion timestamp where applicable.
3. **Cache completion:** publish tenant/purge-generation eviction and cancel in-flight health contexts not past a provider start. Every cache access, derived commit, reply return and pre-send CAS checks current purge_generation and pending_purge_count in durable state; missing/unreachable state fails closed. No TTL-only authorization. A crashed process discards its memory; on restart its old contexts are never restored. Retry eviction until every live process acknowledges or its bounded cache lifetime/worker lease has expired and the new generation is observed; mark CACHE_CONFIRMED.
4. **Completion T2:** verify DB redaction postconditions, source unlinking, staging absence and cache acknowledgments; CAS ledger to COMPLETE and decrement pending_purge_count exactly once. Reads resume only when the count is zero, using current unredacted sources. Known external log/backup copies requiring cleanup are separately reported; do not claim their erasure from a DB/cache success.

**Existing inbound transaction integration:** src/db.js currently wraps handler action plus telegram_operations receipt in processTelegramOperation. T0 must not be nested inside that transaction, or its fence would roll back with T1. Stage 4 routes authenticated correction/deletion control operations through a dedicated purge-command adapter after inbound identity/lease checks and before the ordinary action wrapper. T0 commits independently under the same tenant/target authorization and source-update key. T1 commits the content mutation and the originating operation's COMMITTED receipt together; its result is only a fixed non-health acknowledgment, never a copy of removed values. Normal reply delivery remains fenced until T2. A duplicate with an ADMITTED ledger resumes that purge, not the original handler/LLM; a duplicate after T1 reads the receipt and resumes only cache completion if needed. A receipt redacted by another source purge obeys the no-op contract above. No nested-transaction shortcut or second action execution is permitted.

**Fail-closed read predicate for R-bearing health rows:** authenticated owner AND content_state = PRESENT AND source_linkage_state = COMPLETE AND health_content_redacted_at IS NULL AND tenant.pending_purge_count = 0 AND captured tenant.purge_generation = current tenant.purge_generation, plus existing lifecycle/auth/input/currentness rules. Canonical v20 rows have no R columns: they use the same tenant purge fence plus their tombstone/as-of/source-selector rules. Non-health receipt/reservation status reads remain available for no-op replay, never to expose redacted payload.

A retained row need not have been created in the latest purge generation; its complete source links and T1 traversal establish that unaffected content is safe. Caches/transactions capture the latest tenant fence. Ordinary health writes/derived commits are also fenced while a purge is pending; durable incoming ingestion work can wait without loss or Phase 3 activation. Only the scoped purge worker may read target/staging content under the fence. Authenticated correction/deletion control requests may admit another purge, but cannot use that authority for ordinary health reads.

A T1 error rolls back all content mutations but **does not roll back committed T0**. The tenant remains fenced in ADMITTED, including after process restart. Record only last_error_code/attempt outside the failed transaction, retry the same source traversal, never re-run an LLM or original user action. Crash after T1 resumes cache completion, not content regeneration. Crash after T2 sees COMPLETE and is a no-op. Concurrent purges serialize per tenant and count independently; no partial purge is health-readable. Migration/privacy adapters are fail-closed if any required table/column/link is absent.

Concurrent delivery takes the same tenant/semantic lock and checks the purge fence. Purge winning before DELIVERY_STARTED prevents send and clears any loaded payload on the worker. A provider call already started cannot be recalled reliably; redact local payload and keep the state until delivered/definite/ambiguous classification. If it later reports definite failure after content was redacted, transition to FAILED_TERMINAL/CLOSED, never retry. DELIVERED/AMBIGUOUS always stay CONSUMED. An in-flight worker may hold transient bytes until cancelled/settled; CACHE_CONFIRMED cannot be claimed while those contexts remain live.

No redacted evidence/result/episode/insight/decision/message is refilled. Deterministic recomputation creates new artifact revisions from current sources after the fence clears; it cannot reconstruct erased inputs, revisit old Telegram actions, or bypass consumed/closed semantic keys. Mutable job/invalidation scope is the explicit new-generation queue exception, not retained health history.

Deletion from Kelvin Health OS storage and invalidation of local derived data are enforceable. A Telegram message already accepted by the provider or stored in a user-controlled client cannot be assumed retractable or deletable; the product must disclose that limitation. No tombstone, AMBIGUOUS row, prompt trace, log, or cache may retain deleted health plaintext.

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
- request, select, or access another tenant or an administrator-wide health context; an optional wording call for Owner Monitoring receives only the already authorized bounded claim plan and cannot choose the subject, source, scope, or destination.
- treat Journal/Q&A text as executable instructions;
- provide or override tenant IDs, lifecycle/auth context, policy, tool arguments, destinations, feature flags, or send authority.

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

### Structural prompt boundary

Untrusted Journal/Q&A text must never be concatenated into a system or developer instruction string. The model call uses role-separated messages or an equivalent typed envelope with:

- immutable server-owned system/developer instructions;
- server-owned tenant, lifecycle/auth, purpose, and policy context outside user-controlled fields;
- user health text in a dedicated bounded data field or user-role message;
- explicit quoting/delimiting and escaping for any health excerpt;
- closed JSON/schema-validated inputs where a structured candidate is expected;
- closed JSON/schema-validated outputs, length bounds, and allowlisted enums;
- no tool, database, network, scheduler, or send capability attached to the parsing/wording model call.

User text that contains a tenant ID, policy instruction, role marker, JSON tool call, destination, feature flag, or “ignore previous instructions” content remains quoted data. It cannot populate server-owned fields. Any envelope/schema separation failure, parse ambiguity, unknown field, or attempted authority override fails closed without a fact, decision, tool call, or message.

### Minimum context

The LLM receives a purpose-specific projection. For example, question wording receives the selected candidate key and allowed neutral facts, not the entire health history. Q&A wording receives an approved claim plan and citations, not database access.

No access token, webhook secret, Telegram secret, external authorization code, raw database connection, or cross-tenant batch is included.

Prompt fields have per-schema size limits; truncation is deterministic and cannot remove the delimiter or change field roles. Prompt/request logging stores only template/model/schema versions, opaque artifact IDs, sizes, and outcome codes, never the health-text envelope.

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

The following **13 currently implemented Foundation flags** are parsed and fail closed by current runtime code: each is false when absent, malformed, or unsupported.

- **PHASE4_SCHEMA_WRITES**
- **PHASE4_JOURNAL_REVISIONS**
- **PHASE4_BODY_ENERGY_SHADOW**
- **PHASE4_EVIDENCE_SHADOW**
- **PHASE4_EPISODES_SHADOW**
- **PHASE4_REANALYSIS_WORKER**
- **PHASE4_INSIGHT_MEMORY**
- **PHASE4_PROACTIVE_DECISIONS_SHADOW**
- **PHASE4_OUTBOUND_PROPOSALS_SHADOW**
- **PHASE4_DELIVERY_CUTOVER**
- **PHASE4_OUTBOUND_DELIVERY**
- **PHASE4_MORNING_BRIEF**
- **PHASE4_QA_CONTEXT**

The v25/v26 locked-scope extensions reserve these future default-off controls; they do not exist and have no consumers in current runtime code:

- **PHASE4_QUICK_ACTIONS**
- **PHASE4_OWNER_MONITORING**
- **PHASE4_OWNER_MONITORING_DELIVERY**

Dependencies among the 13 implemented flags are enforced in current code. For example, outbound delivery requires schema writes, reanalysis, episodes, evidence, non-shadow decisions, authoritative PHASE4 tenant mode, passed conjunctive release-gate record, and explicit operation authorization. An invalid implemented-flag combination fails closed and emits configuration diagnostics. Pre-gate builds may write shadow proposals but have no configured provider adapter.

The three future names are specification reservations, not evidence of mechanical runtime enforcement. Until their v25/v26 stages implement both the controls and their dependency checks, the associated entry points, stores, callbacks, owner capability, and delivery routes must be absent/unreachable. Absence therefore means unavailable, never implicitly enabled.

Flags do not classify stored rows. Restart under a different flag set cannot publish SHADOW data: every reader/claim revalidates durable execution_mode and the entire same-mode ancestry. Enabling a future LIVE factory requires fresh authorized LIVE computation, not a SHADOW-to-LIVE UPDATE. During Foundation, **all 13 implemented flags remain off**, and the three future controls and their runtime paths remain unimplemented; internal tests invoke isolated stores/calculators with synthetic context, no scheduler or dispatcher registration.

There is no flag that aliases or enables the Phase 3 analytics worker. Phase 4 names, job kinds, and drain functions remain separate.

### Conjunctive release gate

Until all four conditions below are true:

1. V1.2 production observation gate is PASS;
2. Phase 4 independent Final Gate is PASS;
3. the Architecture Owner approves release;
4. Kelvin explicitly authorizes the specific production operation;

all of the following are prohibited:

- merging any Phase 4 code or schema into main;
- deploying any Phase 4 code or schema;
- running any production migration;
- enabling any production flag;
- sending any real Telegram Phase 4 message;
- test-user delivery, canary delivery, or production delivery.

This is one conjunctive gate, not four interchangeable approvals. Evidence for every condition must be recorded in the release package. Absence, expiry, or revocation of any condition keeps the gate closed.

### Pre-gate work sequence

Before the conjunctive gate passes, work is limited to:

1. local implementation on the Phase 4 branch after its stage is authorized;
2. local tests and synthetic fixtures;
3. populated-v20 migration rehearsal on non-production copies;
4. historical replay on non-production copies;
5. calculation-only evaluation;
6. shadow reanalysis;
7. shadow decisions and separately enabled local shadow-proposal evaluation; LIVE proposal creation, LIVE attempts and provider sending technically impossible;
8. independent review;
9. freeze-candidate preparation and Final Gate evidence packaging.

No real destination binding or Telegram send capability is available to pre-gate shadow processes. A configuration mistake must fail startup rather than convert shadow mode into delivery.

### Post-gate production activation plan

This plan is documentation only and grants no authority. After the conjunctive gate passes, a new explicit Kelvin authorization must name each operation:

1. revalidate all four gate conditions and freeze-candidate commit;
2. rehearse the exact migration and rollback/forward-fix plan on a current non-production copy;
3. deploy schema-compatible code with all Phase 4 behavior and delivery flags off;
4. run the specifically authorized production migration;
5. verify postconditions and keep delivery off;
6. activate tenant/message-family cutover for an explicitly authorized internal cohort;
7. enable test-user delivery, then canary delivery, only under separate named approvals and stop criteria;
8. expand only after reviewed canary evidence.

Tenant cohorts are explicit allowlists or stable hashes, never inferred from health status. Section 10 is the approved scheduler design; applying its Cloudflare/GitHub/watchdog configuration remains a separate named production operation requiring the full conjunctive gate and explicit Kelvin authorization.

### Kill switches

Independent switches must stop:

- queue claims;
- outbound claims;
- Morning Brief claims;
- Quick Action issuance/new callback mutation while preserving authenticated correction, deletion, replay, and privacy completion paths;
- Owner Monitoring authorization/claims and, independently, owner-directed delivery;
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
- Quick Action completion, stale/rejected callback, replay-deduplication, correction, undo, and free-text-fallback rates;
- proposals per tenant with abnormal-volume breaker trips;
- delivery definite failure and ambiguity rates;
- Morning Brief due, claimed, delivered, ambiguous, and outage-expired counts;
- owner follow changes and owner notification class/outcome counts, with no health values or plaintext;
- scheduler success and durable-backlog age by Cloudflare-morning, GitHub-hourly, and event-driven class, plus cadence-aware watchdog alerts;
- stale-read blocks and cross-tenant invariant violations.

Health values and message text are excluded from operational metrics.

## 18. Test strategy and final gate

### Unit and property tests

Body Energy:

- body-energy-v1.2.0 exact required-domain formula, initial40–100/intraday0–100, full-precision arithmetic and Math.round examples;
- canonical main-sleep and matched-recovery selectors use actual v20 fields; same-day ties, naps, scoring/calibration, tombstones, sync/as-of fences, corrections and health-date mismatches;
- each missing required component/baseline yields null; required arrival is null-to-valid; contextual Recovery never changes a valid score/quality/confidence;
- Recovery-score exclusion and duplicate-source-dominance fixtures;
- current-cycle row selection, absent-store-method failure, workout fallback, crossing-wake/ongoing-workout exclusion, and no cycle/workout double counting;
- mutually exclusive UNAVAILABLE/NO_DATA/DEGRADED/WARMING_UP/LIMITED/AVAILABLE precedence for every overlap;
- persisted-manifest audit versus corrected-current recalculation and pre-snapshot overwritten-source non-reproducibility;
- monotonic depletion and strain properties;
- qualified-nap uniqueness and bounds;
- exact reproduction from stored manifests;
- algorithm-version separation;
- exact-result uniqueness: 12:00 and 12:14 in one bucket create distinct result IDs and preserve different time-depletion values; identical exact tuple replay/concurrent insert returns one ID; same exact instant/new input_generation creates a distinct revision;
- two checkpoint workers converge on the same PERIODIC_15M reference/exact closing-instant result; Q&A at a different instant and a checkpoint never overwrite one another; same-instant consumers cite the exact same result row;
- checkpoint reuse discloses original exact as-of/freshness; late correction preserves citations or returns CONTENT_REDACTED and never retro-notifies;
- shadow publication gates for correlation matrix, ablation, sensitivity, distribution/range, missingness, and duplicated-evidence dominance.

Time and scheduling:

- IANA timezone changes;
- spring-forward nonexistent time;
- fall-back duplicated time;
- UTC elapsed hours across both transitions;
- health-day and one semantic-reservation identity;
- Asia/Taipei 08:00 inclusive and 12:00 exclusive boundaries, every-10-minute Cloudflare eligibility only inside the window, no Cloudflare stale alert outside it, and the no-DST UTC mapping 00:00–03:50;
- deployment/runbook inspection asserts the actual Cloudflare trigger is exactly `*/10 0-3 * * *` and rejects `*/10 8-11 * * *`; an application predicate test alone cannot pass the scheduler gate;
- a non-Taipei user's due time outside the global window follows normal GitHub-hourly detection without any equal-10-minute-latency claim or implicit per-user Cloudflare schedule;
- GitHub hourly as the normal outside-window background driver with delayed-start tolerance rather than an exact-hour SLA;
- missed, delayed, failed, overlapping, and recovered runs drain durable webhook, invalidation, reanalysis, maintenance, and reconciliation backlog without loss or false completion;
- event-driven ingress may wake Render while a GitHub background run never needs to wake it; every path converges through the same canonical runner.

Meaningfulness and episodes:

- robust baseline and zero-scale fallback;
- open/close hysteresis;
- merge, split, resolution, expiry, reopen, invalidation;
- expiration from every active state, including ESCALATED and STABILIZING;
- atomic direction reversal and temporary oscillation without dual active directions;
- EXPLAINED cannot commit before current evidence/context;
- diagram/table transition edge sets exactly match, with no self-transition entries/arrows;
- same_state_revision for every active state increments CAS/event once, preserves hysteresis/stabilization/history, and creates no novelty absent registered MATERIAL_ESCALATION;
- last delivered notification excludes SUPPRESSED, FAILED_TERMINAL, INVALIDATED, and AMBIGUOUS;
- USER_DISMISSED atomically retires the insight with its disposition;
- concurrent identical opens converge;
- stale generation cannot commit.

Journal and context:

- source replay returns the same fact;
- correction creates one active revision and invalidates old consumers;
- deletion removes all health content and leaves only the permitted tombstone;
- known context excludes redundant questions;
- EXPOSED, CONFIRMED_UNEXPOSED, and UNKNOWN parser/storage/alignment/correction/deletion behavior;
- an absent log and a different logged factor remain UNKNOWN;
- exactly one highest-utility eligible question;
- presentation-label changes/localization preserve the same canonical Quick Action value and evidence grouping;
- button selection uses no LLM classification and atomically creates exactly one existing Journal logical fact with Journal-side `quick_action`/`TRUSTED_REGISTRY` provenance;
- the server resolves opaque callback → authenticated interaction → versioned allowlisted registry choice; forged callback labels/canonical fields and caller-selected provenance modes reject;
- a pure button fact stores null `raw_answer_excerpt` and never fabricates source text; genuine supplemental text alone receives an excerpt and user-text validation;
- v25 backfill mechanically classifies proven bot-question/free-text/manual rows and assigns ambiguous rows `legacy_unverified`/`LEGACY_UNVERIFIED`, never registry trust;
- Telegram double-click, duplicate update, provider retry, process restart, and callback replay return one result with one generation advance;
- callback ownership rejects tenant/destination mismatch, and expired/replaced interactions reject stale selections;
- “running now” uses authenticated receipt time while “yesterday” preserves the server-issued target date/window and records a distinct answered time;
- Quick Action correction creates the existing revision semantics and Undo invokes the existing deletion/tombstone semantics without a second evidence system.

Evidence and insights:

- future leakage prevention;
- sample and effect floors;
- insufficient confirmed-unexposed samples prohibit comparative effect calculation;
- UNKNOWN-day exclusion and selection/ascertainment-bias fixtures;
- unknown-promotion-confound-v1: fractions 0, 0.49, 0.50, 0.51, 1.0 and zero denominator, with sample/confound gates tested independently; out-of-window/ineligible days excluded, correction/deletion recomputes numerator/denominator and invalidates promotion;
- complete multiple-testing families and Benjamini–Hochberg fixtures;
- hard and soft confound classification and confidence caps;
- no single-day or single-answer promotion;
- compatible-version enforcement;
- reject, refute, expire, invalidate, and supersede behavior.

Policy:

- exact four-action exhaustive output;
- no normal count-cap branch;
- ASK failure never mutates to NOTIFY;
- exact question_utility_v1 component lookups, bounds, missing behavior, threshold, and tie-break;
- counterfactual_decision_impact_v1 all five D outcomes and first-match precedence, identical snapshots, branch signatures and version persistence;
- question selection/ASK removed from branches; spies prove no question_utility_v1 recursion, persistence, jobs, LLM, proposals or sends;
- question and notification evaluated independently;
- semantic novelty and actionable-transition behavior;
- abnormal circuit breaker has an explicit incident reason.

Delivery:

- crash before claim, after claim, before start, after start, after provider acceptance, and before result commit;
- definite versus ambiguous provider failures;
- payload immutability across retry and mandatory redaction on source deletion;
- lifecycle, pause, and stale-decision suppression;
- lifecycle transition after provider acceptance/lost response remains AMBIGUOUS and non-retryable;
- AMBIGUOUS semantic reservation suppresses later decisions with new IDs/generations;
- all seven canonical key builders exclude decision/job/attempt/generation/algorithm/payload/wording values;
- atomic episode-event creation, question request allocation before decision, ordinal/source-receipt replay, semantic answer correction versus equivalent wording, finite fixed followup_kind;
- CLOSED invalidated/suppressed/exhausted keys cannot be replaced; 400-day history cleanup never frees tenant-lifetime reservations/receipts;
- legacy proactive versus Phase 4 semantic-duplication prevention;
- legacy Morning Brief versus Phase 4 local-health-date reservation prevention;
- atomic cutover deferral for in-flight/ambiguous legacy delivery and reversal only before Phase 4 start;
- narrow V1.2 report-claim duplicate reproduction: accepted provider send, lost response, lifecycle transition, reclaim;
- pending projection opens only after confirmed matching LIVE delivery; the tenant/mode slot already exists before start;
- two different episodes/factors/kinds/windows compete under the same tenant/mode: exactly one selection/request/reservation/proposal transaction wins; the loser's transaction leaves no partial rows;
- slot rechecked at provider start, lifecycle/auth change, retry/takeover and pending open/update; stale CAS cannot release a newer request;
- AMBIGUOUS_WAIT blocks a different question for the complete 30-minute window, accepts only explicit matching structured answers, survives restart/pause/disable/resume without resend, and expires without freeing its consumed key;
- definite pre-send failure and unstarted invalidation cancel the slot; proven provider non-acceptance terminates a question without retry; confirmed/unanswered delivery expires conservatively;
- answer replay/correction versus expiry/new occupant, legacy OPEN/experiment flow versus Phase 4 selection, legacy in-flight/ambiguous cutover, and tenant A versus tenant B;
- SHADOW and LIVE same-tenant slots/reservations do not block one another; SHADOW cannot project real pending state;
- no direct Telegram capability in reanalysis modules.

Privacy and Q&A:

- cross-tenant property tests across every store method;
- ordinary Alice/Bob/self Q&A and store paths cannot invoke or forge Owner Monitoring authority;
- only the configured Kelvin owner principal plus an active subject/class subscription can create a dual-principal authorization; revocation, stale subscription revision, wrong destination, or either principal's stale generation fails closed;
- Owner Daily Summary, Important Alert, and Weekly Summary consume only an approved current synthesized artifact or an approved bounded deterministic summary plan, identify the subject explicitly, route to Kelvin, and record capability/reason/artifact-or-plan audit without unrestricted raw browsing;
- absent/stale artifact or plan, wrong subject/class/subscription revision, disallowed plan input, wrong owner destination, or missing audit provenance fails closed with no owner message and no raw/Journal/SQL fallback;
- subject correction/deletion invalidates/redacts linked unsent owner content while preserving non-health authorization/transport audit and the external-copy limitation;
- third-party and general evidence questions cannot load self context;
- specialized handlers cannot precede the perspective gate;
- deleted, superseded, expired, invalidated, or generation-stale artifacts are absent;
- deletion purge/redaction fixtures cover every row in the Section 15 plaintext matrix, AMBIGUOUS rows, caches, prompt material, and injected partial failures;
- telegram_operations complete-result sentinel and owner backfill, duplicate update with pruned processed row, and zero router/Q&A/LLM/mutation/send calls after redaction;
- pending_questions all five health fields, proactive_events all three plaintext/JSON copies, health_insights NOT NULL sentinels and derived statistics purge;
- every R field, nullable content and physical-delete exception; no reconstructable health value remains in envelopes/hashes or source links;
- crash after T0 leaves a durable fence; T1 rollback, correction staging/retry/expiry, crash after DB_REDACTED, cache loss/ack, T2 idempotent completion and simultaneous deletion/correction/send;
- existing processTelegramOperation integration cannot nest/roll back T0; T1 mutation/receipt atomicity and ADMITTED duplicate replay bypass the original action;
- legacy TENANT_LEGACY traversal, unowned receipt/diagnostic quarantine, full field inventory coverage, health-log allowlists and external-copy deletion disclosure;
- scope privacy: delete while analytics invalidation is pending, delete after a partial range, crash after T0/before T1 replacement and restart; no old affected_from/to or range_from/to survives completed T1, requested progress is preserved and completed progress does not advance;
- FULL_TENANT_RECOMPUTE remains pending with null dates and even equal requested/completed generations; all freshness/Q&A/store readers honor scope precedence, old claims lose scope/purge CAS and spies prove zero Phase 3 invocations;
- a separately authorized synthetic worker later consumes FULL by scanning all retained current tenant sources, not an anchor/old range; only whole-pass same-generation success clears it; new mutation/restart cannot skip work;
- experiments: unrelated Journal deletion preserves verified independent definition/intervention/protocol/schedule; linked derived result redacts; ambiguous legacy result immediately quarantines/redacts without losing proven direct fields; copied hypothesis and independent name within DEFINITION have different purge outcomes;
- experiment owner-only reads and cross-user link rejection; explicit whole-experiment deletion purges its own four groups/assertions and dependents; Journal deletion is not whole-experiment or account erasure;
- prompt injection in Journal and Q&A text remains role-separated data;
- tenant-ID, policy, destination, feature-flag, and tool-argument override attempts fail closed;
- Q&A cannot create an outbound proposal or invoke scheduler, dispatcher, or send paths;
- logs and metrics contain no raw health or answer text.

Identity presentation:

- Kelvin brief resolves Kelvin, Alice brief resolves Alice, and Bob brief resolves Bob from each recipient's own identity scope;
- Alice cannot inherit Kelvin and Bob cannot inherit Alice across batching, cache reuse, retries, or missing candidate fields;
- a missing/unproven-name user receives a neutral unnamed greeting;
- explicit name overrides authenticated Telegram `first_name`, which overrides the same user's WHOOP profile first name;
- an owner-directed message can name the monitored subject while retaining Kelvin as recipient, without changing either principal's authority or identity semantics.

### Migration tests

For every post-v20 migration:

- clean v20 to target;
- empty database to target;
- a populated v20 fixture;
- stop after each DDL, column, backfill, and index statement, then rerun;
- rerun after complete success;
- duplicate/invalid legacy fixture fails before unique index and before version row;
- interruption/restart and exact version-row advancement are tested independently at v21, v22, v23, and v24;
- each store-invariant-matrix row tests tenant parent, generations, parent currentness, immutable fields, CAS, orphan prevention, cross-tenant rejection, and purge/invalidation;
- populated v20 health_insights become LEGACY_UNVERIFIED and never Phase 4 promoted/current;
- R expansion table exactly matches all v22 legacy and v23/v24 new objects; safe NOT NULL sentinels, D-table uniqueness, owner attribution and source linkage postconditions;
- old application can inspect v20 fields during expand only; after purge admission only a privacy-compatible binary may read/serve, including rollback;
- new application with behavior flags off changes no user-visible behavior.

Durable SHADOW/LIVE isolation tests additionally cover every M table and source-link edge: restart with changed runtime flags; LIVE Morning Brief/Q&A/dispatcher exclusion of SHADOW parents; null/unknown/mixed-mode rejection; independent current pointers/generation completion/leases; identical semantic keys in separate modes; mode UPDATE rejection; default SHADOW insert; LIVE-only attempts plus server-owned capability; source purge through both modes; and algorithm-version recomputation without cross-mode cache/dedup leakage. Pure synthetic LIVE tests cannot issue real capabilities.

Foundation migration tests stop/rerun at every internal boundary: complete v21, complete v22, **all** v23 objects (not only Body Energy), then **all** v24 objects including SCOPE/modes/slots. Missing one postcondition leaves that version unrecorded. Stores/T0 admission/calculator persistence/Journal correction must refuse an incomplete v24 schema. Tests verify later Intelligence/Delivery packs consume already installed tables, do not retroactively finish a recorded version, and all flags/Phase 3/dispatcher/provider wiring remain off throughout Foundation.

### Integration and end-to-end tests

- webhook or sync semantic change to observation selection to evidence run to episode transition to insight update to decision to proposal, with no send;
- journal answer, correction, and deletion through complete propagation;
- active-ready-unpaused Morning Brief with complete, partial, and wholly missing health data;
- pause or lifecycle change at every delivery boundary;
- reconciliation correction of a previously messaged episode;
- inbound Q&A reply deduplication with durable evidence citations;
- two workers contending for the same job, episode, decision, and message;
- release configuration tests require all four conjunctive gate conditions and prove any missing condition prevents merge/deploy/migration/flag/send authorization;
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

The Phase 4 Final Gate evidence package requires:

- all preceding stages are complete;
- shadow replay mismatch is zero for fixed fixtures;
- no unresolved cross-tenant or deleted-data finding exists;
- delivery ambiguity and abnormal-volume behavior are exercised;
- runbook and kill switches are verified;
- product wording and privacy review are approved;
- Phase 3 remains demonstrably dormant.

Passing this technical list does not authorize a user-facing flag. Real flags, migrations, merges, deployments, test-user messages, and canaries remain prohibited until all four Section 17 conjunctive conditions are true and the specific operation is explicitly authorized.

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

### Historical Stage 1 documentation gate

This gate governed the original pre-Foundation architecture stage and is retained as historical rationale, not as a claim that Foundation is still prohibited or as the current push instruction. It required:

- all 19 required sections present;
- internal paths and named behaviors checked against the baseline;
- formulas, states, migrations, ownership, and failure behavior explicit;
- complete existing test suite passes under Node 22;
- clean diff contains no source, schema, test, configuration, workflow, or package change;
- local commit only, with no push or deployment.

Cycle 3 read-only architecture fixtures exercise the specified keys/transitions in ephemeral models (including in-memory uniqueness/transaction rollback), not repository implementation or production migrations. Preserve the earlier formula/quality/main-sleep/matched-recovery/current-cycle contracts, pure D evaluator, UNKNOWN threshold and exact episode diagram/table parity.

**Two self-review passes before this repair can be called ready:**

| Counterexample pass | Required closed outcome |
|---|---|
| Different exact calculations in one 15-minute bucket; identical retry | Distinct exact IDs for different instants, one winner for identical tuple; no checkpoint collision |
| Different question requests race | One tenant/mode slot, atomic loser rollback before any send |
| Question acceptance lost, pause and resume | AMBIGUOUS_WAIT survives, blocks a different request until explicit answer/expiry, permanent consumed key |
| Journal deletion while legacy range is pending/partially processed | All linked dates null + FULL marker; requested retained, completed unchanged, no Phase 3 call |
| Crash between purge admission and scope replacement | Durable T0 fence prevents any health read; retry same T1 |
| Restart with SHADOW rows and LIVE reader flags | Durable mode and ancestry exclusion; no promotion UPDATE or real attempt |
| Same semantic key, one SHADOW and one LIVE | Independent reservations/slots/generations, no cross-mode blocking |
| Unrelated Journal deletion beside direct experiment definition | Verified independent groups survive; linked result alone redacts |
| Ambiguous legacy experiment group | Immediate group quarantine/redaction, no unproven plaintext or whole-row loss of proven assertions |
| Body-only migration or v22 purge depends on v24 | Version withheld until complete objects; Foundation persists full v21–v24 before runtime T0/stores/Body/Journal |

The second pass checks the exact M/R/SCOPE expansions, PK/unique predicates, typed fields, slot transitions/deadlines, experiment group mapping/read precedence, eight Foundation commit boundaries, all local links and changed-file scope. Any unresolved choice of column, identity, purge boundary or transition is HOLD, not an implementation decision deferred beyond this ADR.

The 2026-09-25 locked-decision amendment gate was documentation-only: no runtime/schema/test/config/workflow change; explicit current-vs-future status; no false implementation claim; all feature flags remained disabled; whole-ADR contradiction audit complete; exactly one commit on `v1.2-phase4` and only that branch pushed. Passing that historical gate did not itself start Stage 5 or replace the Foundation review that was pending at that checkpoint.

## 19. Implementation stages and dependency graph

Stages 2–4 form the implemented **Foundation Pack**, Stages 5–6 the Intelligence Pack, and Stages 7–8 the later Delivery Pack. These names are planning boundaries, not authorization. Foundation is present on the isolated branch, default-off and SHADOW-only, and its aggregate independent review passed. Stage 5 was then explicitly authorized and is implemented SHADOW-only; it still requires its own independent review. Stage 6 has not started. An internal commit is not a separately approved production rollout.

### Dependency graph

~~~mermaid
flowchart TD
    S1[Stage 1 independent PASS plus new authorization] --> F1[Foundation 1 runner and complete v21]
    F1 --> F2[Foundation 2 complete v22 and privacy backfills]
    F2 --> F3[Foundation 3 complete v23 all intelligence tables]
    F3 --> F4[Foundation 4 complete v24 including slots and modes]
    F4 --> F5[Foundation 5 scoped stores and privacy compatibility]
    F5 --> F6[Foundation 6 Body Energy exact persistence]
    F6 --> F7[Foundation 7 Journal revisions and purge]
    F7 --> F8[Foundation 8 aggregate crash privacy and migration tests]
    F8 --> FG[One aggregate independent Foundation review]
    FG --> S5[Intelligence Stage 5 evidence episodes and insights]
    S5 --> S6[Stage 6 invalidation and reanalysis]
    S6 --> S7[Delivery Stage 7 v25 Quick Actions decisions and outbound delivery]
    S7 --> S8[Stage 8 v26 Owner Monitoring Brief Q&A and display names]
    S8 --> S9[Stage 9 shadow evaluation and freeze package]
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

### Foundation Pack: exact internal commit boundaries (implemented, default off)

The table below is the historical plan realized by the Foundation commits now on this branch. All eight boundaries remain disabled and require their targeted verification plus the complete Node 22 suite for aggregate review. No production migration, scheduler activation, dispatcher registration, real Telegram adapter/send path, or Phase 3 activation is in this pack. No v21–v24 version row may be written before **every** object, column, CHECK/trigger, backfill, unique/secondary index and postcondition assigned to that version is complete.

| Internal commit | Scope and dependency | Verification before commit |
|---|---|---|
| 1 | Restart-safe per-version migration runner/postcondition mechanism and **complete v21**, including SHADOW computation state; depends on independently approved ADR and explicit pack authorization | v20/empty/populated fixtures, stop/rerun each statement, exact v21 version advancement, all flags off |
| 2 | **Complete v22**, all Journal/context/answer/privacy objects, legacy R/SCOPE extensions, receipt ownership/no-op compatibility, experiment field-group classification/redaction; no runtime purge admission | Every legacy plaintext/group/range backfill, tenant ownership, interruption and v22 postconditions; v24-dependent runtime remains unavailable |
| 3 | **Complete v23**: exact Body results/checkpoints, evidence runs/items, episodes/memberships/events/semantic events, all insight revisions/current-pointer extensions and M/R/indexes | A missing evidence/episode/insight object prevents v23 advancement even when Body tables exist; mode/default/unique/legacy exclusion checks |
| 4 | **Complete v24**: invalidations/jobs/SCOPE, decisions, delivery modes, semantic reservations, interaction slots, proposals/outbox and LIVE-only attempts; all schema remains dormant | Slot identity, mode/attempt CHECKs, scope/privacy metadata, all postconditions; complete v21–v24 startup readiness verified |
| 5 | Tenant/mode-scoped stores/invariants, purge admission fencing, reader/writer/privacy compatibility adapters and experiment field projections, now using complete v24 storage | Mixed-tenant/mode rejection, R/SCOPE precedence, T0 survival, no-op receipts, legacy pending guard, no runnable dispatcher/provider path |
| 6 | Body Energy selectors/calculator/shared quality and exact-as-of persistence/checkpoint references | Full formula/selector/quality and replay suite, same-bucket identities, new generations, checkpoint races, SHADOW persistence only outside isolated synthetic LIVE fixtures |
| 7 | Journal revisions, tri-state context, answer lineage, correction/deletion T0/T1/T2 and logging allowlists, using existing v24 invalidations/slot/outbox fences | Full matrix/group/range purge, accepted-answer replay, no deleted content/cross-tenant access, zero Phase 3 calls; no proactive question delivery |
| 8 | Aggregate migration/privacy/tenant/mode/concurrency/crash-restart verification and Foundation review evidence | End-to-end synthetic v20→v24 rehearsal, every interruption point, all RC2 fixtures and prior regressions, flags off, no sends; submit **one** Foundation macro-stage for independent review |

Commits 1–4 test persistence contracts but cannot run Foundation runtime behavior; commit 5 refuses admission if any v24 postcondition is absent. Later Intelligence and Delivery packs implement behavior against the complete installed schema, never finish a partially marked version. The locked-scope requirements use the reviewed future v25 Stage 7 and v26 Stage 8 extensions in Section 14 rather than reopening completed versions. Each future version remains withheld until every assigned object, index, trigger, backfill, and postcondition is complete. This amendment changes documentation only and does not begin v25, v26, or Stage 5.

### Stage 2: additive storage and tenant-scoped stores

**Status:** IMPLEMENTED FOUNDATION; default off; aggregate Foundation review passed.

**Depends on:** independent Stage 1 PASS and explicit Foundation authorization; covers internal commits 1–5 in the fixed order above.

**Files/subsystems likely touched:** [src/schema.js](../src/schema.js), [src/migrations.js](../src/migrations.js), new tenant-scoped Phase 4 stores, and migration tests.

**Migration impact:** additive v21–v24 objects and nullable v20 extensions exactly as Section 14; no destructive reshape.

**Work:**

- implement v21–v24 restart-safe migrations in [src/migrations.js](../src/migrations.js) and additive definitions in [src/schema.js](../src/schema.js);
- add tenant-scoped store modules for Phase 4 state;
- implement every R expansion, legacy source-link/owner backfill, fixed-sentinel adapter, redacted-receipt no-op, purge admission/target/staging stores and canonical semantic-identity uniqueness;
- add application-enforced composite reference validation and integrity audit;
- leave all behavior flags off.

**Tests:** partial migration interruption, populated v20 privacy/owner backfill, safe sentinels, all R columns, no-op receipt replay, durable purge fences, semantic identity uniqueness, tenant isolation, privacy-compatible rollback.

**Output:** local-only disabled schema/store foundation with synchronous store invariants and defense-in-depth audit.

**Review focus:** no table reshape, no random backfill identity, no Phase 3 worker wiring, no user-visible behavior.

**Independent review gate:** migration/data-integrity and multi-user-isolation evidence goes into the one aggregate Foundation review after internal commit 8; no partial version approval.

**Explicit non-goals:** calculators, reanalysis, Q&A, message proposals, sends, or flag activation.

**Exit gate:** migrations converge from every tested interruption point and full Node 22 suite passes.

### Stage 3: Body Energy and shared quality

**Status:** IMPLEMENTED FOUNDATION; SHADOW-only; aggregate Foundation review passed.

**Depends on:** complete v21–v24 and Stage 2 stores/privacy compatibility (Foundation internal commit 5); this is internal commit 6.

**Files/subsystems likely touched:** new Body Energy and quality modules/stores, plus adapters around [src/store.js](../src/store.js), [src/time.js](../src/time.js), and [src/readiness.js](../src/readiness.js).

**Migration impact:** use v23 Body Energy tables from Stage 2; no new migration unless the ADR is amended first.

**Work:**

- implement body-energy-v1.2.0 and its exact main-sleep/matched-recovery selectors, required domains and full-precision calculator;
- implement earlier-only robust baselines, quality envelope, provenance manifests, and result persistence;
- add synchronous bounded reads for shadow evaluation;
- expose no user-facing value yet.

**Existing boundaries reused:** canonical reads from **createHealthStore**, timezone utilities in [src/time.js](../src/time.js), readiness vocabulary in [src/readiness.js](../src/readiness.js).

**Tests:** every Section 3 property, non-overlap/load/quality matrices, DST fixtures, retained-input replay, canonical tombstone/freshness/lifecycle filters, and publication-gate analyses.

**Output:** calculation-only, persisted shadow results with provenance.

**Review focus:** no LLM or journal input, no future leakage, no double-counted strain, label never implies WHOOP ownership.

**Independent review gate:** formula, physiology-language, reproducibility and temporal-integrity evidence in the aggregate Foundation review after commit 8.

**Explicit non-goals:** user display, episodes, proactive decisions, or delivery.

**Exit gate:** fixed-fixture calculation and stored-hash-context replay are byte-identical, shadow results have complete provenance, and publication remains prohibited pending every Section 3 publication gate.

### Stage 4: structured journal and context

**Status:** IMPLEMENTED FOUNDATION for persistence/validation/correction/deletion/answer lineage; Quick Action UI/callback runtime is not implemented and belongs to Stage 7.

**Depends on:** complete v21–v24, Stage 2 compatibility and internal commit 6; this is Foundation internal commit 7, followed by aggregate verification commit 8.

**Files/subsystems likely touched:** [src/journal.js](../src/journal.js), journal store/router paths, context-question store, inbound processing, and their tests.

**Migration impact:** use complete v22 Journal/context and v24 invalidation/job/slot/outbox tables already installed by Stage 2; no destructive rewrite and no privacy admission against v22 alone.

**Work:**

- dual-write logical fact identity and source idempotency;
- implement tri-state exposure/coverage, accepted answer events, and T0/T1/T2 correction/deletion purge with redacted-receipt no-op replay;
- add context-question provenance while retaining **pending_questions** as conversation state;
- wire the complete legacy/plaintext inventory adapters and health-log allowlists; no privacy activation before all readers honor the durable purge fence;
- add current ACTIVE-fact reads.

**Existing boundaries reused:** [src/journal.js](../src/journal.js), inbound update idempotency in [src/bot/updateProcessor.js](../src/bot/updateProcessor.js), shared transactions.

**Tests:** replay, exposure tri-state, concurrent corrections, delete-versus-answer/send race, every plaintext-matrix location, partial purge failure, minimal tombstone inspection, raw excerpt bounds, immediate fail-closed reads.

**Output:** tenant-scoped versioned facts, correction/deletion, and typed question provenance behind flags.

**Review focus:** deletion leaves no health content, LLM parse remains a candidate only, existing journal readers remain compatible.

**Independent review gate:** privacy/deletion, parser-authority and cross-user evidence in the one aggregate Foundation review after commit 8.

**Explicit non-goals:** evidence promotion, proactive questions, outbound delivery, or account erasure.

**Exit gate:** correction/deletion currentness and idempotency pass under concurrency.

### Stage 5: evidence, episodes, and insight memory

**Status:** IMPLEMENTED SHADOW-ONLY; Stage 5 RC1 blocker repairs complete and awaiting independent Stage 5 RC1 review.

**Depends on:** aggregate Foundation PASS covering Stages 2–4 and all eight internal commits, plus explicit Intelligence Pack authorization. Both prerequisites were satisfied for this implementation checkpoint.

**Files/subsystems likely touched:** new evidence/episode stores and domain modules, [src/evidence.js](../src/evidence.js), [src/healthMemory.js](../src/healthMemory.js), and approved adapters around [src/analyze.js](../src/analyze.js).

**Migration impact:** use v23 evidence, episode, and insight structures; no Phase 3 table repurpose.

**Work:**

- register evidence methods and persist runs/items, including confirmed-unexposed classification and unknown-promotion-confound-v1 threshold/run fields;
- implement metric registry and meaningful-change calculation;
- consume durable evidence in legal state changes or same_state_revision, atomically create eligible semantic events, then update insight memory;
- adapt eligible existing analysis functions without enabling Phase 3.

**Existing boundaries reused:** deterministic card presentation in [src/evidence.js](../src/evidence.js), status concepts in [src/healthMemory.js](../src/healthMemory.js), selected calculations in [src/analyze.js](../src/analyze.js).

**Tests:** temporal integrity, UNKNOWN selection bias, multiple comparisons/confounds, episode reversal/expiry/race convergence, insight promotion floors and USER_DISMISSED, legacy-insight exclusion, correction invalidation.

**Output:** deterministic shadow evidence, episodes, and versioned insight memory.

**Review focus:** associations remain non-causal, single observations never promote, current uniqueness is enforced.

**Independent review gate:** statistical, state-machine, concurrency, and causal-language review.

**Explicit non-goals:** queue activation, proactive decision, Telegram, or user-facing publication.

**Exit gate:** complete historical replay produces stable episode/evidence/insight results without messages.

**Implementation checkpoint:** the closed metric/evidence registries, robust-baseline and quality calculations, meaningful-change/hysteresis engine, durable evidence adapters, episode lifecycle/semantic-event integration, Journal association family analysis, and versioned insight promotion/weakening/expiry runtime are implemented in `src/phase4IntelligenceRegistry.js`, `src/phase4Intelligence.js`, and `src/phase4IntelligenceStore.js`. RC1 additionally enforces Journal revision/coverage authority at semantic as-of, an outcome-independent comparison-day universe, canonical association identity, the inclusive 36-hour continuity boundary, DEGRADED non-support, explicit semantic clocks, versioned durable confidence, and stable numeric thresholds. Runtime entry points reject LIVE authority. Reanalysis workers and scheduler integration remain Stage 6; proactive decisions, context-question policy, Quick Actions, and outbound delivery remain Stage 7; Morning Brief, Q&A, Owner Monitoring, and display-name work remain Stage 8.

### Stage 6: invalidation and reanalysis

**Status:** NOT STARTED.

**Depends on:** Stage 5.

**Files/subsystems likely touched:** canonical/journal mutation adapters, new Phase 4 invalidation/job stores and drain, [src/processingTransaction.js](../src/processingTransaction.js), canonical scheduler integration, cadence-aware heartbeat/watchdog evaluation, and non-production scheduler fixtures behind default-off authority.

**Migration impact:** use v24 invalidation/job tables; no scheduler-schema or Phase 3 worker change.

**Work:**

- add Phase 4 generation writes to actual semantic canonical and journal changes;
- implement coalesced jobs, lease claims, fences, backoff, and repair;
- add an independently named Phase 4 drain behind a default-off flag;
- implement the Section 10 Asia/Taipei schedule-window predicate, exact Cloudflare UTC trigger `*/10 0-3 * * *`, source-specific heartbeat expectations, realistic GitHub tolerance policy, and durable catch-up scans;
- verify both application-local-time behavior and the deployed Cloudflare trigger value, and preserve the accepted hourly-path latency trade-off for non-Taipei due times outside the one global window;
- make Cloudflare-morning, GitHub-hourly, and event-driven invocations call the same replay-safe runner without requiring GitHub to wake Render;
- keep provider calls outside database transactions.

**Existing boundaries reused:** [src/analyticsInvalidation.js](../src/analyticsInvalidation.js) as a transactional pattern only, and [src/processingTransaction.js](../src/processingTransaction.js).

**Tests:** change/no-change distinction, crash recovery, generation race, coalescing, poison tenant isolation, missed/delayed scheduler catch-up, morning-window boundaries, exact deployed UTC cron verification, non-Taipei global-window behavior, outside-window watchdog behavior, realistic GitHub jitter, and Phase 3 zero-invocation assertions.

**Output:** disabled-by-default event-to-current-derived-state pipeline.

**Review focus:** trigger to invalidation to recomputation boundaries remain durable and no path owns Telegram.

**Independent review gate:** lifecycle/auth/computation fencing, lease/crash recovery, and dormant-Phase-3 review.

**Explicit non-goals:** message delivery, applying production cron/watchdog configuration, production flag enablement, or provider fetch inside a transaction.

**Exit gate:** event and replay paths converge to identical derived state in shadow mode.

### Stage 7: decisions and outbound delivery

**Status:** NOT STARTED.

**Depends on:** independently reviewed Intelligence Pack (Stages 5–6) and explicit Delivery Pack authorization.

**Files/subsystems likely touched:** new policy, decision, v25 Quick Action interaction and Journal-provenance persistence, outbound store, dispatcher, Telegram adapter/callback router, plus [src/accountLifecycle.js](../src/accountLifecycle.js), [src/attention.js](../src/attention.js), [src/journal.js](../src/journal.js), and [src/reportDelivery.js](../src/reportDelivery.js) boundaries.

**Migration impact:** use v24 decision/outbound tables and implement complete v25 for Quick Action transport plus Journal-side trusted-registry/source-kind provenance before dependent behavior; legacy proactive rows are not migrated into Phase 4 decisions, v21–v24 are not modified, and no Stage 8 Owner Monitoring table belongs to v25.

**Work:**

- implement the exact four-action policy;
- implement question_utility_v1 with non-recursive counterfactual_decision_impact_v1 and independent notification evaluation;
- remove Phase 4 dependence on count caps and **downgradeAskToNotify**;
- implement all seven canonical key builders, event/request/answer reuse, non-releasable reservations, message proposal, dispatcher, attempts, ambiguity recovery, and atomic legacy cutover;
- implement the buttons-first Quick Action registry and tenant-bound callback state, resolving opaque callbacks server-side and writing accepted values directly into existing Structured Journal facts through the `TRUSTED_REGISTRY` validator mode with replay-safe callback receipts and existing correction/delete/undo semantics;
- implement v25 Journal-side `source_kind`, registry provenance, conservative legacy backfill, and nullable genuine-user-text excerpt behavior; withhold the v25 version row until every assigned object and postcondition is complete;
- use fake provider adapters only; real Telegram capability remains technically unavailable.

**Existing boundaries reused:** lifecycle checks in [src/accountLifecycle.js](../src/accountLifecycle.js) and the pre-send boundary pattern in [src/reportDelivery.js](../src/reportDelivery.js).

**Tests:** exhaustive decisions/utility, no downgrade, V1.2 duplicate reproduction, semantic reservation across later decisions, legacy/new double-ownership prevention, lifecycle-after-acceptance, failure injection around every provider boundary, stale/lifecycle suppression, abnormal circuit breaker, Quick Action double-click/replay/ownership/staleness/time semantics, trusted-registry versus user-text validation, no fabricated excerpt, source-kind backfill, and complete-v25 migration interruption/isolation/privacy.

**Output:** local shadow decisions, deterministic Quick Action fixtures, v25 default-off stores, and mocked delivery evidence only; no real test-user or canary delivery.

**Review focus:** only dispatcher can send; normal operation has no numeric message cap; ambiguous sends never automatically repeat.

**Independent review gate:** notification safety, duplicate-send, ambiguity, and provider-boundary review.

**Explicit non-goals:** any real Telegram delivery, test-user/canary delivery, production cutover, Morning Brief publication, Q&A publication, or normal-operation count caps.

**Exit gate:** outbound proposal shadowing is stable and mocked delivery is crash-safe.

### Stage 8: Morning Brief and Q&A

**Status:** NOT STARTED.

**Depends on:** Stage 7.

**Files/subsystems likely touched:** complete v26 Owner Monitoring persistence, [src/daily.js](../src/daily.js), [src/reportDelivery.js](../src/reportDelivery.js), [src/healthQuery.js](../src/healthQuery.js), [src/bot/router.js](../src/bot/router.js), recipient-name resolution over existing identity sources, Owner Monitoring services, notification preferences, and presentation tests.

**Migration impact:** use v21 preferences and the v24 typed outbox/reservations/modes, then implement complete v26 Owner Monitoring subscriptions/events, authorization, notification state/preferences, and owner-outbox linkage before Owner Monitoring behavior. Existing report tables remain legacy. Display-name isolation uses the current identity model unless implementation proves it insufficient; it does not itself justify a v25 or v26 migration.

**Work:**

- add MORNING_BRIEF_V1 eligibility, schedule, missing-data rendering, semantic reservation, and typed outbox proposal;
- add notification preferences;
- introduce **ScopedHealthContext** and place perspective authorization before all specialized reads;
- enforce the Section 11 per-user display-name resolution order for every renderer and cache;
- implement v26 and Kelvin's explicit followed-user/class configuration plus conjunctive dual-principal Owner Monitoring authorization over Daily Summary, Important Alerts, and Weekly Summary only;
- permit only an approved current synthesized artifact or approved bounded deterministic summary plan; any failed authority/data-scope/destination/audit predicate produces no owner message;
- use validated deterministic plans with optional LLM wording.

**Existing boundaries reused:** [src/daily.js](../src/daily.js) scheduling concepts, the pre-provider transaction pattern but not row lifecycle from [src/reportDelivery.js](../src/reportDelivery.js), [src/healthQuery.js](../src/healthQuery.js), and [src/bot/router.js](../src/bot/router.js) after correcting route order.

**Tests:** complete/partial/no-data briefs, exactly one health-day semantic reservation across legacy/new modes, DST, pause/lifecycle races, perspective-order regression, currentness lag, Kelvin/Alice/Bob/neutral display-name isolation using existing identity sources, complete-v26 interruption/postconditions, owner subscription/audit/approved-artifact-or-plan routing, fail-closed no-source behavior, ordinary-user cross-tenant denial, and proof Q&A cannot propose/send.

**Output:** complete default-off v26 Owner Monitoring stores plus local/shadow Morning Brief and owner-monitoring proposals and scoped Phase 4 Q&A, with real sending technically impossible.

**Review focus:** missing data never cancels, Body Energy attribution is explicit, display names never bleed across users, ordinary users remain self-only, and every owner cross-user read/send has explicit dual-principal authorization and synthesized scope.

**Independent review gate:** product-language, privacy, scheduling, missing-data, and Q&A-boundary review.

**Explicit non-goals:** dashboard/mobile UI, unrestricted family/admin/raw-record browsing, emergency or real-time monitoring, or opportunistic brief suppression. The selected-user Owner Monitoring contract above is in scope and is not “family sharing.”

**Exit gate:** synthetic end-to-end runs create at most one correct reservation/proposal and authorized Q&A answers under failure injection, with zero real sends.

### Stage 9: shadow evaluation and freeze candidate

**Status:** NOT STARTED.

**Depends on:** Stage 8 and all reviews.

**Files/subsystems likely touched:** local feature configuration, metrics, runbooks, freeze manifest, non-production/synthetic load-test harnesses, and rehearsal fixtures for the Section 10 mixed-cadence/watchdog target; production scheduler configuration remains untouched.

**Migration impact:** none expected; any newly discovered schema need requires a reviewed forward migration.

**Work:**

- execute only the Section 17 pre-gate sequence;
- validate shadow metrics, alerts, runbooks, kill switches, and forward-fix/disable behavior;
- obtain product-language, statistical, privacy, and security approval;
- assemble the Final Gate evidence package and freeze candidate.

**Tests:** non-production synthetic load, queue backlog recovery, mocked provider ambiguity, cutover simulation, conjunctive-gate enforcement, kill switches, disable/forward-fix with new tables retained, no Phase 3 activation.

**Output:** shadow-evaluation results, reviewed freeze candidate, and Final Gate evidence package.

**Independent review gate:** Architecture Owner, Session B, product, privacy, security, and statistical Final Gate approval.

**Explicit non-goals:** test-user delivery, canary delivery, production migration/flags/cutover, merge or deploy, destructive rollback, or Phase 3 activation.

**Exit gate:** Phase 4 independent Final Gate returns PASS and the evidence package records remaining conjunctive-gate conditions. Stage 9 does not activate production.

### Blocking product decisions

There are no unresolved product decisions blocking implementation of the disabled shadow stages. This ADR adopts:

- AFTER_WAKE plus 30 minutes with 10:00 local fallback for migrated Morning Brief users;
- buttons-first Quick Actions with deterministic Structured Journal values, server-issued `TRUSTED_REGISTRY` provenance, genuine-text excerpts only, and free-text fallback;
- Kelvin Owner Monitoring for selected users and the three v1 synthesized notification classes;
- per-user display-name authority with neutral fallback and no universal Kelvin default;
- one global Asia/Taipei 08:00–12:00 Cloudflare high-frequency window using UTC cron `*/10 0-3 * * *`, GitHub hourly background work, cadence-aware watchdog behavior, and the accepted higher-latency trade-off for non-Taipei due times outside that window;
- event-driven plus longitudinal product positioning with no raw real-time physiological-monitoring claim;
- the exact Body Energy v1 formula and quality thresholds in Section 3;
- the evidence and insight minimums in Sections 7 and 8;
- the question threshold and abnormal-only circuit breaker in Section 9;
- the privacy-minimizing retention defaults in Section 15.

Before any post-gate production activation, product, privacy, and statistical reviewers must approve the user-facing wording and versioned constants. Any change to these adopted semantics requires an ADR amendment, new version, and renewed affected Final Gate evidence; it is not an undocumented implementation choice.

### Residual risks

- Body Energy v1.2.0 is an engineering calibration candidate and cannot be published until the correlation/ablation/sensitivity/distribution/missingness gates pass.
- V20 latest-row storage cannot reconstruct a source revision overwritten before a persisted manifest captured it.
- Telegram does not provide application-controlled send idempotency, so a post-request failure can remain AMBIGUOUS. The design prioritizes avoiding duplicate health messages.
- The existing V1.2 report-claim lifecycle has a potential duplicate-send defect that requires deterministic reproduction; no production occurrence is asserted.
- Kelvin Health OS can purge its own copies but cannot guarantee deletion of a message already accepted by Telegram or retained on a user-controlled client.
- Legacy attribution may require conservative tenant-wide derived-copy redaction; external logs/backups require verified retention/cleanup before claiming complete erasure. These are implementation/activation checks, not evidence that production was inspected.
- Current body-measurement provenance is insufficient for Body Energy v1 and is deliberately excluded.
- Observational evidence remains vulnerable to unknown confounds even with statistical guardrails; language and promotion rules mitigate but cannot eliminate that limitation.
- Application-enforced referential integrity requires strong store encapsulation and regular audits because the existing schema does not use SQL foreign keys.
- Morning Brief is protected by a semantic reservation, not a claim of provider-level exactly-once delivery; ambiguity and prolonged outage are explicit terminal outcomes.
- Legacy proactive/report paths coexist before per-family cutover. Authoritative modes, barriers, and semantic reservations are required to prevent double delivery.
- Owner Monitoring intentionally introduces a narrow dual-principal path; an implementation error that exposes it through ordinary Q&A/store APIs would be a critical isolation defect.
- Mixed third-party scheduling is not an exact latency SLA. Durable backlog and cadence-aware watchdog design reduce loss/false alarms but still require operational validation.

### Final architecture verdict

The ADR remains the controlling contract. Foundation Stages 1–4 exist default-off and SHADOW-only and passed aggregate review. Stage 5 is implemented SHADOW-only under its subsequent explicit authorization and awaits independent Stage 5 review. Quick Actions and their v25 Journal trusted-registry/source-kind provenance, Owner Monitoring and its v26 persistence, display-name isolation through existing identity sources, mixed scheduler/watchdog behavior, and Stage 6 reanalysis remain future work and must not be reported as implemented. No production operation is allowed until the four-part conjunctive release gate passes. Phase 3 analytics workers remain dormant unless a separate future decision explicitly activates them.
