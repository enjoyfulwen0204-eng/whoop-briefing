# Stage 6 DOMAIN capacity outcome and concrete fallback

Status: **PARTIAL / production NO-GO**. The runtime implementation remains exactly `caf08fc6e5a6af38988aae97ebf834a80bfcfea7` (tree `587c1bbcd9710ebd5ca175c224112c9bf4085d74`). This successor adds only diagnostic tests and evidence. It preserves the four real RAW calculation units and all prior repairs. No Production query, paid invocation, new permit, credential change, push or deployment occurred. F02 remains Owner Accepted Risk; the Turso Token is unchanged.

## Exact bottleneck at 115 ms

The frozen baseline still fails at 296 physical HTTP / 4,641 SQL / 41.218 s whole phase, with no new DOMAIN, source cursor or completed job. Effective worker time is 45,000 minus 15,000 = 30,000 ms, starting at worker drain entry. Whole phase includes admission and settlement.

A single targeted instrumented fixture measures the original path at 302 HTTP / 4,987 SQL / 41.402 s. The small variation from the frozen baseline reflects instrumentation and timing. The temporary profiling code was removed. These four rows partition that measured whole phase:

| Phase | HTTP | SQL | Elapsed |
|---|---:|---:|---:|
| Admission, context, claim, enumeration and settlement outside the raw unit/release | 111 | 163 | 14.752 s |
| Owned raw selector, BEGIN and outer cleanup, excluding nested DOMAIN | 62 | 925 | 8.569 s |
| DOMAIN through deadline failure | 102 | 3,859 | 14.816 s |
| Job lease release | 27 | 40 | 3.265 s |
| Total | 302 | 4,987 | 41.402 s |

Nested details are **inclusive**, not additional rows to add to the total:

| DOMAIN child/purpose | HTTP | SQL | Elapsed |
|---|---:|---:|---:|
| Analyzer, including authority read | 43 | 2,127 | 6.514 s |
| Authority read, inside analyzer | 32 | 1,772 | 4.909 s |
| Encode result/contracts | 5 | 10 | 0.615 s |
| Flattened required-root capture, interrupted by deadline | 19 | 789 | 2.700 s |

123 of the 302 HTTP requests contain only the fresh permit/DB-clock observation. Original context, owner, job, permit and source checks are repeated at nested typed-read boundaries; the complete RUN/ITEM graph and authority closure are also traversed repeatedly. Canonical request preparation was 3–6 ms with zero HTTP in each measured call. Pure cryptographic cost was not separately measured, so this report does not attribute all remaining time to HMAC or claim a crypto optimization.

Source enumeration itself was 0.287 s / two HTTP / 22 SQL. Its roots cannot replace the later authenticated current/latest/baseline selection. Pending-clock verification was 1.428 s / nine HTTP / 407 SQL, including one full plan construction. Fresh current/latest selection and retained RUN_START producer verification remain necessary. The final complete receipt still requires result/contracts, flattened source/evidence closure, routing, privacy links, named ACK and COMMIT fences in one existing transaction. Until that transaction commits, in-memory encoding/capture is not durable progress.

Every source read is still subject to effective deadline/job lease checks. Runtime budget/cancellation and permit expiry/configuration checks run independently; final execution-owner/job/source generation and COMMIT fences remain. Rollback/release/final settlement are not calculation completion.

The measured worker entry is at whole-phase 3.944 s. Deadline headroom at the observed starts is:

| Boundary | Whole-phase start | Remaining worker budget | New durable DOMAIN/source work |
|---|---:|---:|---:|
| Owned raw unit | 11.672 s | 22.272 s | 0 |
| DOMAIN receipt execution | 20.121 s | 13.823 s | 0 |
| Analyzer | 23.354 s | 10.590 s | 0 |
| Flattened root capture | 32.237 s | 1.707 s | 0 |
| Capture rejects deadline | 34.937 s | 0; deadline exceeded during awaited work | 0 |

These boundary observations are not extra phase durations. The safety margin permits cleanup; it does not grant additional computation time. Source cursor checkpoint and final receipt creation were not reached.

