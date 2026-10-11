# Body Energy private qualification input contract

Adopted criteria: `body-energy-release-criteria-v1`, from ADR
`phase4-adr-v1-stage5-consolidated-closure`. Publication analyses/approvals are
`docs/phase4-architecture.md:556-571`; required source/baseline/freshness and
quality thresholds are `:299-318,442-481`; engineering estimate authorship and
non-medical meaning are `:232-259`. No clinical ground truth or official WHOOP
proprietary-score agreement requirement, nor numerical empirical correlation
or distribution cutoff, is specified in those adopted gates. Such claims or
new cutoffs must not be invented to force release.

Only the release lead may capture consented genuine inputs in a bounded private
operator action after this tool's independent review. The pure exported
`evaluateBodyEnergyPrivate(request)` accepts no provider, DB, credential or
path. It never issues a runtime publication capability.

The request declares `NON_PRODUCTION`, `SYNTHETIC` or
`GENUINE_AUTHORIZED_RETAINED_INPUTS`, one or two already authorized canonical
user IDs, and at most 45 cases/1 MiB total. Each case is either:

- `CURRENT_CANONICAL`: already admitted canonical rows for that tenant, no raw
  provider JSON, at most 46 rows per resource, exact current capture instant,
  current capability/access/sync/tombstone metadata. The real selector rejects
  post-as-of versions; latest rows must never impersonate historical captures.
- `CAPTURED_MANIFEST`: an original retained result manifest already authenticated
  through the typed receipt/audit reader by the operator, with original saved
  value/quality and explicit retained-content/capture declarations. Offline
  reproduction must match that saved result. These declarations are evidence
  attestations for independent verification, not client-supplied authorization.

Only reproduce captured history. A current canonical dataset cannot reconstruct
overwritten source revisions at earlier times. Earlier-only personal baselines
remain the actual selector's latest 30 values in 45 days; missing/invalid/stale
inputs retain the actual calculator's conservative quality/null result.

The result separates `summary` from `privateAnalysis`. The latter contains
health-derived aggregate correlation, distribution, ablation and coefficient
sensitivity and must remain outside Git, logs and ordinary release artifacts;
retain encrypted private evidence only when separately authorized. No user IDs,
individual cases or manifests are returned. Even summary eligibility refers to
the captured instant and is never proof of current publication eligibility.

The coefficient analysis uses analytic partials of the unchanged original
unrounded formula, with explicit clamp/rounding caveats. It does not run a
replacement score or change registered coefficients. Exact boundary/duplicate
conformance evidence from reviewed `d0391aa` is reused, not rerun. Insufficient
or constant paired inputs produce undefined correlations and remain explicit
qualification limitations. A tiny cohort is not a population or capacity test.

Actual Architecture Owner and independent Final Gate must assess complete
evidence, declared limits, estimate wording, privacy and statistical quality.
`validateBodyEnergyQualificationPacket` checks the completeness/version of that
review packet; it does not authenticate a signature or grant publication.
Runtime capability registration requires a separately reviewed exact approved
artifact. Synthetic study/software PASS cannot populate that registration.
