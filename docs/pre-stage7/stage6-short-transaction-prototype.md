# Stage 6 bounded short-transaction prototype — 2026-10-14

One LOCAL/SYNTHETIC/ISOLATED prototype from `75db69fe77d2380206df25509187b79c68d05fd7`. Accepted runtime `src` and 9770553 ancestry are preserved. No Production requests, permits, paid execution, push, deployment, schema additions, credential/F02 changes or Stage 8 worktree changes. Runtime integration and Production remain **NO-GO**. Target capacity and real crash tests pass; the first two synthetic jobs are COMPLETED/current and the remaining four are running.

## Confirmed bottleneck and correction

Reuse accepted [architecture evidence](stage6-architecture-decision.md): repeated authenticated source-link consumers exhausted 128 actual prefix reads at both 10/25ms (`BETA_PILOT_DENIED`, mapped CALCULATION_FAILED). A tenant-wide receipt insertion observation exceeded 2MiB (`BETA_PILOT_PREFIX_BOUNDS_UNAVAILABLE`). The inherited, explicitly loaded test-only DATA memo and exact indexed insertion observation preserve original HMAC/authority checks and outputs; they grant no permit. Full DOMAIN at115ms previously used411 HTTP /15,192 SQL /61.107s. The strict30s attempt used296/4,641/41.218s with zero new DOMAIN. These are distinct before measurements. Source continuation produced no new work at115ms even with a300s diagnostic.

The new prototype snapshots bounded tenant DATA once, runs the original admitted algorithm in a privately owned SQLite/libsql RAM receiver, and records only original successfully committed DML and expected affected-row counts. All original source/control/version/provenance/HMAC checks and output semantics run. Preparation is immutable memory, **not durable progress**. A private sealed transcript is bound to the exact client, execution and budget. Server publication freshly compares the original schema, complete typed projected rows/counts, execution identity/generation/owner, original issued job/tenant/context lease expiries, actor and worker deadlines, plus connection enforcement flags. It then atomically publishes those completed original writes; immutable/FK/check triggers still run. Zero-row effects abort the batch. Final fresh owner/DB-clock fences precede COMMIT. No incomplete calculation is promoted.

Installed @libsql/client0.15.15 `batch(...,'write')` uses BEGIN IMMEDIATE, chained previous-step-ok conditions, COMMIT only on success and ROLLBACK otherwise in one real Hrana HTTP request (`lib-esm/hrana.js:199`). This is an installed-driver fact, not guessed CAS behavior. No new persistent health ledger or schema object is used. Complete scoped predicate equality is deliberately conservative: unrelated changes cause rollback/retry instead of stale publication.

Keyset probes return only PK/byte metadata, with1000-key pages and a16000-key/table fail-closed cap. Adaptive DATA pages have at most250 planned rows,1000 actual rows and2MiB each; total16MiB and128 DATA-page groups. Every fresh count/conservative-byte gate runs **in the same DATA read transaction before any payload SELECT**. Row growth/insertions after earlier metadata cannot bypass the envelope. No OFFSET or repeated full-prefix remote algorithm scans. Complete original authenticated graph validation still runs on RAM DATA.

Before health delivery, preparation registers the existing tenant/purge-generation context lease remotely. RAM is erased and closed before lease release. SIGKILL destroys RAM; the existing15-minute lease TTL/reconciliation fences purge until safe cleanup. Concurrent publication/disposal is rejected while a private publishing flag retains the health barrier through the in-flight frame; sole finally disposes after settlement. Unknown context-registration/publication ACKs set original pending/indeterminate state and block further work. Original work receipts reconcile durable COMMIT uncertainty; calculations are not blindly replayed.

## Measured115ms target

DOMAIN:23 phase HTTP /1,309 provider SQL /3.823s whole phase /2.095s worker. Another5 HTTP/SQL performs durable output readbacks. Publication0.251s including fencing and COMMIT; DOMAIN rows1→2, exact signed named ACK and finalized producer HMAC. Next source:23/1,828/6.247s whole/4.531s worker; publication0.295s, USER→cycle-current cursor, RUN/ITEM2→3, generation8/current SHADOW.

