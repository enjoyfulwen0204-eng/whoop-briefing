# v32 Execution Settlement Authority

Architecture Owner ruling, 2026-10-08. This supersedes the rejected retroactive
cancellation contract. Production remains RC2/v31; this document authorizes no
production operation. v31 is Localization, v32 is Execution Settlement Authority,
v33 is Stage 7, and v34 is Stage 8. Only v32 is implemented here. Settings v1 is
DEFERRED_POST_LAUNCH, the first post-launch schema-neutral UX patch.

## Authority and submission boundary

Before submission, the original cancellation, overall/work deadline, release,
configuration, source and owner/generation checks prevent new settlement.
After COMMIT submission, client cancellation or timeout is not proof of database
rollback. A caller returns COMMIT_INDETERMINATE (503), CANCELLED or TIMEOUT without
handoff when it cannot establish completion under its current authority. Durable
truth is established by a later fresh authorized read. No timeout is increased.

`phase4_executions` binds immutable request/body identity, canonical opaque cohort
scope, phase, exact checkout SHA, OFF/SHADOW mode, source, config proof and parent
sync. Owner generation, lease/deadline and conditional updates fence takeover.

ESTABLISHED → WORK_COMMITTED → FINALIZED_SUCCESS / FINALIZED_FAILURE.
ESTABLISHED → ABORTED permits a new generation to resume. A committed result cannot
be changed on takeover. Finalized records are immutable. ABORTED and the optional
indeterminate observation do not manufacture rollback of already committed work.
Unknown historical v31 heartbeat records remain LEGACY_UNKNOWN; migration does
not invent successful execution records from them.
New rows must start ESTABLISHED at generation one; the initial-authority trigger
rejects fabricated finalized rows. Final state cannot be inserted or mutated as
a shortcut around the conditional work/finalization transitions.

## Work receipts and reconciliation

Each mutating root work transaction appends an opaque receipt in the same SQL
transaction through the execution context. There is no health payload, raw key,
token, secret or user-facing text in this receipt. Failure before COMMIT rolls
back both effect and receipt. An ambiguous acknowledgement never replays the
business callback. Existing deterministic Stage 5 receipts, Stage 6 cursors/work
tips and ordinary report claims/delivery states remain the business dedupe.

The phase result commit records only sanitized counts/outcome, a digest and
WORK_COMMITTED. It contains no success heartbeat or handoff. A fresh invocation
can take over WORK_COMMITTED by CAS, retain its immutable result, skip sync/drain
work, and attempt finalization. Incomplete work requires lease expiry/takeover
and resumes existing business identities/cursors rather than assuming nothing
committed. A receipt proves durable progress, not full phase completion.

Finalization is a separate root transaction with owner/generation/result/release
CAS and database-clock deadline/lease predicates. The canonical finalization
trigger also enforces those time and transition rules at SQL execution. Local
cancellation after submission cannot undo that transition. After acknowledgement,
the caller checks original authority and reads the durable row; transport success
alone is insufficient. Lost finalization acknowledgement is reconciled by a new
invocation. There is one immutable finalization timestamp/result and one
deterministic HMAC handoff, not a second success record per retry.

SYNC drain authorization requires FINALIZED_SUCCESS plus a complete typed sync,
exact release/source/mode/config proof and matching handoff. WORK_COMMITTED and
COMMIT_INDETERMINATE never authorize drain. Stage 6 PARTIAL/NO_WORK/COMPLETE becomes
an authorized invocation outcome only after finalization. Presentation runs after
finalization and still uses currentness, privacy, recipient, allowlist and dedupe
gates. Body Energy remains NOT_AUTHORIZED_NOT_PRESENTED.

## Heartbeat and diagnostics

The execution row is authoritative. Heartbeats are best-effort projections and
can be rebuilt from finalized state. Failed projection cannot revoke or duplicate
finalization. `readPhaseProgress` distinguishes IN_PROGRESS,
DURABLE_PROGRESS_UNFINALIZED, WORK_COMMITTED_UNFINALIZED, COMMIT_INDETERMINATE,
aborted outcomes and finalized typed outcomes. Durable progress is neither silence
nor completion. Separate discovery and drain observations remain available.
The older provider/cron heartbeat remains provider liveness, not SYNC or Stage 6
completion authority; watchdog phase diagnostics read the v32 state explicitly.
Diagnostics also mark an expired unfinalized execution when no cleanup write was
possible. TIMEOUT describes lost phase authority, not proof of database rollback;
receipt/result evidence remains separately visible and reconcilable.
The newest immutable execution identity is selected by creation time. A later
reconciliation update of an older execution cannot hide a newer pending run.

## Runtime and contention

