# Stage 6 final architecture decision — 2026-10-14

Status: **STAGE6_RAW_SOURCE_CAPACITY_REPAIR_PARTIAL**. Stage 6 code capacity **NO-GO**; Production **NO-GO**. Stop increasing execution budgets. Do not implement a speculative DOMAIN ledger migration. This checkpoint retains the accepted runtime `src` byte-for-byte from `88cc17e41c3a30cb2723ca37c19adf42a23cb08d` (tree `15815638667e502f57eef1a807abde34dc6cb50c`), with verified `9770553` ancestry. The seven-file experiment is a test-only, explicitly loaded memory overlay, not a release change. Stage 7 v33, Stage 8 v34, F02, tokens and other worktrees are unchanged.

Machine-readable measurements and exact synthetic DOMAIN receipt/producer identities are in [stage6-architecture-decision-evidence.json](stage6-architecture-decision-evidence.json). Exploratory measurements loaded release 88cc17e with the recorded working variant; they are not mislabelled as frozen-HEAD tests. Frozen verification is recorded separately after the local checkpoint commit.

## Confirmed causes and measured boundaries

The manual/Cloudflare worker has 45 s configured, **30 s effective** after its 15 s safety margin. It must include selection, ownership and publication checks in that effective period. Low latency DOMAIN success is real, but the repeated authority closures, receipt inventory and permit-clock observations consume the higher-latency budget before final root capture/publication. SQL batching alone has not eliminated the HTTP observations.

Retained exclusive phase profile at 115 ms, starting from the retained USER checkpoint:

| Operation | HTTP | SQL | Elapsed | New durable DOMAIN work |
|---|---:|---:|---:|---:|
| Admission/context/claim/enumeration/settlement | 111 | 163 | 14.752 s | 0 |
| Owned raw selector/BEGIN/outer cleanup, excluding DOMAIN | 62 | 925 | 8.569 s | 0 |
| DOMAIN through deadline failure | 102 | 3,859 | 14.816 s | 0 |
| Lease release | 27 | 40 | 3.265 s | 0 |
| Total | 302 | 4,987 | 41.402 s | 0 |

123 of 302 HTTP requests contain only pilot/DB-clock observations. Child measurements overlap their parent: analyzeMetric 43 HTTP/2,127 SQL/6.514 s, result-authority read 32/1,772/4.909 s, receipt encode 5/10/0.615 s, root capture 19/789/2.700 s before the deadline. At selector entry 22.272 s of worker budget remain, receipt execution 13.823 s, analyzeMetric 10.590 s, final root capture 1.707 s. These are reused accepted timing evidence, not a new production scan.

Full completion differs from an aborted 296-request DOMAIN attempt:

| Isolated case | HTTP | SQL | Whole phase | Physical DOMAIN COMMIT after worker start | New work |
|---|---:|---:|---:|---:|---|
| Baseline DOMAIN, 10 ms, existing GitHub 90/75 s policy | 411 | 15,192 | 12.803 s | 10.615 s | Exact signed DOMAIN ACK |
| Baseline DOMAIN, 25 ms, same policy | 411 | 15,192 | 20.510 s | 16.391 s | Exact signed DOMAIN ACK |
| Baseline DOMAIN, 115 ms, same policy | 411 | 15,192 | 61.107 s | 46.629 s | Exact signed DOMAIN ACK |
| Final batching/control prototype DOMAIN, 115 ms, test-only extended policy | 411 | 7,129 | 57.992 s | 43.451 s | Exact signed DOMAIN ACK |
| Baseline source/family continuation, 10 ms | 840 | 17,558 | 21.058 s | — | 0; prefix quota failure |
| Baseline source/family continuation, 25 ms | 840 | 17,526 | 37.442 s | — | 0; same prefix quota failure |
| Prefix DATA + exact receipt lookup source, 10 ms | 2,222 | 73,813 | 67.883 s | — | 1 source, cycle cursor, new RUN/ITEM |
| Final prototype source, 115 ms, 300/285 s test-only policy | 2,192 | 35,760 | 301.961 s | — | 0 new source/cursor/job |
| Baseline DOMAIN with modelled 5 s total transaction lifetime, 115 ms, 180/165 s policy | 228 | 1,603 | 31.098 s | — | 0 new DOMAIN; TRANSACTION_TIMEOUT |

The original frozen `caf08fc` failed DOMAIN attempt was 296 HTTP / 4,641 SQL / 41.218 s, not complete work. The full before/after prototype comparison is **411→411 HTTP, 61.107→57.992 s**. Reducing SQL 15,192→7,129 is useful but does not pass the 30 s gate. The 180 s prototype source test also failed without new source work; one subsequent 300 s diagnostic established the same result. No additional budget extensions are justified.

