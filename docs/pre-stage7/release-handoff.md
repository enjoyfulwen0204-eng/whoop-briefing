# Pre-Stage7 controlled release handoff

This is an unapproved partial Core candidate and an executable review sequence. R1 remains EXECUTION_BUDGET_UNRESOLVED; resolve and independently review the convergent completion model before G1 can pass. No push, tag, application deployment, database mutation, secret/key change, cron change, activation or real Telegram send occurred. Ordinary Morning Brief was not intentionally interrupted. Production remains subject to fresh provider readback; supplied Render maintenance OFF/auto-deploy OFF and reported release dfffbfb are not freshly verified private Render settings.

## Separate candidates and milestones

Checkpoint A includes R1–R6 repair, v32 admission/receipts, ordinary Morning Brief and Stage 6 SHADOW readiness. It contains no Settings code. Checkpoint B is based on A and adds only Settings v1. Neither implements Stage 7/8 or consumes v33. Final SHAs/trees are recorded by the generated manifest and engineering report after code commits are frozen.

| Milestone | Scope and evidence | Local disposition | Release risk |
|---|---|---|---|
| M1 | Explicit PRAGMA function; authority-bounded Coach; resumable identities/leases; corrected grouped-observation attacks | Deadline/lease/admission safety proofs pass; R1 completion remains FAIL | Independent review required |
| M2 | HTTP/Hrana restart, uncertain COMMIT, Morning Brief continuity, three-user timing | Execution budget unresolved | Persistent dispatch/checkpoints are a precise architecture proposal, not implemented completion |
| M3 | Separate authenticated SYNC/DRAIN, six-job backlog, receipts/currentness, three languages | Isolated readiness proof | Production SHADOW/smoke remains pending |
| M4 | Three Settings commands, localized icon buttons, canonical name/locale, secure callbacks | Separate implementation candidate | Only deploy after Public Beta gates |
| M5 | Broad isolated files, restart/negative suites, 20 contention repetitions | Retain all failed runs/reruns | Native failures are separately classified; no blanket broad PASS |
| M6 | Exact source/artifact hashes, gates, provider procedure, rollback | Review handoff | Formal independent reviewer owns approval |

## Generate exact local artifacts

On a clean tracked worktree with Node 22, run:

```sh
node scripts/pre-stage7-release-manifest.mjs --core-sha <FULL_CHECKPOINT_A_SHA> --settings-sha <FULL_CHECKPOINT_B_SHA> --out tmp/pre-stage7/release-artifacts
```

The script reads immutable Git objects and writes local files only. It rejects Settings inside Core, a non-descendant Settings commit, dirty tracked files, missing identities and reused output. The generated split workflow pins both checkouts and both protected environments to A. It never installs that workflow. The Worker proposal retains the reported morning cron `*/10 0-3 * * *`; a config-proof placeholder deliberately prevents runnable deployment. Derive a fresh proof with the original keys for the exact approved release/config/profile only in the separately authorized operator procedure. Never put keys/proof derivation logs into review artifacts.

## Provider acceptance gates

All gates below are **PENDING**, regardless of local tests.

| Gate | Required evidence |
|---|---|
| G1 Core release reviewed | Independent review of exact A SHA/tree/diff and retained original counterexamples; explicit approval of continuation design and its production scheduling limits |
| G2 Stale-run containment verified | Follow [R3 containment](stale-github-containment.md); terminal/deleted obsolete records or independently verified external credential denial effective against cached queued secrets; frozen checkout cannot mutate |
| G3 Controlled deployment | Fresh Render service/deploy/branch/command/config readback; auto-deploy remains OFF; exact approved SHA; Turso v32 read-only structural admission; original keys; protected GitHub environments; exact Worker identity/config/auth; no unintended scheduler replacement |
| G4 Morning Brief healthy | One and three READY users, correct current local date/locale/name/recipient; durable delivery/claim; retry/restart/ambiguity; replay sends zero; SHADOW OFF/presentation OFF |
| G5 Production Stage 6 SHADOW | Authorized SHADOW ON/presentation OFF; finalized authenticated SYNC handoff, separate DRAIN, durable discovery and bounded six-job backlog; current producer bindings/receipts; truthful heartbeat; restart and partial convergence; DRAIN sends zero ordinary briefs; ordinary brief remains healthy |
| G6 Three-language allowlist smoke | Exactly three reviewed READY canonical users zh-TW/en/vi, saved locale and recipient/display name confirmed; authorized user selects English through supported existing language flow; allowlist only; no ALL; no mixed/cross-user/private stale content; neutral fallback; no Body Energy |
| G7 Public Beta stabilization | Separately authorized presentation/LIVE release decision, observed scheduled healthy cycles and delivery dedupe, controlled rollback rehearsal; no Stage 7/8 |

