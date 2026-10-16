# Static assessment of terminal callback canonicalization

Reviewed immutable d85835ef8618a1d891de2fb9260d1c20caece432; src tree16f43e20eb509dccb00d7da5c56bf7fd7ea552c2. No proposed coalescing applied, imported, loader-injected or executed. This is feasibility/counterexample review, not semantics acceptance of a candidate.

## Exact duplication mechanism

phase4Core.js:211–238 caches a check function only for schema32 + SHADOW + a job + STAGE6_DRAIN with all control relaxation options false/absent. The key is context object and job.check function, with exact execution/budget identity in the stored entry. All34/35 Core.run calls make a new closure, even for the same context and job.

processingTransaction.js:313 skips only adjacent identical functions carrying the narrower coalescible brand. Distinct closures all remain in state.checks. Line315's commitFences Set also retains every distinct closure. Lines414 and424 execute those lists at different terminal/COMMIT barriers. Every COMMIT retry executes the latter list afresh. Bounded32 transport controls in-flight fanout; it deliberately does not reduce callback count.

Each Core control closure runs fresh runtime fences, context validation and job ownership, settles all observations, preserves runtime/context/job failure priority, and ends with another fresh runtime bracket. assertContext reads its durable context lease, lifecycle/auth/source/purge/timezone and computation generation/algorithm. Queue job checks validate the exact leased context, tenant-pass owner/expiry and all requested/claimed generations/revisions.

The retained2383 diagnostic was a schema27 SHADOW association with no current job. It proves a large terminal list exists in a genuine association path, but does not measure d858 LIVE group size or attribute its3GiB peak to this mechanism. A function closure list of this size by itself is not evidence of gigabytes of retained content; repeated SQL, native statements, asynchronous resources and transient result allocations remain plausible amplifiers. No root-cause claim.

## Potentially qualifiable narrow change

Canonicalize a trusted Core-generated control CALLBACK FUNCTION, not its return value, Promise, SQL result, successful authority decision or invocation phase. Preserve every BEFORE invocation. Preserve a fresh AFTER and a fresh COMMIT/retry guard for each distinct eligible control purpose. Keep receipt-owner observations, receipt preparation, finalChecks, commitAuthorities, arbitrary callbacks and unmarked checks separate. Do not perform generic Set(checks) deduplication or skip checks because the data snapshot epoch matches.

For a new34/35-only branch, eligibility should be narrower than analysisModeAllowed alone: exact immutable server context; actual current STAGE6_DRAIN execution whose mode matches context; forLIVE, isLiveExecution(current,client,keys,user,context) must hold under the real producing capability, not just a LIVE read allocation. Retain all-false allowPurge/allowInactive/ignoreInput and frozen control options. Preserve the accepted schema32 branch if possible.

A conservative callback identity key includes owning Core/receiver, context object, current job binding/check identity, current durable execution+claim identity, current budget identity (including explicit undefined), active root/receipt transaction marker and current mutation epoch. Do not key by equal JSON/context fields. Different control options, roots, receipt markers, epochs, modes, execution/claim/generation or job bindings must not collapse. Missing root/marker can fall back to uncached behavior.

Stage8LiveExecution does not install currentExecutionBudget: real LIVE operations can have budget===undefined while job.check enforces the original monotonic stage6 budget and execution SQL enforces45s. Undefined is therefore an explicit key state, not authority. Retain the prior-object guard fixed in646's ancestry; absent prior must never pass undefined equality then dereference prior.check.

processingReadObservationEpoch is DATA invalidation only. It increments around same-transaction mutations, resets with each root and does not encode external revocation, wall-clock expiry, budget cancellation or server configuration changes. Matching epoch must never justify cached authorization. A marker+epoch cache can narrow function reuse; each invocation still performs every original fresh check and final bracket. No cache state or function must survive receiver lifetime/reconnect or authorize reuse of a released context.

## Must-fail qualification matrix

Every case below must reject before returning protected health data/committing new work, retain original error/failure priority and leave no new receipt, producer, cursor ACK or publication. Run against the exact candidate in genuine admitted34 SHADOW and35 LIVE producer compositions; a permissive isolated-memory mode callback or fake execution object is not LIVE authority proof.

