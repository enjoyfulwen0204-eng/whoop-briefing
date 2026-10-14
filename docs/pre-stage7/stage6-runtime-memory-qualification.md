# Stage 6 runtime integration and memory qualification

Local candidate only. Full runtime acceptance and Production deployment remain **NO-GO**. No Production reads/mutations, paid execution, publication, credential changes, grants, permits, migration, infrastructure or Stage 8 worktree changes occurred. F02 remains Owner Accepted Risk. Baseline `b1e0d193b2eac17de309da8ae424ad7a66b05a42` and `9770553` ancestry remain intact.

Runtime source: `e9a5bf258561d50bdf81fee482234a35ce12c5ed` (tree `64ec5f5bcd53d13662a9c744bd56f91fe3bd941e`), following integration commit `d7f904ebd267953293536aa1bc0070d83dd9fe74`. Exact current-ACK test successor `db0fb92f1a4942af34f95aff3100d19eb47ea37c` has identical `src/`. Subsequent evidence-only commits preserve this source. See the adjacent JSON evidence and sole independent delta review for hashes and scope.

## Memory evidence and its limits

The previous `547192832` bytes is **547.19 decimal MB / 521.84 MiB**, exceeding 512MiB by 9.84MiB. It was a post-leg observation, not a kernel maximum. Host Node22.23.2/arm64 had a roughly4GiB default V8 heap limit; that is unsuitable evidence for the deployment memory constraint.