Every production top-level phase constructs a private DB runtime and performs
fresh exact-v32 admission. Native receivers are not exposed; raw reconnect ends
the lifetime and requires replacement. No prototype close/reconnect interception
is used. Caller-owned compatibility clients cannot use an issuer context to skip
verification: their privileged root SQL boundaries perform complete metadata
admission. This fallback costs five extra metadata queries per boundary and is
not the normal private phase path. A caller-provided boolean cannot choose it.
The installed file/HTTP/WebSocket native state lives behind private driver fields;
there is no public immutable lifetime token. WebSocket also replaces its private
connection automatically. Phase execution therefore rejects the WebSocket
transport; the production libsql URL resolves to the supported HTTP driver.

Admission is five read-only queries on canonical repository DDL, exact migration
authority/checkpoints, original lookup/audit continuity and enforcement flags.
It includes every v32 table/index/trigger/constraint. No historical DDL, DML,
checkpoint initialization or history scan occurs. Old schemas require controlled
migration; future schemas fail closed. Transient admission contention retries a
complete pass with the original budget, bounded backoff/jitter and no bypass.

Explicit native SQLITE_BUSY/LOCKED at COMMIT on an open transaction retries that
same transaction only. Business callbacks are not replayed. Idle connection
replacement outside an active phase revokes the observed generation, re-admits
and reconciles deterministic business receipts. An admitted active phase ends
instead of reconnecting. Unknown COMMIT acknowledgements become indeterminate.
The established per-tenant resource_locks sync ownership model is retained.

## Budgets and clients

Admission: 30s. SYNC work: Cloudflare/event 120s, GitHub/manual 180s. Drain work:
Cloudflare/manual 45s, GitHub 90s, event 25s. Settlement sub-budget: 15s. Whole-phase
caps: SYNC 165/225s; drain 90/135/70s. Original work and overall clocks remain
conservative success-submission guards; the settlement clock grants no new
success authority. Cleanup is capped at 15 seconds inside the remaining overall
deadline, skipped after overall expiry, and cannot finalize success.
The transaction kernel requires at least 25 ms remaining before submitting each
COMMIT attempt. This is a submission guard, not a guarantee of remote completion
within 25 ms or a retroactive cancellation mechanism.

Worker attempt caps remain sync 180s and drain 100s, two attempts, 16 KiB streamed
body limit and 561s configured combined window including backoff. Signing, header,
body and cleanup cancellation protections remain. It accepts successful dependent
execution only with FINALIZED_SUCCESS. Indeterminate SYNC retries the same signed
identity and never starts drain. GitHub jobs each retain their 10-minute guard;
one bounded CLI reconciliation attempt uses a new runtime with the same identity.
Explicit later reconciliation uses PHASE4_RECONCILE_REQUEST_ID with matching
phase/source/release/mode/config. Conflicting identities fail closed.

## Superseded test assertions

Original Round 3 tests/TAP and Round 2 test sources are preserved in
`phase4-v32-evidence/round3`, and the historical ledgers remain unchanged.

- Rejected post-submission cancellation assertions forbidding all durable success
  are replaced by immediate non-success plus fresh durable reconciliation tests
  in phase4-v32-settlement. This is the Owner's explicit contract change.
- Round 2 handoff-HMAC and heartbeat-projection cancellation now verify immediate
  non-success while retaining already-finalized database truth. These operations
  no longer confer independent completion authority.
- Nested settlement now fails EXECUTION_SETTLEMENT_MUST_BE_ROOT; it cannot expose
  success while an outer transaction is still uncommitted.
- Same-wrapper reopen assertions now require a new private runtime and fresh
  admission. Actual pre-import attacks are tested independently; externally
  supplied compatibility receivers require fresh privileged verification.
- Current-schema assertions/fixtures move to v32. Frozen localization migration
  tests explicitly target v31. Historical Stage 5/6 schema/business assertions
  remain unchanged, apart from the normal-driver test's latest-schema number.
- Worker success fixtures explicitly carry FINALIZED_SUCCESS; separate negative
  controls reject missing/unfinalized authority. No transport limit is relaxed.

## Migration and rollback

Controlled v31→v32 uses the original keys, no health rewrite, no historical
backfill and no execution-success backfill. Applied authority is checked before
DDL; interrupted v32-only DDL/checkpoint/version writes resume idempotently.
Current v32 operator no-op verifies without DDL. Runtime never migrates.

Raw RC2 is not compatible with v32: its exact schema/migration guard rejects 32.
Rollback uses the reviewed v32-capable candidate binary with
PHASE4_EXECUTION_PROFILE=RC2_V32_ROLLBACK and Beta OFF/OFF/empty allowlist. This
closed profile preserves ordinary sync/report behavior and the signed RC2 legacy
HTTP body, binds its authenticated body digest, and performs v32 settlement.
It admits no Shadow drain or presentation. Stop incompatible clients first;
never deploy raw RC2 against v32, downgrade schema or restore pre-v31 data for
ordinary code rollback. The exact rollback binary must be pinned/read back during
the separately authorized rollout review.
