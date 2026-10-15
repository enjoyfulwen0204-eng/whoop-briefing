# Authenticated LIVE producer preflight — contract clarification pending

This is a diagnostic checkpoint, not a LIVE producer implementation or acceptance candidate. Parent: 0acd29f9c010e7f924736ec2c8054f5e44435f5d / tree a200a93ab7f58ef0d9b06bd0f55d3d542d4612b7. Branch: codex/stage8-authenticated-live-producers-20261015. Worktree: /Users/kelvin/.codex/worktrees/stage8-authenticated-live-producers/whoop-briefing. Exact checkpoint HEAD/tree is in the owner receipt after commit.

## Verified state

The accepted triage SHA-256 is 7ec262425ce9b17bdab84f5fbd3c0d43e5546c703ff2e93a1b1e03c6d77fb78d; safety gate c62661d6798d255a00fa4329afb35110f510b0fb44682e81a52e0fe6ecddf42d. All runtime source and existing tests remain unchanged. Stage 7 reviewed 828b3ba and accepted Provider 7c6af29 are ancestors. The successor directory inode 77559133 differs from Stage 6 inode 71452797, device 16777229. No Stage 6 source was written or imported.

The existing LIVE contract is docs/stage8-live-producer-contract.md. It records requirements and says no LIVE producer allocation exists in v34. Clause 1 requires a separately reviewed successor allocation, retaining frozen v32 OFF/SHADOW execution and SHADOW producer definitions. Clause 6 and the final paragraph require coordinated typed-receipt, selector and admission integration. This checkpoint asks for the approved successor reference or clarification that defining the allocation is included in the implementation mission. Missing functionality alone must not be misrepresented as a contract blocker; independent review must challenge this interpretation.

## Concrete boundaries

* phase4V32Schema.js freezes executions to OFF/SHADOW and producers to SHADOW. LIVE cannot be added by a request flag or copying completion rows.
* phase4Reanalysis.js exposes an explicit SHADOW worker capability and rejects LIVE. phase4OperationReceipts.js execute and phase4IntelligenceStore.js association analysis also reject LIVE. Pure Stage 5 mathematics does not authorize publication/delivery.
* stage8LiveAuthority.js grants a scoped server-side LIVE read/core capability; it is not a durable producing execution with original named work receipts or complete source/family/association proof.
* stage8DerivedReader.js authenticates completion and original execution-producer receipts before CURRENT, including current-empty. Its current producer selector cannot find legitimate LIVE rows in the frozen table.
* DAILY_SUMMARY has an existing source-plan path independent of analysis. WEEKLY_SUMMARY needs supported current LIVE insights. IMPORTANT_ALERT needs an already approved current subject alert in DELIVERED/AMBIGUOUS state and fresh typed episode/proactive-decision parents. No arbitrary new alert, subject consent or owner subscription is created here.

An implementation cannot truthfully claim genuine authorized LIVE output merely from these negative checks. A successor must define its exact schema/binary/config identity, closed producing authority and eligibility, request/scope identity, original DOMAIN/family/association receipts, signed source/generation/result manifests, commit-before-finalize-before-deadline ordering, lifecycle/purge/revocation and restart/retry behavior, and reader selection. Frozen SHADOW definitions and current delivery policies must remain intact. The owner mission may authorize implementing that additive allocation; this clarification is pending, not inferred from elapsed time.

## Tests and evidence

`node --test --test-concurrency=3 test/stage8-*.test.js test/stage7-*.test.js test/companion-*.test.js`: 203 PASS / 0 FAIL / 0 skipped / 0 cancelled, Node exit 0. This comprises 200 unchanged Stage 7/8/companion feature definitions plus three new boundary checks. Those checks reproduce SQL rejection of a LIVE execution under v34, rejection of LIVE by the SHADOW worker/capability, and ANALYSIS_UPDATING for all four registered typed kinds despite fake current-empty completion metadata. They preserve peer state and leave zero producers. Existing migration tests exercise v33 before v34 only in synthetic databases; no Production migration occurs.

Existing feature coverage includes Provider, Morning Retry, Owner Monitoring and its authorization/delivery-replay guards, Settings, Coach, Journal, typed source/derived readers, privacy, lifecycle and tenant isolation. Reuse exact-code triage acceptance and unchanged component reviews; no new full triage review or 3,550-case rerun is claimed. No genuine LIVE positive, signed LIVE finalization, LIVE restart/replay, or LIVE alert/weekly delivery test is claimed.

## Stage 6 dependencies

Observed current Stage 6 HEAD was a50336fdb3e418960d3983cb53f1e0f5e0fb60ad, in its own worktree. This is an observation, not a final accepted integration SHA. Its local synthetic HTTP checkpoint reports runtime qualification in progress, monitored six-job completion 0/6 at that checkpoint, and pending full convergence, shared canonical SYNC/webhook/Morning concurrency, crash/replay, sustained-resource and independent runtime acceptance. The later bounded-family/paged-receipt delta retains genuine failures and still requires qualification. These receipts remain SHADOW; none is promoted.

Before final integration, pin the Stage 6 owner's final independently reviewed successor and reconcile phase4Reanalysis.js, phase4IntelligenceStore.js, phase4MetricUnitReceipt.js, phase4OperationReceipts.js, phase4Repositories.js and phase4ResultAuthority.js with v33/v34 compatibility. Preserve its source/family/DOMAIN named ACK, raw cursor ordering, auth/resource/purge/cancellation fences and 45,000/15,000 ms budget contract. Do not import the historical partial caf08fc snapshot or fabricate six-job/Production receipts.

## Independent review request

Review this exact checkpoint read-only. Challenge whether the asserted allocation clarification is a genuine missing contract/security decision or simply implementation already authorized by the mission. Identify the smallest safe next implementation and any exact policy fields that cannot be derived from the existing contract. Independently inspect producer authority, reader integration, tenant/privacy, lifecycle/revocation and Stage 6 dependencies. Reproduce the three boundary tests and registered reader tests as needed with local synthetic fixtures. Do not claim positive LIVE acceptance, modify Stage 6, request Production execution, or repeat triage acceptance. Return precise GO/NO-GO boundaries and evidence. This review is not a substitute for a later review of implemented producer code.

No Production access/mutation, migration, push, merge, deployment, real Telegram, paid execution, resource purchase or credential changes. F02 and Turso Token remain unchanged. No Owner pilot or Public Beta rollout is introduced. Native SIGSEGV remains a separate OPEN stability issue, even though this run observed none. Stage 8 code acceptance and Production are NO-GO while the producer is absent.
