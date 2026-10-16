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
