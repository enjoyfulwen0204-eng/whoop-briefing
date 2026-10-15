# Stage 8 two inherited false-warning repairs — independent delta-review handoff

Baseline: `d538b07e097fedb42481c305de0738761c512a4d` / tree `75122d94febecfcd86129949863ed3b3b8c84849`. Branch: `codex/stage8-two-false-warning-repair-20261015`. Frozen runtime source commit: `52934e90bfacc987f4af52eda2af1a43475e9e41`. The exact final documentation/evidence HEAD and tree are in the owner report and `/private/tmp/stage8-two-false-warning-repair-candidate-freeze.json`, written after this handoff is committed.

**Independent delta-review readiness GO, with the native verification exception below. Independent acceptance has not been performed. Whole Stage 8 NO-GO. Production NO-GO.** F02 remains Owner Accepted Risk.

## Scoped runtime change

Only `src/bot/triage.js` changes at runtime. Safety gate SHA-256 remains `c62661d6798d255a00fa4329afb35110f510b0fb44682e81a52e0fe6ecddf42d`. New triage SHA-256: `7ec262425ce9b17bdab84f5fbd3c0d43e5546c703ff2e93a1b1e03c6d77fb78d`. The grammar version is `predicate-ownership-v1-owned-intent-negation`; the three-state contract, graph schema, ingress, symptom vocabulary and parsing bounds are preserved. No LLM/API or package dependency is added.

The compound negative operator `還沒有` owns its modifier and the following negation together. Its lexer permits intervening non-CR/LF whitespace and cannot cross registered clause punctuation. The complete operator span participates in existing argument proof and negative ownership. Standalone/unaccounted modifiers and unrelated arguments do not gain an exclusion certificate. Positive operators contained inside the negative are retained as immutable lexical evidence; the unchanged safety gate still prevents their affirmative promotion.

`想了解` is a registered education operator. Its personal-inquiry topic eligibility requires a general-topic marker owned by the same predicate after that intent and no owned current/experience/assertion operator. Intent alone cannot exclude a plausible personal symptom. Existing other educational operators keep their behavior. A new personal assertion after the intent owns its own predicate; no message-wide educational veto is introduced.

No Morning Retry, Provider, Owner Monitoring, identity, Settings, Journal, Coach, Stage 6, LIVE producer, schema/migration or accepted authority code changes. All existing tests and expectations are byte-identical to the baseline. Historical evidence, including the prior Low digest-metadata discrepancy, is retained; new evidence uses freshly computed hashes.

## Reproduced causes and ownership

Before runtime edits, both exact originals failed in all four real shared-processor lanes: Settings name, Journal optional note, Coach and ordinary health. Baseline raw processor evidence is **0 PASS / 8 FAIL**. All failures are retained. Frozen direct cases/expectations predate the runtime edit.

| Original / counterexample | Before | After | Owned proof |
|---|---|---|---|
| `「呼吸困難」是我現在還沒有感到的症狀。` | POSSIBLE | CLEAR | P2/SELF owned only `沒有` at [11,13), leaving `還` uncovered and its quote complement epistemic. Now P2 owns `還沒有` at [10,13); complement proof is OWNED_ARGUMENT, polarity NEGATED, and the gate issues OWNED_NEGATION through the existing P1→P2 QUOTE_COMPLEMENT link. |
| `我想了解胸痛的一般原因。` | CURRENT | CLEAR | P1 previously defaulted SELF to a current clinical assertion despite its later `一般`. P1 now owns `想了解` [1,4) and `一般` [7,9); assertion TOPIC, frame EDUCATIONAL, no clinical current assertion. |
| `我想了解為什麼我現在胸痛。` | CURRENT | CURRENT | The intent is in P1; P2/SELF owns `現在` and chest pain. The educational operator cannot exclude P2. |
| `我想了解現在胸痛的一般原因。` | CURRENT | CURRENT | Owned current-time evidence prevents the new intent from excluding a plausible current personal symptom. |
| Negated clause followed by an independent current SELF/OTHER symptom | CURRENT | CURRENT | Independent predicate retains its actor, currentness and positive assertion. |
| Quoted symptom followed by an unrelated `頭痛` argument | POSSIBLE | POSSIBLE | Unproven quote-argument ownership remains cautious; the compound negative does not clear an unrelated symptom reference. |

