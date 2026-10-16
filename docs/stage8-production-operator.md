# Controlled Stage8 production migration operator

This entry is an operator tool, separate from application startup and the historical migration CLI. Source review and isolated tests do not establish Production quiescence, a real recovery backup, capacity, or deployment acceptance. Run only the independently reviewed clean release after its resource/recovery gates pass. The tool never pauses providers, deploys, reopens traffic, enables features, rotates tokens, deletes pending work, or downgrades a schema.

`scripts/stage8-production-migrate.mjs` supports ordered 33→34→35, a single required step, and same-schema 34/35 recovery validation. `scripts/phase4-migrate.js` and the local rehearsal retain their remote34/35 fail-closed controls.

The fixed approved targets are the existing `enjoyfulwen0204-eng/whoop-briefing` repository, Render service `srv-dahs71qd0e5s738n94c0`, Cloudflare account `17558c0263c5c4076055ee0f860907dc` / Worker `whoop-briefing-scheduler`, GitHub workflow `340955986`, and the canonical existing Turso hostname. A URL, caller label, JSON receipt or migration flag cannot substitute for their actual authenticated readbacks.

GitHub normally requires zero nonterminal runs. One separately qualified code-specific exception covers only unchanged queued run `37892556296`, attempt1, workflow head `2ef4a1162c64d67bd1add0e0259872329e80d46c`, with zero all-attempt jobs. Its immutable manifest blob `9efda39f2e73cb56521949f60b32eaf199f22fbd` pins both jobs to checkout `8fbc2d90ae2b3fe68ae29454a26d7603c98784f0`, verifies HEAD, runs `npm ci` before production credentials are supplied, and invokes only the reviewed Phase4 CLI with those credentials. The retained [nine-case qualification](evidence/stage8-frozen-cli-schema-denial-20261016/proof-report.json) proves that exact CLI on actual canonical isolated schemas33,34,35 rejects after its first two SELECTs, before mutable SQL, provider calls or a SYNC handoff. The [frozen manifest](evidence/stage8-frozen-cli-schema-denial-20261016/frozen-briefing.yml) is evidence only and is not installed as a workflow.

Every provider check requires the actual database schema to remain33–35 and re-reads the exact GitHub run, all-attempt jobs, the workflow at its immutable head, and the immutable blob. It verifies Git blob SHA1 and SHA256 against constants compiled into the reviewed operator, plus a pinned hash of the retained qualification file. A private in-memory grant is issued only after those reads; caller JSON, an environment flag or a claim of accepted risk cannot grant the exception. Any new job, attempt, run, changed pin, manifest byte, qualification byte, nonqueued state, or schema32 fails closed. Ordered additive migration preserves a schema33-or-newer version throughout; this exception cannot authorize v32 rollback.

The signed observation truthfully retains one queued/nonterminal run, `providerFinality:false`, and `F02:OWNER_ACCEPTED_KNOWN_RISK_UNCHANGED`, together with the specific code barrier and qualification hash. Cancellation409 and zero jobs never become a cancellation/finality claim. F02 and cached credentials remain an accepted risk; no token is modified or rotated. This limited absence-of-writes proof does not replace the31-minute quiet window, complete app logs, zero active leases, original key continuity, stable full-row snapshot, authenticated fresh recovery backup or preservation checks. A changed GitHub state invalidates the observation rather than being silently adopted.

Supply existing credentials through the protected operator environment: `RENDER_API_KEY`, `CLOUDFLARE_API_TOKEN`, `GH_TOKEN`, `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, and the original distinct `PHASE4_LOOKUP_KEY` / `PHASE4_AUDIT_KEY`. The tool does not load dotenv or print values. Node 22 and exact clean candidate SHA are required throughout; all Git environment selectors are removed before checks. The currently running source SHA is a separate required pin because the previous compatible release remains under maintenance during migration.

The currently running release's proof is validated according to that binary's own contract. `scripts/stage8-source-configuration-proof.mjs` contains the exact compiled formula from immutable v33 release `ca4bff7b711737527ca6c4e306d4a3ef555c9f3b` (module Git blob `3359b0e93054ee4bf05e3ee074a00c5bebfd8ea2`, module SHA256 `5177935d79bdb17780cc2b3bda0271e08a2758e7675086ff5e109f2b4901c230`, canonical function SHA256 `8161be176968b8522cb4bae1762392170981412bd16ef401d1f8bf8e87ff96c4`). Only this exact source SHA selects the legacy formula; no fallback tries both formulas. Its compiled function text is checked at runtime, and focused tests compare it with the immutable Git source plus identical release/continuation dependency bytes.

For that exact old source, actual DB schemas33,34,35 are accepted solely while the same service remains under all existing maintenance/quiescence gates during ordered additive migration. Its beta runtime/mode must remain OFF, execution profile PHASE4, all Stage8/producer/cutover/Body switches absent or OFF, and Stage8 user IDs absent or empty. The original pilot user identity remains inside the old beta-pilot tuple; old cohort/automatic/topology/continuation bindings are preserved exactly. Enabling a new field cannot use the old formula. The provider observation records the chosen source contract. Every other source continues through the existing candidate formula; future Stage8/recovery proofs still bind the new flags, owner/cohort and v35 recovery profile. Application runtime proof code is unchanged.

A read-only actual baseline on2026-10-16 confirmed the ca4 Worker proof matches its own immutable formula and differs from the newer formula applied to the old SHA. That mismatch was an operator compatibility defect, not a reason to change the old Worker binding while it is still serving ca4. Source tests and the private read-only report establish this distinction; they grant no Production pause/migration authority.

Before observing, finish the already authorized operational pause: disable and drain GitHub writers, remove Cloudflare crons, enable Render maintenance, and stop/account for all private, direct, local polling, manual and background writers. Stop an in-process Stage8 continuation by its supported shutdown/configuration path; maintenance alone does not stop it. `STAGE8_POST_SYNC` must be off in the actual Render configuration. Preserve original configuration values for later coordinated restoration. Do not start the new runtime against an older incompatible schema.

Create a protected 0700 directory outside Git and a 0600 inventory JSON there. Its exact shape is:

```json
{
  "operator": "existing-operator-identity",
  "directSql": "STOPPED_EXCLUSIVE_MIGRATION_OPERATOR",
  "localPolling": "STOPPED_EXCLUSIVE_MIGRATION_OPERATOR",
  "manualCli": "STOPPED_EXCLUSIVE_MIGRATION_OPERATOR",
  "privateNetwork": "STOPPED_EXCLUSIVE_MIGRATION_OPERATOR",
  "renderBackground": "STOPPED_EXCLUSIVE_MIGRATION_OPERATOR"
}
```

This declaration is an explicit accountability requirement, not independent proof of quiescence. The tool additionally reads the actual fixed provider pause/identity state, public maintenance 503, zero active DB leases, original key continuity, exact schema, integrity/FK, and a keyed snapshot of every existing data row/column plus original schema/checkpoint history. Expired pending execution/delivery history remains untouched. A finalized execution's historical future lease does not count as an active execution writer.

Start the window from the reviewed clean checkout:

```sh
node scripts/stage8-production-migrate.mjs --observe \
  --expected-commit FULL_REVIEWED_CANDIDATE_SHA \
  --source-commit FULL_CURRENT_PRODUCTION_SHA \
  --inventory-file /protected/outside-git/writers.json \
  --observation-file /protected/outside-git/observation.json
