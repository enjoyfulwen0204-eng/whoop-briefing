# Ordinary SYNC read preparation candidate

This local author candidate starts from exact `600143a29188b867b33a6207b2eb966e015808f5`
(`358eef807cabb3ace7d173b4c08cf817eb0669bd`). It does not qualify the production
envelope. Production STOP, original three legs, 120-second work, 165-second
server, 900-second epoch, 561-second caller margin and every required stage stay
unchanged. The existing portable 110 ms fixture is unchanged; a zero-latency run
is only a count and functional smoke observation.

Fixed readonly preparation now shares the original processing root transaction:

- Daily/weekly due reads retain their date keys and daily short circuit. Due,
  sync-state and scheduled FAST-state preparation share one unit.
- Proactive state and fingerprint metrics overlap after the original coverage
  anchor; monitoring metrics and active insight reads overlap in their own unit.
- Prediction metrics and capability reads overlap after the original anchor,
  preserving the 180-day window and optional capability error behavior.
- Reaper pending and orphan reads share a unit only when the pending list is
  empty. That branch has no first-pass mutations. For any nonempty pending list,
  the orphan read stays after the original expiration/repair loop. No orphan
  results are prefetched across first-pass writes. Telegram link retirement is
  unchanged and retains its separate error boundary.

Each store call still performs its original tenant, lifecycle/auth/privacy,
source/currentness and query predicates. Runtime/ownership fences still execute
on entry, per original call and COMMIT. No authority/data cache is introduced.
All fixed sibling reads settle before error propagation/rollback; their original
ordered failure priority is preserved. Calculations, provider/model/Telegram,
claims, lazy question expiry and durable business writes stay outside these units.

The new readonly preparation boundary refuses every mutation, including batches
and transaction-control SQL, and refuses `outside()` provider work. Even a caught
attempt poisons the unit. It does not suppress original runtime fences.

The fallback is deliberately narrow. Only the actual executor can issue its
private, one-use acknowledgment of a successful readonly rollback, tied to the
original execution-budget and durable-execution identities. Before consuming it,
the parent budget and settled-operation authority are checked again. Pending or
unknown COMMIT, unacknowledged rollback, timeout/cancellation, replacement scope,
attempted mutation/provider work and fabricated boolean/error fields cannot
authorize fallback. Valid fallback discards all shared results and executes the
original independently protected calls. It creates no business work identity or
receipt for swallowed failures. Ordinary first-list read failure still permits
the original orphan pass; global cancellation/uncertainty stops reaper work while
preserving its nonthrowing maintenance contract.

An initial isolated full zero-latency fixture measured 2,524 physical HTTP requests
and 3,541 actual SQL statements. The candidate measured 2,489/3,524, with all three
real Morning/model/record paths, scheduled Prediction/Healthspan and FAST resources
finishing, no duplicate acknowledged sends and no real provider request. This is
35 fewer mocked physical requests; local time is not a latency projection. This
reduction alone may be insufficient for the original 15-second reserve at 110 ms.
Root coordinates the next full original-latency qualification; no such run was
started by this author.

Focused controls cover actual installed Hrana coalescing and SQL-failure rollback,
original live fences, readonly mutation/provider refusal, rollback proof scope and
consumption, unknown COMMIT/cancel/expiry, all-settled failure priority, original
reaper mutation/query order and independent pass failure behavior. Existing
metadata-currentness, maintenance independence, gate suppression and event
convergence checks remain relevant. Raw native SIGSEGV outputs are retained; the
unchanged `600143a` four-case proactive native control reproduces that failure
after four passing assertions. No whole proactive file PASS is claimed.

This is author evidence, not independent approval. A separate reviewer must assess
the exact fallback/readonly unit and composed call sites before any operational
decision. No provider, credential/environment file, production health, live DB,
schema/config/pilot, push, deployment or production operation occurs here.