| DOMAIN operation | HTTP | Provider SQL | Elapsed ms | Worker ms remaining | New durable calculation |
|---|---:|---:|---:|---:|---|
|Original claim/admission|5|6|640|29999|0|
|Control + context registration|2|5|283|29716|0|
|Catalog + column/index metadata|2|92|306|29410|0|
|Key/byte metadata|1|88|153|29255|0|
|Bounded authenticated DATA snapshot|1|183|222|29031|0|
|RAM import/original algorithm/HMAC|0|0|636|—|0|
|Fresh actor/owner observation|1|1|123|28286|0|
|Atomic publication/fencing/COMMIT|1|922|250|28028|1 original DOMAIN unit|
|RAM disposal/context release|1|1|122|27904|Already durable|
|Original signed phase settlement|9|11|1087|Separate15s reserve|Finalized producer|

Provider SQL excludes RAM-local statement work: zero remote SQL does not mean zero computation. Preparation/native/publication are overlapping submeasurements; do not add them twice. Whole phase includes original request claim and signed settlement; readbacks are separate. Every qualified leg asserts worker<30s, phase<45s, publication<4s, with a conservative5s transaction-lifetime model. No execution timeout is enlarged. Actual account server limits, autonomous cancellation of a single long statement and Production RAM fit are not established by this fixture.

## Durable proof and verification

Original receipt verification authenticates stored operation HMACs, generation/currentness, exact DOMAIN named ACK, producer tenant HMAC/result digest and FINALIZED_SUCCESS ordering. Reopen preserves immutable receipt bytes. Altered HMAC and foreign-tenant context fail. Deterministic run keys are unique. Exact identities are in [stage6-short-transaction-evidence.json](stage6-short-transaction-evidence.json).

Completed tests: target1/1; source/input generation, revocation, purge, lease, raw-content, clock, tenant/capability, zero-row/ACK, fresh DATA-envelope race/context-registration ACK and publication/disposal concurrency negatives13/13; ordinary-entry isolation/transaction ceiling6/6; original finite128-group/2MiB reproduction3/3. Two actual child-process SIGKILL cases2/2: before publication→NOT_COMMITTED; after durable COMMIT/before ACK→WORK_COMMITTED_UNFINALIZED. Reopening resumes the required next unit without another DOMAIN. An intermediate negative fixture failed on an over-specific SQL regex, then passed focused2/2 correction. Earlier aggregate/one-row paging failures exposed snapshot/group capacity bounds; byte-packed keyset pages replace them. Failed variants are not called PASS.

Six-job test: first isolated database reached2/2 genuine COMPLETED/current jobs after102 productive legs, max worker14.187s/phase16.135s/publication1.326s, with19 authenticated operation receipts/102 finalized producer HMACs/558 work receipts and17 unique RUN/ITEMs. Remaining four jobs are running: three isolated136 WHOOP+7 Journal+USER successor datasets, two original job kinds each, repeated bounded work. This does not clone six captured private Production inputs. Each leg must commit a real item/unit or finalize an original job; all final generations/cursors/leases/receipts/producers must verify after reopening. No fabricated queue completion.

One independent reviewer examines only this new boundary. Prior temporal-expiry, lost-ACK and schema-observation findings are corrected. Its3MiB-after-metadata negative independently confirms rejection before DATA delivery and zero cursor progress. The six-job long test loaded the pre-lifecycle-serialization helper; algorithm/SQL/gates are identical. Final lifecycle-only correction is separately retested by target,13 negatives and2 actual SIGKILL tests; no frozen-SHA full-long-run claim. Frozen SHA confirmation is pending. Reuse Stage1–5/unchanged6–7 reviews; no full-project audit.

## Release boundary

**Schema required: NO for this prototype.** Runtime, Stage7v33/Stage8v34 migrations/contracts are unchanged; no SHADOW→LIVE promotion. Journal6/7 is separately six-item TENANT_LIMIT, not a seventh-source failure. Prior seventh-source/Body/USER evidence remains valid. Production second pilot is12/12 exhausted; none is reset/spent.

Next authorization: a focused runtime integration task carrying actual branded DB/context, signed SYNC handoff, active monitored pilot reservations and cancellation through this boundary; restrict real projections to necessary health/control fields instead of copying token secrets; cover accepted schema32/33/34, purge and bounded conflict retry; qualify provider payload/SQL/cancellation limits on an independently authorized disposable endpoint. The prototype hardcodes synthetic a/SHADOW and https://isolated.invalid with explicit fixture fetch; ordinary service entrypoints reject the loader. Unmonitored RAM tests do **not** qualify paid/prefix reservation accounting. HTTP/SQL counts are not billed rows. No new infrastructure monthly fee is needed for the proof; actual per-run cost and512MiB Production capacity remain unqualified. New public SHA publication, exact-SHA deployment and a narrowly capped paid validation permit each require explicit owner authorization.
