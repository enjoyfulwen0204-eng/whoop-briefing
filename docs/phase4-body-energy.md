# Body Energy foundation (not publication)

The callable foundation implements `body-energy-v1.2.0`,
`body-energy-constants-v3`, and `robust-baseline-v1` from the accepted ADR.
`body-energy-metrics-v1` identifies only this fixed input contract; it is not
the later Intelligence Pack metric/episode engine. The registry exposes a
public SHA-256 of its non-health engineering constants. Health manifests and
results instead use the existing per-artifact salted keyed audit digest.

The authoritative formula is addition: `.65 * sleep + .35 * autonomic`;
neutral domains produce 70. Sleep Performance is the sole sleep factor. Both
HRV and inverse RHR require their own earlier-only robust baseline. Recovery
score, sleep duration/need/debt, Journal, LLM and notification data never enter
the manifest's numeric inputs, quality or confidence. Only initial and final
scores round. These are engineering estimates authored by Kelvin Health OS,
not medically validated constants or a prediction of safety.

`bodyEnergyInputs.js` selects tenant-owned retained canonical rows using exact
UTC availability fences, current resource/auth/lifecycle access, capabilities,
active tombstones, matched sleep IDs and deterministic binary ordering. It
captures only the required columns, not raw provider JSON. Baselines use one
main sleep per earlier health day, up to the latest 30 values in 45 days, with
separate component missingness. Cycle load and workout fallback are mutually
exclusive. Scored nap IDs cannot count twice. A conflicting duplicate adapter
row is not resolved by input-array order.

`bodyEnergy.js` is the pure calculator and first-match quality decision. UTC
elapsed time is independent of local-day assignment, including DST. Expanded
ISO years and local calendar days at JS Date's endpoints retain exact UTC
millisecond identity. Every output includes deterministic drivers, reasons,
versions, constants hash and authorship. Missing domains remain null.

`stores.bodyEnergy` is issued only by the existing fenced factory. Its
`prepare`/`persist` pair uses an opaque context-bound ticket; arbitrary input
manifests cannot be submitted for persistence. `compute` selects and persists
an exact result. Supplying the known `targetHealthDate` makes the full exact
tuple explicit and returns its retained winner without reselecting current
canonical data. `readExact` and `audit` provide historical reproduction from
the saved manifest; they deliberately return no current-parent reference.
`read` is the separate current, full-provenance-validated parent interface.

V20 is not a source-revision archive. Uncaptured as-of requests fail with
`NOT_REPRODUCIBLE_FROM_RETAINED_INPUTS` when retained source/sync versions are
later than as-of, including corrections that moved an old event into the
future. This conservative failure also covers uncertain post-as-of row
availability; it never substitutes an older sleep as reconstructed history.
A newer generation/as-of may supersede a result while retaining its original
manifest for audit. Same-identity conflicting captures fail, never overwrite.

`checkpoint` is a separate closed 15-minute reference to the exact closing
instant. It cannot round an arbitrary request, substitute now, create an open
bucket or record success after a historical-input failure. `auditCheckpoint`
returns the original referenced instant and result, not a later answer.
Purge removes health fields and salt but retains the opaque exact-lookup
barrier. All retained-history APIs return `CONTENT_REDACTED` after redaction.

Two narrow shared-kernel repairs were necessary for this foundation: source
reference snapshots and Body capture payloads live in the context registry
instead of independent health-bearing WeakMap values, and stale timezone
authority is fenced. Release, expiry, revocation or a failed durable-context
check clears registered health snapshots. Callers must also discard returned
transient health objects before releasing their context.

A detected health-date discrepancy persists a same-mode, non-health FULL
`REPAIR_REQUIRED` job without changing the captured input generation or
claiming repair completion. There is no repair worker in this pack.

No scheduler, dispatcher, Morning Brief, Q&A, notification, LLM, provider or
production migration is wired to this API. The public factory remains SHADOW
only; LIVE authority is restricted to the existing isolated in-memory test
factory. All feature flags remain false. Calibration, ablation, sensitivity,
distribution and independent publication approval remain unsatisfied release
gates; this commit supplies no publication capability.
