# Stage 6 raw-source capacity repair — partial local candidate

Status: `STAGE6_RAW_SOURCE_CAPACITY_REPAIR_PARTIAL`. This candidate is not capacity-qualified or approved for production deployment. Stage 1–5 and unchanged Stage 6/7 reviews are reused; this delta does not implement Stage 7/8.

## Ancestry and scope

The isolated branch `repair/stage6-raw-capacity-20261013` starts at `9770553caba6f4085f4799fb6088db5076433f8e`, whose direct parent is `2340e8bc305c6acde29bbfa540753e79dbd34408`. Checkpoint `2da03c460c17aa0a143f06fc4f9af739a0dc21be` is its direct successor. The newer incompatible local Stage 7 branch was not used. Other worktrees and original checkout were not reset. Journal 6/7 was the production six-item TENANT_LIMIT boundary; it is not reclassified as a failed seventh entry.

The retained fixture processes all seven Journal sources, commits Body DOMAIN, advances USER, and then enters the first raw cycle source. Its representative input has 136 WHOOP sources, seven Journal sources and USER. It uses the installed HTTP/Hrana driver, a fresh connection on every invocation, 115 ms latency per physical request, actual authenticated SYNC/DRAIN handoff and the unchanged 45,000/15,000 ms bounds.

## Measured bottleneck

The retained raw successor baseline takes 41.302 s, 322 HTTP requests and 626 SQL statements with no raw calculation or cursor commit. Baseline construction alone takes 16.271 s / 129 HTTP / 288 SQL. Its original sequential source/control observations consume the productive deadline. Bounded authenticated observations reduce that operation to 1.134 s / seven HTTP, but batch-only still reaches 41.863 s / 316 HTTP / 3,224 SQL without progress because metric analysis and authority closure repeat expensive traversals. This is not primarily a numeric calculation cost.

The retained repair splits work at existing schema-v32 DIRECTORY, RUN_START, RUN_COMPLETE, ITEM and AUTHORITY boundaries. It reconstructs the original canonical plan from current authenticated roots before accepting a pending clock, and requires the exact RUN_START ACK and finalized sealed producer. One raw selector and one actual unit share the original owned transaction. Same-root plan DATA is reused only when the exact core/context, canonical request/plan, execution, job, receipt transaction marker and observation epoch match; fresh delivery/owner gates still run. A write, transaction change or restart discards that DATA. Durable continuation comes from immutable rows and signed receipts, not memory.

The independent reviewer found two retained-delta defects during development: generic discovery discarded its preparation proof, and raw refresh replay did not require its exact DOMAIN work ACK. Both were fixed and independently retested. Original BODY-only completion and metric-family semantics were restored. Generic receipt capture still performs the original comparators; bounded independent observations preserve output and rejection order.

## Durable evidence and limits

Five productive 115 ms invocations commit DIRECTORY followed by four calculation units. The measured whole phases are approximately 26.8–38.7 s and 200–272 HTTP each. Whole-phase timing includes admission and release/settlement; it is not the worker's 30 s productive deadline. The focused proof reconstructs each named unit receipt key, checks producer HMAC, exact generation/scope/request binding, finalized result digest, COMMIT ordering and the actual worker-relative commit time. Reopening the application connection preserves the same run, item and signed authority. No raw source cursor is advanced early.

The remaining raw DOMAIN fixture still takes 41.192 s / 296 HTTP / 4,641 SQL and commits no new DOMAIN or cursor. Its strict progress assertion fails. SQL-count reductions are not an acceptance result. Later raw-union/frame experiments also failed capacity and were removed completely. A proposed read-only sibling marker was rejected because it produced no durable named ACK; the entire marker path was removed. No experiment counter is counted as progress.

Run the narrow positive evidence:

```sh
RAW_PROFILE_LEGS=5 node --test test/stage6-raw-capacity-profile.test.js
```

Run the concrete remaining failing capacity gate:

```sh
RAW_AFTER_AUTH=1 node --test test/stage6-raw-capacity-profile.test.js
```

The normal seven-leg invocation is also strict and fails on zero-progress DOMAIN. It must not be represented as a passing capacity test. Six-job convergence, valid raw DOMAIN/family completion, source cursor completion, final job settlement and actual process-crash continuation through the complete sequence remain unproven. Primary focused source/currentness/lease/generation/tenant tests pass 11/11. Eight independent retained-delta safety scenarios were verified, including raw unit chain/immutable replay, missing DOMAIN ACK, invalid producer/finalization, forged run clock, lost COMMIT ACK, serial/parallel capture equality and resource/content rejection. This is safety-only review, not whole-capacity approval.

Compact operation counts, remaining budget, generation and exact receipt evidence are in `stage6-raw-capacity-checkpoint.json`. Performance logs identify the loaded checkpoint SHA; final source hashes and ancestry distinguish later reviewed changes. Do not infer frozen-commit timing from an uncommitted release pin alone.

## Next technical action

Introduce a genuine durable raw DOMAIN/receipt preparation boundary or reduce its complete authenticated closure enough to fit the effective deadline. The boundary must bind the exact original canonical calculation, flattened source content, output graph, HMAC/producer, generation and job scope; replay must freshly reconcile all dependencies and lease ownership. A source-level sibling completion boundary additionally needs the required association results and insight/family tips, not only input digests or the metric DOMAIN. First make the strict retained-source fixture complete DOMAIN and source settlement across process restart; then run the full six-job synthetic workload at 115 ms until all six authentically complete. Do not widen timeouts, accept a read-only no-op as progress, or advance cursors to escape this fixture.

## Controlled production plan — not authorized or executed

Production stays at the previously reported 0/6, second permit 12/12. This session performed no provider operation, paid execution, counter reset, token change, public GitHub push or deployment. No prior authorization is assumed to cover this new SHA.

After the remaining local gates and exact-SHA independent capacity review pass:

1. Freeze the exact source SHA/tree and release artifact hashes. Apply the existing `release-handoff.md` controls for immutable checkout pins, original keys, schema-v32 read-only admission, source/config proof, stale-run containment and a reviewed rollback. Preserve production schedulers and ordinary Morning Brief.
2. Obtain separate authorization to deploy that exact candidate. Public GitHub publication of the new SHA needs its own explicit authorization. Start with optional SHADOW/presentation off; no migration or token replacement is part of this repair.
3. Obtain a separately bounded paid validation allowance with an explicit invocation/retry ceiling and cost/expiry monitor. The exhausted second permit must remain intact; implementation of a new permit, if needed, requires approval and review. A deployment alone does not authorize DRAIN.
4. Under that exact allowance, use one finalized current authorized SYNC handoff and the smallest admitted DRAIN continuation sequence. Read back exact unit/DOMAIN/cursor/job receipts, producer generations and immutable evidence after every invocation. Stop on loss of forward progress, failed fencing/currentness, uncertain COMMIT requiring reconciliation, allowance ceiling or expiry. Production completion can be declared only after all original six jobs complete legitimately and their original authority is verified.

No production authorization is needed to continue the unfinished local repair. Approving a deployment or another paid pilot cannot close the current technical capacity gate.
