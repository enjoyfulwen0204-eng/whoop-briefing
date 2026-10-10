# R3 — STALE_GITHUB_RUNS_PROVIDER_ACTION_REQUIRED

Internal read-only challenge, 2026-10-09 12:09–12:12 UTC, plus fresh GET readback at 14:42–14:43 UTC. No provider action applied.

Both runs 37892556296 (attempt 1) and 37891962479 (attempt 2) remain queued, conclusion null. Fresh attempt-specific job readback finds zero jobs for 37892556296, but TWO completed jobs for current attempt 2 of 37891962479: SYNC failure at 06:21:36–06:24:49 UTC and skipped DRAIN. Its all-attempts response includes four completed jobs, including attempt 1 SYNC failure at 06:08:09–06:11:28 UTC and skipped DRAIN. These executions predate this engineering session. The earlier zero-jobs observation is retained as an earlier response, not current finality proof. The parent queued state conflicts with completed job records and requires provider finality; a failed SYNC job does not prove no committed work. All 144 run records were paginated; these are the only nonterminal runs. Workflow 340955986 is disabled_manually; repository Actions is enabled/allowed_actions=all. There are zero environments. Both old jobs omit jobs.environment and consume the nine repository-scoped production credential names. Current main pins dfffbfb; frozen workflow 2ef4a1162c64d67bd1add0e0259872329e80d46c pins application 8fbc2d90ae2b3fe68ae29454a26d7603c98784f0.

The preserved isolated HTTP/Hrana stale-release proof finalized that obsolete checkout successfully on v32 after a user mutation. TAP SHA256 821af128f365b04f8529f5154ef12ac6ec6c69cfea6a2664206612759d59a747; source SHA256 445248e781e164086320bf01d483d95e5b6c1cd8a9d30c916ae8d9680164ef9e. Source/report remain in tmp/independent-rc4-production-recovery-review and /private/tmp/rc4-independent-review. These hashes are historical proof, not containment.