Every positive DOMAIN result is authenticated by the original operation receipt verifier and exact original named work receipt, finalized producer HMAC/result digest, source/input generation 8 and COMMIT ordering. Reopening leaves the receipt unchanged; HMAC tampering and foreign-tenant verification are rejected. This is genuine durable DOMAIN progress, not a cursor or job completion substitute.

### Source/family CALCULATION_FAILED is not a timeout diagnosis

At both 10 and 25 ms the underlying error is `BETA_PILOT_DENIED`: repeated source-link graph consumers exhaust `reservePilotPrefixRead`'s **128 actual prefix read sets**, during recursive `validateStoredGraph` / source revalidation / entity / episode opening. `stage6ErrorCode` maps the underlying error to CALCULATION_FAILED. The test-only DATA cache avoids repeated identical complete source-link reads while rerunning authority/HMAC checks. It next exposes `BETA_PILOT_PREFIX_BOUNDS_UNAVAILABLE`: the receipt insertion probe conservatively bounds the entire tenant/mode receipt history, including unrelated large Body/RAW receipts, at 2 MiB. Narrowing only the owned v32 Stage6 pre-insert observation to the exact indexed receipt key gets past this particular condition. Actual complete inventories retain their bounds. Neither problem is fixed merely by a longer timeout.

The prototype scopes DATA to the same private original transaction, context, execution/budget, opaque grant, active receipt marker and write epoch. Complete DTOs are cloned and bounded; fresh fences run on hits. Misses crossing a business-write epoch poison the transaction. No accepted authority, HMAC, currentness or receipt result is cached. Only adjacent identical pure control callbacks are coalesced; different callbacks keep their original order, every before/final/COMMIT check remains. Two independently found defects (ordinary LIVE fallback ordering and late-miss invalidation) were corrected before packaging.

There are two explicit work-envelope differences: identical cached consumers do not reserve another actual prefix read; the targeted insertion probe no longer requires unrelated tenant receipt history to fit the aggregate inventory bound. The 128 actual-read limit, payload/write caps, paid admission and 12/12 permit are not increased. More work can nevertheless increase per-attempt cost. This is not financial approval.

## Six captured jobs: evidence, supersession and unresolved blockers

Reuse the retained readback from 2026-10-13 01:06 UTC; no new production SQL was executed. Full opaque IDs and scope revisions are preserved in the JSON companion.

| Captured identity prefix / kind | Original→successor input generation | Actual evidence and specific blocker |
|---|---|---|
| 550c5325 / RECOMPUTE_DERIVED | 30→31 | External authenticated SYNC legitimately superseded generation; still PENDING/completed 0; non-owner is outside the owner-only pilot |
| ce3c5e8c / REPAIR_CURRENTNESS | 30→31 | Same; no captured failed calculation attempt; do not invent CALCULATION_FAILED |
| c95606a8 / RECOMPUTE_DERIVED | 35→36 | Same; 43 retained raw rows, not completion evidence |
| bab0e741 / REPAIR_CURRENTNESS | 35→36 | Same; no individual calculation failure proved |
| edc2adcd / RECOMPUTE_DERIVED | 22→26 | Authenticated SYNC supersession resets stale cursor; raw 133→136. Owner path has DOMAIN capacity and independently reproduced source quota/bounds blockers; exact live family input/output is not cloned |
| f898c9f0 / REPAIR_CURRENTNESS | 22→26 | Same authority/capacity gates; still PENDING/completed 0 |

All six original generations are legitimately superseded, **not marked complete**. Their six successor jobs remain unresolved; owner second paid permit is exhausted at 12/12, and the four non-owner jobs require independently scoped admission. Captured readback does not supply a per-family failed calculation proof for all six. Fixtures diagnose the representative owner path, not unseen private health inputs.

A separate synthetic full workload did converge: three isolated native SQLite/libsql databases, each 136 WHOOP + 7 Journal + USER sources and two actual job kinds, each requiring 64 bounded fresh application connections. **6/6 COMPLETED**, generation 8=current, cursor/owner null, attempt 0, 19 authenticated operation receipts and 64 finalized producer HMACs per database; 9 DOMAIN, 17 RUN and 17 ITEM rows each, no duplicate deterministic runs. Test PASS 1/1, 868.461 s. Each productive leg committed actual items/units or completed a job. This establishes schema-compatible algorithm convergence only: native transport, no monitored pilot admission, no 115 ms remote qualification, fresh connections rather than a full OS crash. It is not a replay of the six captured private datasets. The reproduction fixture now includes explicit nonempty and work-receipt checks; those added assertions are not retroactively claimed for this exploratory run.

Journal 6/7 is independently the six-item TENANT_LIMIT. The retained seventh Journal/Body/USER proof remains valid; no artificial Journal completion was added.

## Actual deployment constraints