G2 is a **precondition to any new credential access/promotion**, then is reverified after controlled deployment. Disabling the workflow, changing a pin, removing a secret name or adding a check to new code cannot close G2 for old queued snapshots.

## Controlled deployment and rollback procedure for later authorization

1. Independently review A and the continuation architecture. Select exact immutable SHA/tree; prohibit Settings diff in A. Verify G2 external containment before promotion. Keep restored production Morning Brief running until the reviewed controlled window; inventory all current writers and in-flight deadlines. No provider operation in this document is authorized by the implementation session.
2. Inspect actual Render service identity, deployed release/tree, build/start command, health path, runtime Node 22, auto-deploy OFF, maintenance state, pending deploys and non-secret configuration. Record original values. Select the exact reviewed commit in a manual deployment; never select latest branch. No schema migration is required: verify v32 through read-only admission, original key continuity and production HTTP/Hrana. If writer quiescence is required by review, its smallest window must be explicitly authorized; never run historical v20→v31 controls here.
3. Verify the deployed SHA and `/health` liveness plus authenticated scheduler readiness, then G4 P0 Morning Brief. Preserve current cron and scheduling sources. Do not infer private deployment state from public health alone.
4. Reverify G2, install the reviewed split workflow only through the protected release environment, preserve `17 * * * *`, concurrency/no cancellation, original key bytes and source attribution. Read back the actual source/env protection/job state. Approved SYNC outputs must be finalized/complete/drain-authorized before DRAIN receives its authenticated handoff. GitHub historical frozen snapshots require the separate R3 procedure regardless of this workflow.
5. Deploy the reviewed Worker only when its exact server/config identity is admitted, original trigger secret is available and continuation architecture is approved. Preserve the live `*/10 0-3 * * *` window; compare actual schedules before/after and account for propagation/in-flight executions. Verify caller limits 180s SYNC/100s DRAIN, work limits 120s/45s and 561s Worker window. Do not extend any deadline to mask latency. A persistent dispatcher proposal needs separate implementation/verification before claiming unattended slow-path completion.
6. Perform G5 production SHADOW validation with presentation OFF, then G6 three-language allowlist smoke only after the human English choice and explicit activation/send authorization. No ALL cohort; no fabricated summaries when no current authorized items exist.
7. Perform G7 Public Beta stabilization. Then independently review B and deploy/smoke Settings as the first UX patch. Telegram webhook/polling must accept message and callback_query, private actor gates and durable conversation ordering. Preserve pending updates/max_connections=1; do not drop the Telegram queue.

Routine rollback uses an independently reviewed **v32-compatible** release with `PHASE4_EXECUTION_PROFILE=RC2_V32_ROLLBACK`, SHADOW OFF, presentation OFF and empty allowlist. Retain original lookup/audit bytes, schema/data/receipts and delivery ambiguity. Prepare a matching immutable release/config proof and protected rollback environment. Verify health and one/three-user ordinary brief/replay. Raw RC2 on v32, downgrade, production backup restore and key rotation are prohibited. No rollback/deployment action was executed here.

## Ordered owner handoff

Independent Core Repair Review → controlled Core deployment (G2 precondition) → P0 Morning Brief verification → stale-run containment re-verification → production Stage 6 SHADOW → three-language allowlist smoke → Public Beta stabilization → independent Settings review → controlled Settings deployment/smoke → PRE_STAGE7_COMPLETE → begin Stage 7 v33. Formal production completion cannot precede these gates.
