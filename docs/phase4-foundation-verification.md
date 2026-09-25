# Foundation Pack verification map

This is a review handoff, not approval to activate or deploy. The Foundation
lineage began from ADR baseline `1140cc9e1b16412027f599a7cc363d8e2b10dcff`;
the verified implementation checkpoint before the locked-decision documentation
alignment is `9d97c10ed6df5694708c18f6f07b5dc20ceaf465` on branch `v1.2-phase4`.
Foundation Stages 1–4, including additive v21–v24, tenant/mode/privacy stores,
Body Energy, and Structured Journal persistence/validation/correction/deletion,
exist default-off and SHADOW-only and passed aggregate independent review before
the separately authorized Stage 5 implementation began. All fixtures are
synthetic. No credentials, provider, production database, real send, additional
scheduler, or dispatcher is required for Foundation verification.

The 2026-09-25 ADR alignment documentation repair is complete at this handoff;
the repaired requirements are **specified but not implemented**. Stage 7 Quick Actions
require future v26 interaction transport plus Journal-side `TRUSTED_REGISTRY`
and `source_kind` provenance; pure button facts have no fabricated user-text
excerpt. Stage 8 Owner Monitoring persistence is separately owned by future
v27. Display-name isolation preferentially uses existing same-user identity
sources and does not receive a migration merely because Stage 8 contains the
fix. The one global Asia/Taipei 08:00–12:00 Cloudflare window maps to the exact
UTC trigger `*/10 0-3 * * *`; deployment verification must inspect that trigger,
and higher hourly-path latency for non-Taipei due times outside the global
window is an accepted v1 trade-off. At the Foundation checkpoint none of v26, v27, Quick Actions, Owner
Monitoring, display-name repair, or scheduler/watchdog changes is implemented.
Stage 5 and its RC1 blocker repairs are now implemented SHADOW-only against the
unchanged v24 schema and have their own verification handoff in
`docs/phase4-stage5-verification.md`; independent RC1 review is pending and
Stage 6 has not started. The Foundation
aggregate PASS does not approve Stage 5 or any production activation.

## Reproducible commands

Use Node v22.22.3. From the repository root:

```sh
node --test --test-concurrency=1 test/*.test.js
node --test --test-concurrency=1 test/phase4-*.test.js test/body-energy*.test.js test/journal-foundation-validation.test.js
```

The complete existing suite includes local HTTP server fixtures. Those need
localhost binding permission; they do not require an external provider. The
exhaustive interrupted-migration matrix emits many synthetic schema logs and
is substantially slower than an empty-database migration. Do not omit it.

## Coverage map

| Requirement | Executable evidence |
| --- | --- |
| v20 through every exact intermediate schema; no premature version; interrupted DDL/backfill; repeat convergence; integrity | `phase4-v21` through `phase4-v24`, `phase4-foundation-migration` |
| Field-scoped legacy redaction, exactly ten experiment leaves, proven independent siblings | `phase4-v22`, `phase4-experiment-store`, `phase4-journal-inventory` |
| Tenant/mode/authority, cache/lease/restart, current parent chains | `phase4-stores`, `phase4-foundation-isolation`, `phase4-insight-store` |
| Stable semantic reservations, question-slot race, CAS, delivery ambiguity, lease takeover | `phase4-interaction`, `phase4-transport-store`, `phase4-foundation-isolation` |
| Body formula/property/selectors/quality, exact result and checkpoint races, supersession/audit | `body-energy`, `body-energy-store`, `phase4-foundation-isolation` |
| Closed parser boundary, Unicode excerpt, ambiguity, tri-state exposure and UNKNOWN gate | `journal-foundation-validation`, `phase4-journal-store` |
| Structured fact/coverage answer, authenticated receipt, correction revisions, no send | `phase4-journal-answers`, `phase4-journal-inbound` |
| T0/T1/T2 crash/restart, transitive plaintext inventory, cache fence, no replay resurrection | `phase4-privacy`, `phase4-journal-inventory`, `phase4-foundation-privacy` |
| Public LIVE denial, all thirteen runtime-enforced Foundation flags false, future v26/v27 locked-scope flag names without runtime consumers absent/unreachable, no provider/timer/production wiring | `phase4-stores`, `phase4-foundation-isolation`; aggregate entry-point diff review |

Each name above is a `test/<name>.test.js` file. All are included in the full
suite and the focused Foundation command. Existing V1.2 regression tests remain
in the full suite; new gates do not replace them.

## Aggregate review repairs

1. Reproduced whole-experiment deletion followed by a fresh field correction
   resurrecting the projection. The durable whole-deletion barrier now applies
   to correction as well as new-field writes. Overlapping whole/leaf ADMITTED
   commands serialize, and proof/revision validation is repeated before T0.
   Final boundary review also reproduced SQLite numeric aliases (`01` versus
   `1`) bypassing a textual ledger identity. Admission now requires a canonical
   positive safe-integer experiment ID before T0; aliases cannot create a fence.
2. Reproduced canonical deletion for a disabled tenant between T1 and T2
   resetting a redacted queue row, stranding strict T2 verification. Generation
   advancement now preserves pending redaction markers, null FULL scope and
   disconnected links. T2 was not weakened. Active-user writes remain fenced;
   cleanup converges after reopening either path.
3. Added counterexamples proving post-start question payload purge preserves the
   full occupied window and refuses reconstruction, and ANSWER_LINEAGE cannot
   exempt numerical evidence from ordinary provenance/freshness checks.

## Deliberate non-production limits

- No LIVE issuer exists for a disk/remote database. Internal LIVE fixtures own
  an actual isolated memory database; callers cannot supply a URL or credential.
- FULL_TENANT_RECOMPUTE is durable pending work, not proof that a worker ran.
- Historical Body calculation cannot recreate canonical versions absent from
  v20 storage; exact saved manifests replay, otherwise it fails explicitly.
- Correction staging is limited to 30 days and is destroyed when an expired
  T1 is attempted, without releasing the purge fence. Journal has an explicit
  fresh-validation resume API. No scheduled retention/recovery worker is
  enabled. Future operational recovery for other expired correction kinds
  must preserve the admitted command and obtain a newly validated assertion;
  it must not clear a stuck fence or reconstruct old health content.
- Delivery eligibility uses current branded lifecycle/auth context, durable
  READY state and generation-bound cutover, destination and computation. This
  Foundation does not mint a cutover approval or substitute for release gates.
- Local purge does not claim deletion from Telegram clients, external logs or
  backups. Body Energy is a deterministic product metric, not medical validation.

The Foundation aggregate review has passed. The next checkpoint is independent
Stage 5 RC1 review against the ADR and `docs/phase4-stage5-verification.md`. Do not
begin Stage 6, enable flags, implement the future v26/v27 stages, deploy, or migrate production
from this map.

RC4 schema-allocation amendment: Stage 5 now owns v25 durable episode history. The future reservations above are v26 Stage 7 and v27 Stage 8; Foundation execution counts remain the historical v24 results. See [RC4 verification](phase4-stage5-rc4-verification.md).
