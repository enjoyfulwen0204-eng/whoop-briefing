# Stage 6 late-unit RAM lifecycle repair — 2026-10-14

LOCAL / SYNTHETIC / ISOLATED successor of `1a78d9b1b3b69b1874cda3c2b000422b97209cdf`. The accepted short publication architecture, original calculations and `9770553` ancestry remain intact. No runtime `src`, schema, Stage7v33/Stage8v34 contract, F02, credentials or Production operation changes. The earlier pre-safety six-job run is not acceptance evidence.

## Measured cause and minimal correction

On installed Node22.23.2, the async_hooks implementation of AsyncLocalStorage maintains a global `storageList`; every asynchronous resource initialization propagates every enabled instance. Each private RAM receiver owns eight instance scopes (processing5, core1, receipt producer1, legacy adapter1). Native database close previously left five of eight enabled. Consequently completed units continued adding propagation work and properties to subsequent Promise resources, inflating allocation and GC. A cold late calculation passes; accumulated scopes make the same authenticated calculation exceed its deadline. Graph/HMAC work itself is not an intrinsically >24.5s indivisible unit.

The repair registers only scopes of the explicitly private loader-owned receiver and its processing alias. After actual native database close, it disables those eight scopes and clears their registry. Seed failures take the same cleanup path. It rejects premature cleanup, is idempotent and leaves peer receivers and global execution/budget/receipt transaction scopes intact. Cancellation retains ownership until the existing preparation finally closes the database. No graph traversal, source validation, HMAC, output, named ACK, deadline, reserve or publication SQL is removed or changed. No new durable boundary is necessary.

The retained synthetic file was copied read-only, authenticated, and advanced through six original committed legs to checkpoint78. It contains18 signed receipts,78 finalized producer HMACs,371 work receipts,16 unique RUN/ITEMs, input/source generation8 and a real recovery cursor. The original file and other worktrees were not changed. Tests resume that checkpoint directly instead of repeating180 previous commits.

## 115ms observations

| Measurement | Early DOMAIN | Late79 after cleanup |
|---|---:|---:|
| Input graph nodes / edges | 120 / 366 | 190 / 2230 |
| RUN / ITEM count | 2 / 2 | 16 / 16 |
| Preparation | 1.433s | 3.351s |
| Worker / whole signed phase | 2.093s / 3.924s | 4.314s / 6.114s |
| Atomic publication | 0.242s | 0.488s |
| HTTP phase / diagnostic readbacks | 23 / 4 | 25 / 4 |
| Remote SQL phase / readbacks | 1314 / 4 | 4239 / 4 |
| Native RAM statements including seed | 3358 | 15299 |
| Snapshot bytes | 632431 | 3650878 |
| Peak RSS / heap used | 519MB / 130MB | 382MB / 92MB |
| GC observed | 0.099s | 0.197s |

The early fixture first builds an original source checkpoint natively; its RSS includes that warmup. Memory figures are observed process peaks, not live sensitive objects or a production512MiB qualification. Timings are concurrent local synthetic observations with installed driver/Hrana and115ms per HTTP; they are not observed Production latency.

| Instrumented preparation activity | Early calls / inclusive time | Late79 calls / inclusive time |
|---|---:|---:|
| Graph roots | 20 / 0.581s | 112 / 1.187s |
| Graph traversal | 15 / 0.802s | 84 / 1.582s |
| RUN enumeration | 3 / 0.001s | 28 / 0.007s |
| Authority closure | 0 | 4 / 0.012s |
| Authority validation | 3 / 0.077s | 27 / 0.428s |
| HMAC JSON + crypto | 1552 each / 0.015s | 7065 each / 0.076s |
| Canonical manifests | 2921 / 0.007s | 14782 / 0.044s |
| Receipt encoding | 1 / 0.005s | 1 / 0.003s |

These nested/concurrent observations are deliberately non-additive. Facade SQL call counts include recursive fencing observations; native SQL statement counts and remote Hrana counts are reported separately. SQL identity diagnostics retain hashes, never SQL arguments, health values or keys. The graph and HMAC observations authenticate retained calculations again; already completed calculations are not recomputed or duplicated.

The matched900-retired-scope control uses the same authentic78→79 calculation and differs only in terminal scope cleanup. Without cleanup:30s `SYNC_TIMEOUT`, zero new publication, RSS1.228GB, GC9.181s,905 enabled retired scopes. With cleanup: preparation3.884s, worker4.854s, publication0.559s, RSS416MB, GC0.432s, zero retained/live scopes. The900 scopes are an explicitly labeled process-retention model, not new health computations. A1440-scope control independently exhibits30s timeout/RSS1.951GB/GC11.186s; cleanup passes. No second optimization or timeout extension was used.

## Durable progress and gates

On final code, late79 commits six real source items and a new signed DOMAIN receipt: recovery→sleep05 cursor, producers78→79, work receipts371→380, RUN/ITEM16→17. Reopening authenticates all receipts and exact named DOMAIN ACK/source/input8. The next invocation resumes the other original job, reaching its sleep05 cursor, producers80/work388, with RUN/ITEM still17 and no duplicate deterministic run. Early DOMAIN similarly commits its exact signed ACK and the resumed source advances USER→cycle05. These are genuine database commits, not memory-only progress.

