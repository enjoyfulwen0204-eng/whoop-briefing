# Stage 8 reconciliation with the pending Stage 6 successor

Final Stage 6 integration is deferred. The inspected lineage is 2340e8b → 9770553caba6f4085f4799fb6088db5076433f8e → 2da03c460c17aa0a143f06fc4f9af739a0dc21be → caf08fc6e5a6af38988aae97ebf834a80bfcfea7. The raw-capacity branch was clean when inspected but its handoff explicitly marks the successor partial and not capacity-qualified. The remaining raw DOMAIN gate reports 41.192 seconds with no new DOMAIN/cursor commit. No Stage 6 source, worktree or permit was modified or imported by this repair.

The six overlapping runtime files are phase4Reanalysis.js, phase4IntelligenceStore.js, phase4MetricUnitReceipt.js, phase4OperationReceipts.js, phase4Repositories.js and phase4ResultAuthority.js. Stage 8's existing v34 compatibility expansion and Stage 6's new raw preparation/receipt logic must be reconciled semantically; do not replace either full file or blindly cherry-pick the earlier budget fix.

Reconcile only after the Stage 6 owner freezes and reviews its final successor:

1. Pin its exact HEAD/tree and verify ancestry from 9770553. Re-read its final capacity/safety evidence and source hashes. Do not assume caf08fc is the final successor.
2. Start an isolated combined candidate. Preserve all approved Stage 7 interactions and Stage 8 repairs. Preserve frozen v32/v33/v34 definitions and the source/key/receipt authority.
3. Retain queue.owned(..., {assertBudget}) preparation guards and the post-enumeration budget check from 9770553. Preserve the latest successor's rawOwned path, metricPreparationUnitFromCurrentRaw, authenticated observation scope, DISCOVERY proof propagation, exact DOMAIN named ACK verification, and INCOMPLETE unit boundaries. Never advance a raw cursor before the required DOMAIN/family/association work commits.
4. Extend only the appropriate schema-version predicates to include v33/v34 while retaining SHADOW-only execution, producer proof and original 45,000/15,000 ms wall/safety limits. Carry the corresponding receipt/repository/intelligence/result-authority changes together.
5. Port the successor's fixtures to the exact combined v34 binary while retaining a pinned authentic v32 producer fixture for migration-preservation tests. Verify seven Journal roots, original generations/cursors, producer and result digests, named ACK/COMMIT ordering, missing ACK rejection, auth/resource/purge/lease/cancellation fences and peer isolation across real process restart.
6. Run the strict raw DOMAIN and full six-job synthetic capacity gates at 115 ms physical latency. Keep zero-progress or partial convergence failures OPEN. The two existing Stage 8 v32 preservation tests do not replace these gates.
7. Rerun Stage 7/8 and the relevant regressions, freeze a new combined SHA/tree and obtain independent review. Actual Stage 6 Production evidence and any new allowance require separate owner authorization; this work grants none.

Even a completed Stage 6 SHADOW capacity repair does not create LIVE analysis producers. The separately reviewed LIVE contract described in stage8-live-producer-contract.md remains required.
