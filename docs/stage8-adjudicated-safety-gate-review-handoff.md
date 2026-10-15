# Stage 8 adjudicated safety-gate repair — NO-GO handoff

This is one bounded repair on the retained Conservative Safety Gate. The previous candidate b69a9d64785a38de220da4ca36f48aa4180b4820 / tree 63eef422008d88a00be309d5365b6b2f65adf57a remains frozen. The successor is in `/Users/kelvin/.codex/worktrees/stage8-gate-adjudicated-repair/whoop-briefing`, branch `codex/stage8-gate-adjudicated-repair-20261015`. Its exact final HEAD/tree is in the owner report and `/private/tmp/stage8-adjudicated-safety-gate-candidate-freeze.json`, written after committing this evidence. No independent acceptance of this successor has been claimed.

## Bounded stop verdict

**Repair code: NO-GO. Independent delta-review acceptance readiness: NO-GO. Whole Stage 8: NO-GO. Production: NO-GO.** The requested exact examples and frozen corpus pass, but a final fresh adversarial check exposed the same High ownership family in unrecognized quote-complement wording. Runtime edits stopped; no further grammar expansion was attempted. This commit is a failure-preserving candidate, not an approval candidate.

CG-H01 remains **OPEN**. CG-M01, CG-M02 and CG-L01 are **CLOSED on the measured frozen and new corpora**. The remaining High failures are:

| Input | Required | Actual |
| --- | --- | --- |
| `"chest pressure" is exactly what I am experiencing right now.` | CURRENT | CLEAR |
| `「胸痛」正是我現在感到的症狀。` | CURRENT | CLEAR |
| `"đau ngực" chính là triệu chứng tôi đang cảm thấy.` | CURRENT | CLEAR |
| `"chest pressure" might be what I am feeling right now.` | POSSIBLE | CLEAR |

`quoteComplement` rejects the unrecognized connecting prefix and returns no relationship. The quoted P1/S1 retains QUOTED/Mentioned; the outside SELF P2 owns current or uncertain evidence but no symptom. `reduceSafetyEvidence` then grants S1 a `QUOTED_MENTION` exclusion certificate without retaining the unresolved outside relationship. Missing relationship proof still becomes false proof of absence. These four inputs already failed on b69a9d6; this is an unresolved High family, not a newly introduced baseline regression. Full paired graphs are in `residual-before-after.json.gz`.

All sixteen real shared-processor combinations (four inputs × Settings name, Journal NOTE, Coach, health) fail their safety expectations. Four pending-name captures and four Journal-note captures occur; all sixteen enter ordinary consumers/identity capture. No committed profile changes, peer changes, replay errors or scoped health reads were observed in this residual matrix. Health/Coach paths return the existing medical-information response instead of the ingress safety response; do not misreport ordinary WHOOP metric exposure. These failures and expected outcomes remain permanent tests. No expectation was weakened or deleted.

## Authority and scope

The owner approved the four independently adjudicated defects and twenty invalid standalone-quotation expectations. `stage8-adjudicated-repair-evidence/independent-review-reference.json` pins the independent report SHA-256. Original report, text, manifests and reviewer harness sources are retained compressed without modification. Verbose paired traces and per-definition records use lossless .json.gz files to keep the review diff readable; decompress with gzip or Python. A mutable helper file contains 88 inputs, whereas the report's embedded direct results contain 86; this repair pins the latter 86 and all 50 processor inputs from the report itself. The preliminary helper run and canonical 86-case reproduction are separately retained; no missing probes are claimed to have run.

Only `src/bot/triage.js` changes at runtime. `src/bot/safetyGate.js` remains byte-identical, as do 305 other runtime/config/dependency paths. Existing v33/v34, Morning Retry, Provider, Owner Monitoring, Settings, Coach, Journal, transport/lifecycle/privacy and authenticated LIVE producer contracts are unchanged. The reviewed Stage 7 828b3ba foundation remains an ancestor. The successor directory and Stage 6 directory have different inodes; no Stage 6 worktree or receipt was modified. Integrity records preserve all 92 prior evidence files byte-for-byte.

## Application repairs and ownership

