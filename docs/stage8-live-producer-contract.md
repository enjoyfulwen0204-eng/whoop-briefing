# Stage 8 LIVE producer integration contract

Stage 8 source facts, Morning plans and owner daily summaries can run independently of analysis completion. Derived Q&A, owner weekly synthesis and important alerts require an authenticated LIVE analysis producer. No such producer exists in the current v34 contract. This is a code and upstream-contract dependency, not a flag or deployment-only requirement.

The reader boundary is `createStage8DerivedReader` in `src/stage8DerivedReader.js`, wired by `createStage8Runtime`. Its registered kinds are BODY_ENERGY, INSIGHTS, EPISODES and EVIDENCE. Selection is bounded to ten same-tenant, same-mode, same-generation artifacts. Every selected artifact passes the existing typed operation receipt/parent authority, and scope is checked again before returning. No request supplies SQL, results, a provider, another subject, or execution mode.

A future producer allocation must prove all of the following before the reader may return CURRENT, including CURRENT with zero items:

1. Explicit server-owned LIVE execution authority and exact approved schema/binary/configuration identity. Keep the existing v32 OFF/SHADOW execution and SHADOW producer definitions frozen. Allocate a separately reviewed successor contract; changing the old CHECK constraints or setting completion metadata is insufficient.
2. Same tenant and exact input/source/purge/lifecycle/auth generations and algorithm set. No pending purge or outstanding invalidation may be omitted.
3. Exact canonical request digest and scope identity; original named work receipts, committed unit/DOMAIN/parent outcomes, and immutable producer HMAC. Every artifact must be reachable through its original registered receipt and source graph.
4. Finalized successful execution, exact execution sequence and producing generation, finalized result digest, and commit/finalization ordering before the original deadline. A partial unit, failed/cancelled execution, uncertain COMMIT or cursor checkpoint cannot prove aggregate completion.
5. Completion of every mandatory source/family/association unit in the analyzed scope. An empty item list still requires this complete producer proof.
6. Fresh typed reads and currentness checks across process restart, authorization/resource revocation, correction/erasure, cancellation, generation changes, expiry and multi-user isolation.

The current implementation recognizes the existing execution-producer proof shape defensively but that table cannot contain LIVE rows. The future producer review must explicitly adapt the producer selector, runtime schema admission, and relevant typed receipt readers to the new allocation. A compatibility projection alone cannot weaken their mode or parent checks. Until that combined contract is reviewed and implemented, every derived kind remains ANALYSIS_UPDATING. The separate existing LIMITED Body Energy trial presentation is preserved and is never relabeled LIVE analysis.

Tests: `test/stage8-derived-reader.test.js`, existing provider/scoped/adversarial tests. Positive source-fact and owner source-plan tests are synthetic. There is no positive LIVE-analysis or Production acceptance claim.


## Local v35 successor implementation

The v34 baseline statements above are retained as historical contract evidence. The isolated successor now implements canonical LIVE computation, atomic original-ACK publication, typed readers and privacy/revocation closure in an opt-in v35 allocation; see [controlled integration handoff](stage8-live-controlled-integration-handoff.md) and its exact evidence. This supersedes the earlier missing-producer implementation status for that candidate only. Whole Stage8 and Production acceptance remain NO-GO pending the listed integration and stability requirements. No flag promotes SHADOW output and no Production migration or delivery is authorized.