Three bounded read-only management GETs on 2026-10-13 17:17:59 UTC confirm Render **Oregon**, one Node web-service instance, **0.5 CPU/512 MB** plan, and Turso group/default's sole primary in **Tokyo (aws-ap-northeast-1)**. No SQL, provider execution, credential changes or production mutations. The installed client is @libsql/client 0.15.15 over HTTP/Hrana; the worker rejects WebSocket transport when the owned no-reconnect lifetime cannot be established. **115 ms is simulated**, not an observed production RTT.

Existing budgets: manual/cloudflare 45/15/60 s wall/margin/job lease; GitHub 90/15/120; event 25/15/40. The app currently caps those sources accordingly, with 30 s admission and 15 s settlement reserves, execution-owner lease normally 225 s and 15 min context/handoff age limits. There is no job-lease renewal implementation. Extended fixtures use fixed 210 or 330 s initial leases for 180 or 300 s bounded tests, retaining owner/generation/expiry checks; they do not claim heartbeat renewal. Longer asynchronous runs need new coordinated renewals of execution, tenant-pass and job fences, a durably observed operator stop, and reconciliation on restart.

Calculation retry delays are 60 s/5 min/15 min/1 h/6 h; failure five requires repair. Timeout yields do not invent calculation failures. Processing BUSY admission is bounded to 15 s/64 attempts with capped backoff; business callbacks are not replayed, active transactions do not reconnect, and uncertain COMMIT reconciles. Current Cloudflare caller has 180 s SYNC / 100 s DRAIN HTTP deadlines; scheduled Worker wall time is bounded separately. These HTTP limits do not enlarge the app's worker budget. [Cloudflare limits](https://developers.cloudflare.com/workers/platform/limits/).

The current official **@libsql/client** documentation specifies a **5 s interactive transaction timeout** and a write lock until commit/rollback. Management metadata did not reveal this account's configured server transaction ceiling. We did not execute production SQL to measure it. The fixture now models total lifetime expiry before SQL and at the actual COMMIT after awaited pre-commit fault injection; it rolls back pending writes. Already durable COMMIT followed by lost ACK remains indeterminate. It does not emulate autonomous server timers, interrupt a single long SQLite statement or model the separate stream-idle watchdog. Unlimited fixtures therefore cannot qualify a long remote transaction. [Turso TypeScript reference](https://docs.turso.tech/sdk/ts/reference). Historical configurable libsql transaction slots are not evidence that this production account permits >5 s. [libsql issue 925](https://github.com/tursodatabase/libsql/issues/925).

## Options A / B / C

| Criterion | A: existing algorithm in asynchronous Render One-Off/background executor | B: minimal authenticated batching | C: durable segmented DOMAIN ledger |
|---|---|---|---|
| Six jobs | Native algorithm converges; remote source fails even at 300 s; moving it alone is unqualified | Repairs source quota/bounds at 10 ms; 115 ms source still fails | Can represent bounded durable work in principle; unimplemented, no convergence proof; must also cover source/family boundary |
| Engineering | Small supervisor; safe lease renewal/cancel/restart and short transactions make it material | Seven-file prototype; private lifetimes/order and envelope semantics require delta review | Largest: payload schema, complete-stage manifests, receipt/producer validation, publication, purge and reconciliation |
| Deadline / crash safety | Platform permits long jobs but not long Turso transactions; old job config survives service redeploy, requiring durable stop/release fencing | Transaction memo is not persistent progress; existing completed RAW units and receipts survive; final unit still too long | Only genuinely completed authenticated stages persist; final publication must still be short and fully current |
| Schema | Supervisor alone no schema change; existing tables can only be reused for their legitimate completed objects | No schema change | Additive migration and entity/privacy contracts; execution receipts cannot store health JSON |
| Stage 7 v33 / Stage 8 v34 | Preserve signed settlement/cursor contracts; no SHADOW→LIVE; routing/role changes require review | Accepted runtime unchanged; prototype needs affected-boundary review before promotion | Must coordinate reserved versions, authorities and privacy purge; cannot claim prior v33/v34 review applies |
| Security / tenancy | Same keys/admission and authoritative primary; do not use embedded replicas to bypass authority; bound simultaneous owners | Keeps original HMAC and fresh fences; cache private/epoch-bound; envelope differences explicit | Health-bearing persistent projections add retention/erasure obligations; isolate tenant/mode/all generations/producer |
| Deploy / migration | Separate exact-SHA job command/service, role/routing, renewals and cancellation; no deployment done | Production candidate not accepted | Migration plus rollout/recovery plan; not implemented |
| Cost | One-Off billed per second; background service approximately $7–25/month plus DB/workspace/egress | No new service; continued computation may increase DB spend per attempt | Optional same service plus stage/root/link writes and retained payload storage; no certified run count |

