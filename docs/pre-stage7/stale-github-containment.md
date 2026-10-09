# R3 — STALE_GITHUB_RUNS_PROVIDER_ACTION_REQUIRED

Internal read-only challenge, 2026-10-09 12:09–12:12 UTC. No provider action applied.

Both runs 37892556296 (attempt 1) and 37891962479 (attempt 2) remain queued, conclusion null, zero jobs. The latter attempt 1 completed/failure. All 144 run records were paginated; these are the only nonterminal runs. Workflow 340955986 is disabled_manually; repository Actions is enabled/allowed_actions=all. There are zero environments. Both old jobs omit jobs.environment and consume the nine repository-scoped production credential names. Current main pins dfffbfb; frozen workflow 2ef4a1162c64d67bd1add0e0259872329e80d46c pins application 8fbc2d90ae2b3fe68ae29454a26d7603c98784f0.

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
