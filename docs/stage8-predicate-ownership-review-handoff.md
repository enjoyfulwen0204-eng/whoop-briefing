# Stage 8 Predicate Ownership Delta Review

Predicate ownership implementation is GO and independent repair review readiness is GO. Independent implementation acceptance is pending. Whole Stage 8 and Production remain NO-GO because Stage 6 reconciliation, authenticated LIVE producer integration and the existing native stability gate remain outstanding.

## Frozen foundation and scope

The parent is dbb89360315a1cf6f1d9291b5310a24204c2e7b1, tree ec86b6a6caeb70c47b98c1c510abe29702868c80. The independent design review supplied GO for the constrained ownership contract, with implementation NO-GO at that parent. Its JSON SHA-256 is 6e3115f13a7094d304623d6efaffeb12c14f1acf80c742c19a71cbd29cf5f4a6. Reviewed Stage 7 candidate 828b3bad0f75d3b81d374e431872878af56f6c9a is an ancestor.

Branch: codex/stage8-predicate-ownership-20261014. Checkout: /Users/kelvin/.codex/worktrees/stage8-predicate-ownership/whoop-briefing. Before writes, its device/inode was 16777229:74357255; Stage 6's separate directory was 16777229:71452797. No Stage 6 source or working tree was modified or imported. Stage 6 advanced independently during this task; its latest observed HEAD is evidence of the other session's activity, not an accepted integration receipt.

Only src/bot/triage.js changes at runtime. The registered symptom vocabulary, three-state assessUrgency adapter, actual shared processor, Morning Retry, Owner Monitoring, Settings, Coach, Journal, Provider, v33/v34 definitions, dependencies and deployment configuration are preserved. Original tests and the 94-case corpus retain their expectations. The final commit identity is recorded in the accompanying candidate freeze JSON and owner report; use that exact SHA and tree for review.

## Ownership implementation

The parser constructs subject/head boundaries before evaluation, including repeated SELF, distinct OTHER actors, supported Chinese/Vietnamese symptom heads and non-symptom predicates. Object possessors remain inside their governing predicate. Only a proven list shares its predicate; unsupported relationships cannot inherit exclusions. Operators have one ownerPredicateId, and evaluation selects events solely by that id. Unknown modifiers cannot end negation.

Predicate records contain identity, headSpan, ownedSpan, actor, assertion, local frame, symptomIds and operatorIds. Symptom/operator records carry spans and one predicate owner. Bounded SUBJECT_INHERIT, REFERENCE, REPORT, FRAME and OUTCOME links carry supporting spans. Outcomes derive active states while preserving immutable original evidence, and can retire only matching same-actor, same-symptom assertions at a current outcome. Historical outcomes never cancel another current predicate.

Reported first-person language binds to its actual reporter. A standalone textual quote does not bind SELF. External current references create separate predicates without importing topic/history operators. Conditional and epistemic frames remain distinct and local. Unsupported nested speaker ownership returns POSSIBLE_CURRENT_URGENT with quotation_scope; malformed serious quotations and overflow also take the safety path. This finite grammar deliberately leaves unsupported relationships uncertain.

Bounds: 8,192 UTF-16 characters, 128 clauses, 128 symptoms, 128 predicates, 256 operators, 512 links and depth 16. Grammar and vocabulary are pinned by predicate-ownership-v1 and the frozen source/tree. Parsing has no database, network, provider or model dependency. Traces are in-memory inspection data, retained here only for synthetic fixtures; assessUrgency discards them before ingress.

## Mandatory traces

All three originally failing statements now decide CURRENT_URGENT. Full spans, operator IDs and owners are in [acceptance-traces.json](stage8-predicate-ownership-evidence/acceptance-traces.json).

| Example | P1 | P2 | Target |
| --- | --- | --- | --- |
| I had chest pain yesterday whereas my friend has difficulty breathing. | SELF; head had; chest; owns pastPredicate had and pastTime yesterday | my friend; head has; breathing; owns present/ongoing has; no past operator | OTHER |
| I had chest pain yesterday whereas I have difficulty breathing. | SELF; head had; chest; owns had and yesterday | separate SELF; head have; breathing; owns present/ongoing have; no past operator | SELF |
| 我昨天胸痛然而我呼吸困難。 | SELF; predicative head 胸痛; owns 昨天 | separate SELF; predicative head 呼吸困難; no past operator | SELF |

The fourth frozen statement gives P1(SELF, was, no symptom, owns fine/yesterday) and P2(SELF, have, chest pain), also CURRENT_URGENT. Frozen expected ownership preceded runtime edits in test/stage8-predicate-ownership/contract.json.

## Verification

| Distinct selection | PASS | FAIL |
| --- | ---: | ---: |
| Preserved documented tests | 560 | 0 |
| Full permanent suite, including 94 historical cases and three OPEN cases | 203 | 0 |
| New ownership and metamorphic tests | 172 | 0 |
| New actual shared processor tests | 21 | 0 |
| Total distinct test definitions | 956 | 0 |