Repository/org secrets are read when a workflow is QUEUED. Removing current secret names cannot prove that already-queued snapshots lose cached credentials. New environment rules or new runtime release checks do not intercept the old manifests. [GitHub secret timing](https://docs.github.com/en/actions/reference/security/secrets).

## Separately authorized provider procedure

Preserve exact attempt/job/manifests and HTTP responses. Keep workflow disabled and leave Render, Cloudflare, cron, DB, all keys and ordinary Morning Brief unchanged.

For each exact ID above, request:

```
POST /repos/enjoyfulwen0204-eng/whoop-briefing/actions/runs/{id}/cancel
GET /repos/enjoyfulwen0204-eng/whoop-briefing/actions/runs/{id}
GET /repos/enjoyfulwen0204-eng/whoop-briefing/actions/runs/{id}/jobs?filter=all
```

202 is acknowledgment only. 409 while still queued is not proof. If ordinary cancellation does not converge, request the documented POST /actions/runs/{id}/force-cancel once and read back terminal status and all jobs. Only after finality, DELETE /actions/runs/{id}; require 204 then GET 404, unavailable attempts/jobs, and full pagination with no obsolete runnable records. Deletion availability must be established, never assumed for a newly queued record. [Run API](https://docs.github.com/en/rest/actions/workflow-runs), [run management](https://docs.github.com/en/actions/how-tos/manage-workflow-runs?apiVersion=2022-11-28).

If orphaned queued records survive, preserve the exact responses and obtain provider finality through a separately authorized support action. This session does not contact support.

## Future credential isolation

Both future jobs must reference a release-specific protected environment with independent approval. Original key bytes remain unchanged, but production credentials must be available only through that environment; remove repository-scoped copies after the retained queued records are conclusively removed. Verify no legacy manifest without that environment can receive DB, WHOOP, Telegram or model credentials. Emergency RC2_V32_ROLLBACK needs its own independently approved pinned environment, v32, SHADOW/presentation OFF and empty allowlist. [Environment protection](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments).

Alternative external denial: Turso allowed_ips/VPC rules, effective even against cached tokens. Exact API: PATCH /v1/organizations/{organizationSlug}/databases/{databaseName}/configuration with {"allowed_ips":["<verified permitted application egress>"]}. This requires prior verification of Render egress, every legitimate DB consumer, alternate endpoints, propagation and recovery access. GitHub direct CLI would require approved egress or authenticated server invocation. No rule is applied here. [Turso allow rules](https://docs.turso.tech/cloud/allow-rules).

Token invalidation is not a safe targeted shortcut: documented invalidation affects database/group tokens, requires replacement and may cause downtime. No rotation is authorized. [Turso invalidation](https://docs.turso.tech/cli/db/tokens/invalidate).

## Acceptance

Require old records unable to execute/rerun OR cached credential denied before mutable SQL; isolated frozen manifest fails before DB/provider work; approved current SYNC retains Morning Brief and zero replay sends; STAGE6_DRAIN retains authenticated handoff and cannot send ordinary brief; v32 rollback retains access and original keys. Preserve production verification evidence. Local passes and changed pins cannot close R3.

## F02 successor procedure — exclusive production network authority

Disposition: **R3_CONTAINMENT_DESIGN_READY_PROVIDER_ACTION_REQUIRED**. Fresh 2026-10-10 05:27 UTC GET evidence is retained under `tmp/pre-stage7/consolidated-repair/provider/github-fresh.json`: both parent records remain queued. First run has zero jobs; second has four completed all-attempt jobs while its parent remains queued. There are zero environments and nine repository secret names. No enforcement was applied.

The earlier alternative must NOT permit GitHub-hosted runner IP ranges. That would also admit these obsolete ubuntu-latest snapshots. Use one separately reviewed option:

1. Establish definitive GitHub finality, delete both exact obsolete records and remove repository/organization-scoped production secret copies only after definitive removal. Cancellation HTTP 202 or conflicting completed jobs is insufficient. Verify deletion with HTTP 204, run/attempt/job GET 404 and complete pagination. A terminal retained record can remain rerunnable; terminal status alone is insufficient. Current provider documentation permits deleting completed runs or runs older than two weeks; do not assume deletion of today's queued records. If cancellation/force-cancellation/deletion cannot establish finality, this option remains blocked and provider support is required.
2. Apply external Turso network denial that excludes ALL GitHub-hosted runners, including these cached credentials. Prepare dedicated, static, exclusive Render egress plus a separate trusted service/runner egress for reviewed CLI SYNC/DRAIN and emergency rollback. The new `docs/phase4-isolated-runner-workflow.yml` is a proposed artifact, not an installed workflow. Frozen snapshots request ubuntu-latest and cannot select its self-hosted label. Do not reuse a public shared runner/egress, a broad cloud range, or the Taiwan Mac. If exclusive stable egress or allow rules are unavailable on the actual provider plan, stop this provider option and obtain approval for infrastructure or credential isolation; do not invent compatibility.

For option 2, the exact separately authorized order is:

- Save current GET `/v1/organizations/{verifiedOrganization}/databases/{verifiedDatabase}/configuration`, actual plan/entitlement, every primary/replica/group/alternate endpoint and existing rules. Enumerate all legitimate SQL consumers and emergency access; identify exact outbound IPs as observed at the DB boundary, including IPv6. Preserve original lookup/audit bytes. No secrets are copied into reports.
- Prove the proposed exclusive network in an isolated provider database first. Valid cached old credentials from GitHub-hosted egress must be denied even for SELECT 1; spoofed forwarding headers must not bypass denial. Reviewed pinned code on the dedicated runner and Render must pass v32 admission. No arbitrary SQL gateway may exist on allowed Render ingress.
- Provision release-specific protected environments for approved current and RC2_V32_ROLLBACK identities with required independent reviewer approval and restricted refs. Keep the scheduler disabled during this handoff. Install no unreviewed code. Worker continues to authenticate to Render and never receives DB credentials.
- After explicit production authorization and fresh preflight, PATCH that exact database's configuration with `allowed_ips` containing ONLY verified exclusive application/approved-maintenance egress (and no broad `allowed_aws_vpc_ids` escape). Do not change keys, schema, block_reads, block_writes or credentials. Keep current Render Morning Brief code and cron running. GET readback must equal the approved rule set on every endpoint; allow rules apply to all valid tokens and therefore intercept the old frozen checkout below its application checks.
- Prove denial with a valid legacy credential through a separately controlled GitHub-hosted probe that makes **only SELECT 1**. Preserve the denied response without token bytes. Denial of all SQL is stronger than attempting a production canary write. Prove reviewed current SYNC/DRAIN and v32-compatible OFF/OFF/empty-allowlist rollback on approved egress. Obtain fresh Morning Brief health, claim/dedupe and scheduled observation evidence under separately authorized smoke procedures.
- Complete obsolete-record finality/deletion where possible and remove repository/organization secret copies. New secrets live only in the approved release environment. Reinspect old workflow dispatch/rerun paths; a newly queued old manifest has no environment credentials. The network deny still covers already cached credentials.

Rollback of the application stays on the same allowed Render/trusted egress with v32 and original keys. If the rule denies a legitimate consumer, use prevalidated allowed maintenance egress/provider console to add only its verified exclusive IP. Restoring unrestricted rules reopens F02 and is an emergency security decision requiring explicit authorization, not routine rollback. Do not invalidate all database/group tokens as an unplanned recovery shortcut.

Required enforcement proof A–D remains pending: old frozen checkout denied before any mutable SQL; reviewed release allowed; Morning Brief operational; RC2_V32_ROLLBACK allowed. Platform quota/network capability and exclusive egress are provider prerequisites. GET metadata is not containment.

Sources: [GitHub secret queue timing](https://docs.github.com/en/actions/reference/security/secrets), [cancel/force-cancel/delete/rerun APIs](https://docs.github.com/en/rest/actions/workflow-runs), [deletion eligibility](https://docs.github.com/en/actions/how-tos/manage-workflow-runs?apiVersion=2022-11-28), [Turso configuration readback](https://docs.turso.tech/api-reference/databases/configuration).
