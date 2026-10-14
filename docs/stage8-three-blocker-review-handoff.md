# Stage 8 three-blocker repair — exact reviewer handoff

Branch: `codex/stage8-three-blocker-repair-20261014`.
Baseline: `7c6af29b7d19857444001694a6aae86a59ddf4d9`, tree `1345bfebd7f22c71854e0841c88fefdd84b77216`.
Final runtime/test source freeze: `25e3f14bbb7c3cc30cd57ea4a00c8440c2fc608d`, tree `82821e4ed2ef80399ce092bcaa0cf6cdfdbbe1b2`.
Obtain final evidence HEAD/tree with `git rev-parse HEAD HEAD^{tree}`. Later commits contain only reviewer documentation/evidence. Source hashes, exact diff, run classifications and compressed/uncompressed log hashes are in `stage8-three-blocker-evidence/`.

Implementation verification: PASS for the three-blocker repair. Code acceptance recommendation: GO for independent review; independent acceptance is PENDING. Whole Stage 8 completion/Final Review and Production remain NO-GO. Stage 6 integration and authenticated LIVE analysis producers remain BLOCKED. These results are synthetic only.

## Three finding closures

1. **Multilingual urgent handling — CLOSED in implementation verification.** The original 21 independent probes reproduced 9 PASS/12 FAIL on the pinned baseline. The detector now recognizes Chinese, English, Vietnamese and mixed-language symptoms, normalizes Unicode/apostrophes, and examines every symptom occurrence. Negation, education, quotations, hypothetical descriptions and clearly resolved history are scoped to the relevant symptom/clause. Ordinary fatigue or an unrelated historical resolution cannot suppress a current red flag. Added checks include direct Vietnamese statements, short-of-breath wording, repeated negated/current mentions, paired-symptom negation, resolved historical descriptions and multilingual ordinary questions. Existing localized safety guidance is reused; no model or WHOOP measurements enter urgent replies.
2. **Global ingress precedence — CLOSED in implementation verification.** `createUpdateProcessor` selects urgent handling after private transport classification and durable ownership, before authenticated name capture or Stage 7 inbound processing. It emits guidance inside the existing action/receipt path after the account lifecycle check. Webhook and polling already share this processor; their Settings-first handlers are not invoked for urgent input. Recognized urgent messages preserve the active name-edit session and Journal NOTE state, produce no identity capture or ordinary scoped health read, and retain replay/destination/lifecycle guards. Nonurgent flows remain available. Review both production wiring paths, not only the router.
3. **Stale ELIGIBLE Morning closure — CLOSED in implementation verification.** Both FAILED_DEFINITE and previously attempted ELIGIBLE work receive frozen-plan/currentness validation before retry. Typed-read failures roll back their own read transaction, then a narrow metadata-only conditional transaction retires the original work. The frozen v24 transition permits ELIGIBLE → SUPPRESSED; it does not permit ELIGIBLE → FAILED_TERMINAL. `closeMorningRetry` therefore uses SUPPRESSED with terminal reason FAILED_TERMINAL, atomically closes the original reservation, and requires the exact revision, no live lease, Morning class, positive attempt count and latest FAILED_DEFINITE attempt. It cannot retire ambiguous/started work or mint a replacement reservation. Existing FAILED_DEFINITE terminalization, backoff, expiry audit and deduplication are preserved. Tests cover authorization generation, locale, pause, expiry, resource revocation, same-generation source-content changes, disconnected parent links, stale revision and ambiguous consumption.

Only four runtime files change: `src/bot/triage.js`, `src/bot/updateProcessor.js`, `src/phase4TransportStore.js`, `src/stage8MorningStore.js`. All 50 original Stage 8 paths remain present. Frozen v24/v32/v33/v34 definitions, migrations, dependency manifests, scheduler/workflow configuration, Stage 6 overlapping runtime files, LIVE authority and derived-reader boundaries remain unchanged. No Stage 6 code was merged or imported. Retain the latest separately frozen and independently reviewed Stage 6 successor, including its original authority and budget guards, when planning later integration. This repair does not qualify Stage 6 capacity or create a LIVE producer.