Final frozen execution groups: safety 576/576; integration 200/200; regression 164/164; polling/transport retry 16/16. All four processes exited 0, with zero skipped/cancelled tests. The original 560 break down as 21 + 11 + 17 + 125 + 6 + 200 + 164 + 16. The 94 historical inputs are included in the permanent 203; repeated execution is not added to the distinct total. Syntax checks pass 3/3 and git diff --check passes. Runtime SHA-256: b0a11d15b3e956682baabedfd9fb2357ba04ce9e518ec354f56349aa586ebccf.

Retained results, exact commands, compressed log hashes and all recorded failed/rerun selections are in [results.json](stage8-predicate-ownership-evidence/results.json). Protected source identity and the captured native crash comparison are in [integrity.json](stage8-predicate-ownership-evidence/integrity.json). All 2,027 previously tracked paths other than triage.js remain byte-identical to the pinned baseline.

The three OPEN tests ran first: pinned baseline 0 PASS / 3 FAIL; repaired candidate 3 PASS / 0 FAIL. New tests assert ownership for all 94 preserved historical inputs, mandatory intermediate records, multilingual/mixed variants, temporal order, negation, resolution, recurrence, lists, object possession, references, quote speakers, frames and bounds. The 21 added actual-processor checks cover the four frozen messages plus possible-current inputs across Settings name, Journal note and health lanes. Both safety decisions preserve name/note/identity state, avoid ordinary consumers and scoped health reads, and deliver through synthetic transport only once on replay. Existing authority and normal-continuation checks remain intact.

The first combined 180-case regression selection returned 179 PASS / 1 FAIL because the sandbox denied the local webhook listener (EPERM). The complete required 164-case command then passed with authorized local-listener permission. The polling/transport selection also reproduced the existing index.node finalizer SIGSEGV after all 16 assertions passed. UUID 15297104-5a23-3847-9a99-938dd2f1ac9e and offsets 4618472, 2513860, 2740588, 506516, 380320, 470324 match the prior independent baseline evidence. All failures and reruns are retained. STAGE8_NATIVE_BASELINE_SIGSEGV remains OPEN, root cause unassigned; passing reruns do not resolve it.

Provider wiring and its synthetic ingress remain verified: the provider/Morning-provider subset is 16/16 PASS within the retained integration suite. The existing v34 migration subset is 20/20 PASS within the same integration suite and exercises isolated local preflight, v33-before-v34 ordering, idempotency, interruption recovery, guards and remote-apply rejection. No release migration was applied.

## Coach and Journal read only audit

Candidate Coach buttons and callback processing are implemented in src/companionCoach.js, src/stage7InteractionStore.js, src/stage7Runtime.js and src/bot/updateProcessor.js; topic/range/free-question choices persist in diagnostics_json. test/companion-production.test.js uses actual inline keyboard/callback_query composition and verifies stored selections. Journal choices, skip/missingness, edit/undo and optional confirmed notes are implemented in src/stage7Companion.js, src/stage7Composition.js and the trusted Journal stores. test/stage7-journal.test.js and test/stage7-process.test.js verify trusted facts, correction/privacy, replay and process restart. These files/tests are unchanged and included in the integration run.

Coach production composition lineage is adecd3e, with reviewed reply fencing in 828b3ba. Journal lineage includes c540384, 46cd5b2 and df94c9e, with reviewed repairs inherited by 828b3ba. Implemented/tested local functionality must be distinguished from merge/deployment. The retained read-only Production observation at 2026-10-13T14:43:29Z showed deployment dep-db6utp2vcj2c73f0l180 on 2340e8bc305c6acde29bbfa540753e79dbd34408, schema v32 and Stage 7/8 gates off. The 15:08:13Z Telegram routing/health observation matched that service. The retained main inventory on 222530a showed no Stage 7/8 or interactive Coach paths. Those observations showed interactive Coach and Smart Journal unmerged/undeployed; they do not assert a fresh October 14 Production state. Deployment acceptance for both remains a separate outstanding item. See stage8-review-handoff.md and stage8-evidence/{production-feature-readback,telegram-routing-readback,main-feature-readback}.json.

## Dependencies and exact reviewer action

Stage 6 still needs its owner-frozen final successor, independent capacity qualification, isolated semantic reconciliation, budget/authority/DOMAIN/cursor and restart guards. This patch manufactures no completion receipt and changes none of those files. Stage 7's reviewed v33 foundation remains inherited and undeployed according to the retained observation. v33 must precede v34. Authenticated LIVE producer allocation, selector/schema admission and typed-reader integration remain outstanding; SHADOW or completion metadata is never promoted to LIVE. Read the unchanged stage8-stage6-reconciliation.md and stage8-live-producer-contract.md.

Pin the final HEAD/tree from the owner report and freeze JSON. Compare against dbb8936; confirm only triage.js changes at runtime and original test/corpus bytes are preserved. Review the ownership traces, object/subject boundaries, local frame links and outcome actor/time compatibility. Run the three OPEN tests first, then all commands in results.json on the exact frozen binary. Challenge new ownership/metamorphic cases and actual processor state/read/replay protections. Record an independent delta verdict for this candidate; no implementation or whole-stage PASS is inferred from the architecture design verdict.

No Production operation, deployment, push, merge, credential change, real Telegram delivery or Stage 6 write occurred. F02 remains Owner Accepted Risk. Body Energy's LIMITED estimated trial and the existing morning schedule remain unchanged. Whole Stage 8 and Production remain NO-GO.
