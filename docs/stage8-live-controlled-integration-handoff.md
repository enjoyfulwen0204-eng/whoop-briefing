# Stage 8 controlled LIVE producer integration

This is a local, independently reviewed analysis-producer candidate. Producer delta: GO. Whole Stage 8 code acceptance and Production: NO-GO. No deployment or real delivery is claimed.

## Foundation and isolation

Foundation: `649676e030aa8d25639985d397c5d3837462f484`, tree `e2445e02e324ff633a256bf244522808fb393ffa`. It contains accepted Triage `0acd29f9c010e7f924736ec2c8054f5e44435f5d` and reviewed Stage 7 `828b3ba` as ancestors. The accepted triage/safetyGate and v33/v34 schema builders remain byte-identical; hashes are in the evidence manifest.

Branch: `codex/stage8-live-controlled-integration-20261015`.
Worktree: `/Users/kelvin/.codex/worktrees/stage8-live-controlled-integration/whoop-briefing`, device/inode `16777229:77664211`.
Stage 6: `/Users/kelvin/Desktop/whoop-briefing/tmp/stage6-raw-capacity-20261013/candidate`, `16777229:71452797`. Physical separation was confirmed before editing. Stage 6 was inspected read-only; its changing HEAD is not an acceptance receipt.

The original 297-line namespace patch (SHA256 `e9dc477d1b3972c6eef5292e03a15016704db803d8f8650caddcaa7a534f4130`) changes nine code-owned physical table selectors/closure keys. It adds no producing authority, consent, schema mutation or execution-mode permission by itself. It was applied only after a fresh explicit environment approval of the exact `git apply` operation. The earlier rejection was preserved; no denial bypass was used. The privacy prerequisite and subsequent scoped local implementation edits also received environment approval.

## Implementation

`stage8LiveProducer.js` composes the canonical source/metric/family/association worker with the private admitted v35 LIVE capability, actual checkout identity, server-owned cohort/eligibility, active authenticated provider, READY, lifecycle and purge checks. Requests supply an opaque identifier and eligible user only. No source results, receipts, transport, consent or follows come from requests.

`phase4ReanalysisQueue.js` preserves opaque EOF and all-family completion proofs. Each of the two required jobs writes its metadata-only completion seal in the same transaction as its original named work receipt. Publication reconstructs that named key from the signed cursor hash and checks its exact original producer, tenant, execution sequence, request/scope, generation and original 45-second deadline.

`stage8LivePublication.js` atomically signs a complete producer/artifact manifest after both genuine jobs complete. A completion flag or empty item list cannot substitute. Certificates are immutable per input generation and expire after 15 minutes. Expired, damaged, failed or recovered production causes actual FULL recomputation with a new input generation; source generation is unchanged unless the source really changed. FAILED executions remain FINALIZED_FAILURE. Recovery records PARTIAL and never authorizes aggregate completion by itself.

Typed SELF readers authenticate the certificate and selected original receipt/parent/source graph; wrong tenant, SHADOW, stale/revoked scope and incomplete production stay fenced. BODY output retains estimated/quality metadata and the existing LIMITED trial contract. Owner Monitoring retains separate authenticated dual principals, explicit follows, enrollment revisions, destination and class policies. DAILY remains an approved source-plan path. WEEKLY requires supported current insights. IMPORTANT requires an authentic current subject alert already DELIVERED/AMBIGUOUS. No such alert or delivery is fabricated.

The server-owned `createStage8Runtime().analysis.run` seam is opt-in with `STAGE8_LIVE_ANALYSIS`, default off, and rejects nesting inside existing SYNC/SHADOW executions. Trusted post-sync scheduling remains an integration step. No new public endpoint or automatic schedule was activated.

LIVE health receipt/result authority storage participates in canonical privacy inventory and physical erasure. Invocation/reader/Owner transient context leases are released after use, preserving the purge cache-ack fence.

New manifest traversal preflights counts and worst-case byte bounds before row transfer, then reads 64-row pages: at most 4,096 producer rows/16 MiB metadata and 10,000 artifact rows/64 MiB worst-case escaped JSON. NULL metadata lengths count correctly. These bounds do not qualify overall Production capacity.

## Schema and test evidence

The v35 proposal remains local and unapplied to Production. It adds LIVE-only siblings plus immutable metadata completion/publication tables with no-replace guards, safe integer/hash constraints, closed two-job proof shape and deferred original receipt FK. Independent schema review allowed isolated synthetic execution. Frozen v33/v34 definitions and ordering remain intact. Fresh/default migration remains v34; an already-v35 database validates its exact profile. Older kernel-only local v35 shapes fail closed and require a separately controlled migration decision; no silent repair is implemented.

Exact commands, counts, hashes, raw compressed TAP, prior failures, interruptions and independent review are in [results.json](stage8-live-controlled-evidence/results.json). Repeated/subset runs are not added together as unique tests.