- **CG-H01 — quotation references (partial repair; family OPEN):** `QUOTE_ARGUMENT` binds an adjacent personal assertion or personal uncertainty to its quoted symptom object. A bounded `QUOTE_COMPLEMENT` binds a following actual/epistemic personal predicate to the quoted object, with an inspectable supporting span and `referenceSymptomId`. Original quoted evidence remains immutable; derived symptoms belong to the outside predicate and use its actor, polarity and time. An unbound quotation supplies no authenticated SELF or currentness. Within an admitted quote relationship, unknown operands retain POSSIBLE. Unrecognized connecting prefixes remain unsafe, as documented in the bounded stop above.
- **CG-M01 — Vietnamese completion:** only contiguous `hết hẳn` / `khỏi hẳn` forms extend the registered resolution operand. NFC/NFD normalize under the existing ingress contract. Actor, target, time and clause ownership remain local. Intervening arbitrary words are not consumed or exempted; independent current symptoms and negated completion retain safety precedence.
- **CG-M02 — educational quote objects:** reading-about predicates have local educational evidence in en/zh-TW/vi. Reporting a generic educational topic does not manufacture the reporter as its clinical actor. Existing personal-evidence evaluation remains responsible for explicit current personal assertions inside genuine reported questions. Hypothetical and informational framing stay local; a reading marker cannot suppress another current predicate.
- **CG-L01 — metric suffixes:** following question heads and registered metric operands receive a separate predicate before evaluation. A bare symptom cannot acquire an actor/head from an unrelated metric question. The frozen English suffixes, “How is my HRV”, native Chinese/Vietnamese forms and mixed inputs retain POSSIBLE. Existing independent symptom assertions retain CURRENT.

The three owner-required examples are explicitly asserted as CURRENT, CURRENT and POSSIBLE respectively in the new direct and actual-processor tests. No generic NLP engine, database, new dependency, external model or new ingress layer is introduced. Existing 8192-character, 128-predicate/symptom, 256-operator, 512-link and quote-depth bounds remain; overflow remains cautious. The small `assessUrgency` adapter does not expose or persist the ownership graph.

`analysis.json`, the 86-case and new-case before/after trace files record predicates, actors, operator owners, temporal/currentness states, links, certificates and decisions. The full frozen direct corpus and ownership tests pass in the semantic preflight. The final fresh eleven-case set has seven PASS and four High false clears, and its sixteen processor reproductions all FAIL. Final counts and the bounded stop disposition are recorded in results.json; the preflight is not an acceptance verdict.

## Before/after ownership samples

| Frozen input | Before | After |
| --- | --- | --- |
| `"chest pressure" is what I am experiencing right now.` | CLEAR; quoted P1/S1 had no link to SELF P2 | CURRENT; P1 → P2 QUOTE_COMPLEMENT; P2 owns derived S2, SELF and O1–O6, including experiencing/right now |
| `「胸痛」是我現在感到的症狀。` | CLEAR; quoted P1/S1 disconnected from SELF P2 | CURRENT; P1 → P2 QUOTE_COMPLEMENT; P2 owns S2, SELF and O1–O4, including 現在/感到 |
| `我不確定我是否「胸悶」。` | CLEAR; quoted P2/S1 had no personal reporter link | POSSIBLE; P1 → P2 QUOTE_ARGUMENT; SELF and epistemic scope are proven, currentness/polarity remain UNKNOWN; O1–O4 stay owned by P1 |
| `Tôi đã hết hẳn đau ngực.` | POSSIBLE; unowned modifier prevented exclusion certificate | CLEAR; one local resolution operator owns the contiguous compound and compatible symptom target |
| `I am reading about "chest pain".` and native equivalents | CURRENT; generic present wrapper supplied clinical actor | CLEAR; local educational evidence supplies no personal clinical assertion |
| `chest pain What is my HRV today?` | CURRENT; metric question supplied symptom actor/head | POSSIBLE; question predicate owns its actor/head and no symptom |

The three quote ownership traces above are exact author observations from the final runtime. Original nodes, evidence spans and operator ownership remain in the paired JSON traces; the table abbreviates them. A standalone quote remains CLEAR under the independently adjudicated contract. Actual reported clinical questions and independent current assertions retain CURRENT.

## Test correction versus application repair

