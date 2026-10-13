# Stage 6 raw-source capacity repair checkpoint

Parent: `9770553caba6f4085f4799fb6088db5076433f8e` (direct successor of `2340e8bc305c6acde29bbfa540753e79dbd34408`). The other newer local checkpoint is a Stage 7 branch which does not contain 9770553. This isolated successor retains the Journal repair exactly.

The retained USER successor at 115 ms/physical Hrana request takes 41.30 s / 322 HTTP / 626 SQL with no calculation or cursor progress. Its baseline preparation alone costs 16.27 s / 129 HTTP / 288 SQL. Bounded authenticated root observations reduce that preparation to 1.13 s / 7 HTTP, but batch-only still takes 41.86 s / 316 HTTP with no durable progress.

This delta uses existing v32 RUN_START, RUN_COMPLETE, ITEM, AUTHORITY and public DOMAIN boundaries. A retained raw analysis instant is accepted only after recomputing the original plan against current authenticated sources and verifying its exact named RUN_START receipt and sealed finalized producer. Original algorithms, HMAC, source checks, lease/generation fences, cursor policy, 45 s/15 s budget and permit controls remain. Raw request construction and one subunit share one existing owned transaction.

Installed HTTP/Hrana continuations have durably created the directory, RUN_START, RUN_COMPLETE, ITEM and AUTHORITY across fresh connections. Earlier split variants stalled at RUN_COMPLETE; the owned variant repaired that boundary. DOMAIN capacity qualification remains pending. These are partial local measurements, not six-job convergence or deployment approval.

Next: strict raw DOMAIN/family/cursor capacity fixture, focused authority/restart checks, six-job convergence qualification, one independent delta review. Production remains 0/6 and second pilot 12/12. No additional paid execution or public SHA publication is authorized.
