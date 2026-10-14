# Stage 8 triage architecture correction — NO-GO handoff

Branch: codex/stage8-triage-architecture-correction-20261014.
Baseline: 177bfbc9c7ff41b9d3021ded136598f871bcfcfd, tree 1cfa46fe5cb83410c04148a57d1c68371e1a550b.
Frozen runtime/test prototype: cd24e9ecfe14438b0a7e7a52f90a93b1d1739c3b, tree 3216ef4857dc00c702bfa8cb77cd01f132be8c46.
The later evidence commit contains documentation only. Obtain its final HEAD/tree with git rev-parse HEAD HEAD^{tree}.

Implementation verdict: FAIL. Repair code readiness: NO-GO. Whole Stage 8 readiness: NO-GO. Production: NO-GO. This branch is an isolated experimental prototype, not accepted repair code.

## Reproduction and bounded stop

The exact latest independent evidence was available; nothing was reconstructed. It contains 58 novel statements, 40 overlapping metamorphic variations, 16 shared-processor cases and three multilingual metric-exposure cases. Deduplication yields 94 distinct raw strings with unchanged expected urgency. Baseline direct reproduction: 61 PASS / 33 FAIL; its original novel subset reproduces 37 PASS / 21 FAIL. Baseline actual shared processor: 4 PASS / 15 FAIL across 19 cases.

Confirmed causes: unrelated past context overriding current assertions; actual assertions attached to quotations losing their referents; negative scope lost across unknown modifiers or coordinated symptoms; resolution scope; embedded hypothetical versus actual assertion; educational-list continuation; fictional third-person reference. The permanent corpus retains origins, exact expectations and failure classifications.

The prototype passes the recovered 94/94 and all original 560 tests. However, a bounded off-corpus gate found three later-current-predicate false negatives. Their expectations remain in test/stage8-triage-architecture/open-gate.test.mjs and fail. Runtime edits stopped under the user's stop rule. The source is frozen as a WIP/NO-GO commit; no acceptance claim is made.

Read stage8-triage-architecture-alternative-design.md for the replacement predicate-span graph, uncertainty policy, privacy/failure/operating trade-offs and acceptance invariants. The prototype's existing group identifiers do not prove operator ownership.

## Actual prototype architecture

Regexes lex symptom expressions and semantic operators; the interpreter then records per-symptom assertion, speaker, polarity, time, resolution/recurrence, framing, quotation and relationship evidence. It handles coordinated lists, postnominal/adjacent references, reported speech, same-speaker outcomes and epistemic uncertainty. The final reducer exposes CURRENT_URGENT, POSSIBLE_CURRENT_URGENT and CLEARLY_NONURGENT. Both safety decisions take the existing conditional localized safety path at shared ingress before identity capture, name/note persistence, Stage 7 consumers and ordinary metrics.

Only src/bot/triage.js and the explicit decision adapter in src/bot/updateProcessor.js change at runtime. There is no external model/API dependency or raw-message runtime logging. The historical registered symptom vocabulary and localization remain unchanged. The classifier is bounded to existing input/clause/mention limits, but its imperfect predicate ownership makes the architecture unacceptable.

## Verification

Original documented suites: 560/560 PASS, all process exits 0, zero skipped/cancelled:
21 original adversarial; 11 closure; 17 previous independent; 125 scope/bounds; six processor; 200 integration; 164 regression; 16 polling/transport.

Permanent new suite: 200 PASS / 3 FAIL across 203 tests, process exit 1, zero skipped/cancelled:
94 distinct recovered corpus tests; 56 new boundary/metamorphic tests; 16 uncertainty tests; 19 exact recovered ingress checks; 15 possible-current/normal-continuation/authority checks; three OPEN predicate cases.

The 19 recovered actual-processor cases now pass. Current positive cases preserve pendingName/Journal state and have zero ordinary scope reads; the prior three metric exposures produce safety guidance with zero scope reads. Clearly nonurgent cases resume normal name/note behavior. Possible-current checks span four lanes and all three locales, preserve state/identity, retain replay deduplication, and permit normal subsequent name, free-text note, Coach and metric interactions. Forged sender, stale lifecycle and changed tenant destination checks use existing guards and fake transport.

