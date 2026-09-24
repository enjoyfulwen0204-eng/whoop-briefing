# Foundation Pack verification map

This is a review handoff, not approval to activate or deploy. The Foundation
lineage began from ADR baseline `1140cc9e1b16412027f599a7cc363d8e2b10dcff`;
the verified implementation checkpoint before the locked-decision documentation
alignment is `9d97c10ed6df5694708c18f6f07b5dc20ceaf465` on branch `v1.2-phase4`.
Foundation Stages 1–4, including additive v21–v24, tenant/mode/privacy stores,
Body Energy, and Structured Journal persistence/validation/correction/deletion,
exist default-off and SHADOW-only. All fixtures are synthetic. No credentials,
provider, production database, real send, additional scheduler, dispatcher or
Intelligence Pack is required.

The 2026-09-25 ADR alignment adds current Phase 4 requirements that are
**specified but not implemented**: Quick Actions, Owner Monitoring, per-user
display-name isolation, the future additive v25 contract, and mixed
Cloudflare/GitHub scheduler plus cadence-aware watchdog behavior. Stage 5 has
not started. One independent aggregate Foundation review remains pending; this
document does not claim that the new locked requirements passed implementation
review.

## Reproducible commands

Use Node v22.22.3. From the repository root:

```sh
/Users/kelvinloh/.nvm/versions/node/v22.22.3/bin/node --test test/*.test.js
/Users/kelvinloh/.nvm/versions/node/v22.22.3/bin/node --test test/phase4-*.test.js test/body-energy*.test.js test/journal-foundation-validation.test.js
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
| Public LIVE denial, all thirteen implemented Foundation flags false, future locked-scope flags absent/disabled, no provider/timer/production wiring | `phase4-stores`, `phase4-foundation-isolation`; aggregate entry-point diff review |

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

After the locked-decision alignment report is returned to the Architecture
Owner, the next implementation checkpoint remains the independent aggregate
Session B Foundation review against the amended ADR. Do not enable flags,
deploy, migrate production, or begin Stage 5/the Intelligence Pack from this
map. Pushing the single documentation-alignment commit only to
`v1.2-phase4` does not change that prohibition.
