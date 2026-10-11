# Body Energy production integration candidate

This candidate is software implementation and isolated deterministic evidence. It is **not empirical calibration, publication approval, a production deployment, a natural alert, or proof of sustained operating capacity**. The original calculator, registry constants, confidence formula, and CYCLE priority are unchanged. There is no v33 migration or Stage 7 UI/framework. Existing Settings handlers retain precedence.

## Adopted authority

`docs/phase4-architecture.md` section 3 (lines 232–242) requires result/state, algorithm/full constants hash, as-of/day/wake/timezone, quality/confidence, included/excluded inputs/source versions, drivers and Kelvin Health OS estimate authorship. `/energy` and `/energy sources N` expose compact authorized-owner provenance in bounded pages. Morning/alerts are concise and point to `/energy`; confidence explicitly means data quality, not physiological accuracy. The retained manifest remains complete and authenticated; no raw provider JSON is rendered.

The exact criteria are `src/bodyEnergyReleaseCriteria.js`: section 3 freshness, AVAILABLE and confidence >= .80, 30-day mature baseline from the 45-day window, and section 3 evaluation/section 17 release requirements. The versioned qualification registry in `bodyEnergyQualificationAuthority.js` remains pending genuine evidence and final gate. Runtime flags, JSON or consent cannot manufacture a publication grant. Isolated publication/transport issuers accept only memory databases and fixed synthetic outcomes. Numeric publication and notifications remain OFF until an exact approved packet/cohort is registered and reviewed.

## Implemented seams

- Canonical admitted inputs -> unchanged calculator -> existing v32 Body store/provenance and operation receipts. Typed publication reader requires current tenant/generations, schema32, completed generation, genuine finalized DRAIN producer proofs, retained artifact receipts and original source freshness.
- Normal Morning composition, narrow Telegram query and persistent `/energy alerts on|off` control. Control replies bind the durable consent revision/enabled state, actor/lifecycle/profile/locale, including restart and ABA checks. Health output recipes bind current publication proof and canonical profile authority.
- Morning's final transport authorization checks ordinary snapshot then Body. If Body alone fails, only transport's explicit zero-send ACCOUNT_INACTIVE/messageId:null result permits one ordinary fallback under the same claim. Delivery/network ambiguity never causes fallback/resend. Ordinary snapshot rejection remains fenced.
- Finalized DRAIN is the only automatic alert trigger. Explicit Body opt-in, existing global notification control/pause, READY/private actor binding, freshness and rechecks apply. Existing common rolling per-user cap2 and Body-topic 24h cooldown are atomic; semantic episode/delivery claims omit generation/policy/attempt. Genuine Telegram acknowledgment remains required. Synthetic fixture ACKs are labeled synthetic.

## Confirmed temporal repairs

The previous derived seam treated actual `body_energy_results.created_at` as if it had to precede its source as-of and failed metric analysis. The candidate authorizes the derived persistence instant through exact producing execution, generation, ownership and completion instead. Source as-of, ingestion timestamps, manifests and historical rows are not relabeled or rewritten. Future actual-clock/foreign/stale producers fail closed.

The previous current-analysis seam fixed the generation clock before a later unchanged canonical poll's synced_at. A v32 active owned DRAIN now captures a supported actual analysis clock. Body's first capture occurs after admitted inputs; retry uses its existing immutable operation identity. Raw metric capture reuses an authenticated committed analyzeMetric receipt's instant only when the exact current and baseline source versions match. New lawful capture is possible before an original commit or for changed source versions. The original generic WHOOP ingestion/updated_at <= captured-asOf checks remain intact; cancelled, expired, foreign, unsupported future clocks and future sources remain fenced. Historical strict audit/readExact remain strict.

Publication accepts a monotonic synced_at-only canonical refresh only when every other captured relevant field remains exact and refresh time <= actual supported reader clock. Original as-of, manifest/hash/receipts and source ages are retained; refetch cannot prolong freshness. Provider/relevant-value changes remain fenced.

## Explicit proposed Body notification policy

The existing generic Stage5 robust metric episode requires robust-Z/persistence/severe gates. Its current-generation Body history does not supply a previous-generation baseline for each new load generation. Those generic gates are unchanged. This candidate proposes a **separate, explicit notification policy**, requiring its own Architecture Owner / independent policy approval in the publication packet; it is not silently authorized by the generic registry.

Magnitude preserves existing body_energy metric registry semantics: absolute12 **OR** relative15% with denominator floor10. Normal time depletion is subtracted. Prior/current AVAILABLE/.80 results and relevant sources must be fresh <=90min, same owner/auth/lifecycle/health-day/wake, unchanged required recovery/sleep/baseline and unchanged prior completed-workout/nap evidence. Recalculation/correction, cross-wake, representation change, expiry and insufficient evidence suppress.

Cycle updated_at alone is insufficient: WHOOP webhook `.updated` also represents creation and there is no Cycle/Day Strain webhook (official developing/webhooks FAQ). The new `body-energy-workout-event-v1` manifest field is non-score provenance, with admitted canonical workout roots/source versions and exact original provider created_at; it never adds workout weight to a CYCLE score. A new completed workout can support the signal by either:

1. prior authenticated capture observed same id/start/provider-created value with end=null; current capture observes completion with end after prior capture; or
2. prior complete capture lacked that id, current provider-created time and actual completion end are both after prior capture, created<=updated<=current capture, and the workout remains in the same wake/fresh source window.

Existing completed ids and historical end times cannot qualify as first creation; old completed-workout correction suppresses. Missing/malformed/future versions, access/tombstone failure or unavailable fresh synchronization suppress. Official Workout response documents created_at/updated_at/start/end (`https://developer.whoop.com/api/#tag/Workout`); its sample does not guarantee ongoing records, so first-creation and progression remain distinct supported software paths. Real eligible occurrence/provider behavior is still an operating observation gate, not established by these synthetic fixtures. Episode identity uses owner/wake/completed-workout id, not input generation or policy version.

The retained non-score extension is admitted by a narrow successor to the previously reviewed private evaluator: bounded primitive shape, original capture cutoff, unique ids, max128 events and exact sync ages. Original captures without the optional field remain valid. Original manifest is never stripped or called current canonical history.

## Evidence and operating limit

All listed tests use synthetic rows in isolated memory SQLite, actual schema32 stores, actual durable SYNC/DRAIN claims/finalization and original calculator. Normal tooSoon poll -> DRAIN -> unchanged refetch -> eligible Morning and real receipt-backed CYCLE relative-only drop -> durable synthetic ACK pass focused tests. Cycle correction without a completed event, consent/profile ABA, future bookkeeping/source/clock, late control revocation, stale/pending/foreign publication, duplicate/ambiguous delivery and final-send invalidation have negative controls.

A measured first full 30-day native generation made **151,950 logical proxy execute calls**, including nested executor/privacy/authority wrappers (this is not a unique SQL statement or Hrana HTTP request count). Families: canonical source55685, context24444, job21775, other46788, execution1450, Body88, receipt595, source link1125. Native HTTP=0. Original counting/failed runner evidence is preserved outside Git. It does not establish cost or production45s feasibility. Subsequent instrumentation uses the approved production telemetry without overriding driver executors. The original measured gap remains open for a separately reviewed bounded performance repair; no timeout/authority extension is implied.

Earlier local failed reproductions remain preserved. A native multi-fixture run suffered SIGSEGV after two passing tests; it is not a PASS and is not silently discarded. Focused tests are rerunnable; final independent exact-candidate review and genuine publication qualification remain separate requirements. No provider operation, real health read, external send, push or deployment was performed by the implementer.