```

The observation is authenticated with the original Phase4 keys, bound to both SHAs and the inventory, and exclusively created with file+parent fsync. Wait at least 31 minutes. The second actual Render response's authenticated HTTP Date must also establish the full 31-minute interval; changing a local file or clock cannot satisfy it. The receipt expires after two hours. No single elapsed timer proves drain.

The apply invocation re-reads all fixed providers, rejects changed release/configuration or any new/queued deploy/job, and compares the complete source digest. A nonnull HTTP replication index must remain identical. A null index is recorded as unavailable and never converted to 0. In either case the tool requires complete authenticated Render application logs for the entire quiet window: any app record, missing pagination proof, nonprogress, truncation or request failure rejects the window. This deliberately conservative fallback must itself pass independent review for the actual deployment. If app activity appears, investigate/finish drain and start a new complete window; do not hide events or edit receipts.

Prepare a fresh protected 32-byte AES backup key file, retaining it outside Git with the recovery artifacts. Then invoke the actual apply entry once, using fresh unique backup paths:

```sh
node scripts/stage8-production-migrate.mjs --apply \
  --expected-commit FULL_REVIEWED_CANDIDATE_SHA \
  --source-commit FULL_CURRENT_PRODUCTION_SHA \
  --inventory-file /protected/outside-git/writers.json \
  --observation-file /protected/outside-git/observation.json \
  --backup-file /protected/outside-git/fresh-source.sql.enc \
  --key-file /protected/outside-git/fresh-backup.key \
  --from-version 33 --target-version 35 \
  --confirm-production whoop-briefing
```

Before any remote DDL, the tool downloads the official authenticated HTTPS `GET /dump` using the existing database token, encrypting chunks directly with AES-256-GCM. Raw SQL is never written. After the entire GCM tag authenticates, it restores into an owned temporary 0700 directory, verifies schema/keys/integrity/FK and every original row/column/history against the still-quiesced actual remote source, seals a separate encrypted SQLite image, and rehearses ordered migration plus no-op recovery locally. Both encrypted artifacts are exclusive, 0600, crash-durable, bound to the source/release, and at most one hour old. Temporary plaintext SQLite is deleted after verification; encrypted backups and keys remain protected for the approved recovery retention period.

Each actual remote step rechecks paused providers, the log window and active leases, runs only the ordered additive migration with `allowRebuild:false`, and verifies all original column values/rows, original schema history, checkpoints and integrity. The final result explicitly states traffic remains closed. It is not a deployment or LIVE feature receipt. Keep providers paused until the exact compatible release is deployed and its actual SHA, schema, health, original keys and OFF gates pass; then perform the separately coordinated reopening and real feature verification.

If execution stops after a committed step, preserve every receipt and backup. Discover the actual exact schema and partial additive state; take a new authenticated observation and fresh backup before resuming from that exact state. Do not replay stale observations, overwrite backups, restore 33 as routine application rollback, erase cutover authority, or delete pending work. Same-schema recovery must retain the newly installed Stage5/7/8 send boundaries and callback compatibility. A durable PHASE4 Morning cutover requires an independently qualified source-plan-compatible recovery binary; a legacy-only binary cannot become its fallback.

Primary contracts: [Turso HTTP API](https://docs.turso.tech/sdk/http/reference) (`/dump`, `/v2/pipeline`) and [Render application logs](https://api-docs.render.com/reference/list-logs). Existing writer controls are retained in `docs/phase4-deployment-control.md`; its old schema numbers are historical, not commands to execute against today's source.
