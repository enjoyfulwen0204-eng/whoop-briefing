# Bounded continuation implementation candidate

The local implementation uses the existing v32 authority and receipt ledger to recover bounded work across authenticated invocations. It does not establish a full-path under-120-second guarantee. The final frozen timing ledger determines the R1 disposition; architecture approval and production validation remain required. No deployment, production database change, new schema version, or activation is included.

## Independent clocks and limits

| Boundary | Limit / meaning |
|---|---|
| Cloudflare SYNC work | 120 seconds |
| Admission | 30 seconds |
| Settlement allowance | 15 seconds, with original authority still required |
| Nominal SYNC whole server deadline | 165 seconds |
| Worker SYNC caller | 180 seconds |
| Cloudflare DRAIN work / whole server / caller | 45 / 90 / 100 seconds |
| Worker invocation window | 561 seconds, unchanged |
| Phase lease | At least 225 seconds; expiry is distinct from work authority |
| Tenant SYNC lease | Remaining work authority +15 seconds, at most 195 seconds |
| Reconciliation lease | 300 seconds; owner-specific acquisition and settlement |
| Incomplete execution context | 900 seconds from immutable created_at |
| Report coordination | Live clock; original WHOOP observation time cannot backdate a lease |

The next scheduled invocation may resume the same durable identity; it does not extend its original 900-second context. A caller disconnect is not proof that the original server stopped. Takeover requires serialized database observation of predecessor deadline loss and owner/generation CAS. Unknown COMMIT remains uncertain until authoritative reconciliation. No timer is enlarged to make a test green.

## Authenticated discovery and dispatch

`POST /internal/briefing/continuation` is separately HMAC-authenticated over its own path and narrow release/source/mode/config body. Fresh v32 admission and a 30-second budget apply. It performs read-only SQL and returns only exact canonical request bytes, a fixed progress state, and receipt count. It returns no user, health, credential, owner, or receipt-key material.

Worker opt-in is `BRIEFING_CONTINUATION_DISCOVERY=on`; repository defaults stay OFF and contain no active cron. Protocol version 1 is encoded in the existing opaque `requestId` prefix `p4c1_`. No JSON field or schema object was added. These identifiers grant no authority: HMAC, admission, release/config/source/mode, ownership and deadlines remain mandatory. Canonical bytes must reproduce the stored identity digest exactly. DRAIN identity is deterministic from its finalized SYNC parent, so a Worker death cannot invent a sibling child.

Discovery filters that exact prefix before selection. Legacy transport bytes are never reconstructed or adopted. Legacy exact-body retries retain their original digest. A serialized fresh-scope election still checks all live same-source unfinished identities, including legacy identities; filtered discovery is not permission to overlap mutable work. WORK_COMMITTED metadata may overlap a newer invocation under the retained v32 contract. Promotion preflight must inventory and explicitly reconcile legacy residuals; discovery cannot silently repair an arbitrary historical body.

DRAIN recovery has priority. A receipt-backed expired-parent drain uses the existing authenticated metadata-only PARTIAL reconciliation contract and cannot restart business work. Death between finalized SYNC and DRAIN rediscovers the parent and replays immutable success to obtain the same authorized handoff. A recovered DRAIN never calls ordinary SYNC or sends Morning Brief.

Worker retries retain identical transport bytes, re-sign each attempt, bound discovery, response streams and backoff by the original invocation deadline, and propagate cancellation. Live-owner retryAfterMs is an observation, not an authority grant. A second cron invocation discovers the original ledger; no eventually-consistent external KV is the ownership authority.

## Durable progress and dependency checks

State distinctions are explicit: IN_PROGRESS, INCOMPLETE_RESUMABLE / COORDINATION_PENDING, COMMIT_UNCERTAIN, WORK_COMMITTED_UNFINALIZED, FINALIZED_SUCCESS, TERMINAL_FAILURE, STALE_REQUEST, and conflicting identity. Pending states grant no handoff or presentation. An acknowledged work commit is distinct from finalization. Finalized replay is immutable. Old incomplete requests fail closed without deleting their committed receipts; known immutable work can still reconcile metadata under the retained contract.

Canonical resource batching preserves ordered atomic HTTP/Hrana batches and checks tenant binding. Privacy initialization runs only when required; each observation still rechecks fresh lifecycle/auth/purge/currentness. No business transaction spans a WHOOP/model/Telegram wait.

Resource/window receipts bind the original window, pagination position, actual credential authorization generation, lifecycle, WHOOP subject, purge generation and timezone. Root guards execute before/after and before COMMIT, including receipt replay, empty responses, diagnostics and settlement. Lease grant/settlement receipts bind their actual owner. A prior true grant cannot authorize a successor or leave its lease retained.

The real WHOOP client binds the credential snapshot actually used, checks fresh authorization before dispatch/retry/refresh and after successful body consumption, and rejects stale generation/subject before accepting the observation. Every reconciliation page is checked. Routine token refresh retains its authorization generation and existing CAS/ambiguity rules.

WHOOP windows keep their original observation time. Default Morning Brief eligibility and 24h/48h late policy use a live presentation clock after polling and again after generation/renewal. Shared report lease renewal and delivery authorization use a live coordination clock. Explicit historical presentation clocks are trusted fixture composition only and cannot arrive through the HTTP request body. Cross-midnight continuation therefore cannot remove a late label, send expired data, or renew a new report lease into the past.

## Acceptance evidence and limits

The final handoff must include A–H, actual caller-abort/restart evidence, and slow/jitter HTTP trials with installed HTTP/Hrana SQL and the real WHOOP client using synthetic fetch. Required assertions include truthful partial status, monotonic durable receipts, zero duplicate committed canonical/Stage6 effects, zero duplicate delivery, zero new provider calls after tested cancellation, exact request recovery, and current privacy/authority. Idempotent WHOOP reads may be freshly reobserved; raw provider fragments are not stored in execution receipts.

A completed 112ms fixture alone is not a production p95 or arbitrary-latency guarantee. Scheduling feasibility, 900-second age behavior, high-latency terminal outcomes, existing six-job backlog and restart must be assessed independently. Stage6 BUDGET_EXHAUSTED/PARTIAL is not fabricated COMPLETE. Production architecture and rollout gates remain pending regardless of local green tests.

Historical failures remain retained: review A 18.442s/B 50.739s/C 83.096s honest PARTIAL/F 121.705s timeout; earlier candidate seven-generation pending progress and uncertain COMMIT; prototypes around 679/680s; later b36e868 Worker SHADOW rehearsal 551.907s with only9 seconds of caller-window margin. Those older experiments do not replace final-source evidence. Original failed runs, fixture corrections, native failures, challenge counterexamples and corrected reruns are preserved by the final evidence manifest.

## Cancelled HTTP stream cleanup

The admitted DB transport allows a bounded Hrana v2 JSON close of an existing baton after parent cancellation. Its payload contains only `baton` and protocol `close`; it cannot execute SQL, COMMIT, open a new stream or confer tenant authority. A cancelled request with a known baton closes it; a late response is cloned synchronously before the driver discards its body, and its issued baton is closed. Cleanup is bounded by the existing 15-second settlement resource margin. An unavailable acknowledgement remains uncertain and requires provider stream expiry and fresh reconciliation; close is not evidence that a submitted COMMIT rolled back.

The local Hrana server fixture explicitly rolls back an open transaction on stream close, matching server connection disposal instead of relying on the installed native driver's deferred finalizer. Original lock failures and corrected known-baton/lost-BEGIN-ACK tests are retained. No health request or business write can use this cleanup exception.