## Exact verification

Node `v22.23.2`, normal ESM resolution, existing locked local dependencies. Final source freeze passes:

- Documented integration: **200/200**, exit 0.
- Documented regression: **164/164**, exit 0.
- Original independent probes plus 11 extended closure cases: **32/32**, exit 0; the original **21/21** are included.
- Affected polling/transport: **16/16**, exit 0 (12 polling, 4 transport).
- Syntax: **11/11** changed runtime/test files. Diff whitespace checks pass.

Final groups have zero skipped/cancelled tests. A context-matrix test additionally checks genuine current symptoms and nonurgent educational/negated/resolved cases. Superseded development/fixture runs are retained and excluded from final PASS counts. One optional combined triage invocation ended in a SIGSEGV after its fatigue assertion; the isolated assertion rerun passed. Its cause is unassigned, and that combined invocation is not counted as PASS. Existing pure urgency precision assertions passed. The previously independently reproduced two onboarding helper assertions still hard-code v32; the helper and schema version are unchanged by this repair.

## Independent reviewer steps

1. Create a fresh detached checkout at the final evidence HEAD. Verify HEAD/tree and ancestry from the baseline; compare every runtime/test byte with the source freeze and `source-integrity.json`. Read the exact diff with `gzip -dc docs/stage8-three-blocker-evidence/repair.diff.gz` and the retained failure/pass classifications.
2. Independently reproduce the baseline failures and all three closures, including native/mixed language, negative/resolved context and active Settings/Journal states through the real shared update processor. Verify private sender, lifecycle, replay and destination protections.
3. Review separate typed validation and atomic conditional cleanup. Probe source/parent invalidation, all documented stale fields, expiry, overlap/CAS and ambiguous recovery. Require the same original reservation and no provider resend/replacement key.
4. Rerun the commands below with synthetic databases and fake transport only. The two authentic v32 migration-preservation probes require the clean pinned read-only `2340e8bc305c6acde29bbfa540753e79dbd34408` fixture at `/Users/kelvin/Desktop/whoop-briefing/tmp/stage6-p0-20261013/worktree`.

```sh
node --test --test-concurrency=2 test/stage8-three-blocker/*.test.mjs test/stage8-three-blocker-closure.test.mjs
node --test --test-concurrency=3 test/stage8-*.test.js test/stage7-*.test.js test/companion-*.test.js
node --test --test-concurrency=3 test/settings-v1.test.js test/settings-v1-product.test.js test/settings-v1-integration.test.js test/settings-v1-process.test.js test/conversational-perspective.test.js test/telegram-webhook.test.js test/cloudflare-scheduler.test.js test/morning-readiness.test.js test/body-provisional-policy.test.js test/phase4-foundation-privacy.test.js test/phase4-privacy.test.js test/phase4-morning-continuity.test.js
node --test test/bot-polling.test.js test/phase4-transport-store.test.js
node --test --test-name-pattern='D1:|D2:' test/regate-round4.test.js
node --test --test-name-pattern='一般疲倦' test/conversational-health-hardening.test.js
```

5. Report independent repair-code acceptance separately from whole Stage 8 Final Review and Production. Read the unchanged `stage8-live-producer-contract.md` and `stage8-stage6-reconciliation.md`. No wired reader, source plan, SHADOW result or SQL completion marker is positive LIVE analysis evidence.

F02 remains **Owner Accepted Risk**. No Production operation, push, merge, release migration, real Telegram send, credential access/change or actual health-data mutation occurred. Existing migration definitions were exercised only in synthetic fixtures. Production/native acceptance, final Stage 6 reconciliation and authenticated LIVE producer readiness remain outstanding.
