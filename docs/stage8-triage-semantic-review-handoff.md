# Stage 8 triage semantic-scope repair — reviewer handoff

Branch: `codex/stage8-triage-semantic-repair-20261014`.
Baseline: `5a6e0a5764a75ec303acfaf52f356694f717b750`, tree `58d1f264efe179fc61dd2fd971a30462e32f797b`.
Runtime/test source freeze: `e59e38353343cf229a2597f5d9dd793b876f3476`, tree `3f6d5522b548674beb08d7c97905f51b3db475b3`.
The final evidence commit follows this source freeze and contains documentation/evidence only. Obtain its exact HEAD/tree with `git rev-parse HEAD HEAD^{tree}` and compare every runtime/test byte with the source freeze.

## Reproduced causes

Before editing, the locally available original 21 and additional 11 tests passed 32/32. The actual new independent harness reproduced 5 PASS/12 FAIL across its 17 tests. Its expectations were preserved; the committed portable copies change only module-root resolution and add the corresponding URL import. No cases were reconstructed or weakened. The exact requested 12-example matrix reproduced seven incorrect decisions; its remaining five Boolean decisions passed, including a mixed-scope case that passed for the wrong symptom before repair.

The High defect came from a clause-wide educational marker overriding current phrases omitted by CURRENT_ASSERTION, including possessive/current Chinese wording and Vietnamese inability to breathe. A following “I am experiencing it right now” was not associated with its symptom. This let the shared processor's correctly positioned safety branch be bypassed; an authenticated name-edit state stored pendingName and a stable-authenticated Journal NOTE stored the symptom text.

The Medium defect came from incomplete anchored negation grammar and resolution recognized only after a symptom. “Not having”, “no longer having” and preceding Vietnamese “đã hết” were incorrectly escalated.

## Actual interpretation rules

Only `src/bot/triage.js` changes at runtime. The ingress processor, webhook, router, Stage 7, Morning store/runtime/transport, Owner Monitoring, identity, schema/migrations, dependency manifests, Stage 6 overlap and LIVE boundaries remain byte-identical to the baseline.

1. Normalize NFC and typographic quotation/apostrophe variants. Recognize the registered serious symptom vocabulary and weak heartbeat/dizziness/breathing combinations. Overlapping lexical expressions collapse to the longest expression.
2. Segment punctuation, contrast and causal clauses while preserving complete symptom expressions and quoted spans. “不過” inside “喘不過氣” is not a connective. Single-quote parsing preserves contractions, and English actor tokens use Unicode boundaries.
3. Assign each occurrence an explicit state: CURRENT, NEGATED, RESOLVED, HISTORICAL, HYPOTHETICAL, QUOTED, INFORMATIONAL, EDUCATIONAL or AMBIGUOUS. Negation and resolution attach to their own predicate and coordinated symptom list. They cannot suppress a new subject/predicate, contrast clause or unrelated symptom.
4. A local actual subject/present predicate or possessive current symptom overrides educational wording. Education requires affirmative generic-topic evidence: the request marker precedes its topic without a later symptom subject or attached current qualifier, or the symptom has a generic definition/cause suffix. Otherwise a plausible serious expression stays AMBIGUOUS; an unfamiliar personal predicate cannot be vetoed by educational wording. A time word modifying “learn about” does not independently assert a symptom. Explicit fictional cases, quotations and informational source descriptions have their own scope; actual independently asserted current symptoms remain safety cases.
5. Immediate current anaphora/recurrence creates a new assertion tied to the previous symptom-bearing clause. A bounded forward reference chain permits subsequent explicit resolution without resolving unrelated symptoms. Explicit past-only statements are historical; an ongoing/recurring assertion overrides the historical account.
6. A serious CURRENT or AMBIGUOUS occurrence triggers the existing localized conditional safety guidance. Weak combinations require distinct compatible symptom kinds, an 80-character neighborhood and compatible explicit actor identities. Different explicit people cannot manufacture a combination.
7. Bounds: 8,192 UTF-16 input characters, 128 clauses and 128 interpreted mentions, including reference assertions. Exceeding a bound conservatively returns the same nondiagnostic conditional safety guidance (`scope_limit`); it never opens ordinary health scope. Normal Telegram messages fit below the character bound.

No model/provider or health read participates in classification. The existing shared processor handles detected safety before authenticated name capture, Journal/Coach and ordinary health consumers, after transport authentication/durable ownership and within the existing lifecycle/receipt/deduplication path. No integration ordering change was required.

## Final source verification

Original 21: 21/21 PASS; closure 11: 11/11 PASS; new independent 17: 17/17 PASS; direct semantic matrix/bounds: 125/125 PASS; additional real localized ingress: 6/6 PASS; integration: 200/200 PASS; regression: 164/164 PASS; polling/transport: 16/16 PASS. The five accepted final process groups exit 0 with zero skipped/cancelled tests, for 560/560 total. The first final regression invocation ended 163 PASS/1 process FAIL with SIGSEGV in the unchanged webhook test. Its native UUID and six fault offsets match the previously reproduced baseline defect. The same complete regression command then passed 164/164 on the same source without code changes. Both runs are retained, and the native issue remains OPEN. Syntax 5/5 and source diff whitespace checks pass. Implementer readiness: GO for independent repair review; independent acceptance is PENDING.

