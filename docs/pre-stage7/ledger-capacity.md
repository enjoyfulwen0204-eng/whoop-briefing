# F06 — controlled Beta capacity and future archival

Disposition: **F06_CAPACITY_ARCHITECTURE_APPROVAL_REQUIRED**. Local growth/discovery engineering is implemented; provider capacity and the finite production operating envelope are not approved or proven. Full v32 history stays immutable. No deletion, trigger weakening, identity reset, migration or archival was performed.

## Measured evidence

The local trigger-enforced history benchmark uses real SQLite and installed HTTP/Hrana queries, three synthetic users, one SYNC/DRAIN pair per iteration, six receipts and three producer rows per pair. It is a storage/query stress model, not a claim that real business work always has six receipts.

| Pairs | Executions | Receipts | Producers | Logical bytes | Maximum discovery, 10 runs | First-ID replay |
|---:|---:|---:|---:|---:|---:|---:|
| 0 | 0 | 0 | 0 | 1,941,504 | 69.5 ms | n/a |
| 100 | 200 | 600 | 300 | 2,609,152 | 65.0 ms | 9.9 ms |
| 1,000 | 2,000 | 6,000 | 3,000 | 8,613,888 | 59.5 ms | 9.6 ms |
| 10,000 | 20,000 | 60,000 | 30,000 | 68,698,112 | 189.1 ms | 9.2 ms |

Original discovery exceeded its unchanged 30-second budget at the last size. Its correlated terminal-child lookup repeatedly scanned history. The successor uses a non-null terminal-child ID set; it preserves exclusion of every terminal child without a schema/index change. EXPLAIN shows existing phase/source and receipt execution indexes, one child-list scan and a temporary sort. Reads still grow with history; this is not an indefinite constant-cost or retention solution. Original failure and successful rerun remain under `tmp/pre-stage7/consolidated-repair/capacity*`.

Read-only production metadata on 2026-10-10 05:39 UTC: v32; actual CHECK function numeric zero; 17,972 pages × 4,096 bytes = 73,613,312 logical bytes; 37 executions, 947 receipts, zero producers. This is not provider billed usage, remaining quota or full private admission. No platform quota credentials/entitlement were available. Do not infer quota from SQLite max_page_count, a public pricing tier or the database's current size.

The approved reported Cloudflare window `*/10 0-3 * * *` has **24** invocations/day. Its normal pair model adds 48 executions/day; same-identity continuation adds generations/receipts, not a new identity for each retry. GitHub is reported disabled and adds no approved current scheduled invocation. Future GitHub/manual/event sources must be included before changing scope. The stress model adds approximately 6,676 bytes/pair, about 160,215 bytes/day at this cadence, for this deliberately small receipt model. Actual warm/cold/partial/continuation harness output now includes execution/receipt/producer counts, page bytes, real Coach and Telegram transport paths, HTTP requests and retry counts. Use those larger measured profiles and production deltas to size the cohort; do not promote the small model as a worst-case estimate.

## Growing inventory and hot reads

- `phase4_executions`: one immutable identity per invocation/child; all canonical requests, result digests, states and generations retained. PK/unique identity lookup supports replay; phase/source/sequence index supports latest heartbeat. Scope election and historical discovery still scan a finite matching history.
- `phase4_execution_work_receipts`: one immutable semantic effect/count receipt per committed step; includes replay after lost ACK. Unique `(execution_id,step_key)` and receipt PK support per-execution/step reads. A replay reads all that execution's receipts, not all history; its size follows bounded work/continuations.
- `phase4_execution_producers`: bindings per tenant/mode/input generation/producing execution; required for currentness and finalization. PK supports tenant/generation reads. Producer and heartbeat reads must remain measured against the finite envelope; no removal of a binding supporting current live data.
- `phase4_operation_receipts`, `phase4_receipt_routes`, `phase4_receipt_route_entries`, `phase4_receipt_route_manifests`: durable Stage 5/6 effects and routed origin/replay evidence. Counts and indexes are inventoried by the benchmark; the execution stress model has zero business rows in these tables and does not measure their business growth.
- `phase4_source_links`, privacy/audit artifacts, context-cycle and entity revision/evidence rows: supporting authority grows with business effects. Bot replies now add a source-generation link as well as the existing lifecycle/auth/purge link. Include this growth and retained Telegram/report receipts, reconciliation/analytics runs and queue history in the full database/provider budget.
- Settings revisions use one permanent reserved `telegram_state` row per canonical user, updated in place. Settings sessions remain one expiring slot per user. Neither replaces execution replay retention.

