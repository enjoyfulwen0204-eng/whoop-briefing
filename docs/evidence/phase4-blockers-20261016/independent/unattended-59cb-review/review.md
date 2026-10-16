# Independent scoped review: unattended driver59cb485

Exact fresh detached source59cb485d3858ef4d48024c718e547222d9a3e294, src treec8b636b3e07a69c6c025a6d8a3a639ea3873faf6. Tracked source unchanged before/after focused execution. Reviewer artifacts remain outside the checkout. No Production/original campaign mutation or reservation; no coalescing proposal or long capacity test.

Decision: scoped GO for the bounded server-owned continuation/discovery/ordinal/lifetime software boundary reviewed here. Whole release remains NO_GO. This is not production rollout, native-crash, HTTP/Linux512MiB capacity or large-history unattended convergence approval.

## Exact correction

Compared with independently rejected d9e1625, the only runtime change is src/stage8PostSync.js: import existing withExecutionBudget, explicitly await its discovery callback, assert the same5000ms budget at entry/exit and after each metadata await. No global execution-budget behavior changed. All original run/producer/receipt/parent/lease/ordinal logic is unchanged. Other src files are byte-identical to d9e.

This corrects the demonstrated timeout-versus-join error: expiry revokes discovery authority but no longer makes resume/loop.stop claim that the underlying operation settled. resuming remains true and shutdown remains joined while the late metadata ACK is outstanding. After its ACK arrives, the immediate budget assertion rejects before another metadata read or producer call. The budget timer is closed only after the actual callback settles.

The5s limit is authority to continue discovery, not a claim that an already submitted network operation physically ends within5s. Shutdown safely waits for its real settlement; a provider that never settles remains an operational termination concern rather than permission to force-close the active receiver.

## Independent tests

- Unmodified committed stage8-continuation-loop.test.mjs + stage8-unattended-continuation.test.mjs:6PASS/0FAIL/0CANCELLED,41491.549291ms.
- Reviewer independent-counterexamples.test.mjs:14PASS/0FAIL/0CANCELLED,17306.908208ms. Uses genuine signed SYNC/subject receipt and real owned native fixture. Candidate code is not replaced or loader-modified.
- Fresh standalone webhook module initialization: exit0. No listener/Production request was started.

The corrected join counterexample holds a genuine db.getState metadata ACK beyond the deadline. At5.2s, stop is still pending, the ACK is still outstanding and a second resume returns BUSY/invoked0. Releasing the ACK joins the actual callback, records exactly SYNC_TIMEOUT, schedules no new tick and performs exactly one metadata read (no read after the late ACK). Execution/receipt counts and hashes of phase4_executions, phase4_jobs, phase4_computation_state, stage8_live_executions, stage8_live_execution_work_receipts, stage8_live_publications and outbound_messages remain unchanged. Fixture DB closure occurs after the join.

Other reviewer counterexamples passed: invalid subject HMAC; fake done with old progress HMAC; signed invalid ordinal64; oversized progress; signed subject naming an absent receipt; original receipt no-delete trigger; stale signed source scope; finalized-parent generation immutability; actual subject-lock revocation after acquisition; another lock owner; and exact created+15min rejection. Negative operations preserve protected row hashes, excluding the explicitly staged negative metadata/lock/source mutations themselves. No guard or DDL was weakened to stage tests.

A separate real ordinal63 case performs actual producer work once and returns EXHAUSTED without writing ordinal64. The local suppression returns IDLE; a newly constructed runtime may replay the same deterministic last child once and still returns EXHAUSTED with identical execution/receipt counts. It creates no new SYNC. The committed positive case genuinely completes both current-source jobs by resume/restart; a crash after child finalization but before progress commit replays that child without new receipts. A global successful parent without a genuine subject receipt remains insufficient.

## Retained boundary assessment

Server composition supplies the fixed existing owner cohort. Discovery accepts no external tenant, ordinal, health data, result, receipt, SQL or transport input. It considers at most64 recent same-release/config/mode finalized SYNC parents, authenticates bounded subject/progress metadata against current scope, skips authenticated done and enters original run() for authority. The existing separately issued LIVE producer capability remains mandatory; OFF/SHADOW SYNC is only its prerequisite.

Original run freshly verifies finalized canonical parent/current release+configuration+mode, authentic handoff and named subject receipt, shared subject lock, lifecycle/auth/source/purge/enrollment/preferences, immutable result/generation and created_at+15min. It retains deterministic ordinal0..63, unchanged45s execution/30s productive bounds, six item/subunit cap, and original named receipt/cursor gates. No new parent or direct analysis.run call is introduced by discovery. Suppression cache stores only bounded spent-parent failures until original expiry and never grants work.

The loop waits2s after each completion, cannot overlap itself, cancels queued work before entry, observes a failed tick once, and joins its real in-flight operation on stop. Webhook starts it only under existing enabled LIVE/PostSync configuration and statically joins loop.stop plus server.close before db.close. The corrected delayed-ACK test proves the formerly missing Promise-lifetime edge. Full deployed signal/provider termination and existing native cleanup safety remain separate open gates.

Newest64-row discovery and fail-closed malformed metadata can delay an older valid parent. These bounded availability limits do not expand authority. Generic post-sync180s file cancellation remains unresolved; that direct-afterSync file never starts the new loop or discovery, and its final14 nested tests completed before its parent/teardown stalled. No rerun, GC/timer/native cleanup modification or fixture-only classification was used to hide that failure.

## Preserved rejection evidence

Original d9e report: ../unattended-d9e-review/review.md (SHA256 d5812ae6fff09bc0573f21dc1ec508419887ddf767d911f7059e068cf44e335d). It remains NO_GO. Its first and corrected reviewer TAPs preserve the actual join failure and separately classify invalid reviewer attempts to delete immutable receipts/edit finalized generation.59cb's pass is evidence for its explicit joined-callback change; it is not an inference that a passing retry fixed native crashes.

Prior native SIGSEGV/withdrawn-fairness close crash,512MiB capacity failures, inaccessible Docker/Git mount and Cloudflare authentication, generic pipeline/class regressions, original Stage6 metadata settlement and Production migration/recovery gates are not closed by this review.