- All 36 new LIVE definitions passed: genuine numeric computation to typed reader, all four registered reader kinds, private authority, schema constraints, tenant/generation/auth/lifecycle/READY checks, canonical purge, separate Owner subject, replay and actual child crash/lost-COMMIT-ack recovery.
- Independent security/functional review: 49 repository definitions plus four reviewer-authored checks, **53 PASS / 0 FAIL**. The additional checks cover enrollment revocation at publication INSERT, selected-root revocation, real public resource-authorization invalidation/peer isolation, and NULL-safe SQL bounds.
- Full original 210-definition Stage 7/8/companion run: raw **206 PASS / 1 native file failure**; the four definitions lost to the Stage 7 delivery process SIGSEGV passed in one isolated rerun. Thus all 210 original functional definitions have passing coverage across runs; the full invocation failed and stability remains open.
- Original Provider/Morning/Owner retry subset: **23 PASS / 0 FAIL**, after fixing the observed cleanup regression without changing expectations.
- The combined final LIVE/current-capture run reported **37 PASS / 1 native file failure** over 38 reported results: 36 new LIVE definitions and the current-capture assertion passed, then its native test process crashed. One isolated current-capture rerun passed 1/0. Neither rerun resolves SIGSEGV.
- Original typed authority/closure/split and early legacy worker coverage confirmed 40 passing checks before an explicit capacity-run interruption. One isolated final-settlement check also passed. Two extended legacy worker cases remain unconfirmed; they are not counted as PASS.

The original Owner cleanup failure (203/7), fixture mistakes, the interrupted initial positive run and the concurrent oversized-sibling timing failure are retained. Expectations were not weakened. The corrected fixture supplies explicit canonical Journal timestamps, seven genuine baseline days for a numeric estimate and a legitimately due existing morning preference.

Routing, cross-generation and insight-isolation regressions: **34 PASS / 0 FAIL**, including the unchanged oversized-sibling case.

Reader samples on the final local synthetic run were103.85–117.16ms;64 LIVE worker legs had maximum7,853.99ms. The full pipeline/privacy case took71.76s across bounded legs, with observed process peak827,760KiB RSS. Migration, native driver allocations, repeated reads and purge are included; this is not attributable steady-state producer overhead.

## Limits and remaining integration

The legacy v28 60-day SUPPORTED-insight capacity run repeatedly exhausted its unchanged 90s/15s budget with zero progress (85.96s, 79.08s, 99.10s legs). The local command was stopped after these three consecutive legs, retaining 40 completed PASS checks and marking the run INTERRUPTED/INCOMPLETE. No budget, expectation or Stage 6 implementation was changed to manufacture a result. The extended SUPPORTED and contrary-evidence cases remain unconfirmed. This is additional unresolved qualification evidence, not a Stage 6 completion receipt.

The native SIGSEGV reproduced in Stage 7 delivery and current-capture processes. Isolated functional reruns passed; stability remains OPEN. No fix is claimed.

Positive qualifying WEEKLY content and authentic LIVE subject-alert upstream/delivery acceptance remain integration requirements. Current Owner tests prove real separately authorized subject computation, approved DAILY, WEEKLY no-qualifying-content and IMPORTANT no-approved-alert policy behavior. They do not claim positive weekly/important delivery.

Stage 6 must supply its final independently accepted SHA/tree and reconcile the six overlapping files: `phase4Reanalysis.js`, `phase4IntelligenceStore.js`, `phase4MetricUnitReceipt.js`, `phase4OperationReceipts.js`, `phase4Repositories.js`, `phase4ResultAuthority.js`. Preserve actual raw/DOMAIN/family/source/cursor completion, INCOMPLETE behavior, source identities and 45,000/15,000ms controls. Complete Production runtime/capacity, shared SYNC/Morning and restart acceptance remain dependencies.

Performance samples cover local synthetic migration/computation/purge and bounded readers under concurrent tests. They are not Production throughput or attributable steady-state memory benchmarks. Raw measurements are preserved in results.json. Native peak RSS is material and still requires qualification.

No Production configuration/database/migration, push, merge, deploy, real Telegram send, paid execution, resource purchase or credential change occurred. F02 remains Owner Accepted Risk; the Turso Token is unchanged. No new Owner pilot or Public Beta rollout stage is introduced.

## Exact reviewer/owner handoff

1. Obtain this frozen branch HEAD/tree with `git rev-parse HEAD HEAD^{tree}`; compare the source manifest and independent final binding receipt. The runtime implementation is frozen at `faeb2acff7d86992475bebc7333bf92b1d2e38a5` / tree `9ae1360d0dc5d195277011f0ed8124868af7bf7b`. The independently reviewed runtime foundation is e941fda plus the single NULL-bound change with publication SHA256 `ff9a9d2359796bf27d462f07245d7261653c657f59b525eb4ec5e198a4164fa0`.
2. Review `git diff 649676e..HEAD -- src test`, the v35 schema report and retained failures. Reuse exact-code acceptance for unchanged Triage/v33/v34 and prior components.
3. Reconcile final Stage 6 ownership/receipts and qualify the two legacy capacity cases, native stability, qualifying WEEKLY and approved LIVE alert upstream. Wire a trusted separate post-sync producer invocation and explicit authorized subject policy; keep existing self-only and Owner class boundaries.
4. After all integration requirements pass, obtain separate owner approval for ordered v33→v34→v35 Production migration and matching deployment. Verify real authenticated LIVE outputs and authorized delivery only after that approval. This candidate grants no Production authority.
