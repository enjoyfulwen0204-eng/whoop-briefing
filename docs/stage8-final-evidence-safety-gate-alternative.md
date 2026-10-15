# Stage 8 conservative safety-gate alternative — owner review required

Status: DESIGN ONLY. The single focused final evidence repair stopped at runtime commit bf4da07 because a new High regression remains. This proposal is not implemented, accepted, deployed or a Stage 8 completion claim.

## Confirmed limitation

`argumentProof` currently supplies an exclusion-level whole-argument requirement to positive elliptical continuation as well. A registered serious symptom with past onset loses its plausible current descendant when descriptive words after an inherited subject/head are unknown:

- My chest pain started yesterday and is still present.
- My chest pain started yesterday and is still severe.
- I had chest pain yesterday and is still present.

The baseline returns CURRENT_URGENT. The prototype returns CLEARLY_NONURGENT. P1 owns chest pain/yesterday and remains historical. P2 inherits SELF and owns is/still but contains no copied symptom; unrecognized present/severe rejects the implicit relationship. Actual Settings and Journal consumers persist the text and Coach/health consumers run. This violates the three-state safety contract.

The prototype also omits the previously frozen NON_SYMPTOM_BARRIER reference from P3 to P2 for `I have chest pain. I had a headache yesterday. It has resolved.` Chest pain remains urgent, but the established inspection graph contract fails. Retain a barrier relationship without claiming a serious-symptom match or authorizing retirement.

## Minimum conservative gate

Preserve the predicate graph, lexer bounds, accepted ingress and existing runtime files. Separate evidence that warrants caution from evidence that authorizes exclusion:

1. Exclusion remains strict: CLEARLY_NONURGENT requires compatible actor, symptom, assertion, temporal and antecedent proof for every serious candidate. Unknown nouns/targets cannot create a resolution or absence certificate.
2. An inherited subject plus a new present head and owned current/continuing operator can retain a plausible serious-symptom lineage even when its descriptive complement is not fully understood. Use POSSIBLE_CURRENT_URGENT for that unproven positive continuation; do not manufacture CURRENT or a matched resolution.
3. Restrict this gate to bounded structural relationships already present in the graph: ACTUAL frame, known serious ancestor (or the existing proven weak pair), compatible message-local actor, no independently asserted competing subject/argument, and no complete contrary proof. Distinct metric/question predicates, educational/hypothetical/quoted mentions, typed negation and completed history continue to require their own routing proofs.
4. Compute the unresolved-current-lineage signal in the in-memory classifier before its small assessUrgency adapter discards the graph. Both safety decisions use the existing localized ingress response and bypass identity, name/note persistence, Coach and ordinary health scopes. Do not introduce a new persistence or transport layer.
5. Preserve original evidence and immutable operator owners. Keep a non-symptom barrier reference inspectable without cloning a serious symptom across that barrier.

No automatic implementation of this proposal is authorized by this repair cycle. The owner should review its admission conditions and acceptable false-positive trade-off before another scoped change.

## Privacy, failure and operational trade-offs

The gate needs no external model, API, provider, WHOOP read or new database table. Input and ownership traces remain in memory; production logs should contain only reason/version/bound counters. Existing 8192-character, 128-predicate/symptom, 256-operator, 512-link and depth-16 limits remain; overflow already uses the cautious decision.

Conservative uncertain routing may interrupt names/notes or emit safety guidance for an unsupported current nonmedical continuation. It must not become a blanket symptom-mention alarm. Operator/actor/frame conditions and negative controls need owner-reviewed tests. The benefit is avoiding reassuring metrics or persistence when a plausible ongoing serious symptom has not actually been excluded.

## Acceptance for the next cycle

Keep all old semantic expectations and original failed evidence. Require the 956 preserved checks, the corrected 349 scoped checks, the 195 new final semantic checks, the 25 reproduced real processor checks and all 12 stopped current-continuation probes. Assert the barrier graph and cautious lineage, not just output words. Add bounded positive/negative pairs for current continuation versus unrelated metric activity, explicit negation, currentness, actor switches and educational/quoted frames in en/zh-TW/vi. Verify zero name/note writes and zero ordinary scoped reads for both safety decisions.

Freeze a new exact SHA/tree and obtain independent review. Keep Stage 6 final successor reconciliation, authenticated LIVE producers and STAGE8_NATIVE_BASELINE_SIGSEGV separate. Do not import the old partial Stage 6 successor, relabel SHADOW as LIVE or change F02 Owner Accepted Risk.