## Verification commands

Use Node `v22.23.2` and the locked local dependencies with ordinary Node ESM resolution. All transport is fake and all databases contain synthetic fixtures. A local ephemeral listener may be required by documented webhook/process tests. The authentic v32 migration-preservation fixtures require the clean read-only pinned `2340e8bc305c6acde29bbfa540753e79dbd34408` checkout at `/Users/kelvin/Desktop/whoop-briefing/tmp/stage6-p0-20261013/worktree`.

```sh
node --test --test-concurrency=2 test/stage8-three-blocker/*.test.mjs test/stage8-three-blocker-closure.test.mjs
node --test --test-concurrency=2 test/stage8-triage-semantic/*.test.mjs
node --test --test-concurrency=3 test/stage8-*.test.js test/stage7-*.test.js test/companion-*.test.js
node --test --test-concurrency=3 test/settings-v1.test.js test/settings-v1-product.test.js test/settings-v1-integration.test.js test/settings-v1-process.test.js test/conversational-perspective.test.js test/telegram-webhook.test.js test/cloudflare-scheduler.test.js test/morning-readiness.test.js test/body-provisional-policy.test.js test/phase4-foundation-privacy.test.js test/phase4-privacy.test.js test/phase4-morning-continuity.test.js
node --test test/bot-polling.test.js test/phase4-transport-store.test.js
node --test --test-name-pattern='D1:|D2:' test/regate-round4.test.js
```

The first command contains the original 21 plus 11 closure tests. The second contains all 17 new independent tests, 125 direct scope/bounds cases and six additional localized real-processor cases. `stage8-triage-semantic-evidence/test-results.json` records final run outcomes, process exits, baseline failures, superseded focused runs and compressed/uncompressed log hashes. `source-integrity.json` records source/protected hashes, exact source diff, harness preservation and direct classification output.

Review the state traces, not only urgent Boolean decisions. Explicitly challenge current/negated/resolved statements, education plus current anaphora, quoted contractions, hypothetical scope and causal continuation, explicitly coordinated comma lists, third-person informational context, recurrence, unrelated resolution, same/different actor weak combinations, and late-position/overflow bounds. Require the actual shared processor to preserve name/NOTE/Coach state, avoid ordinary scoped reads and identity capture on urgent input, retain replay/lifecycle/tenant protections, and accept normal name/note continuation.

## Native baseline stability issue

Tracking ID: `STAGE8_NATIVE_BASELINE_SIGSEGV`. Status: OPEN, root cause unassigned, independently classified B — existing baseline defect. The previous independent review reproduced the exact optional combined selection on `7c6af29`: three assertions passed, then the native process failed at shutdown with SIGSEGV. The native image UUID `15297104-5a23-3847-9a99-938dd2f1ac9e`, six fault offsets and N-API finalizer/cleanup stack matched the reported candidate crash. Test files, localDb, db runtime and dependencies were byte-identical. The proof is retained from `/private/tmp/stage8-final-independent-review-results.json`. This patch changes none of those files, does not refactor the native library, and does not claim crash resolution based on isolated or mandatory-suite passes.

Optional reproduction command (keep its exit status separate):

```sh
node --test --test-name-pattern='D1:|D2:|一般疲倦' test/regate-round4.test.js test/conversational-health-hardening.test.js
```

## Limits and release boundaries

This is a finite deterministic grammar, not a general natural-language or medical interpreter. Registered vocabulary, explicit subject/predicate/marker forms, local coordinated lists and neighboring reference chains are covered. Arbitrary paraphrases, spelling errors, unsupported languages and distant implicit referents are not guaranteed. Unknown currentness of a detected serious expression receives conditional safety guidance. Explicit actor identity is syntactic and cannot identify arbitrary unnamed people. The bounded overflow policy can conservatively escalate unusually long/complex unsupported input. The supplied independent counterexamples and committed boundary matrix must all pass; these limits must not be used to excuse a regression in those cases.

The independently CLOSED Morning stale ELIGIBLE repair is retained unchanged. F02 remains Owner Accepted Risk. No Production access/change, push, merge, deployment, release migration, real Telegram delivery, actual health-data mutation or credential access/change is authorized or performed. Existing schema definitions are exercised only in synthetic test fixtures.

Independent repair acceptance remains PENDING. Whole Stage 8 Final Review and Production remain NO-GO. Read the unchanged `stage8-stage6-reconciliation.md` and `stage8-live-producer-contract.md`: retain the latest independently verified Stage 6 successor and its authority/budget guards for a separate semantic integration candidate; final successor/capacity qualification remains outstanding. Authenticated LIVE producer allocation and selector/admission/typed-reader integration remain separate work. No SHADOW result, wired reader or completion marker is positive LIVE evidence.
