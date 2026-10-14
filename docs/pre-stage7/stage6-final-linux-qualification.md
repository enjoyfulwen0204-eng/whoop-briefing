# Stage 6 final Linux runtime qualification — PARTIAL / NO-GO

2026-10-14. Local synthetic qualification only. Baseline `5b0f9e1f3e06b50a3cc6e6ffe14cd8dc28995b78`, accepted RAW/DOMAIN algorithms, signed receipts and `9770553` ancestry are preserved. **No production/runtime source, dependency, schema, deployment configuration, grants or permits changed.** New commits add opt-in `.mjs` qualification fixtures only. Tested crash/process-composition checkpoint: `ffbe057bfd3e5813a4e8b018d81a27aad9a3139a`; two-CPU continuation/concurrent-service checkpoint: `dd73231026bc75cabf9acee29db408d283a2cc91`. Their runtime source bytes are identical to baseline.

## Actual deployment observation and controlled Linux model

Read-only Render dashboard/deploy logs confirm live SHA `2340e8bc305c6acde29bbfa540753e79dbd34408`, Oregon, `0.5c-512mb`, Node **22.23.2**, `npm run bot:webhook` → `node src/bot/webhook.js`. Production architecture and exact cgroup byte/swap limits were not inspected; no Production database request or mutation occurred. Render's displayed512MB must not silently be equated with a verified kernel512MiB limit.

Local Docker Desktop29.8.2 runs genuine Debian12 Linux/aarch64, cgroupv2. Every app group enforces `memory.max=536870912`, `memory.swap.max=0`, and `cpu.max=50000 100000` (controls:100000/200000). V8 is96/2MiB; no manual GC. Official Node22.23.2 image; installed locked `@libsql/client`0.15.15. Hrana/SQLite provider lives outside the app cgroup on internal networks with115ms per HTTP request; no Production credentials/endpoints are mounted. Kernel `memory.peak` includes all app children and native allocations. RSS/heap/external/GC/event-loop data describe the instrumented service Node; RSS sums are not cgroup usage. Native allocator totals cannot be separated precisely through the installed driver.

The initial harness has npm + test coordinator + service Node. The last0.5CPU control uses `--experimental-test-isolation=none`, verifying npm + shell + one service Node, matching Production's Node process count. This remains a controlled factory harness, not a claim of identical Production hardware/boot environment.

## Measured capacity gates

Worker remains **30s effective** (45s configured less15s margin), with the original5.5s publication reserve. Every authority/lease/HMAC/generation check remains active.

| Profile | Whole DRAIN | HTTP / SQL | Kernel peak | Result |
|---|---:|---:|---:|---|
|0.5CPU, extra test coordinator|35.19s|81 /477|281.29MiB|TIMEOUT; no source progress|
|1CPU diagnostic|33.00s|105 /504|310.16MiB|PUBLICATION_HEADROOM_REQUIRED; no source progress|
|2CPU diagnostic, first/second continuation|30.60 /24.97s|111 /4306;111 /4108|360.56MiB overall|Two genuine partial commits; fresh current ACK/HMAC/replay PASS|
|0.5CPU, Production-like Node count|32.69s|108 /511|348.35MiB|Atomic SHORT_TRANSACTION_HEADROOM_REJECTED before effect writes; no source progress|

Two-CPU preparation18.02/13.17s; publication2.35/1.99s. Whole DRAIN includes admission/settlement and is distinct from the child worker deadline. The maximum measured cgroup peak is378077184B =360.56MiB,29.58% headroom. All measured groups report0 OOM/OOM-kill. **This is partial-workload memory evidence, not complete multi-job Linux memory qualification.**

Cause: CPU-quota throttling and synchronous/microtask-heavy RAM work consume preparation/publication headroom and starve the shared event loop. At the Production-like0.5CPU boundary, the preserved atomic DB-clock reserve correctly rejects publication. The initial0.5CPU control records239 throttled periods and25.81s throttled time; the final same-process-count control records175 periods/20.07s. TwoCPU reduces throttling but still records a12.10s event-loop stall; oneCPU is insufficient. **TwoCPU is the smallest tested late-unit success, not a proven complete-service resource adjustment.**

## Durable/crash and service evidence