Two preliminary negative-case tests reached the correct normal route but an urgent-only fixture guard threw MODEL_FORBIDDEN. Their expectations were preserved; nonurgent cases now use the existing no-provider fallback, while urgent cases still forbid the ordinary provider path. A preliminary destination fixture used an unconditional fake send, omitting the production destination guard; it was corrected to use createSendReply with a fake API and an explicit synthetic revoke/rebind. Neither fixture correction changed application code or expected results. The superseded failures are retained in evidence.

Commands (Node v22.23.2, locked existing dependencies, synthetic DBs/fake transport only):

    node --test --test-concurrency=2 test/stage8-three-blocker/*.test.mjs
    node --test test/stage8-three-blocker-closure.test.mjs
    node --test --test-concurrency=2 test/stage8-triage-semantic/independent-extra.test.mjs test/stage8-triage-semantic/independent-coach.test.mjs
    node --test test/stage8-triage-semantic/scope.test.mjs
    node --test test/stage8-triage-semantic/ingress.test.mjs
    node --test --test-concurrency=3 test/stage8-*.test.js test/stage7-*.test.js test/companion-*.test.js
    node --test --test-concurrency=3 test/settings-v1.test.js test/settings-v1-product.test.js test/settings-v1-integration.test.js test/settings-v1-process.test.js test/conversational-perspective.test.js test/telegram-webhook.test.js test/cloudflare-scheduler.test.js test/morning-readiness.test.js test/body-provisional-policy.test.js test/phase4-foundation-privacy.test.js test/phase4-privacy.test.js test/phase4-morning-continuity.test.js
    node --test test/bot-polling.test.js test/phase4-transport-store.test.js
    node --test --test-concurrency=2 test/stage8-triage-architecture/*.test.mjs

The last command deliberately exits 1 until the OPEN cases are genuinely repaired. Do not weaken their expectations or interpret a passing historical suite as proof of semantic closure. The authentic v32 fixture remains the clean read-only 2340e8bc305c6acde29bbfa540753e79dbd34408 checkout at /Users/kelvin/Desktop/whoop-briefing/tmp/stage6-p0-20261013/worktree.

## Preservation and release boundaries

Morning stale ELIGIBLE remains independently CLOSED and byte-identical. All other accepted runtime files, schemas/migrations, dependencies, workflow configuration, Stage 6 overlap and LIVE boundaries are untouched. No Stage 1–5 re-review occurred.

STAGE8_NATIVE_BASELINE_SIGSEGV remains B — existing baseline defect, OPEN, root cause unassigned. No new native failure occurred in these runs; the optional combined D1/D2/ordinary-fatigue command passes 3/3 on this source. That pass does not resolve the known matching index.node finalizer crash or remove the eventual integrated-release stability gate.

Stage 6 still requires owner-freezing and independent capacity qualification of the latest successor, isolated semantic reconciliation with the original authority/budget/DOMAIN/cursor guards, 115 ms raw DOMAIN/full six-job gates, restart checks, combined regressions and independent review. Do not assume the documented partial caf08fc is final.

Authenticated LIVE producer allocation, selector/schema admission and typed-reader integration remain outstanding. Require complete finalized original receipt/parent/source proof, exact mode/generations/configuration/digests, deadline and revocation/restart/isolation checks. A SHADOW result, wired reader or completion marker is not LIVE evidence. Read the unchanged stage8-stage6-reconciliation.md and stage8-live-producer-contract.md.

No Production changes, deployment, push, merge, release migration, real Telegram delivery, paid testing, credential access/change or actual health-data mutation occurred. F02 remains Owner Accepted Risk.

Exact next action: review the replacement graph contract and its operator-ownership invariants before another implementation cycle. Start from the preserved baseline and reuse the immutable corpus, OPEN cases and ingress proofs. This prototype must not be merged as a completed repair.