No hot-path result should silently become successful because an object is missing. Source/identity/producer corruption or monitoring failure is a closed gate. Source metadata queries, first-ID replay and discovery are measured separately; a query returning LIMIT 1 is not automatically a constant-cost scan. The maximum locally verified history envelope is 20,000 executions, 60,000 work receipts and 30,000 producers for three synthetic users, with the exact profile above. It is not a verified duration for real Beta and does not prove remote latency at that size.

## Finite production acceptance and observability

Before G5, obtain and archive authenticated provider configuration `size_limit`, actual organization plan/storage allowance, organization-wide remaining storage, database/replica usage and billing semantics. Use the smaller effective database/organization headroom. [Turso configuration](https://docs.turso.tech/api-reference/databases/configuration) documents the database limit; it does not establish this account's entitlement.

Measure ordinary OFF/OFF growth, SHADOW incremental growth, largest transaction, per-user receipts/producers/business/audit growth and discovery/replay tail latency under the exact approved cadence/cohort. Obtain the operator's verified incident response interval and approve a finite duration/cohort. No default duration, percentage threshold or invented quota is installed.

The arithmetic helper `src/finiteBetaCapacity.js` reserves:

`Morning reserve = measured OFF growth/day × approved incident response days + largest measured transaction`

`Beta headroom = verified effective capacity − current usage − Morning reserve`

`maximum finite days = floor(Beta headroom / measured total daily growth)`

It reports whether supplied numbers fit; it always retains the architecture approval disposition and never turns arbitrary inputs into provider proof. Unknown/malformed evidence or zero measured growth cannot prove permanent retention. Alert before the stop-SHADOW threshold (`capacity − reserve`) and before the measured history/latency envelope is exceeded. Threshold values must be derived from the authenticated evidence and approved response interval. Observe externally from approved egress; do not rely on a saturated DB to emit its own alert. The explicit read-only CLI is `scripts/pre-stage7-capacity-readonly.mjs --remote-readonly tmp/...json`.

If headroom, monitoring or latency margin becomes inadequate: stop new SHADOW/presentation work through a separately reviewed/authorized OFF/OFF/empty-allowlist profile; retain all authority and receipts; keep ordinary Morning Brief and its reserve operational. Escalate a provider capacity increase before reserve exhaustion. Do not stop Morning Brief, purge ledger rows, reset identities or change triggers to create space. OFF still adds ordinary execution history, so stopping SHADOW alone is not a permanent solution. A provider/architecture owner must approve measured thresholds and duration before production SHADOW. Monitoring alone is not archival.

## Future archival proposal — approval required

Request a dedicated maintenance schema allocation without consuming Stage 7 v33 or Stage 8 v34 silently. No allocation or migration is implemented here.

1. Introduce a reviewed protocol epoch/issuance boundary for future IDs so archived legacy namespaces cannot be admitted as new work when the archive is unavailable. Preserve exact legacy identity/body digests, original creation time and terminal/incomplete distinctions; old-ID replay either returns authenticated archived results or fails closed, never creates new effects.
2. Archive immutable canonical request/result evidence, receipts, original execution sequence/generation, producer bindings and tenant audit references into authenticated, content-addressed chunks with a signed manifest and an anti-replay index. Preserve original lookup/audit key bytes and their continuity; no key rotation or inferred identity replacement.
3. Retain compact live authority for every producing execution referenced by current business data and every incomplete/uncertain execution needing reconciliation. Currentness verifies the original sealed producer's state, generation, sequence, tenant and input generation against authenticated live/archive evidence. Missing/corrupt evidence hides presentation and cannot become CURRENT.
4. Copy and verify first; seal a manifest; then atomically commit an authorized live/archive handoff. Only a later independently approved contract may permit physical removal. Existing v32 no-delete/immutability triggers remain intact until that explicit migration. An interrupted copy leaves live authority unchanged; an uncertain handoff COMMIT is reconciled before any removal.
5. Restore/restart validates manifests, chunk hashes, anti-replay coverage, tenant ownership and key checkpoints before enabling work. Partial archival or corruption fails closed for affected replay/currentness; it cannot fabricate a terminal result or silently reissue an old ID. New-epoch ordinary work must remain operational during archive outage only after the reviewed epoch boundary proves it cannot collide with legacy identities.
6. External archive/index capacity still grows and requires its own measured retention, corruption recovery, billing and audit policy. This proposal is not a proof of indefinite scalable storage.