| Counterexample | Boundary that must remain fresh |
| --- | --- |
| Prime eligible callback, revoke/delete context lease, re-enter identical context/job at unchanged data epoch | Next BEFORE and terminal reject CONTEXT_REVOKED/RELEASED; no prior success reuse |
| Advance only clock across context/job/execution expiry without a business write | Fresh clock checks reject despite matching epoch/function |
| Change owner/lease expiry/requested or claimed generation/scope revision on the job | Exact leased job check rejects; no checkpoint/complete |
| Change lifecycle/auth/timezone/source/input/purge generation, pending purge or algorithm | Full assertContext rejects; pre-captured health bytes never escape |
| Revoke LIVE enabled/eligible/config/release/admission/receiver lifetime after an earlier check | Original producing capability/runtime/config fences reject at next guard and COMMIT |
| Same context/job callback under another durable execution/claim/generation or budget, including missing budget | No inherited guard outcome or old claim closure; real authority required |
| Equal-valued foreign context or another Core/client/tenant/mode; LIVE read grant or fabricated execution | Original brands/allocation/producing authority reject |
| Same function source/context fields but different job binding, relaxed options or root/receipt marker | No canonicalization across purposes/lifetimes; allowPurge:true must not reuse false policy or vice versa |
| In-transaction mutation between Core runs; new root starts epoch0 | New epoch/root cannot consume old observation; all fresh predicates still run |
| Successful first COMMIT attempt's checks, definite BUSY, then revoke/expire before retry | Retry re-runs all fresh COMMIT gates; rollback, no callback replay |
| Existing named receipt replay after principal/lease/config revocation | Admission/replay terminal checks still reject; receipt itself is not a new grant |
| Callback failure, undefined rejection, delayed sibling, interleaved unmarked/final check | Original first-array error preserved; all originally required sibling observations settle; rollback and no work after rejection |
| A branded check attempts mutation/provider work; caller catches its error | Existing read-only/sticky failure enforcement prevents commit; no generic callback coalescing |

A positive qualification must separately show the expected small number of eligible callback FUNCTIONS while still observing fresh per-phase guard invocations and every original result/receipt/HMAC/source/SQL assertion. Counts alone cannot establish semantics. Test file/HTTP/native receivers without any timer, GC, profiler, budget, ordinal or authority change. No long capacity run requested here.

## Memory evidence and practical limits

The corrected implementer WEEKLY TAP is copied here with SHA256 c082fa4e9d2b738ce524fe21e78ff4db0b0a8cad4837a5440cf2cdb6ba31f0e1. It reports1PASS/0FAIL/0CANCELLED,275791.718834ms test duration,64 observed legs0..63, CURRENT at63,306 source ACKs+54 committed units,0 jobsFailed and per-leg ACKs+units<=6. Exact committed test verifies typed INSIGHTS CURRENT/nonempty/nonCausal and Owner WEEKLY approval/proposal/dedup/one outbox; reader SQL selects only SUPPORTED PHASE4 insights before authentic typed reads. This is inspected implementer functional evidence, not an independent test run or an unattended-path proof.

Maximum post-leg sampled heap192218544B and RSS1392672768B differ from kernel peak3249216KiB (~3.10GiB). Sampling cannot bound transient/native memory. Installed @libsql/client's sqlite3 executeStmt prepares a new libsql Statement per SQL execution; that JavaScript wrapper has no explicit finalization in its path. This supports investigating query amplification and native allocation lifetime, but does not prove native retention or suggest unreviewed cleanup. Known native crashes remain open. Actual HTTP transport does not execute that same local sqlite3 statement path, so local native RSS is not a measured Production512MiB footprint. Production Node22 Linux HTTP qualification remains unavailable; no capacity or native-fix inference from this pass.

Decision: callback canonicalization is a reviewable hypothesis with the above boundaries. Semantics acceptance remains WITHHELD until an exact candidate and independent must-fail evidence exist. Do not apply the previously denied one-line scope expansion on this static assessment alone.