Full before/after predicate, actor, operator spans, references and decisions are archived in `before-traces.json.gz`, `after-traces.json.gz` and `selected-before-after.json.gz`.

## Functional verification and mandatory process qualification

**All 3,275 preserved functional test definitions have passing observations. There was no single clean 27-command run. Do not label either failed full regression process PASS.**

- Initial 27 documented commands: 26 successful processes; the regression process failed. Its 164 declared definitions produced 162 passing assertions, one release-identity-related assertion failure, one unobserved local-server assertion and one extra native process-failure row.
- The local source-freeze commit overlapped a legacy SYNC test phase: phase start 08:30:33.108Z, commit 08:30:33Z, completion 08:30:34.231Z. `originalAuthority.assert` checks real HEAD. The first phase carried the old release identity. The failed assertion is retained as a local verification HEAD-transition artifact; no Morning or release-authority code/expectation was changed.
- Unchanged regression rerun at fixed HEAD: both runtime-on/off Morning continuity assertions pass. Native SIGSEGV recurred in `telegram-webhook.test.js`; 160 assertions passed, four were unobserved, plus one native process-failure row.
- Across the two retained full attempts, 163/164 regression assertions had passed. The only remaining local-server assertion was run once with `--test-name-pattern='真的起一個 server'`: **1 PASS / 0 FAIL / 0 skipped**, process exit 0. All 164 now have explicit passing witnesses. No further native retries were performed.
- `preserved-3275-disposition.json.gz` and `regression-164-witnesses.json.gz` match every original definition by run/title/occurrence and identify its evidence. Raw failed attempts remain archived alongside passing witnesses.

Other mandatory results include integration **200/200**, polling/transport **16/16**, safety **576/576**, scoped **348/348**, and quotation ownership **298/298**. Provider and migration coverage remains included. All **62 previous closures** reproduce: 21 inner-conditional boundary, 27 outer conditional, nine Chinese negative containment, five ambiguous OTHER reports. The five previously adjudicated expectation corrections are preserved unchanged.

New focused checks: **275 PASS / 0 FAIL**: 37 base statements + 111 normalization/quotation/padding transformations + 56 recovered prior direct probes = 204 semantic definitions; seven structural definitions; 64 real processor definitions. Counts are test definitions, not claims of 275 different natural-language statements. The base matrix is in `base-language-matrix.json`. No test expectation was weakened.

The recovered previous 56-case real-ingress matrix is **56/56 PASS**, including the eight prior failures. Six additional signed Coach continuation checks pass: both repaired inputs under all three user locales, followed by authenticated topic/range selection, same-card identity, persisted choice, one delivery per update, replay prevention, no lifestyle-fact creation and peer preservation. These diagnostics are reported separately from the 275 focused definitions.

## Actual ingress and authority evidence

The tests compose the real `createUpdateProcessor`, Stage 7/8 runtimes, Settings, router, signed reply guards and isolated v34 SQLite fixtures. Network/provider delivery is synthetic; real network fetch is forbidden. Existing 538 processor rows pass, including **328 safety rows** with zero ordinary scope reads, consumers or identity capture and no unauthorized name/note/profile/peer changes. New 64 processor rows include 36 safety and 28 CLEAR rows, all passing. CLEAR name and note continuations use canonical normalization; the 64-grapheme/256-byte Settings limit is unchanged.

Both original inputs are valid names under that limit (19 graphemes/57 bytes and 12/36), so their restored normal handling is not an altered name-length policy. Current/POSSIBLE messages retain localized conditional safety guidance before name/note capture or ordinary health handling. Authentication, lifecycle, tenant, signed receipt and replay protections are covered by the preserved suites and unchanged source.