Generation8/scope revision7 SHADOW fixture identity is `(fixture,a,SHADOW,job_kind,8,7)`. The two-CPU new `analyzeAssociationFamily` operation joins its current `stage6.associations` named ACK and current cursor ACK. Both actual jobs advance from `recovery/synthetic-old-recovery` to `sleep/sleep-00`;19 authenticated receipts,80 finalized producer HMACs,380 work receipts; no duplicate runs. A fresh connection and exact request replay preserve them. The old cycle DOMAIN proof is identified as retained evidence, not mislabeled as newly calculated work.

Actual Linux SIGKILL follows the provider's original atomic COMMIT while its ACK is withheld. Container exit137 with OOM=false. A new app process uses the same signed request and original deadline, reaches RECONCILIATION_ONLY/FINALIZED_SUCCESS, verifies the new named operation/cursor ACK,19 receipts/79 producers/376 work receipts, and exact replay. Synthetic permit attempts stay1; no clock/lease/counter/queue state was edited. The recovery process has its own cgroup metrics; those are not used as the calculation's memory peak. Recovery PASS1/1 under the **twoCPU diagnostic**, not0.5CPU acceptance.

Actual SYNC/Morning Brief, webhook/router/processor/server and DRAIN factories run in one0.5CPU app group. Their two synthetic databases are independent; this does **not** qualify contention on the same Production database. External368 health probes measure22.09s maximum versus10.65ms initial response; the declared2s responsiveness gate fails. DRAIN TIMEOUT35.60s. All three Morning Briefs deliver exactly once with one model call each, but full SYNC returns REQUIRED_RESOURCE_FAILED118.14s; webhook and retry return503 without a send. The provider models a strict5s transaction cap; that cap is not a verified Production Turso setting, and the SYNC failure is not attributed solely to CPU. The independent external health stall alone proves the service responsiveness failure.

Combined failure cleanup retires3 receivers/22 scopes,0 live scopes/callbacks,0 real external provider calls. Freshly rerun actual receiver lifecycle5/5, finite permit96/2 suite17/17, and work-profile/prototype receiver5/5 PASS. Retain the first unrestricted Darwin permit suite SIGSEGV after13 passing tests; do not count it as passing. Reuse unchanged source-security/SIGKILL18/18 and focused51/51 evidence. Preserve the earlier128/4 admission failure as a negative control, not a Linux128/4 PASS. Reviewer-found default-glob and combined no-work false-positive test gaps were fixed before acceptance claims.

## Six-job and release decision

Existing unmonitored algorithm6/6 twice remains accepted. Full monitored Linux six-job convergence is **NOT QUALIFIED**;0/6 final jobs are newly completed here. Two-CPU results are partial continuations only. The target0.5CPU late-unit failure blocks a legitimate full convergence run, so repeating all six under the same failing boundary is stopped. No synthetic completion is presented as Production completion.

No algorithm/publication redesign or ledger migration is justified. Next narrow local correction: measure/bound cooperative scheduling at the RAM driver/preparation boundary, preserving ALS and original budgets/authority; then requalify responsive combined service and full six at a viable measured resource profile. TwoCPU supplies evidence for a resource comparison, not permission or proof to purchase it. Render lists2CPU/4GB at$85/month versus current0.5CPU/512MB at$7/month; this excludes database/network costs and is **not** an actual per-run cost certificate ([official pricing](https://render.com/pricing)). No complete operational adjustment has passed all gates yet.

Full runtime code acceptance **NO-GO**; Production **NO-GO**. No ready deployment authorization manifest is issued because the required gates fail. Remaining requirements: complete Linux deadline/fairness/multi-job-memory qualification; full monitored six with legitimate synthetic admission; same-database SYNC/webhook/retry/cancellation qualification; independent final acceptance; then exact-SHA public publication/deployment approval, any measured resource-change approval and valid authenticated LIVE execution/admission authority. Preserve the exhausted12/12 Production ledger. These are direct Production+LIVE release requirements; **no new Owner pilot or Public Beta rollout gate is introduced**.

F02 remains Owner Accepted Risk. Journal's original6-item TENANT_LIMIT remains separate and unmodified. No SHADOW promotion to LIVE. Stage7v33/Stage8v34 source/contracts remain unchanged; new schema-version compatibility qualification is not claimed. Stage8 root remains clean at `899dff0ae61474bb2b9ec0a0743cdbf11a999d3b`/tree`5a2d81942d7133f0a0a1a4fbb8f1431d17c92936`. Only owned synthetic Docker providers were stopped; unrelated containers were untouched. See the compact machine evidence in `stage6-final-linux-qualification-evidence.json`.
