> Historical repair packet. The three subsequent independent blockers and their repair are covered by [stage8-three-blocker-review-handoff.md](stage8-three-blocker-review-handoff.md).

# Stage 8 independent repair review handoff

This candidate repairs the independently confirmed Stage 8 safety, recovery, scheduling, retry, identity and localized-control defects. It preserves all 50 original Stage 8 paths and approved Stage 7 behavior. Stage 8 is not COMPLETE: final Stage 6 integration and authenticated LIVE analysis producers remain blocked. Formal whole-Stage-8 Final Review and Production readiness are NO-GO; the independent repair delta is ready for focused review with final synthetic verification complete.

The branch remains `codex/stage8-v34-provider-20261013`. Baseline is `5dc3462de7e67e63246657e9c7e4ae92249bf108`; the inherited Stage 7 foundation is `828b3bad0f75d3b81d374e431872878af56f6c9a`. Runtime/test source is frozen at `41d298caee041beedb3f5c182b340edf7d8e45eb`, tree `1128db7ddc8d4f2281c3687fcca648c312083428`. Obtain the final evidence commit HEAD/tree with `git rev-parse HEAD HEAD^{tree}`. Final documentation/evidence commits change no runtime or test source. Source hashes and path preservation are recorded in `stage8-repair-evidence/source-integrity.json`.

## Original findings and before and after evidence

| Finding | Status | Before | After |
| --- | --- | --- | --- |
| Urgent symptom routing | CLOSED | The independent Chinese urgent/recovery collision returned HRV and recovery values | The existing deterministic safety response precedes Stage 8, Body, source scope and model routing; the same reproduction is checked in zh-TW, vi and en |
| Recovery and configuration fencing | CLOSED | Active Stage 8 could invoke a provider under COMPANION_V33_RECOVERY and flag changes retained the same proof | Both recovery profiles reject active Stage 8/cutover gates before IO; proofs include gates/cohort/cutover/profile; retained runtimes reject configuration changes and signed replies |
| Automatic owner scheduling and subject plans | CLOSED for independent code | No scheduled caller; positive tests inserted another subject's plan manually | Existing signed companion endpoint composes the owner lane independently of Stage 7; explicit followed subjects receive authorized source plans without SYNC, DRAIN or pilot consumption |
| Owner definite retries | CLOSED | FAILED_DEFINITE never progressed | Durable 30/60 second minimum backoff, three-attempt ceiling, permanent semantic key, expiry/exhaustion suppression; uncertain/recovered started attempts are AMBIGUOUS and never resend |
| Morning retries and expiry | CLOSED | A 429 remained failed indefinitely and the old reservation remained RESERVED after expiry | Retryable definite 429/5xx use existing one/two minute backoff and three-attempt ceiling; permanent failures, stale authority/plans and expiry close the original reservation; expiry audit is retained |
| First-name provenance | CLOSED for independent code | Only explicit name confirmation recorded provenance | Authenticated private Telegram capture and verified WHOOP OAuth profile capture are wired; binding/auth generations, explicit precedence, profile revision, erasure and no-rehydration are tested |
| Icons and localized controls | CLOSED for emitted controls | Quiet hours had only numbers; owner choice was an unidentified ordinal | Quiet-hour labels contain localized wording; owner choices contain localized subject text and a proven name or stable private alias, repeated in class selection; text input remains available |
| LIVE producer and reader availability | BLOCKED | No authenticated LIVE producer and no runtime derived reader | Typed reader boundary is wired and tested to reject SHADOW, forged/current-empty metadata and revoked scope; actual LIVE producers and their new schema/receipt integration remain absent |
| Final Stage 6 repair integration | BLOCKED | 9770553 was outside ancestry and its budget guards were absent | Latest successor caf08fc was inspected read-only; its raw DOMAIN capacity gate is still partial. No overlapping source was copied or cherry-picked; exact reconciliation plan is provided |
| Production activation and native acceptance | OPEN | Stage 7/v33 and Stage 8 undeployed in retained readbacks | No Production operation occurred; approved migration/cutover, compatible recovery and genuine provider/native visual evidence remain required |

The owner lane reads at most 301 subscription metadata rows, rejects more than 300 retained subscriptions, and checks at most six per tick. A durable rotating cursor prevents cron-cadence starvation. A pending attempt is recovered or validated before a subject plan is rebuilt; recovery reads metadata only. Retry eligibility rechecks both principals, enrollment/subscription revision, source/profile/privacy generations, destination and rollout. Actual retry time follows the unchanged scheduler cadence. No new local timer loop sends messages.

