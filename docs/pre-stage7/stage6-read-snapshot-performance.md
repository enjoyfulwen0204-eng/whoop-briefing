# Stage 6 transaction read reuse candidate

This is a local performance repair with isolated installed-driver evidence. It
does not establish provider cost, a 45-second production drain, full-generation
capacity, publication qualification or production deployment. Core SYNC timeout
diagnosis remains separate; no timeout, lease, generation, schema or flag changes
are included.

## Confirmed repeated work

A single receipt-backed v32 Body compute with the existing 30-day baseline makes
5,263 actual SQLite statements through 5,260 mocked Hrana HTTP requests before
this repair. Context checks account for 3,084 statements, canonical roots/access
for 2,011, and source links for 131. `prepare`, `persist`, source revalidation and
receipt graph reconstruction repeatedly select equal data in the same original
write transaction. These counts are recorded at the isolated server's actual
statement execution, including conditional batches; they are not nested proxy
counts or provider-billed units. The same input/as-of is used for both sides;
the actual execution/lease/persistence clock is not frozen.

## Bounded scope

Only the privately owned, admitted runtime can activate this optimization.
Foundation and Stage 6 `core.run` identify the same server-owned context; the
original processing boundary still opens its SQLite write transaction. A memo
belongs to one transaction attempt and one exact context object, uses exact SQL
and typed bound arguments, and only accepts a closed list of deterministic
owner-bound source/artifact/receipt data SELECTs. The fixed original user-state
generation projection and computation-state projection are data snapshots;
auth, purge, lifecycle, timezone and input comparisons still execute each time.
Caller-owned receivers with unobservable close/reconnect lifetimes do not reuse
reads. A context does not gain authority through this API.
Budget and durable execution scope identities must also match the transaction's
original scope. Parent abort immediately closes the memo; expired callbacks
cannot refill it or transfer it to a new budget/execution.

Resource leases, execution/producer/work owners, database/current clocks, schema,
metadata admission, migration/key continuity and token material are excluded.
Original branded context, source versions, complete graph traversal, HMAC/hash,
job fences and commit ownership checks continue. No traversal is declared valid
just because a prior traversal succeeded. Current time/lease and cancellation
checks never come from this memo.

Every mutation, including coordination/receipt writes and batches, invalidates
all context entries both before and after driver submission. An epoch excludes
late reads crossing a mutation. Rollback/replay/deferred attempts, COMMIT
submission (including contention retry), completion, close/reconnect/lifetime
termination clear and close the memo. No scope survives a transaction or uses a
persisted cache. Limits are 256 entries, 4 MiB per attempt, 256 KiB per result,
128 rows per result and 8 KiB per key; exceeding a limit uses the original read.
Driver ResultSet prototypes, numeric row aliases and primitive values are
preserved, with separate clones on storage and return so caller mutation cannot
modify a future read. Binary storage is included in the byte bound.

## Focused evidence

The equivalent representative work uses 1,608 actual SQL statements and 1,605
mocked HTTP requests after reuse, about 69.5% fewer requests. The four execution
owner reads and durable work receipt remain identical; canonical rows, result,
quality, confidence and all drivers are identical. Local elapsed time is not a
network latency/cost projection. Normal logical `DB_QUERY` telemetry still counts
facade calls; `DB_HTTP` measures real submissions.

Focused tests cover original schema/context and same-transaction mutation
fences, rollback, late I/O/write epochs, parent cancellation, timeout, private
lifetime versus caller-owned lifetime, context/tenant/root/commit isolation,
savepoints, thrown writes, outside rollback attempts and abandoned async scopes,
mutable results/numeric aliases, excluded clock/owner/key shapes and finite memo
bounds. Earlier failed local test attempts are retained as diagnostic evidence.
The exact candidate still requires independent code/configuration review before
any production operation. No provider/credential/live health read, Telegram
send, public push or deployment occurs in these tests.
