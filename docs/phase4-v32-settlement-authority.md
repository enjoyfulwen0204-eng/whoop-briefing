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
ESTABLISHED → ABORTED is terminal. A retry must use a new request/execution ID.
An ESTABLISHED row with a committed work receipt cannot be aborted; cleanup
retains that unfinalized row for explicit reconciliation/takeover. A committed result cannot
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
back both effect and receipt. A named generic step checks its deterministic receipt before the business
callback; a lost acknowledgement cannot replay its effect. Domain retry resumes
reviewed deterministic business identities and cursors under fresh authority. Existing deterministic Stage 5 receipts, Stage 6 cursors/work
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
The newest immutable execution identity is selected by execution_seq. A later
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


## Unpublished v32 review repair

This repaired v32 replaces the rejected, unpublished 0a8597b candidate in place.
The execution-authority checkpoint is `phase4-execution-v2`. No v33 allocation
or historical execution backfill is needed. Production has not been migrated.

### Complete transition matrix

Rows are old states, columns are requested states. `Y` is legal subject to CAS,
identity, ownership, lease/deadline and result constraints. `N` always rejects,
including a terminal self-update. Projections belong outside authority rows.

| From / to | ESTABLISHED | WORK_COMMITTED | FINALIZED_SUCCESS | FINALIZED_FAILURE | ABORTED |
|---|---|---|---|---|---|
| ESTABLISHED | Y | Y | N | N | Y, only without receipts |
| WORK_COMMITTED | N | Y | Y | Y | N |
| FINALIZED_SUCCESS | N | N | N | N | N |
| FINALIZED_FAILURE | N | N | N | N | N |
| ABORTED | N | N | N | N | N |

Active owner takeover increments generation exactly once; ESTABLISHED takeover
requires expired lease. Committed result bytes/digest stay immutable. Finalized
or aborted identity, generation and owner can never be revived. `BEFORE INSERT`
rejects duplicate ID/ordinal before SQLite REPLACE can delete its victim, even
with recursive triggers OFF. DELETE, replacement, duplicate IGNORE and UPSERT
are not execution-authority mutation APIs. Existing rows use conditional UPDATE.
Receipt UPDATE/DELETE/REPLACE is also rejected. There is no ordinary purge/reset
path for execution authority.

### Deterministic steps and canonical reconciliation

`transaction(fn, {workStep})` accepts a stable server-chosen logical operation
identity. Its receipt key binds immutable request digest, canonical scope and
step kind/business identity; release/phase/mode/source/config are bound by that
request digest. Owner, retry generation, wall time, process ID and random nonce
are excluded. Each receipt records immutable request/scope/generation proof and
only an optional finite scalar count/boolean/opaque hash result. The business
mutation and receipt commit atomically. On a fresh authorized retry, receipt
lookup precedes the callback and returns the stored safe result without replay.
Different steps have different keys. Generic state/custom table mutations without
a step key fail before DML. A generic callback must return a safe aggregate or
void; health payloads and user-facing text are rejected and rolled back.

Reviewed domain stores retain their canonical object/operation receipts and
Stage 6 cursor/family authority. Their root receipt is a deterministic execution
progress ordinal, not their business dedupe. It does not authorize success or
justify blindly replaying a non-idempotent callback.

`reconcileExecution` is the shared read-only classifier. It validates immutable
request identity, result digest and receipt request/scope/generation, then returns
NOT_COMMITTED, WORK_COMMITTED_UNFINALIZED, FINALIZED_SUCCESS, FINALIZED_FAILURE or
ABORTED. Corruption and authority mismatch throw typed errors. An ESTABLISHED row
with any committed work receipt is WORK_COMMITTED_UNFINALIZED for reconciliation;
absence of receipts does not bypass an active owner or its transaction lock.
COMMIT acknowledgement loss sets the execution context's indeterminate state.
The transaction kernel reads durable state before exposing that ambiguity.
Domain error handlers must propagate it before calculation/retry mapping; the
phase runner checks the context even if a callback swallowed the exception.
Only a later fresh authorized reconciliation/finalization can produce success.

### Producing executions and currentness

