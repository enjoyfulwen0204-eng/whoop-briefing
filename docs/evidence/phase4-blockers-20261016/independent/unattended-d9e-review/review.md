# Independent review: unattended candidate d9e1625

Exact detached source d9e1625d02a2741807abbcef4fa34c72740bbcf4, src treea9534bf16c5cc6dd3c0e6ea45136e330533e28f0. Tracked candidate files unchanged. No Production/original campaign access or mutation, no extra capacity run, no coalescing patch loaded/applied.

Decision: NO_GO for this exact driver candidate because its timeout race violates shutdown's promised DB-lifetime join. The narrowed discovery/parent/ordinal authority checks otherwise passed the focused counterexamples below. No whole-release approval.

## Blocking finding: timeout returns before metadata callback settles

src/stage8PostSync.js:76–105 wraps discovery in createExecutionBudget(5000).run. ExecutionBudget.run races the callback against abort; it does not await callback settlement after timeout. Consequently resume's finally clears resuming, loop.pending resolves through its catch handler, and stage8ContinuationLoop.stop returns even while the underlying metadata callback remains pending. webhook.js:589–593 then permits db.close after only this outer stop promise and server.close have joined.

Independent real-fixture reproduction used the original genuine0-day canonical SYNC/subject/producer setup. It first executed db.getState's real query, then held only that method's metadata acknowledgement with a controlled Promise gate. Calling loop.stop while gated returned after4989ms with observed SYNC_TIMEOUT and metadataAckStillOutstanding=true. Corrected fixture run reproduced it after4991ms. The assertion requiring actual settlement failed. The gate was released and joined before fixture cleanup; no unsafe close, native crash, grant or business-result fabrication was attempted.

Required correction seam: retain aborted authority after5s, but keep resume/resuming and loop.pending joined to the ACTUAL metadata callback until its currently outstanding operation settles. Use the existing execution budget scope/assertions around an explicitly awaited callback instead of treating abortable's early rejection as actual settlement. Recheck budget after each awaited metadata operation so a late ACK cannot initiate another read or producer. Do not change the global execution budget helper, parent TTL, producer deadlines or source limits. Correction verification must hold an ACK past5s, observe stop STILL pending and another resume BUSY at5.2s, release the ACK, then join SYNC_TIMEOUT/no new productive receipts before closing DB. No passing retry on unchanged d9e can fix this.

## Focused evidence

- Committed test/stage8-continuation-loop.test.mjs + stage8-unattended-continuation.test.mjs: independently5PASS/0FAIL/0CANCELLED,32627.244875ms. Genuine work/restart/commit-before-progress replay plus current-source checks; loop scheduling tests.
- Reviewer corrected independent-counterexamples.test.mjs:13PASS/1FAIL/0CANCELLED,14798.164084ms. The sole remaining failure is the timeout/join finding above.
- Fresh standalone webhook module import: exit0. This establishes initialization only, not listener lifecycle.

Passed reviewer boundaries include invalid subject HMAC; progress-HMAC fake done; authenticated invalid ordinal64; oversized progress; authenticated subject referencing a nonexistent receipt; immutable receipt deletion rejected by original DDL; signed subject stale after current source changes; immutable finalized parent generation rejected by original DDL; actual subject-lock revocation after acquisition; another owner holding the subject lock; exact original created+15min excludes work; and genuine ordinal63 exhaustion. The ordinal test committed actual work once, left signed progress at63, skipped locally thereafter, then rebuilt runtime and replayed the same spent child without new receipts/executions/SYNC. No ordinal64 was minted.

Initial custom run7PASS/5FAIL is retained as independent-counterexamples-first.tap. Three invalid test setups/cascades are not runtime findings: deleting an immutable receipt was correctly denied; updating a finalized parent generation was correctly denied (its attempted cleanup also was denied); that test's acquired lock then caused the following lock test to fail. One aggregate parent failure reflected those three subtest failures. The timeout/join assertion was the real fifth failure. Corrected only reviewer test setup: signed nonexistent receipt instead of deleting authority, direct assertions that immutable DDL refuses those writes, and real subject-lock revocation. No candidate guard, schema or expectation was relaxed.

## Security/privacy/runtime assessment

Discovery is server-only and accepts no client-supplied user/ordinal/scope/results. The copied fixed cohort is supplied by existing runtime configuration; ordinary composition still requires exactly its server owner. Query is limited to64 recent finalized same-release/config/mode SYNC rows. HMAC-authenticated subject must match current scope; progress's HMAC is bound to its opaque progress key, ordinal0..63 and boolean done. Authenticated done is skipped; malformed state fails closed. Selected parents still enter the original run function, which freshly validates canonical finalized parent, original handoff, authentic named subject receipt, subject lock, current lifecycle/auth/source/purge/enrollment/preferences, parent result/generation and original15min age before/through work and progress commit. No original phase authority is promoted into LIVE: the existing private producer remains responsible for LIVE grants, named work and45s/30s execution/productive bounds.

Local overlap returns BUSY. Different runtime/process instances retain the original shared subject lock. The failure-only exhausted map is bounded64 and evicts only suppression entries; it never grants work or extends expiry. After restart the last deterministic ordinal can replay once, but no next ordinal exists. Discovery may starve an older eligible parent behind64 newer rows, or fail closed on corrupt newest metadata; these are bounded availability limits, not authority bypasses.

The fixed2s loop schedules after completion and does not overlap itself. Queued ticks stopped before entry perform no work; start is one lifetime only; failure observation does not create retries within a tick. Startup remains gated on existing Stage8 LIVE/PostSync flags, with no new endpoint. Shutdown code intends to join loop and HTTP server before DB close, but the actual promise-race bug defeats that guarantee in d9e.

Core, producer math, schema, request/receipt authority and all prior privacy changes are byte-identical to d858. New behavior does not establish Production Node22/Linux HTTP512MiB capacity or close known native cleanup crashes.

## Existing generic post-sync cancellation

Primary affected-d9e1625.tap reports45PASS/0FAIL/1CANCELLED across the post-sync and webhook files, with the post-sync file killed at180005.633625ms and all14 nested first-test subtests reported complete. This is inspected implementer evidence, not independently rerun or accepted as PASS. The last app log is runtime_admission_complete at02:12:46.187Z; no first-root completion or second top-level post-sync test appeared before file timeout02:13:15Z.

That file invokes afterSync directly; it never calls new resume() or starts continuationLoop. Its exercised run path changed only the distinct ordinal-exhaustion error, not reached under32-leg loop. Therefore the new discovery5s abort race is not its cause. Remaining first-test path is fixture teardown: phase4Fixture t.after runs two setImmediate ticks, then synchronous db.close -> Sqlite3Client.close -> native databaseClose, then two ticks. There are no teardown markers to identify which step stalled. Heavy generic readmission/native statement lifetime is a plausible lead (primary kernel peak3766550528B), but no exact close/deadlock diagnosis is proved. Retain as unresolved teardown/native-lifetime regression; do not label fixture-only, add GC/fairness/clock changes or replace it with a passing owned fixture. No long rerun performed.

All previous failed evidence remains preserved. Await a separately pinned correction before scoped driver acceptance.