Exactly twenty baseline expectation values change: the four standalone informational quote inputs and sixteen listed transformations become CLEARLY_NONURGENT. `invalid-expectation-adjudication.json` records every original/corrected record, the independent reference and owner authority. The complete original cases, raw failed assertions, old TAP, before traces and original expectations remain in the unchanged baseline evidence. These are corrected-test PASS outcomes, not application-defect closures or proof of clinical wellness. No other frozen expected classification or case text changes.

The seven legitimate original failures (five Vietnamese checks and two metric-suffix checks) must pass by runtime repair. The 2,151 previously passing definitions are an identifiable subset of the full 2,178 definitions; both sets are verified separately. The fifteen older stopped-prototype closures remain separately mapped, including the headache barrier inspection contract.

One new author harness initially assumed a 70-grapheme nonurgent reported topic could be accepted as a Settings name. Its failure, exact source and raw output are retained. The unchanged 64-grapheme/256-byte Settings contract correctly rejects that input. The new supporting test checks that rejection, preserved session/profile, and successful/replayed valid-name continuation; its triage expectation remains CLEAR throughout. This changes no frozen application expectation. New NFC/NFD continuation checks compare names/notes with the existing canonical normalization functions. Original reviewer diagnostic mistakes and harness sources remain available and are not silently relabeled as application repairs.

## Verification and real shared ingress

All final commands, Node exit codes, distinct counts, failures, hashes and diagnostic reruns are in `stage8-adjudicated-repair-evidence/results.json`. Final runtime SHA-256 is pinned in runtime-freeze.json. The complete documented 2,178 corpus is run, including the adjudicated twenty and all seven legitimate original failures. The new semantic suite includes the reviewed 86, 49 new cases, 81 transformations and five ownership/adapter tests. Extra native-query and reported-question contrasts preserve their failed development evidence. Partial verification under superseded source was intentionally terminated with SIGTERM and retained as diagnostics; it is excluded from final counts and distinguished from native SIGSEGV.

The exact final totals are **2,560 distinct definitions: 2,540 PASS / 20 FAIL / 0 skipped / 0 cancelled**. No final-run native process failure was observed; this does not resolve the open historical SIGSEGV. Distinct suite accounting:

| Suite | PASS | FAIL |
| --- | ---: | ---: |
| Original full corpus, with only 20 adjudicated expectation corrections | 2,178 | 0 |
| New semantic/ownership suite (86 reviewed + 49 new + 81 transformations + 5 structural) | 221 | 0 |
| New actual processor matrix (50 reviewed + 84 new) | 134 | 0 |
| Final fresh adversarial semantic cases | 7 | 4 |
| Real processor reproductions of the four residual High inputs | 0 | 16 |

The original 2,151 previously passing definitions are verified by title and occurrence: 2,151 PASS / 0 FAIL. Original failing definitions: **20 corrected-test PASS**, separately **7 application-repair PASS**. Five Vietnamese and two suffix failures pass. The original documented 956 pass 956/956; all fifteen older stopped-prototype counterexamples pass. These subsets overlap the 2,178 total and are not counted twice. `original-2151-and-27-disposition.json.gz` and results.json retain exact per-definition/run matches.

The new processor matrix reproduces all 50 report inputs and adds 84 owner/contrast jobs across name, Journal NOTE, Coach and health lanes in en/zh-TW/vi/mixed text. The original 224 processor jobs and expectations also remain intact. Matrices are partitioned by original job index modulo three into isolated Node processes; aggregation must prove complete, disjoint coverage. Real `createUpdateProcessor`, Stage 7 runtime, Settings and source-router code use local synthetic databases. Every fetch is forbidden, and delivery is synthetic.

Passing matrices contain 228 safety rows and 130 nonurgent controls, with zero safety persistence/read/consumer violations. The additional residual sixteen fail, as detailed above. Safety assertions check unchanged name/note/identity/profile state, no ordinary consumers/captures, zero scoped health reads, peer isolation, one delivery and replay. Nonurgent cases check legitimate Settings/Journal/Coach processing, canonical NFC, and the unchanged validation limits. Existing authority, privacy, lifecycle, stale callbacks, concurrency and transport suites remain part of the full verification. No authorized transport receipt is misrepresented as an unauthorized health-state write.