One-Off jobs have a platform limit of 30 days, inherit a latest successful service build/config snapshot, and continue after service redeploy. Cancellation is explicit; platform longevity is not transaction correctness. Background workers poll a queue and do not accept inbound requests. [One-Off jobs](https://render.com/docs/one-off-jobs), [background workers](https://render.com/docs/background-workers).

**Decision:** A-only and B-only are not sufficient. C is not justified for implementation yet, because a DOMAIN-only ledger would leave the proved source/family envelope and transaction-capacity failures unresolved. Do not write a ledger migration. The next owner decision should authorize a bounded **short-transaction preparation/publication prototype**, with an asynchronous supervisor only after its transaction proof passes. Start by reusing the existing genuine RAW units and legally completed existing objects; never repurpose immutable evidence or scalar-only execution work receipts as scratch health storage. If existing stores cannot express the required completed source/family output, return for approval of an additive ledger covering that exact boundary.

## Exact next implementation and release gates

1. Qualify the server transaction-lifetime contract from provider documentation/support or an independently authorized disposable database; do not spend the exhausted production permit or infer the value from a long local fixture. Keep the conservative 5 s fixture gate until established otherwise.
2. Prototype one DOMAIN outside a long-lived write transaction: authenticated input/result preparation retains every original source/control/version/hash and producer binding; original HMAC/graph checks run without publishing completion. A final **short** transaction freshly observes the complete relevant root/source/control and lease union, authenticates original receipts/producers, rejects same-timestamp changed content, and atomically publishes the original DOMAIN plus exact ACK. No stale in-memory authorization may authorize a commit. Target <4 s transaction age with jitter and final fencing included; fail the prototype if it cannot be demonstrated. Existing root-lifetime brands require an explicit reviewed preparation/publication authority contract, not a bypass.
3. Apply the same measured boundary to the episode/source-family path responsible for 128-read and 2 MiB failures. Preserve original output semantics and every required family before cursor advancement. Completed existing RAW objects must resume without recalculation. If this cannot fit existing approved schemas, stop and obtain exact additive-schema/privacy/invalidation approval; do not allocate v33/v34 or overwrite Stage 7/8 work.
4. Only then implement a bounded async supervisor: original signed SYNC handoff, exact release/config pin, pilot admission, central stop/revocation, CAS-renewed execution/job/tenant lease bundle, bounded cancellation, no transaction reconnect, crash/ACK reconciliation, idempotent settlement and separate DRAIN routing. Do not accept a service ENV snapshot as current operator authority.
5. Prove all six representative jobs over 115 ms Hrana **including transaction ceiling**, real OS kill/restart, stale generations/expired leases/revocation/tamper/tenant attacks and exact cursor/job publication receipts. Separately map the six captured successors to their actual admission and completion or an explicit input blocker. Obtain one independent delta review before any release authorization.

This is an approval plan, not a claim that the new short-transaction architecture is implemented or proven. No production candidate passes today. Next authorization is for this bounded isolated architecture change, not deployment. After qualification, public new-SHA publication, exact-SHA deployment/service or schema changes, and a new narrowly capped paid validation permit each require their own owner scope. No token/F02 change is proposed.

## Operating cost estimate and evidence limits

Current listed Render compute tiers imply $7/month for 0.5 CPU/512 MB and $25/month for 1 CPU/2 GB. A 300 s One-Off at those tiers is roughly **$0.00081–$0.00289 compute**, using a 30-day month; not a complete job cost or sizing result. One-Off avoids a permanent extra worker charge; a separate continuously running worker adds the monthly tier. Region relocation requires a new service, and proximity cannot be assumed to yield a particular RTT. [Render pricing](https://render.com/pricing), [regions](https://render.com/docs/regions).

Illustrative Turso Developer overages are $1/billion excess rows read, $1/million excess rows written, $0.75/GB excess storage and $0.35/GB excess sync. Exact account allocation and billed rows are unmeasured here. **HTTP/SQL counts are not billed-row counts**; full six-job/ledger costs cannot be certified from these fixtures. The $0.10/attempt reserve is an admission planning reserve, not an invoice prediction. No new permit is minted. [Turso pricing](https://turso.tech/pricing).

Reuse unchanged historical approvals and retained 29 focused / 2 independent negative evidence. New delta checks: prototype data/control isolation 10/10; ordinary model/isolation 6/6; original prefix/bounds/memo regression 19/19; transport COMMIT/lost-ACK checks 3/3. A separately attempted legacy v32 lost-ACK suite is 0/2: both fail before execution because its old HTTP worker factory supplies no required pilot grant (BETA_PILOT_DENIED). It cannot qualify current Stage6 restart safety and is not hidden as a PASS; accepted runtime is unchanged. The deliberately strict zero-progress workload fixtures remain FAIL and are not relabelled as passing capacity. There is no accepted production fix, no migration, no public push and no deploy in this checkpoint.