Each full sequence runs in one Node process, including the loader worker, in-process Hrana/SQLite provider emulator, private admitted RAM receiver and three fixture lifetimes retained until teardown. Both sequences complete all6 jobs/306 legs with no manual GC or `--expose-gc`. `process.memoryUsage()` samples every20ms and GC observations measure heap/external/ArrayBuffer allocations. The second sequence also captures kernel peak RSS, so synchronous peaks are not omitted. Native allocations are included in RSS but are not exhaustively represented by V8 `external`. These measurements are not additive. [Node memory/resource units](https://nodejs.org/docs/latest-v22.x/api/process.html#processresourceusage).

| Local sequence | V8 old/semi MiB | Peak RSS | Heap used peak | External peak | Result |
|---|---:|---:|---:|---:|---|
| Full algorithm6/6, first |128/4|496353280B sampled|102301520B|13034853B|PASS, only7.55% sampled512MiB headroom|
| Full algorithm6/6, repeat |96/2|405618688B kernel /391397376B sampled|97072424B|12389803B|PASS,24.45% kernel512MiB headroom|
| Actual monitored4 bounded legs |128/4|368705536B kernel|111328056B|18946499B|PASS with restart/HMAC verification|
| Actual monitored2 post-source-freeze legs |128/4|372228096B kernel|101312272B|18833405B|PASS, receiver ownership7/7 retired,52 scopes disabled,0 live|
| Frozen actual monitored4 current-ACK legs |96/2|373342208B kernel /357384192B sampled|82221888B|18872417B|PASS,13/13 receivers retired,98 scopes disabled,0 live|

Full96 sequence GC totals69.53s over1556.13s, with natural GC only. Final RSS265715712B, heap33490192B; each RAM receiver retires at the productive boundary. Full dataset3 does not exhibit unbounded receiver retention. Maximum algorithm work10.679s, complete leg12.484s and publication1.120s under CPU contention from other isolated tests; original30s/45s boundaries and5.5s publication reserve remain unchanged.

The actual service plan is `0.5c-512mb`, one Node instance in Oregon; prior retained read-only evidence places Turso in Tokyo.115ms is simulated. Render documents plans in MB; a fresh Linux cgroup limit has not been inspected. [Render plan labels](https://render.com/docs/compute-plans). Host `constrainedMemory()` is0. Docker daemon is unavailable; no image or paid resource was purchased. The application defaults to3 concurrent SYNC users, whereas monitored qualification uses1 and a process-wide single Stage6 preparation latch. Real simultaneous SYNC/webhook/native allocations and Linux allocator behavior remain unqualified.

## Integration and durable proof

The actual `runExecutionPhase → createPublicBetaRuntime → monitored grant → Stage6 worker` composition uses the accepted original algorithm in an owned RAM receiver, then publishes original completed DML/ACKs in one short atomic batch. It retains the original typed snapshot/schema comparisons, actor/source/generation/lease/purge/producer/HMAC guards, runtime admission, signed settlement, idempotency and receipt-only reconciliation. No schema object or durable ledger was added. Only SHADOW preparation is supported; schema33/34 execution is not newly qualified. Stage7/8 contracts and independent worktree remain unchanged.

The integration corrections are bounded:

- Privately owned receiver scopes track active async callbacks. Terminal native close retires scopes only after callbacks settle; global budget/execution and peer scopes remain active. Success, rejection, cancellation and retry cleanup are covered.
- Server-only binding/coverage proofs tie one completed bounded DATA import to its exact RAM receiver, current grant/attempt, execution, budget and parent transport. Provider token values are omitted; only auth generation is imported.
- Existing exact evidence authority item/scope reads now probe their actual immutable PK prefix. The previous whole-tenant probe23rows/1160534 conservative bytes exceeded1MiB; original HMAC/root/type/byte checks remain.
- Guarded proxy re-entry delivered the same physical driver ACK to inner and outer recorder frames. An instance-local WeakSet records each physical result once; distinct installed-SDK statements return distinct result objects. Original affected-row checks remain strict.
- Actual DB-clock/grant/lifecycle guards precede and follow the writes inside the atomic batch. Post-COMMIT observation failures retain indeterminate settlement. Private capability minting, zero coverage and expired-budget latch bugs found by the reviewer were fixed and re-reviewed.
- A pre-existing baseline permit cleanup bug is repaired only in its existing private closure scope; an expired business transaction still rolls back and its durable negative-only closure survives restart.
- Genuine original `NO_WORK`/`NO_ELIGIBLE_WORK` outcomes retain fresh typed queue/control publication. They never complete a pending job.

Four115ms monitored invocations commit original source work and cursor progress:17.398/16.685/15.377/15.280s,111HTTP each,4306/4108/4114/4120SQL. Final publication1.025–1.100s. Reopening after each verifies signed receipts18→19, sealed producers78→82 and named work receipts371→388. The new receipt is `analyzeAssociationFamily`, committed under its original **stage6.associations parent ACK**, not a newly created cycle DOMAIN. Exact current execution/generation, association and cursor ACKs are independently recomputed by `stage6RuntimeCurrentProof.mjs`. The printed cycle DOMAIN proof is retained earlier evidence and is labeled accordingly.

Cancellation before DATA and cancellation after complete RAM calculation leave the persistent cursor and18 original receipts unchanged. After active RAM cancellation, all3 owned receivers/22 scopes retire with0 live callbacks/scopes. Actual runtime lost ACK and actual process SIGKILL after atomic COMMIT yield5 current named receipts and `WORK_COMMITTED_UNFINALIZED`. Fresh restart waits for the **original** deadline, then settles `RECONCILIATION_ONLY/FINALIZED_SUCCESS`,19 signed receipts/79 producers/376 work receipts; permit remains1 attempt. No owner/lease clock or counter was forced.

## Acceptance boundaries

Both full algorithm sequences legitimately complete all6 synthetic jobs with57 signed operations,306 finalized producer HMACs and1674 work receipts; source/family cursors clear and all6 completed generations equal8. They remain unmonitored algorithm fixtures, not proof that the actual finite grant can finish6 jobs. The original monitored allowance is12 attempts. A fresh representative dataset has144 sources for each of2 jobs: even the original6-item tenant limit requires at least48 reservations before RAW units. The conservative integrated1-item boundary requires at least288. No additional allowance, ledger reset or fake completion is authorized. Production remains exhausted12/12; Journal TENANT_LIMIT is separate from capacity and these financial limits.

A stricter128/4 current-ACK run committed its first request but denied its next before RAM, consistent with the RSS admission boundary. Entire test FAIL0/1: this counterexample prevents128/4 general memory acceptance. An initial96/2 run crossed a local HEAD commit and correctly failed the original release fence after publication; it is invalid capacity evidence, retained as a release-control rejection. The frozen96/2 retest PASS4 legs, current new association/checkpoint ACK and all restart proofs, with kernel373342208B (356.05MiB),30.46% headroom. No admission threshold, deadline or timeout was relaxed.

Focused evidence: receiver5/5; permit17/17; other focused suite51/51; original source safety16/16 plus SIGKILL2/2; new pre-DATA cancellation1/1, active-RAM cancellation1/1, lost-ACK restart1/1, actual SIGKILL restart1/1, completed queue/no-work1/1. The sole independent reviewer reports no retainedP0/P1 and **GO for scoped security/partial monitored proof only**. Earlier rejected controls, native test-process SIGSEGV, artificial diagnostic response-cloning heap failure, release-fenced run and128 admission counterexample are not hidden or counted as passing acceptance.

## Smallest remaining qualification and release prerequisites

Keep the accepted short-publication architecture. First qualify96/2 under Linux512MiB/0.5CPU, with the Hrana emulator outside that cgroup, actual service composition/concurrent SYNC, repeated jobs, cancellation and restart.96/2 has both full algorithm memory and4 frozen monitored-leg evidence;128/4 has actual monitored positive evidence but a retained admission counterexample. No profile is approved for Production yet. Do not use manual GC or raise the cap to turn a fail into PASS. A larger resource plan requires measured need and separate owner approval; no purchase is justified yet.

Then resolve the finite monitored continuation/cost contract with explicit owner approval; preserve the exhausted ledger. Qualify actual Turso payload/batch/statement/clock/cancellation limits on an explicitly authorized disposable endpoint. Actual per-run billed cost is unqualified: HTTP/SQL counts are not billed units and the old US$0.10/attempt estimate is not a capacity certificate.

Only after those gates: final independent runtime acceptance; exact new SHA publication authorization; separate exact-SHA deployment approval; reviewed Node memory flags and existing release/configProof/signed SYNC handoff controls; narrowly authorized paid validation with fresh legitimate finite admission. No Production DRAIN is currently authorized. Deployment, public push and Stage6 Production completion remain **NO-GO**.
