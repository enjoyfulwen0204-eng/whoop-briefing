# Stage 8 final evidence ownership repair — stopped NO-GO prototype

Independent review readiness: NO-GO. Whole Stage 8: NO-GO. Production: NO-GO. This is a locally frozen diagnostic prototype, not an accepted repair or release candidate. Runtime edits stopped after one focused repair cycle exposed a new High current-continuation regression. Do not push, merge, deploy or promote this prototype. F02 remains Owner Accepted Risk.

## Exact source and intended scope

Baseline HEAD 9dc287fc5d916409002caafe5b845012da476032, tree 3b409ceaec663fa3c7b0ea39a4b418c5542d3acb. Branch codex/stage8-final-evidence-ownership-repair-20261014. Runtime source commit bf4da07ec85e6e1276b2cf5b49b019b216738f96. Runtime SHA-256 563015e819e237b3d3f88d32c3a0a4e373c56779760639c8f55cc38a21c11023. The final documentation HEAD/tree is given in the owner report; its runtime source is identical to this commit.

Only src/bot/triage.js changed at runtime. All 300 other runtime files, dependencies, configuration, Settings runtime, Morning Retry, Owner Monitoring, Provider, Journal/Coach, schema/migrations, Stage 6 and LIVE producer implementation are byte-identical to the baseline. Stage 7 828b3ba remains an ancestor. No real data or Production migration was performed. Tests use synthetic local databases, fake Telegram sends and no external model/API.

The exact independent evidence at /private/tmp/stage8-scoped-repair-independent-review.json was recovered in full. Its SHA-256 is 49918d38111c073b2099e8bd4ce17c2dc2c8b1acf2fb8d974fcc8ee114626e46. The original report, Settings failure and baseline traces are retained in stage8-final-evidence/. No counterexample was reconstructed or semantic expectation changed.

Frozen-before-runtime commits: 72a2225 (six mandatory ownership cases, all 40 independent cases and original failure evidence); a6eeccf (149 additional metamorphic expectations and the separately authorized invalid Settings assertion correction). The runtime freeze follows both.

## Implemented ownership rules

Resolution no longer authorizes a reference merely because the urgent vocabulary finds no symptom in that predicate. Unknown/unmatched arguments are barriers. Fully accounted deictic/elliptical outcome predicates retain strict actor, temporal and lineage checks. Definite or zero-copula matching symptom references can borrow a proven adjacent actor/symptom identity in ACTUAL scope, retain a referenceSymptomId, and retire only the compatible lineage. Unproven actors, competing subjects, hypothetical/educational/quoted frames and historical outcomes cannot silently close valid positive evidence.

Comma/Chinese enumeration edges support same-owner object possessors, including Vietnamese cua/toi possession and reported-speech identity. A new finite predicate is separated from a governed object list; plural shared-subject outcomes retain the established list semantics. Negation is never extended across a distinct actor/current predicate.

Duration proof distinguishes open perfect/present-endpoint intervals from completed simple past and causal/unproven since. Existing have-had semantics and recurrence remain. Degree/temporal operand tokens and atomic deictic references stay bounded in the lexer. The Vietnamese education lexer now enforces word boundaries so hoi cannot match inside khoi; this fixed one development failure without changing its frozen expectation.

## Results and stop condition

All six exact mandatory traces and all 40 independent counterexamples now pass. The six include the ongoing-perfect control. All 149 new metamorphic checks pass (195 total new semantic tests). The 25 copied real shared-processor checks pass, including three-locale validation, canonical profile isolation, valid name preview/save and replay. The formerly failing 67-grapheme name assertion now correctly rejects under the unchanged 64-grapheme/256-byte contract, leaves canonical name/revision and session unchanged, then accepts a valid name. Its original failed evidence is retained.

Preserved and scoped gates do not all pass:

- Existing 956: 954 PASS / 2 FAIL. Safety 574/576; integration 200/200; regression 164/164; polling/transport 16/16.
- Previous 349 scoped checks: 348 PASS / 1 FAIL. Semantic 139/139, processor 69/69, metamorphic 100/100, localized processor 33/33 and continuation 1/1 pass. Frozen ownership contracts 6/7; PO-H01's NON_SYMPTOM_BARRIER relationship fails.
- New semantic 195/195 and reproduced shared-processor 25/25 pass.
- Intentionally preserved stop-regression processor checks: 0 PASS / 12 FAIL.
- Distinct final definitions: 1537 tests, 1522 PASS / 15 FAIL, zero skips/cancellations. The diagnostic 904-case direct run and the first 195-case development run are retained but not counted again.

High regression: My chest pain started yesterday and is still present. The baseline returns CURRENT_URGENT; this source returns CLEARLY_NONURGENT. The same failure occurs with is still severe and the equivalent past-onset continuation. argumentProof's exclusion-level whole-argument requirement rejects unrecognized descriptive complements of an inherited positive/current predicate. P1 retains only historical chest pain; P2 has is/still and SELF inheritance but no serious-symptom candidate. The actual processor stores the text as pendingName and a Journal note; Coach/health handlers run. Twelve real processor checks preserve these failures across three messages and four lanes. This is a systematic inclusion/exclusion proof asymmetry, not an invalid Settings expectation.

Graph regression: I have chest pain. I had a headache yesterday. It has resolved. remains CURRENT_URGENT, but P3 no longer exposes the frozen referenceId to non-symptom barrier P2. Do not change that established structural expectation merely to obtain PASS.

Family acceptance: A OPEN because the established barrier relationship is not preserved, although the originally unsafe resolved-headache cases are corrected. B CLOSED on the frozen/reproduced matrix. C OPEN because accepted historical-to-current continuation regressed, although the reported historical-duration/causal examples and ongoing-perfect control pass. D CLOSED on the frozen/reproduced matrix. No independent acceptance is claimed for B/D.

## Reviewer/owner next action

Read [the conservative safety-gate alternative](stage8-final-evidence-safety-gate-alternative.md). It is design only, not implemented. Review a bounded POSSIBLE_CURRENT_URGENT fallback for a plausible inherited current serious-symptom lineage, with stricter proof only for exclusion. Preserve the non-symptom barrier graph without authorizing a serious-symptom clone/retirement. Approve the admission conditions and false-positive trade-off before another scoped runtime cycle. Do not keep adding descriptive keyword patches or automatically start a general NLP redesign.

Read stage8-final-evidence/results.json, integrity.json, before-traces.json, after-traces.json, stop-before-after.json, processor observations and compressed TAP files. Compare runtime only against 9dc287f; independently reproduce the High stop cases first. The failure tests remain active. Confirm no name/note persistence or ordinary scope access after a future approved correction, then rerun all frozen suites on a new exact SHA/tree.

STAGE8_NATIVE_BASELINE_SIGSEGV remains B — existing baseline defect, OPEN, root cause unassigned. No native failure occurred in these final executions. Passing runs do not resolve the retained finalizer issue. Stage 6 final-successor/capacity/reconciliation, authenticated LIVE producer allocation and integrated stability qualification remain separate dependencies. Preserve the latest verified Stage 6 successor and its budget/authority guards; do not import the old partial successor. SHADOW is never LIVE.
