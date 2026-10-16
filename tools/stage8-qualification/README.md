This is a separate, manual-only qualification workflow. Install only after review
on `main`, then dispatch that workflow on `main` with the reviewed, published full
candidate SHA from this same repository. It does not modify or invoke the legacy
Morning Brief workflow, migrate Production, or use Production credentials.

The standard `ubuntu-24.04` runner is free for this public repository. No larger
runner, Actions cache, uploaded artifact, registry push, environment or OIDC is
used. Aggregate JSON is printed to the job log and job summary; raw synthetic
databases stay on the ephemeral runner. GitHub confirms that logs and job
summaries do not consume artifact storage allowance:
https://docs.github.com/en/billing/concepts/product-billing/github-actions

The workflow must exist on the default branch before manual dispatch:
https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow

Both checkouts use a pinned official checkout action and do not persist its
read-only token. The trusted workflow controls build a fresh image from candidate
package/lock files only. An authentic detached Git worktree supplies the candidate
HEAD; source, tests, package files, its real `.git` file and real common Git
directory are mounted read-only at their actual absolute paths. No Git identity
environment variable or synthesized Git object is used.

Pinned official images:

* Node22.23.3 bookworm AMD64:
  https://github.com/docker-library/repo-info/blob/master/repos/node/remote/22.23.3-bookworm.md
* libsql-server retained `f8fb14f` multiarch index (`sqld0.24.33` is asserted at
  image build, before workloads):
  https://github.com/tursodatabase/libsql/pkgs/container/libsql-server

The first CI run38887745672 stopped during image build, before any database or
producer call. The pinned image's actual version line, confirmed by an isolated
image-only `--version` diagnostic with no host mounts, is exactly
`sqld sqld 0.24.33 (f8fb14f3 2026-08-11)`. Its repeated `sqld` prefix is part of the
upstream output. The strict build check matches that complete line and prints
only harmless Node/sqld versions. Both image digests and expected versions remain
unchanged. This diagnostic is not a workload or resource qualification.

Qualification is Linux AMD64, Node22.23.3, one combined shell/Node/sqld cgroup:
512MiB memory, no swap,0.5CPU,128 PIDs, network none, read-only container and source,
fresh0700 output. Source preflight independently verifies actual cgroup/mount
metadata before starting the database or producer. Image build is at most10min;
workload at most32min plus10s forced client termination and bounded cleanup; job
at most45min. Original45s LIVE,30s worker and six-unit limits are unchanged. The
existing two-profile harness starts at most64 producer calls, including replays.
It uses fresh empty and synthetic three-user HTTP databases defined by the reviewed
candidate fixture; the candidate report records actual seeded densities. It never invokes
the historical Stage6 campaign or consumes its identities/attempt ledger.

This verifies the bounded producer and typed self-reader profile only. It cannot
prove Production availability, actual Turso transaction ceilings, real user
interaction, or concurrent Telegram/SYNC responsiveness. Partial, failed, aborted,
OOM or incomplete business results fail the job and remain unverified. A resource
qualification PASS must still precede the separate approved release and actual
Production workload verification.

The summary retains expected and actual resource row totals, numeric memory/CPU
and HTTP counters, and at most16 failure stage/code/SHA256 records per profile.
It omits source values, private IDs, SQL, raw errors and credentials. Trusted
wrapper failures identify their control phase and a bounded code/hash; cleanup
failure diagnostics preserve the primary error.

For the next targeted diagnosis, select workflow input `mode=diagnostic-empty-one`
with the final reviewed/published candidate SHA containing the diagnostic harness.
This uses the same offline container, memory/CPU/mount checks and genuine producer,
but only one empty synthetic user and at most one producer call, no dense profile,
replay or typed-reader qualification. The outer wall cutoff is shortened to10min;
the original45s LIVE,30s worker, six-unit and115ms HTTP latency remain unchanged.
The job deliberately reports `ISOLATED_LINUX_LIVE_HTTP_DIAGNOSTIC_ONLY`,
`qualificationPassed:false` and nonzero exit2. Capturing a useful diagnostic is
not qualification PASS, Production evidence, or a new campaign authorization.

Default `mode=qualification` retains the actual original call contract:
`empty16`, then dense receives `64 - actualEmptyCalls`, combined at most64 including
replays. No32+32 allowance is introduced. Do not dispatch this full mode merely to
collect the single-leg diagnosis.

The bounded safe summary now retains phase request/SQL counts and elapsed time,
per-leg ordinal/elapsed/failure phase and aggregate durable before/after counts
(including ESTABLISHED/WORK_COMMITTED/finalized execution counts and real receipts).
It retains at most16 normalized SQL template digests with fixed verb/category and
runtime-stage enums. The entire maximum128 detail groups are reserved for
PRODUCER_LEG; migration/seed can never consume that capacity. All phase counters
remain complete. Full scopes count the actual FULL_TENANT_RECOMPUTE stored enum. Arguments, SQL text/literals/comments, stack text, request
IDs, cursor hashes, health values and credentials are discarded. SQL group timing
is an HTTP-envelope upper bound including injected latency; groups overlap and
must not be interpreted as individual server SQL timings. Internal stack-stage
classification runs only in diagnostic mode; unmatched stages stay UNCLASSIFIED.
No raw report/database artifact is uploaded. Unknown/missing readbacks remain
null rather than fabricated zero or completion.

Actual run38888919478 retained only whole-profile HTTP totals, so its17k request
counts cannot be assigned to migration/setup versus workload after the fact. Its
0 completed jobs is not evidence of0 committed work. The new summary preserves
actual durable progress even when the single producer call ends SYNC_TIMEOUT.
A separate local no-socket/non-Linux experiment reproduced that timeout with
real persisted work; it cannot substitute for this official Linux diagnosis.