Focused adversarial16/16 and actual SIGKILL-before/after-commit replay2/2 pass on the repaired ownership path. Independent working delta controls7/7 pass; no retainedP0/P1. Frozen-code scoped safety review GO; final six-job convergence PASS, with capacity evidence reviewed separately below. The full test asserts positive durable progress every productive leg, worker<30s, phase<45s, publication<4s, zero retained/private live scopes, and all final job generations/cursors/leases plus signed receipts/producers after reopening.

The original5.5s publication reserve,24.5s preparation allowance and modeled5s transaction limit remain enforced. Publication still performs fresh exact authority/rowset/lease/generation/context checks and original conditional DML atomically. No stale or partial result is promoted to COMPLETE.

Schema required: NO. Runtime/paid monitored grant integration and provider RAM/payload/cost qualification remain separate gates. This authorized isolated prototype cannot be called a deployed runtime repair. Journal TENANT_LIMIT remains the separate six-item rule, with seventh Journal/Body/USER evidence preserved. Production pilot12/12 is exhausted. No public push, deployment or paid validation is authorized. Production remains NO-GO.

[Measured evidence](stage6-late-unit-evidence.json) contains compact phase data, checkpoint proof and artifact hashes. Final six-job results and the independent frozen-code verdict are sealed without changing the measured executable source.


## Final frozen-code acceptance

Executable repair commit `279ec56e3c82785d7d6e88b68c783a686bd7e632`, tree `92e4375d72439de253e70a6a5334c37a053076e1`. The full test launched seconds before commit creation with exactly the same executable bytes; subsequent changes are documentation only. No pre-safety long run is counted.

Full115ms test PASS1/1 (one unrelated target test skipped) in1481.129s across306 bounded invocations: six of six original job kinds in three representative synthetic successor fixtures reach COMPLETED, requested/completed generation8, cursorNULL, leaseNULL. Each dataset has136 WHOOP sources,7 Journal entries andUSER;864 source items and162 original RAW subunits are durably processed. After reopening,57 signed operation receipts,306 finalized producer HMACs and1674 work receipts validate, including exact named DOMAIN ACKs;51 RUN/ITEMs are unique. No manual queue-state update, artificial cursor or partial-to-COMPLETE promotion is used.

Max worker4.406s, complete admission/work/signed-settlement phase6.220s, atomic publication0.591s; aggregate8868 HTTP/842193 remote SQL includes diagnostic readbacks. Each leg is genuinely productive and passes unchanged30s/45s/4s gates. All306 private receivers close and disable2448 registered instance scopes; zero retained/live private scopes. The precise former failure boundary—fixture2 leg79 after180 committed legs—now commits six real items, worker4.406s/publication0.499s/phase6.220s. This is the actual retained-process test, independent of the modeled900-scope control.

Post-leg process RSS peak547,192,832B and heapUsed295,240,728B across all three fixtures in one process; this is not a Production512MiB qualification. The peak is reported honestly and excludes unobserved between-leg peaks. Provider payload/driver/platform memory and paid admission accounting still require authorized runtime qualification.

Separate Node processes advance authentic checkpoint78→79→80, retain19 receipts and RUN/ITEM17, authenticate producer HMACs/exact ACK, and resume both recovery→sleep05 cursors without duplication. A6,242,304B final first-fixture checkpoint is retained at `/private/tmp/stage6-late-six-complete1/checkpoint.sqlite`, SHA256 `c87367a418dd6e6195c22497d90d578e44b8bd9894b6b12ebb94c3941142e668`. A distinct normal Node process reauthenticated19 receipts/102 producers/558 work receipts and exact DOMAIN ACK, with unchanged file hash. Original retained checkpoint and valid receipt evidence are preserved; no bulk evidence archive is committed.

Post-freeze lifecycle/isolation5/5, adversarial security16/16 and real SIGKILL/replay2/2 PASS. Independent ownership/cancellation controls7/7 are reused with unchanged registry/helper hashes. One reviewer, no full-project audit. [Independent scoped review](stage6-late-unit-review.json) records frozen source hashes and final capacity qualification. Stage1–5 and unchanged Stage6/7 approvals remain reused.

**LOCAL isolated architecture/code: GO. Formal Stage6 runtime: NO-GO until separately authorized integration with branded monitored grant/reservation/cancellation and provider resource qualification. Production: NO-GO.** No deployment, public publication, new permit or paid validation happened. Runtime/Stage7v33/Stage8v34 contracts and migrations remain identical. Journal TENANT_LIMIT is unchanged and separate; pilot12/12 and F02 Owner Accepted Risk remain unchanged. Next smallest authorization is focused runtime integration/qualification of these exact verified source bytes; public SHA publication, deployment and a narrowly bounded paid validation permit each require their own owner authorization.