`phase4_execution_producers` binds each contributing execution to user, SHADOW
mode and input generation, with its immutable execution ordinal, producing owner
generation and keyed tenant proof. Stage 6 claim/checkpoint/completion records the
binding inside durable work transactions. Bindings are additive across producing
executions; they do not erase an earlier contributor. Currentness requires the
completed input generation **and every producing execution FINALIZED_SUCCESS**,
correct ordinal/generation/phase and tenant proof. Missing, failed, unfinalized or
cross-user authority withholds presentation. Later unrelated NO_WORK cannot add
a producer and cannot launder an earlier unfinalized result. Partial durable work
is retained, and reconciliation can make it eligible once properly finalized.
A retained reader also checks durable schema version, so an old facade cannot
keep the pre-v32 publication rule after controlled migration.

Completion evidence comes from finalized execution rows. v32 no longer writes
the tenant success heartbeat inside ambiguous Stage 6 work COMMIT. Heartbeats are
best-effort projections after finalization and cannot authorize publication or
drain. Durable diagnostics use execution_seq; projection order also uses ordinal.

### Immutable monotonic ordering

`execution_seq` is an INTEGER PRIMARY KEY AUTOINCREMENT with a safe-integer
constraint; execution_id is immutable UNIQUE. SQLite allocates it atomically in
the short establishment transaction. No lock spans WHOOP/provider work. Each
committed establishment is strictly newer globally and therefore within each
canonical scope. Explicit ordinal regression and later mutation reject. Death
before establishment COMMIT creates no durable execution; a subsequent allocation
remains above all committed ordinals. Finalization timestamps never change order.
Phase/source progress uses the ordinal index, and projections carry identity plus
ordinal. Tenant generation bindings retain all contributors rather than selecting
an older completed row over a newer pending producer.

### Controlled migration only

Only `scripts/phase4-migrate.js` applies v31→v32, with explicit operator flags,
Node 22, original keys, target/production/commit guards and postconditions.
`scripts/migrate.js` is an argument-preserving alias for that tool. Read/admin,
preflight, OAuth, webhook, bot and scheduled/briefing runtimes never migrate.
Older schema fails with CONTROLLED_MIGRATION_REQUIRED; future schema rejects.
Diagnostics may explicitly opt into `--legacy-read-only`; that path cannot
upgrade. The migration caller/entrypoint inventory accompanies review evidence.

### Review boundaries and preserved products

Node 22, private phase runtimes, metadata-only admission, bounded same-transaction
COMMIT BUSY retries, cross-process resource_locks ownership, signed release-bound
handoff, Worker limits and GitHub ten-minute guards remain. HTTP transaction
setup now acknowledges lazy Hrana BEGIN before the business callback so BEGIN
contention can retry safely. No callback replay is used to retry COMMIT BUSY.
Ordinary morning briefing/report dedupe remains separate from Beta presentation.
Body Energy is NOT_AUTHORIZED_NOT_PRESENTED; no LIVE or future-stage activation.
Settings v1 remains the first post-launch UX patch, schema-neutral unless reviewed
otherwise, with /settings, language/name controls and /language /name shortcuts.


### Complete immutable request matching

Execution rows retain canonical_request_json, a sorted serialization of the
validated flat request fields. This contains only phase/source/mode, opaque IDs,
release SHA and authenticated hashes; raw request bytes are not persisted.
The raw authenticated body digest remains identity_digest, so signed retry and
conflict behavior is unchanged. Canonical JSON rejects unknown/duplicate keys
and non-string fields at SQL insertion; its fields must match the immutable
columns. It cannot be updated. Helpers compare the complete canonical request,
including handoff and legacy body digest, before result persistence. This closes
wrong-request poisoning that a subset of column comparisons could miss.

### Expired parent and committed-only reconciliation

A new drain still requires the fresh age-bounded successful SYNC handoff. An
existing WORK_COMMITTED drain may instead finalize its immutable result after
the handoff ages out: no business callback runs. An ESTABLISHED drain with
canonical committed receipts and an expired parent may reconcile **only** that
already durable progress under fresh authenticated, owner/generation/deadline
and matching release/config/source authority. It records PARTIAL with
RECONCILIATION_ONLY, historical workReceipts and zero newly processed items;
it never discovers, calculates, drains or presents new work. It is not full
backlog completion and cannot invent a complete result from an uncertain ACK.
A later fresh-handoff invocation resumes remaining work through existing cursors
and receipts. This explicitly finalizes the producing execution rather than
letting an unrelated NO_WORK launder its unfinalized data.

Parent FINALIZED_SUCCESS, complete typed SYNC, exact release/source/mode/config
and deterministic handoff HMAC still must match. Missing receipts/uncommitted
work does not qualify, nor does ABORTED. All new business work keeps the original
handoff age limit. Original request body identity must match; reconciliation of
an older release uses its approved matching binary and configuration.