## Performance and native stability

Interleaved AB/BA paired measurements use the exact d538 baseline and frozen candidate source, 200 warmups/version and 1,000 timed pairs/shape under concurrent local tests. Focused p95: 1.134→0.951 ms; original negative: 0.463→0.421; educational original: 0.174→0.195; near-limit: 21.826→20.334. These are noisy host measurements, not a production capacity qualification or claimed speedup. No configured execution-limit violation was observed. Bounds remain 8,192 UTF-16 characters, 128 clauses/predicates/mentions, 256 operators, 512 links and depth 16; overflow remains POSSIBLE.

After eight 1,000-parse batches with explicit GC, retained candidate heap delta was 71,296 bytes, peak sampled delta 77,408; no obvious unbounded growth was observed. This is not a leak-freedom proof. No persistent classifier cache or external dependency is introduced.

**STAGE8_NATIVE_BASELINE_SIGSEGV remains OPEN, root cause UNASSIGNED, classification B_EXISTING_BASELINE_DEFECT.** Both observed crashes match native image UUID `15297104-5a23-3847-9a99-938dd2f1ac9e` and offsets `[4618472,2513860,2740588,506516,380320,470324]`. The historical report was located in DiagnosticReports/Retired with its original SHA-256, corroborating the frozen baseline fingerprint. Fingerprints are archived without copying the full host crash report. Passing assertions and the isolated local-server pass do not resolve the native issue. No native library or cleanup refactor was attempted; eventual integrated release still needs separate stability qualification.

## Exact independent reviewer action

1. Create a fresh detached checkout at the final HEAD/tree in the owner freeze receipt. Verify ancestry from d538 and source hashes above. Confirm triage.js is the only runtime delta; safetyGate.js, accepted feature code, v33/v34 schemas/migrations and all prior expectations/evidence remain unchanged.
2. Read this handoff and `stage8-two-false-warning-repair-evidence/results.json`. Retain the failed native/HEAD-transition attempts as evidence. Inspect the two original ownership traces and all 62 retained closures.
3. Supply existing local dependencies and the same read-only v32 preservation fixture. Run the four new commands in `commands.json` (211 + 22 + 21 + 21) and all 27 original commands. Keep HEAD fixed for the entire verification period; commit documentation only after tests finish. Record assertions separately from any extra native process rows, and never count skipped/missing cases as passing.
4. Verify actual name/note continuation, current/uncertain safety fencing and all three locales. The published raw diagnostic scripts use absolute implementation paths; in a private review copy, redirect only root/resource/output paths to the fresh checkout. Inputs, expectations and assertions must remain unchanged. Their executed originals and hashes are retained. The recovered processor uses the committed `independent48.json`; signed Coach continuation uses the real runtime and only synthetic transport.
5. Add bounded probes around the two changed lexical/ownership boundaries. Unknown arguments must remain cautious; independent current assertions must remain safety-first. Do not broaden this delta into a general NLP rewrite or modify accepted features.
6. Issue an independent verdict for the final frozen candidate. The implementer claims readiness, not independent acceptance or whole Stage 8 completion.

## Separate release dependencies and restrictions

Stage 6 owner-frozen successor reconciliation/capacity review, authenticated LIVE producers, native stability qualification and final integrated review remain outstanding. Preserve the latest Stage 6 successor and its 45,000/15,000 ms authority/budget guards; do not import the old partial caf08fc successor. SHADOW artifacts and a wired reader do not prove functional LIVE analysis. No Stage 6 or LIVE source was modified here.

No Production access/change, push, merge, deployment, real Telegram delivery, paid external execution, credential access/change or schema/migration code change occurred. Only synthetic fixture schemas/data were exercised. F02 remains Owner Accepted Risk. Whole Stage 8 and Production remain NO-GO.
