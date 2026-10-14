# Stage 8 replacement triage design — predicate ownership first

Status: design proposal; not implemented or accepted. The bounded prototype is NO-GO. Do not merge its classifier or infer Production readiness from the passing historical suites.

## Why the prototype stopped

The recovered 94 distinct statements pass, but off-corpus transformations still produce systematic false negatives. An earlier historical predicate can supply time evidence to a later current predicate within the same punctuation clause:

- I had chest pain yesterday whereas my friend has difficulty breathing.
- I had chest pain yesterday whereas I have difficulty breathing.
- 我昨天胸痛然而我呼吸困難。

The prototype creates different group identifiers for these symptoms, but evidenceFor still gathers earlier clause-prefix events when no coordinated prior is passed. A group identifier is not an evidence-ownership proof. This is the same temporal-scope failure class that caused the rejected repairs. The primary implementer stopped runtime edits rather than adding more connector exclusions. The three urgent expectations remain failing permanent tests.

## Replacement contract

Keep the registered symptom vocabulary, localization, existing three-decision ingress adapter and accepted authority/receipt protections. Replace the fragment interpreter with a finite predicate graph whose operators have explicit owners. Do not add an external model/API or promote a reader/SHADOW result to LIVE.

The lexer produces offset-bearing tokens and semantic operators: symptom, subject/possessor, finite or aspectual predicate, negation, temporal qualifier, resolution, recurrence, coordination, modal/conditional, topic, quotation boundary and reference. Unknown modifiers remain tokens; their spelling cannot end an established negative predicate. Unknown structural relationships cannot provide a CLEARLY_NONURGENT proof.

The parser constructs these immutable nodes:

- Predicate: id, exact token span, subject identity, assertion kind, governing predicate/aspect and uncertainty.
- Symptom occurrence: id, kind, span, predicateId, grammatical role (predicate, object or possessed subject).
- Operator: id, type, span, ownerPredicateId or an explicitly proven shared-list id.
- Frame: id, type (conditional, educational, informational or quotation), span, parent frame and attached predicate ids.
- Relation: kind, origin/target ids and evidence span. Allowed kinds are shared predicate/list, relative object, current reference, latest same-subject outcome, reported speech and explicit recurrence.

A new subject plus a finite/aspectual predicate creates a new predicate even when the connector is unfamiliar. Possessors inside an object do not automatically become new subjects. A predicate owns only its span; the evaluator never receives an entire preceding clause prefix.

For the first failed example, the graph must contain P1(SELF, had, chest pain, yesterday) and P2(friend, has, difficulty breathing), with yesterday owned solely by P1. P2 has no historical operator. The same invariant applies when both subjects are SELF or the language changes.

## Evaluation laws

1. Negation governs one predicate and its proven coordinated symptom objects. A separate subject/predicate starts a new scope. Unknown relationship or competing scope stays uncertain; it cannot silently exclude a serious symptom.
2. Time governs the predicate/aspect it modifies. Past onset is distinct from completed history. An unrelated past predicate cannot change another symptom's currentness. “Has not resolved” is ongoing evidence; negated recurrence proves absence rather than a medical cure.
3. A latest explicit resolved/absent outcome can retire only matching same-subject symptom assertions. A past resolution cannot cancel a later/current assertion. Other-person and other-symptom outcomes are separate nodes.
4. A quotation is a mention frame, not an exclusion decision. A report or outside current assertion can attach its symptom occurrence to an actual predicate. Standalone quotations remain informational. References resolve only to a compatible nearest predicate/list; unresolved references remain uncertain.
5. Educational intent governs topic predicates. An actual symptom assertion is evaluated separately, including relative clauses and mixed languages. Conditional and epistemic questions have different frame types. Neither an educational marker nor an arbitrary time word has message-wide veto authority.
6. CURRENT_URGENT requires a current asserted serious predicate, or the existing compatible current weak-symptom combination. POSSIBLE_CURRENT_URGENT covers a detected serious symptom with plausible but unresolved current/assertion scope, conflicting evidence, unsupported structural ownership or an exceeded bound. CLEARLY_NONURGENT requires an explicit exclusion proof for every detected serious predicate and no independent positive candidate.
7. Both safety decisions bypass identity capture, name/note persistence, Coach and ordinary personal-health reads. They use existing localized conditional guidance and make no diagnosis. Clear nonurgent input preserves normal workflows.

## Bounds and operating behavior

Retain the existing 8,192 UTF-16 character limit. Bound the graph to 128 symptom occurrences, 128 predicate nodes, 256 operator/frame nodes, 512 relation edges and nesting depth 16. Use iterative evaluation; no unbounded recursion or regex backtracking over arbitrary content. Overflow or unresolved ownership returns POSSIBLE_CURRENT_URGENT. These are proposed limits requiring latency and coverage qualification, not measured production capacity claims.

The binary, grammar and registry versions must be pinned together. Classification must be reproducible across restarts. The classifier has no database, provider, network or health-context dependency. Locale selection and authenticated transport/lifecycle/receipt authority remain in the existing shared processor.

## Privacy, failure and trade-offs

All interpretation stays in-process. No raw message, quotation or health context leaves the server for classification. Runtime logging records only decision/reason ids, grammar version and aggregate bounds; no raw spans or private text. Full traces are restricted to synthetic test fixtures. No new retained user-message store is introduced.

Conservative uncertain routing raises some false positives and adds friction to names/notes. That trade-off prevents unproven exclusion from producing reassuring metrics or storing a potential emergency as ordinary data. Clearly parsed generic, hypothetical, negated and resolved input must still pass normal-routing tests; conservatism is not a license to ignore their semantics.

Finite grammar and vocabulary still cannot guarantee arbitrary natural language. Unknown roles and contradictions must be explicit uncertainty, not inferred safe history. Grammar maintenance and multilingual fixtures cost more engineering effort than regex exclusions, but ownership is inspectable and can be tested as an invariant. No paid service or model deployment is required by this design.

## Acceptance before another implementation candidate

First freeze the graph schema, attachment rules and expected parse graphs for the 94 recovered statements plus all three OPEN cases. Review that design separately from implementation claims. Reuse the frozen corpus expectations unchanged.

Add bounded property tests over actor, clause order, language, current/past, negation, resolution, recurrence, quotation and educational transformations. Assert operator owners and graph edges, not only urgent booleans. Every unrelated-past transformation must preserve a positive current predicate; every latest-outcome change must target only its own subject and symptom.

Then implement the replacement without changing accepted Morning Retry, Owner Monitoring, Settings/Journal, Provider, migrations or Stage 6/LIVE code. Run all 560 existing tests, the complete permanent corpus, every property family and actual shared-processor persistence/replay/authority checks. Freeze a new SHA/tree and obtain independent review. A systematic ownership failure at this gate is NO-GO; do not grow global exclusions.

Stage 6 successor reconciliation, authenticated LIVE producers and the open baseline native SIGSEGV remain separate release dependencies. F02 remains Owner Accepted Risk.