## One focused transport experiment, then stop

A narrow experiment overlapped server-branded readonly root/artifact DATA with their original entrance controls, settled all observations before delivery, denied readonly mutations and retained all original checks. It still failed at 299 HTTP / 5,494 SQL / 41.368 s, with zero DOMAIN progress. The entire experiment was removed. Source files are byte-identical to `caf08fc`; no timeout, authority or cursor shortcut is retained. Further repetitions of this same optimization were stopped.

## What the alternative RTT tests actually prove

The same installed HTTP/Hrana driver and representative retained source checkpoint were tested at explicitly different synthetic transport latencies. The production worker bounds stayed 45 s / 15 s. These are architecture-sensitivity fixtures, **not** passing 115 ms qualification:

| Added latency/request | Leg | HTTP | SQL | Whole phase | Result |
|---|---:|---:|---:|---:|---|
| 25 ms | DOMAIN | 399 | 15,180 | 24.613 s | One genuine DOMAIN committed |
| 25 ms | Fresh connection, source/family continuation | 718 | 15,482 | 33.074 s | Deadline, zero further progress |
| 10 ms | DOMAIN | 399 | 15,180 | 12.109 s | One genuine DOMAIN committed |
| 10 ms | Fresh connection, source/family continuation | 828 | 17,546 | 20.443 s | FINALIZED_FAILURE, mapped CALCULATION_FAILED |

A separate 10 ms DOMAIN-only proof passes the exact original operation-receipt authenticator, reconstructs its original named DOMAIN ACK, verifies finalized producer HMAC and result digest, generation 8 and COMMIT ordering, rejects tampered HMAC and foreign tenant, and reopens an unchanged receipt. The strengthened fixture requires the new cycle_strain DOMAIN itself, not merely any reported unit; its physical COMMIT ACK occurs at worker 10.635 s (399 HTTP / 15,180 SQL / 12.533 s whole phase). RUN/ITEM counts stay at two: no duplicate raw calculation. This proves an immutable DOMAIN can be produced by the existing algorithm at lower RTT. It does not prove source cursor, job, process-crash sequence or six-job completion.

Another diagnostic source continuation under load reached its deadline rather than reporting the mapped calculation failure. The exact underlying source/family error is therefore unresolved; do not invent an error cause or infer liveness from the DOMAIN-only success. The strict fixture intentionally fails when a leg produces no durable progress.

## Concrete alternative execution architecture

A near-database dedicated DRAIN service is a measured partial mitigation; it is **not sufficient on its own** because source/family continuation remains unqualified. The robust fallback is a separately versioned durable DOMAIN preparation ledger, optionally executed by that dedicated service:

1. Keep current RAW RUN_START/RUN_COMPLETE/ITEM/AUTHORITY unchanged. Begin DOMAIN preparation only from the exact canonical request/plan and verified original named receipts/producers.
2. Persist immutable stages for **encoded result/schema contracts**, **actual evidence/authority graph closure**, and **bounded flattened-root chunks**. Each stage must store genuine completed output, not a BEGIN marker or input-only digest. Each row has tenant/mode, all generations, original operation key/time, plan/input digest, stage/chunk identity, algorithm/schema contract, producer execution/generation and an HMAC. Each stage and its exact named ACK commit atomically under original execution/job ownership. Failed or uncertain commits reconcile before retry.
3. An append-only publication stage requires every preceding authenticated output and exact producer. Every producing execution must be FINALIZED_SUCCESS with its original result digest and producer HMAC verified; reject unfinalized, foreign-tenant or stale-generation producers. A sealed expected stage/chunk manifest must be complete and unique; reject omissions, duplicates, reordering and mixed operations/plans. Freshly observe the complete current source/control/output union in bounded indexed read batches; run the original graph, item, source version/content, HMAC, purge and context comparisons. A same-timestamp correction must reject the stored root hash even when generation is unchanged. No accepted guard is cached across stages. Create the original public DOMAIN receipt/routes/privacy links only after this final verification succeeds in one transaction. The final publication must itself be demonstrated below the original deadline; splitting earlier stages does not waive that gate.
4. Source completion remains a separate required boundary covering every family, association window/result and insight tip. A metric DOMAIN or input digest cannot stand in for these results. Diagnose the current source/family continuation failure and verify its final cursor/job receipts before accepting the architecture.