The 200-case integration suite includes unchanged Provider/Morning, Owner, migration and recovery contracts. Fixture migration verifies v33 before v34, interruption/restart, admission/key rejection and legacy preservation only in synthetic databases. The clean pinned read-only 2340e8b Stage 6 fixture is still required for the preservation tests; its compatibility is not a final Stage 6 reconciliation or capacity receipt.

## False positives, performance and stability

The reviewed 86 input rows contain 57 positive and 29 negative expectations; the 49 new cases contain 32/17 and their 81 transformations contain 50/31. Those initial groups have zero false clears, false warnings or precision mismatches. The eleven final fresh probes add seven positive/four negative rows, with four false negatives and zero false positives. Across the 227 direct corpus rows this is 4/146 positive false negatives (2.74%) and 0/81 negative false positives. These are synthetic corpus-row rates with related transformations, not population estimates. `final-analysis.json` includes the residuals; the earlier analysis.json is deliberately retained as pre-adversarial evidence. Four previously accepted benign working/busy continuations remain POSSIBLE warnings, reported separately; they are not claimed as confirmed-current emergencies or hidden as zero clinical false positives.

`benchmark-baseline.json`, `benchmark-candidate.json` and benchmark.mjs retain 100 warmups plus 500 timed parses per shape with GC measurements. Ordinary p95 is about 0.326 ms versus 0.509 ms; quoted p95 about 0.476 ms versus 0.542 ms. The in-bound 80-predicate workload p95 is about 9.361 ms versus 5.763 ms. Ordinary retained heap delta across 500 parses is 89,496 bytes versus 83,824; quoted retained delta is 115,200 versus 13,368. Full transient/RSS and overflow decisions are preserved. Runs overlap local tests, so differences include host noise and are not SLO or memory-leak guarantees. No external inference, provider call or persistent allocation participates in classification.

`STAGE8_NATIVE_BASELINE_SIGSEGV` remains B_EXISTING_BASELINE_DEFECT / OPEN / root cause UNASSIGNED. The prior recorded index.node UUID, six offsets and N-API cleanup signature remain retained. Final run observations, including any process failure or passing rerun, are reported separately in results.json. A passing run does not resolve this stability issue, and no native code/dependency was changed.

## Exact independent reviewer action and remaining boundaries

Pin the successor HEAD/tree from the owner report and create a fresh detached review worktree there. Compare b69a9d6..HEAD, verify only triage.js changes at runtime, check the twenty-ID expectation manifest, source hashes and unchanged evidence. Supply the same Node v22.23.2 dependencies and read-only pinned Stage 6 fixture. Create `/private/tmp/stage8-adjudicated-repair` before running; for concurrent review adapt only output destinations to a separate private directory, preserving all inputs and assertions.

First run `node --test --test-concurrency=2 test/stage8-adjudicated-repair/final-adversarial.test.mjs test/stage8-adjudicated-repair/residual-processor.test.mjs`: expected author result 27 definitions, 7 PASS / 20 FAIL, exit 1. Validate the four false-clear graphs and eight pending-name/note captures before considering any acceptance review. Then run the five Vietnamese and two precision repairs, the three owner-required quotation examples, reading controls and all fifteen older closures. Execute every final command in results.json, including all three legacy and new processor partitions. Challenge local quote/report/education ownership, negated and historical quote complements, separate actors, ephemeral uncertainty, arbitrary Vietnamese intervening text and native metric suffixes. Inspect the ownership traces and actual state/read/replay guards, not just urgent response text. This SHA is ready for independent failure validation only; it is not ready for acceptance delta review. Confirm the bounded stop and decide a separately authorized treatment of unresolved quote relationships without restarting broad lexical expansion. Architecture retention and author verification are not Final Review PASS.

Whole Stage 8 and Production remain **NO-GO**. Stage 6 owner-frozen reconciliation/capacity/authority/raw DOMAIN and receipt requirements, authenticated LIVE analysis producers and final semantic integration/stability qualification remain outstanding. SHADOW/metadata/reader wiring is not LIVE production evidence. Existing Coach/Journal controls are locally implemented and tested, but retained historical Production observations are not fresh deployed acceptance. No Stage 1–5 work was reopened. No Production mutation, push, merge, real migration, real Telegram delivery, paid execution, credential access/change or Turso Token modification occurred. F02 remains Owner Accepted Risk.
