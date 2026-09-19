# Phase 4 Foundation storage boundary

This is disabled persistence infrastructure, not a release or activation guide.
The accepted architecture remains `phase4-architecture.md`.

## Authority and execution

`createPhase4Foundation` issues only SHADOW contexts. Every context, source
reference, experiment assertion and work lease is an instance-bound capability;
copying its visible fields does not copy authority. Contexts capture tenant,
mode, lifecycle, authorization, input and purge generations. An input change
invalidates existing contexts rather than silently upgrading them.

The internal LIVE kernel additionally requires an actual in-memory database.
`test/phase4Fixture.js` owns a fresh private memory database and accepts a clock
only, not a caller's database, URL, credentials, provider or transport. Runtime
modules do not import it. There is no production LIVE issuer, gate record,
cutover completion API, scheduler or provider adapter here. All thirteen flags
remain false; requesting activation fails closed.

## Transactions, reads and privacy

The shared transaction executor serializes root operations on a connection.
Nested failures poison their enclosing transaction. Provider computations use
the existing outside-transaction retry boundary; they cannot retain authority
across a purge. Expected duplicate report inserts use a conflict-safe insert,
and retryable report failures retry whole fenced insert transactions.

New derived writes validate their complete parent chains. Mutable logical
episode/insight refreshes require fresh evidence and current projections;
generation-qualified provenance links distinguish their current dependencies
while retaining old dependencies for transitive purge. Old revisions are not
promoted to current data. New comparison evidence validates UNKNOWN counts and
the exact denominator/fraction relationship.

Privacy APIs are manually invoked storage foundations only. No command admits
a purge and no worker runs it. T0 must commit independently; T1 atomically
redacts its complete closure in both modes; T2 verifies targets and waits for
all older context leases. Clearing cached values without releasing the context
does not complete T2. Legacy health adapters fail closed during pending purge,
filter positive R states, and refuse to refill a redacted artifact. Unclassified
legacy copies cannot escape traversal by lacking an artifact ID. Diagnostics
accept closed non-health codes, not arbitrary error narratives.

Owned Telegram action receipts carry durable lifecycle/auth/purge fences and a
separate server-supplied owner. Redacted replay is the exact fixed no-reply
object and bypasses routing, models, mutation, typing and delivery. The later
Journal control adapter must prove inbound admission separately; a primitive
`sourceUpdateId` cannot authorize it.

## Question and transport state

Question acquisition, request, decision, semantic reservation and optional
proposal are atomic. The `question-slot-v1` window is thirty UTC minutes.
Ambiguity permanently consumes the reservation and retains an answer window;
expiry and late transport proof never create another semantic identity.
Projection into real pending questions is a separate, current LIVE-only check
after proven acceptance. Legacy readers cannot consume that projection.

The legacy guard can import an owned OPEN interaction without inventing a
Phase 4 request, preserve its existing deadline, and resolve it by CAS. Unknown
legacy send lineage defers coexistence/cutover, never implies a free slot.
Actual legacy-path deployment and delivery cutover are not enabled by this
interface. SHADOW never writes real pending questions or delivery attempts.

Transport methods store state only; they never send. Expired unstarted claims
can recover to eligibility; a started attempt recovers to permanent ambiguity.
`phase4-transport-retry-v1` is a conservative storage retry default: only
definite provider rate-limit/unavailable outcomes, non-question messages,
at most three attempts and 60/120-second backoff. Every retry must pass current
eligibility again. A failed eligibility check does not silently close or resend
anything; an authorized metadata-only close operation can terminalize a
definitely failed message. Questions and purged payloads never retry.

## Experiment fields

Every experiment has ten current classified field leaves. New unproven fields
are quarantined, not inferred to be independent from their shape or caller.
Direct assertions are separately issued and generation-bound; derived leaves
carry verified roots. A field correction stages only its new value and uses
T0/T1/T2. Durable replay does not require recreating an in-memory assertion.
Whole-experiment deletion covers all revisions, while source deletion preserves
proven independent sibling fields. Semantic source changes fan out to existing
computation modes only and never create a LIVE mode.

FULL_TENANT_RECOMPUTE remains pending even with null dates or equal generation
counters. This Foundation contains no authorized full-scan worker, so its job
completion API cannot claim such work completed. The Phase 3 worker remains
dormant. The later Intelligence Pack owns computation/decision policy and
worker activation under the ADR's separate release gates.