The existing receipt-authorized LIMITED Body Energy trial policy remains separate from LIVE analysis. Missing analysis is always ANALYSIS_UPDATING, including fake SQL completion/current-empty metadata. No flags manufacture producers or scope completion.

## Verification and evidence

The P0 milestone passed 32/32 focused cases. The final independent repair group passed 44/44. Actual-schema typed selector checks passed 3/3. Changed WHOOP/OAuth helper regressions passed 54/54; isolated polling passed 12/12. The final documented integration suite passes 200/200 and the regression suite passes 164/164, both exit 0, zero skipped/cancelled: 364 distinct cases including 31 new Stage 8 cases. Source syntax checks pass 26/26. Exact counts and log hashes are recorded in `stage8-repair-evidence/test-results.json`. These are synthetic results only.

Earlier failed fixture/hardening runs are retained as superseded failures. Runs interrupted before later runtime fixes are retained as INTERRUPTED, not counted as PASS. In the optional combined polling/onboarding run, a native polling crash cleared in the isolated rerun. Two historical-rewind assertions hard-code SCHEMA_VERSION=32 and fail unchanged on the requested v34 baseline; `baseline-historical-fixture.tap.gz` reproduces both. The historical helper is unchanged and those cases are not passed.

v32/v33/v34 schema definitions, dependency manifests and scheduler/workflow configuration are unchanged. Required migration tests exercise v33-before-v34, interrupted migration, original keys/data, admission drift rejection, byte-preserved v32 DOMAIN/producer/work receipts and the authentic six-of-seven Journal cursor. They do not establish Stage 6 capacity or Production completion.

All emitted Journal, Coach, Settings and Quick Action controls in the scoped tests have icon and text coverage in zh-TW, vi and en. Native Telegram visual acceptance and genuine LIVE/provider evidence remain unverified. No real Telegram sends were made.

## Exact next reviewer instructions

1. Pin the final branch HEAD/tree and create an independent detached checkout. Verify ancestry from 5dc3462 and 828b3ba, the complete effective diff, source hashes and preservation of all 50 original paths. Review all repair commits; do not reuse the original 333-case author PASS as review approval.
2. Review urgent routing precedence, both recovery profiles, configuration proof inputs and interrupted final-boundary behavior. Review the real polling/webhook capture hook and WHOOP OAuth capability/generation flow.
3. Review signed owner composition, subscription bounds and durable cursor, subject-only source-plan grants, metadata-only recovery, attempt CAS/backoff/expiry/exhaustion, and ambiguous no-resend barriers. Review Morning retry classification, frozen projections, old-authority closure and reservation/expiry audit.
4. Verify meaningful localized labels, subject identification, free text, callback persistence, optional notes, confirmation, edit/retract and explicit missingness in all three locales. Obtain native screenshots only in a separately authorized controlled acceptance workflow.
5. Reproduce the focused repair cases and documented suites with Node 22 and locked dependencies:

```sh
node --test --test-concurrency=3 test/stage8-*.test.js test/stage7-*.test.js test/companion-*.test.js
node --test --test-concurrency=3 test/settings-v1.test.js test/settings-v1-product.test.js test/settings-v1-integration.test.js test/settings-v1-process.test.js test/conversational-perspective.test.js test/telegram-webhook.test.js test/cloudflare-scheduler.test.js test/morning-readiness.test.js test/body-provisional-policy.test.js test/phase4-foundation-privacy.test.js test/phase4-privacy.test.js test/phase4-morning-continuity.test.js
```

The two authentic v32 probes still require the clean pinned read-only 2340e8b checkout identified in the original handoff. Use only synthetic databases and transport. Do not activate gates, invoke Production, access/change credentials, send real acceptance messages or consume Stage 6 allowances.

6. Keep LIVE analysis and final Stage 6 integration BLOCKED. Follow `stage8-live-producer-contract.md` and `stage8-stage6-reconciliation.md`; re-pin the latest final reviewed Stage 6 successor before integration. Its SHADOW completion alone cannot satisfy the LIVE producer contract.
7. Report scoped repair acceptance separately from whole-Stage-8 Final Review and Production. Do not claim COMPLETE while mandatory producer/integration requirements remain unmet.

F02 remains Owner Accepted Risk. Turso credentials were not accessed or modified. There was no push, merge, Production migration/deployment/flag change, permit spend, or real health-data mutation. All repairs and evidence are confined to the dedicated Stage 8 worktree.
