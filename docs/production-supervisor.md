# Stable production runtime

`npm run bot:webhook` keeps its existing startup path by default. The exact value
`KHOS_RUNTIME_SUPERVISOR=on` selects the fixed supervisor entry. It conflicts with
`KHOS_MAINTENANCE_INGRESS_MODE=whoop-only`; unsupported values fail before startup.
Selecting the entry does not authorize a maintenance window.

The supervisor owns one HTTP listener and all managed business constructors.
Before initial business closes, it mounts the canonical signed WHOOP metadata
intake. It then closes admission, drains owned work, disposes business databases
and initializes the signed original A epoch. The protected operator owns backup,
B admission, migration and revocation. Resume reads actual C35 or D33, captures
one immutable epoch scope, reconstructs every business database, joins the intake
and starts background work before business readiness becomes true. Cold A/B
starts only intake and supervisor liveness. It never infers prior SQL cancellation.

`GET /health` and bodyless `HEAD /health` report supervisor liveness during the
quiet interval. `businessReady` distinguishes fully started business service.
Owner commands at `/internal/production-transition-control` require the existing
phase4 MAC, original window and bounded command lease. A timeout retains actual
work ownership. An initial backup/preparation failure has a fixed A-to-D abort;
actual B or35 cannot use it. No endpoint accepts arbitrary SQL or a caller client.

The canonical adapter includes only production observation capture and guarded
connections. Local backup issuers and module graph hooks are absent. The tests
substitute only SDK construction for the controller, bootstrap and canonical DB;
they use native SQLite plus real local HTTP and forbid actual provider traffic.

## Later ordinary releases

The original C/D registry, boot row, trigger manifest, historical source and
window survive restart, expiry, disconnect and privacy purge. Expiry blocks new
maintenance. It does not block independently verified completed normal service.

A changed release or static configuration needs a separate startup contract.
The current `qualifyCurrentTerminalRuntime` observes an already LIVE release and
cannot qualify a new rolling deployment before it becomes ready. That gate is
intentionally retained. A future `PLANNED_TARGET` qualification must authenticate
the original terminal C/D context, actual prior service/env/database observation,
reviewed exact target commit and intended static configuration. The new process
must check its actual checkout/configuration and owned durable terminal state
before readiness; it must not rotate BASE, renew maintenance, delete fences or
adopt an old A token. Independent post-deploy LIVE verification must remain a
separate result. No planned-target issuer, durable transport or startup grant is
implemented in this batch. Later flag activation and changed-SHA deployment
remain blocked on that separate reviewed contract.
