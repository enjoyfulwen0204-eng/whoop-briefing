# Stage 8 Independent Review Repair Checkpoints

Baseline: `5dc3462de7e67e63246657e9c7e4ae92249bf108`. Dedicated branch only; Production and credentials untouched. F02 remains Owner Accepted Risk.

## P0 safety and recovery

Deterministic urgency and symptom education now precede Stage 8 routing. Recovery profiles reject all active Stage 8 gates and delivery cutover before database/provider access. Configuration proof includes Stage 8 cohort/gates/cutover, and retained runtimes fence changes during processing and send.

Verification: `p0-focused.tap.gz`, 32/32 passed, zero skipped/cancelled. This is synthetic code evidence, not LIVE acceptance. Stage 6 source was not imported.

## Independent functionality and reader boundary

The signed companion service now admits the owner lane independently of Stage 7. It consumes no SYNC/DRAIN handoff or Stage 6 pilot allowance. A durable metadata cursor visits at most six of at most 300 retained subscriptions per tick. Current followed-subject source plans are built under the explicit dual-principal subscription scope. No computation completion is created.

Owner delivery retries only definite failures, with 30/60 second minimum backoff, three-attempt maximum, immutable semantic identity, and expiry/exhaustion suppression. Actual retry timing follows the existing signed scheduler cadence. Durable authorization expires no later than 90 minutes after source-plan capture; every attempt revalidates the unchanged plan and both principals. Ambiguous and interrupted started attempts never resend.

Morning Brief uses its existing one/two minute retry policy for definite 429/5xx nonacceptance, three-attempt maximum, permanent-failure closure, and bounded cleanup of eight expired reservations. Attempts freeze the original projection. Source/authorization/presentation changes cannot authorize a stale retry.

Telegram first names come only from authenticated private updates and exact active bindings. WHOOP first names come from the same verified profile request used during OAuth, bound to the saved authorization generation. Explicit names take precedence. Repeated unchanged capture is a no-op; changed names advance profile revision. Physical self-scoped erasure leaves permanent redacted rows. Polling and webhook share the capture hook.

Quiet-hour choices now include localized wording. Owner choices show localized subject wording and either a proven name or a stable private alias; class selection repeats that subject identification. Free-text questions, notes, names and times remain available.

Focused verification: `independent-repair-final.tap.gz`, 39/39 passed, zero skipped/cancelled. Earlier unsuccessful runs remain retained and are superseded, never counted as functionality passes.

The runtime now wires `stage8DerivedReader.js`. It checks registered kinds, current scope/generation, finalized producer authority and typed operation receipt readers. Current v34 cannot supply a LIVE producer; fake complete/current-empty metadata and SHADOW results remain ANALYSIS_UPDATING. Actual LIVE producer availability and final Stage 6 integration remain blocked.

## Typed selector freeze

Actual-schema execution checks caught and repaired the evidence-run timestamp selector. BODY_ENERGY, EPISODES and EVIDENCE now use registered existing columns and exclude incomplete/invalidated/expired selections before typed authority checks. `typed-selector-final.tap.gz` passes 3/3. WHOOP and OAuth compatibility regressions pass 54/54. The first integration/regression runs were interrupted before this runtime freeze and are retained as interrupted evidence, not final PASS.

## Lifecycle hardening and final runtime freeze

Owner started-attempt recovery now precedes subject plan generation, including after enrollment revocation. Recovery discovery reads metadata only. Morning retries close stale, paused, changed-profile/authorization/destination and expired frozen plans without another provider call; expired definite failures retain an expiry audit and close their reservation.

`frozen-repair-focused.tap.gz` passes 44/44 with zero skipped/cancelled. A native crash in the optional combined capture suite cleared on isolated polling rerun, 12/12. The two optional onboarding historical-rewind cases fail because invalidHistoricalRewind.js asserts SCHEMA_VERSION=32; the unchanged requested baseline reproduces both failures. They remain pre-existing documentation/test evidence issues and are not represented as passes. The historical helper was not modified.

The final documented integration and regression runs will qualify this runtime freeze; all earlier interrupted runs remain marked interrupted and excluded from final counts.
