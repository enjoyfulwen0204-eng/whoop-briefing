# Stage 8 authenticated LIVE producer kernel checkpoint

Status: implementation incomplete; LIVE producer acceptance NO-GO. This checkpoint is not an analysis producer or a Production deployment candidate.

## Integration foundation

Accepted Stage 8/Triage foundation: `0acd29f9c010e7f924736ec2c8054f5e44435f5d` (tree `a200a93ab7f58ef0d9b06bd0f55d3d542d4612b7`), with reviewed Stage 7 `828b3bad0f75d3b81d374e431872878af56f6c9a` and Provider ancestry preserved. Diagnostic preflight: `cd7633f64d3076ddc09df62de8f799ac769100d5`.

Dedicated branch: `codex/stage8-authenticated-live-producers-20261015`.
Worktree: `/Users/kelvin/.codex/worktrees/stage8-authenticated-live-producers/whoop-briefing` (device/inode `16777229:77559133`). Stage 6 worktree: `/Users/kelvin/Desktop/whoop-briefing/tmp/stage6-raw-capacity-20261013/candidate` (`16777229:71452797`). Physical separation was established before editing. Stage 6 was observed advancing from `a50336fdb3e418960d3983cb53f1e0f5e0fb60ad` to `e97074d545c7c86658593ad6be33566f94f5a1e1`; neither was imported or modified by this lane.

Accepted `src/bot/triage.js` SHA256: `7ec262425ce9b17bdab84f5fbd3c0d43e5546c703ff2e93a1b1e03c6d77fb78d`.
Accepted `src/bot/safetyGate.js` SHA256: `c62661d6798d255a00fa4329afb35110f510b0fb44682e81a52e0fe6ecddf42d`.
Both remain byte-identical.

## Implemented and verified boundaries

- Opt-in v35 sibling allocation for LIVE execution, work receipts, producer identities, result authority, operation receipts, receipt routes and family directory metadata. Default migration target stays34. Existing v26-v34 table definitions and CHECK constraints stay unchanged; schema admission uses exact34/35 profiles and rejects unknown versions.
- Private LIVE producing capability bound to admitted connection, keys, release/configuration identity and server eligibility/enabled callbacks. Same approved connection renewal is followed; returned issuer state is immutable. A SHADOW worker or read capability is insufficient.
- Private execution registration binds frozen claim/request, original tenant scope digest, release/config and actual connection. Kernel write and producer-binding checks compare original input/source/auth/lifecycle/purge/algorithm/timezone scope. A separate memory-fixture tenant gap was reproduced and then closed with a per-user guard.
- Closed server execution runner with caller-supplied IDs only, immutable canonical request, database-clock owner/generation/lease/deadline guards, named same-transaction work receipts, producer HMAC, signed result digest and immutable finalization. Work callback is server-bound at construction; requests cannot provide results, receipts, SQL, manifests or delivery transports.
- Replayed finalized results require digest and keyed signature verification. Expired ESTABLISHED executions recover committed units as PARTIAL, without replaying an old lease or inventing completion. WORK_COMMITTED takeover remains bounded by a new owner generation. Fresh context is asserted before aggregate commit and finalization.
- Typed receipt/authority and directory factories have initial explicit physical namespace support. This is incomplete integration and does not establish LIVE health-artifact privacy closure.

The positive kernel fixture commits a real synthetic named transaction and signed producer row. It deliberately leaves `last_completed_generation=0`. It is not positive evidence of finalized source computation, registered DOMAIN/family completion, typed CURRENT output, authenticated provider input or delivery.

## Actual blocker and remaining implementation

The owner mission authorizes implementing the additive successor. Absence of an existing v35 allocation is not an owner authorization blocker; the initial preflight interpretation was corrected and original evidence is retained.

Automatic approval review rejected the proposed multi-file computation/authority/privacy integration, including the narrower physical-selector-only attempt. Its stated reason was the breadth of security-critical authority/closure changes relative to validation, even in this local isolated branch. No rejected command executed. Further affected runtime edits stopped; owner approval was requested while unaffected verification continued.

`stage8-live-producer-namespace-integration.patch` is a concrete 297-line, unapplied next diff. It passed `git apply --check` and independent read-only review of physical table selection, signed closure inventory keys and preserved SHADOW gates. This subset review does not authorize applying an automatically rejected action and does not accept a complete LIVE producer.

Remaining work after explicit authorization:

1. Apply the namespace patch and validate original typed authority/closure, then adapt metric unit receipt and Body-derived producer selectors to exact LIVE allocation. Preserve the original complete source/unit/DOMAIN/family acknowledgment relationships.
2. Add the canonical LIVE computation driver with explicit producer capability, genuine finalized source enumeration, provider/onboarding/auth checks, mandatory source/family/association completion, restart/retry, revocation and purge fences. No SHADOW result copying or flag-based promotion.
3. Add a signed complete-scope publication certificate tied to original completion acknowledgments, including empty result sets. The current runner alone cannot issue one.
4. Wire registered Stage 8 typed readers to that proof and physical typed authority graph. They currently remain v34-only/ANALYSIS_UPDATING for absent LIVE producers; a fake completion row remains insufficient.
5. Wire Owner WEEKLY_SUMMARY only to supported LIVE insights and IMPORTANT_ALERT only to the existing approved subject-alert delivery/ambiguity policy. DAILY_SUMMARY remains source-based. No enrollment, consent, follow relationship or delivery is fabricated.
6. Add LIVE receipt/result authority fields to complete privacy inventories, redaction and root closure; test correction, revocation, purge, broken provenance and tenant isolation. Sibling health storage must not be activated without this.
7. Complete v35 application composition/admission renewal/restart and administrative compatibility. Existing Stage 8 factories and read guards still contain exact-v34 admission; they were not globally relaxed.
8. Positive genuine-source LIVE output + typed CURRENT integration and adversarial security tests; unknown-COMMIT injection/reconciliation; Owner permission/outbox tests; final exact-code independent acceptance.

## Stage 6 and full Production dependencies

Obtain the Stage 6 owner's final independently accepted runtime SHA and reconcile the six documented overlapping files semantically: `phase4Reanalysis.js`, `phase4IntelligenceStore.js`, `phase4MetricUnitReceipt.js`, `phase4OperationReceipts.js`, `phase4Repositories.js`, `phase4ResultAuthority.js`. Preserve rawOwned source handling, original metric units, DISCOVERY, DOMAIN receipts, INCOMPLETE boundaries, cursor/family ordering and wall/safety budgets. Do not import a partial worktree wholesale or invent six-job completion receipts.

The owner’s complete Stage 6 Production runtime/capacity/shared SYNC/Morning/restart acceptance remains separate. The native SIGSEGV remains OPEN; a passing isolated rerun does not resolve it.

After producer code acceptance and Stage 6 reconciliation, complete final integration/resource/stability evidence, obtain explicit Production approval, prepare ordered v33→v34→v35 controlled migration and matching deployment, then verify real authenticated LIVE outputs and actual authorized delivery. No Owner pilot or Public Beta rollout stage is added.

## Verification

Final machine results and raw TAP are stored beside this handoff. Distinct suites are counted separately; subset reruns are not added together as unique tests. Earlier failures, rejected action descriptions and superseded audit interpretations are retained.

Genuine completed authorized LIVE analysis output: FAIL / not implemented.
Typed LIVE CURRENT acceptance: FAIL / not implemented.
Legacy SHADOW rejection and fake-completion rejection: tested and retained.
Tenant/identity/scope/replay/crash boundaries: isolated kernel tests; full health privacy/currentness and unknown-COMMIT integration remain outstanding.

No Production configuration, database, migration, resource purchase, paid job, real Telegram transport or credentials were used. F02 and the Turso Token remain unchanged. Only in-memory synthetic migration/SQL and existing loopback fixture transports were executed.

Final affected run: **210 PASS /0 FAIL /0 skipped /0 cancelled**, exit0,619382.501667ms. New allocation/runner definitions: **7 PASS /0 FAIL**, included in210. Typed authority/closure/execution: **27 PASS /0 FAIL**, exit0,241841.098958ms. Supplemental routing/directory: **30 PASS /0 FAIL**, exit0,498668.124875ms. Do not add the earlier203-check preflight or subset reruns as new unique checks.

Allocation-only benchmark (20 samples each): v34 mean23.80ms /p95 27.46ms; v35 mean31.97ms /p95 41.67ms. Observed post-GC heap did not grow over either20-sample loop. RSS snapshots were200163328 and204472320 bytes in one process; their difference is not an attributable producer memory cost. Full regression resource telemetry is retained in TAP. These runs used concurrent local tests, not qualified Production resource limits. Complete LIVE computation throughput/memory is unmeasured.

Before freeze review, read this handoff, results.json, all four new runtime modules, the authority/kernel diff and the raw compressed TAP. Obtain exact HEAD and Tree from Git; verify all recorded source hashes. Request only checkpoint/subset review until the missing canonical computation, complete-scope publication, typed readers, LIVE privacy and actual authorization integration are implemented. No final producer acceptance is claimed.