For this roughly 32-root raw fixture, a design target is chunks of at most 16–32 roots and about 3–6 additional preparation/publication invocations per new DOMAIN, subject to measurements. That is a **planning estimate**, not tested convergence or an approved paid allowance. Bounds retain the original root/JSON limits. Larger permitted graphs need more bounded chunks, not truncated validation.

### Migration implications

The current v32 schema has no approved store for health-bearing encoded DOMAIN/root preparation payloads. Execution work receipts permit only scalar/boolean/hash results; they cannot be repurposed to hold health JSON. Existing completed evidence/authority rows are immutable and cannot be overwritten as scratch space.

The ledger therefore needs an explicitly reviewed additive schema/contract migration, entity/table registry and structural admission updates, exact indexed lookup of each stage's own producer (not an unbounded producer scan), generation invalidation, TTL/retention and full privacy purge/source-link support. Use a separate versioned DOMAIN-preparation contract; do not silently claim Stage 7/v33 approval or retrofit old receipts. Existing v32 data/receipts remain intact. The migration is not implemented or authorized for Production by this evidence checkpoint.

A dedicated DRAIN service additionally needs an exact-SHA role/endpoint and authenticated phase routing; the present Worker uses one endpoint for SYNC and DRAIN. Preserve SYNC/Morning Brief and route only DRAIN after a separate reviewed change. Both services must use the original database, keys, permit admission, lease/fencing and signed handoff/continuation rules. Do not create an embedded replica or trust a read-replica RTT as a write-transaction RTT. Qualify the actual interactive transaction RTT, CPU, jitter, cancellation and deployment region before selecting a service. Render region changes require a new service; region placement alone guarantees no particular RTT. [Render regions](https://render.com/docs/regions).

### Estimated operating costs and approval boundary

A dedicated Render service adds approximately US$7/month for 0.5 CPU/512 MB or US$25/month for 1 CPU/2 GB; the larger plan is the safer initial CPU qualification target, not a measured sizing conclusion. Workspace fees and bandwidth are extra as applicable. [Render compute pricing](https://render.com/pricing).

Database cost does not fall simply because RTT falls: the complete 10/25 ms DOMAIN made 15,180 SQL statements. SQL statements/HTTP counts are not billed rows. A ledger adds stage/root/link writes and stored health projections; actual cost needs metered read/write/storage bytes and the existing account's plan. For an illustrative listed Developer overage tariff, marginal cost is excess reads/1 billion × US$1 + excess writes/1 million × US$1, plus applicable storage/sync; this is not a quote for this account or a certified upper bound. [Turso pricing](https://turso.tech/pricing).

The existing US$0.10/attempt monitoring reservation is a financial planning reserve, not a billed prediction. The estimated 3–6 additional DOMAIN ledger invocations reserve an extra US$0.30–0.60/domain for those new stages. Existing RAW units and other source/job work are additional. Never use these estimates to mint a permit. The exhausted second 12/12 allowance remains intact. No new paid validation is authorized. After local full qualification, approval must name the exact release/migration/service routing and separately capped validation allowance; public publication of a new SHA remains separately authorized.

## Journal, tests and release verdict

Journal 6/7 remains the original six-item TENANT_LIMIT, not a seventh-entry error or DOMAIN bottleneck. The retained local fixture still processes the seventh entry and USER boundary through actual work; no artificial Journal completion or cursor advancement was added.

The 115 ms strict DOMAIN gate remains FAIL. The 10 ms DOMAIN-only receipt proof is PASS; 10/25 ms source continuation fixtures are FAIL. Temporary transport regressions passed 8/8 but apply to an experiment that was removed and are not candidate capacity approval. Unchanged `caf08fc` source safety reviews are reused. All six captured jobs, complete OS-process crash/resume and valid source/job settlement remain unproven. **Production readiness: NO-GO.**
