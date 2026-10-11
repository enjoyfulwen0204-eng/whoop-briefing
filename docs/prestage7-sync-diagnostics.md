# Bounded SYNC operation diagnostics

This candidate adds operational visibility to the reviewed v32 execution path.
It does not raise deadlines, reorder reports/synchronization, grant publication,
resume expired work, alter schema/keys, or reset delivery claims. Core authority,
source/currentness, cancellation, immutable receipts and handoff checks remain in
force. The release operator must independently qualify any functional repair.

Each admitted phase gets a random trace correlation. When the existing claim
provides an execution sequence, subsequent events include that safe integer.
There are no user/chat IDs, names, health dates/values, SQL/parameters, URLs,
prompts, provider errors or credentials in diagnostic fields. Categories are a
closed list and the existing positive logger allowlist is retained.

`phase4_operation_start` and `phase4_operation_end` identify an allowlisted
operation, sequence, elapsed milliseconds, remaining active budget when known,
and outstanding count. WHOOP/model/Telegram HTTP header waits and body reads are
separate. Database executor invocation spans include their existing queue/fence
work; physical database HTTP request spans identify actual submissions. The five
exact runtime metadata reads and existing root re-admission callbacks have
separate categories so repeated admission can be measured without weakening it.

The detail ceiling is 192 events per phase: 96 reserved for orchestration stages
and 96 for database/provider details. After that ceiling, counters continue and
`phase4_trace_summary`, every encountered `phase4_operation_totals`, and pending
`phase4_operation_outstanding` categories are always emitted. Only 128 individual
active spans are retained; fixed per-category counts preserve all outstanding
counts. No diagnostic events or counters are appended after the phase closes,
even if original canceled asynchronous work later unwinds.

Per-category `duration_ms` is cumulative inclusive time; `max_duration_ms` is its
largest completed call. Nested/parallel durations cannot be added together or
interpreted as wall-time percentages. A successful inner call does not finalize
the whole phase. The final summary uses the actual typed phase outcome. Pending
operations at timeout remain PENDING, with no invented end or successful result.

Counters have distinct meanings:

- `query_count`: processing executor invocations/statement count for batch;
  includes existing recursive dispatch and invocations rejected by fences.
- `metadata_query_count`: executor calls inside the existing runtime metadata
  scope that match its exact five approved read-only statements.
- `runtime_readmissions`: existing root admission callback invocations; this
  instrumentation never adds a callback, metadata query or retry.
- `db_http_requests`, `whoop_requests`, `model_requests`, `telegram_requests`:
  actual fetch submissions through their reviewed transport seams. Database
  protocol-only close/cleanup traffic is not included in business request counts.
- `retry_count`: existing accepted contention/provider retry decisions before
  backoff; it does not imply another provider submission succeeded.

These are operational counters, not a provider billing certificate. Transport
counts and adapter invocation counts must not be conflated.

The smallest managed diagnostic should retain the current permitted cohort,
pilot clock/stop/budget, release/Worker proof, and normal source deadlines. Read
actual Render `phase4_trace_summary`, per-category totals and outstanding events,
then match the durable execution sequence/receipts/finality. Legacy operator
harnesses suppress application stdout/stderr; their projections alone cannot
supply these timings. Do not resend acknowledged or ambiguous reports or create
unbounded new identities to obtain diagnostic success.

Existing evidence shows real progress until deadline in both ordinary manual
cycles: sequence63 committed33steps through117.023s; sequence64 committed42steps
through168.501s. The v32 receipts contain opaque step keys and commitment times,
not operation names or starts, so the last outstanding operation cannot be
reconstructed from receipt intervals alone. The historical managed morning
readback contains one metadata admission (~1.368s), then acknowledged report
work followed by substantial synchronization before its120s deadline. This does
not establish repeated full metadata admission as its cause. The owned HTTP
factory is registered as a private runtime; repeated root admission is enabled
only for non-owned composition. No database admission optimization is included.
