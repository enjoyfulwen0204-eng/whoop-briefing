# Post-RC3 v32 delivery-default admission repair

PHASE4_RC3_V32_DELIVERY_STATE_ADMISSION_REPAIR_COMPLETE

All relevant substantive cases completed successfully. This is a local repair
candidate for independent review; production remains paused.

## IDENTITY

Starting SHA ce8e4fd76baab494d32de11e4d022311e303a066; tree
5b16b41b9b81c1ffd6098ae4f7c6a2183064e72d. Branch v1.2-phase4; starting working
tree clean. Local origin tracking and recovery/vietnam-stage2-rc3 point to that
published historical RC3 candidate. The final commit/tree and clean read-back
are returned in the session report. No existing tag is changed.

## DIAGNOSIS

ADMISSION_CONTRACT_DRIFT

The production definition is a legitimate retained v7 installation history.
The first fast admission compiler used only current fresh-CREATE and current
ADD-COLUMN definitions, omitting the already-installed v7 definition. V32 never
intended to replace this legacy column: its migration is narrowly additive
execution-settlement authority. No schema repair/version allocation is required.

## HISTORICAL CONTRACT

Canonical schema is history-aware. These are three exact reviewed definitions
of the same column, not every member of the runtime enum:

| Installation history | Exact column definition |
|---|---|
| Original v7 ADD, retained in production | delivery_state TEXT NOT NULL DEFAULT 'DELIVERED' |
| Fresh CREATE from v7 onward | delivery_state TEXT NOT NULL DEFAULT 'ACTION_READY' |
| Later TG-R05 ADD where column is absent | delivery_state TEXT NOT NULL DEFAULT 'AMBIGUOUS' |

A pre-v7 receipt table had only update_id INTEGER PRIMARY KEY, result_json TEXT
NOT NULL and committed_at TEXT NOT NULL. d4beb11 added six delivery columns and
kept that primary key. Existing-column detection never changes a default. The
TG-R05 commit explicitly states that production already had the column and the
change would not run there. Its earlier v7 migration report records that the
production table was empty when the column was added; these are historical Git
evidence, not fresh provider verification.

| Milestone | Commit | Schema | Fresh / later ADD / retained v7 default |
|---|---|---|---|
| Receipt origin (v6) | fee0448d7c52e2e98fe2607026f840b78dc024b7 | v6 | absent / absent / absent |
| v7 | d4beb11c44e307e799fb8e7b54186729f7df5e66 | v7 | ACTION_READY / DELIVERED / DELIVERED |
| TG-R05 | de7c0791faddf4e69c9357003803fc691a835784 | v7 | ACTION_READY / AMBIGUOUS / DELIVERED |
| Stage5 freeze | 32e6af485b2bf7e75fb4e00afb21711a9b2799f1 | v27 | ACTION_READY / AMBIGUOUS / DELIVERED |
| Stage6 freeze | 2de5f6ef3417f7a3c72e75c65106fec5c0e8b7d0 | v30 | ACTION_READY / AMBIGUOUS / DELIVERED |
| Localization | 10503f22497fb3ef8e41fc2016e269d1efaaf90a | v31 | ACTION_READY / AMBIGUOUS / DELIVERED |
| RC2 | c364ea7a7586bcaafb3fccd66bc18a461643732c | v31 | ACTION_READY / AMBIGUOUS / DELIVERED |
| first RC3 repair | 5ecb503fef9d6ae36a33c14ecd1f9ccaf81a1eae | v31 | ACTION_READY / AMBIGUOUS / DELIVERED |
| first reviewed RC3 repair candidate | 1577b1bec81b9f490c28b51b5ab6594d4d1537ad | v31 | ACTION_READY / AMBIGUOUS / DELIVERED |
| first v32 | 0a8597b555b37a3945c7451d3bd7cca590809547 | v32 | ACTION_READY / AMBIGUOUS / DELIVERED |
| approved RC3 | ce8e4fd76baab494d32de11e4d022311e303a066 | v32 | ACTION_READY / AMBIGUOUS / DELIVERED |


The first structural mismatch is introduced by
5ecb503fef9d6ae36a33c14ecd1f9ccaf81a1eae, which created runtimeAdmission.js.
Its table variants include fresh ACTION_READY and later ADD AMBIGUOUS only.
The v32 introduction 0a8597b and approved ce8e4fd retain that omission. The
RC2→RC3 schema.js diff changes the schema-version allocation, not this column.

ACTION_READY and AMBIGUOUS both first appeared as runtime values in d4beb11.
ACTION_READY was also the fresh-CREATE default there. AMBIGUOUS became the
ADD-COLUMN default in de7c079, with evidence-based legacy COMPLETED backfill.
This is a missing historical definition in admission, not an enum-based default
rule or an intentional v32 delivery behavior change.

No delivery_state CHECK constraint was introduced by these versions. Runtime
state legality is enforced by application transition predicates. V22 extends
owner/privacy/linkage and operation_state with its COMMITTED CHECK; it adds
p4_receipt_source/p4_receipt_owner and privacy indexes. Those complete columns,
constraints and indexes remain required. Later Stage 5/6, localization and v32
migrations do not change delivery_state. V32 execution triggers/indexes remain
byte-for-byte unchanged.

## DELIVERY SEMANTICS

DEFAULT_SCHEMA_ONLY for supported RC2/RC3 runtime and repository operator paths.
Migration ADDs use a default for old rows; pre-v7 runtime receipts had no such
column. Frozen v9/v19 fixtures intentionally represent their own reviewed
fresh/ADD history. They do not prove the production v7 ADD was changed.

Legal runtime states: NOT_REQUIRED, ACTION_READY, DELIVERY_STARTED, DELIVERED,
AMBIGUOUS. A schema default is not evidence that a new reply was delivered.
All three runtime INSERT sites explicitly provide delivery_state:

| Writer | Initial state and behavior |
|---|---|
| db.processTelegramOperation | ACTION_READY with reply; NOT_REQUIRED without reply; action/result/receipt atomically commit; cached receipt skips callback |
| phase4JournalInbound.commitReceipt | Explicit ACTION_READY for correction/deletion acknowledgement; authenticated receipt identity, privacy/provenance fences and source-update dedupe |
| phase4JournalInbound.answerReceipt | Explicit ACTION_READY for structured-answer receipt; authenticated source identity and same-transaction answer/receipt |

No repository script inserts into telegram_operations. Immutable RC2 contains
these same three explicit writers. Its isolated v31 control preserves DELIVERED
DDL, writes ACTION_READY/NOT_REQUIRED correctly and executes each callback once
across replay. RC2 was not run against v32 in that control.

| Reader/transition | Authority and safety |
|---|---|
| db.processTelegramOperation; journal receipt/replay readers | Read committed result/owner/privacy identity before returning cached work; receipt existence does not prove delivery |
| db.getTelegramOperation | Reads stored state; historical null/mocked fallback DELIVERED is unreachable for an admitted NOT NULL column |
| db.markDeliveryStarted | Only ACTION_READY; atomic owner/processing lease/conversation ordering/privacy fences; writes DELIVERY_STARTED before network |
| db.markDelivered | Owner/state/message-ID fenced; writes DELIVERED from start; late evidence on AMBIGUOUS leaves it AMBIGUOUS |
| db.markDeliveryFailed | Only a definite provider non-acceptance permits start→ACTION_READY; next attempt reuses the committed action |
| db.markDeliveryAmbiguous | Start→AMBIGUOUS; no automatic retry |
| db.markDeliverySuppressed | Start→NOT_REQUIRED; intentional terminal suppression; no delivered proof |
| db.abandonStaleConversationUpdates | DELIVERED selects COMPLETED; all others ABANDONED; clears stale ownership and prevents late send |
| bot.updateProcessor.deliverReply | DELIVERED already done; NOT_REQUIRED suppressed; STARTED/AMBIGUOUS never resent; every other value must still win ACTION_READY SQL authorization |
| phase4V22Backfill; phase4Redaction | Unreadable/erased ACTION_READY becomes NOT_REQUIRED; unresolved STARTED becomes AMBIGUOUS; actual delivered/ambiguous history retained |
| phase4SlotStore legacy in-flight reader | STARTED/AMBIGUOUS blocks incompatible legacy-question cutover |

Report-claim delivery_state is a different state machine and was not changed.
Privacy/root/inventory readers that select a whole operation row do not derive
send authority from its SQL default. Historical DELIVERED receipts remain
terminal. Changing/rebuilding a default to satisfy a verifier would be unnecessary
and could change unkeyed/legacy interpretation; no such rewrite is made.

## REPAIR

Application delta is only src/schema.js and src/runtimeAdmission.js:

- Declare the exact retained v7 definition in frozen historicalDefinitions
  metadata alongside its current ADD specification, with Git provenance.
- Compile those complete declared definitions as table-column variants.

Migration code ignores this read-only descriptor field; CREATE, ALTER, backfill,
version registry and v32 DDL are unchanged. No runtime state, transition, renderer,
delivery, driver, key or provider setting changes. Full structural comparison
continues for all 520 required objects, including types, nullability, CHECK/FK
contracts, indexes/predicates/uniqueness and trigger bodies.

Focused tests use an isolated actual v6 CREATE + v7 DELIVERED ADD history, migrate
through v31 and then the unchanged controlled v32 operator. The installed HTTP
libsql client executes Hrana SQL against a private synthetic SQLite backing DB.
Two real OS SIGKILL/restart tests use fake-send checkpoints; no real send occurs.

## ADMISSION

Canonical production-like v32: PASS. Five read-only metadata queries; zero DDL,
zero DML and no migration invocation. Schema stays v32; integrity OK; FK zero.

Malformed schemas: PASS (rejected). Missing/unrelated/default-enum/in-flight default,
wrong literal case or quoting, altered type/nullability, incorrect/incompatible
CHECK, missing column, wrong v32 trigger and wrong v32 index all fail closed.
Fresh ACTION_READY and later ADD AMBIGUOUS histories still pass independently.

## MIGRATION

v31→v32: PASS. Same-key v32 no-op: PASS. Existing table DDL/row fingerprints and
original key checkpoint rows preserved; no ALTER/rewrite of telegram_operations.
All v32 execution objects created, no fabricated historical execution success,
no LIVE, no Stage 7/8; repaired admission, integrity and FK checks pass.

## DELIVERY REGRESSION

PASS. Explicit creation/states, successful send, definite failure/retry, ambiguous
send, replay, restart and dedupe pass under the DELIVERED schema history.
SIGKILL before send leaves ACTION_READY; fresh retry sends once without rerunning
business callback. SIGKILL after fake acceptance leaves DELIVERY_STARTED;
restart/replay sends zero more messages and never claims DELIVERED.

## V32 AUTHORITY REGRESSION

PASS. Async COMMIT/reconciliation, deterministic receipts, producer bindings,
release handoff, replay, deadline/cancellation, lease expiry, Stage 5 contention
and Stage 6 currentness/progress cases completed. The production-like rollback
profile also passes signed legacy OFF/OFF ingress, complete typed SYNC, replay
once and no drain authorization. No execution-authority or processing transaction
code was changed. Stage 5 normal-driver contention passed 20 consecutive repeats
(40 additional assertions). The 480-pass backlog/process-death fixture passed.

## MORNING / BETA / LOCALIZATION

PASS. Ordinary morning brief, OFF/OFF, SHADOW ON/presentation OFF, dedupe, all
three locales, display-name isolation, neutral missing-name behavior, no Kelvin
fallback, cross-user isolation and Body Energy suppression pass. No real sends
or production scheduling changes.

## BROAD TESTS

Node v22.23.2; npm 10.9.8. Final accepted results: **165 files, 1,537 cases,
1,537 pass, zero fail/skip/cancel**, with every file exiting normally. The
[test ledger](phase4-rc4-delivery-default-tests.json) records each assertion,
attempt, source hash and selected complete run. The single compressed evidence
archive preserves 206 exact TAP logs, baseline source and diagnostic records.

Original primary shards: 165 files, 1,511 reported entries, 1,507 pass and four
failed file entries caused by native SIGSEGV; six files timed out. Those runs
remain failures/incomplete runs. The four native files passed unchanged isolated
reruns. All six timeout files passed complete unchanged serial reruns after
concurrent load stopped, using a 20-minute test-harness bound for expensive
fixtures. Application/server/Worker/GitHub budgets were not changed. Two files
had printed all assertions before a process-exit timeout; normal exit was still
required. No substantive assertion failure remains unresolved.

Original ce8e4fd production-history reproduction: one substantive admission
failure on telegram_operations before repair, retained as the regression's
baseline. A newly added positive rollback fixture initially omitted synthetic
keys and failed; fixture keys were supplied without weakening any assertion,
and its full 18-case file passed. An additional lifecycle timeout, an incomplete
fourth-case probe terminated explicitly, and a temporary instrumented diagnostic
copy's timeout are preserved as non-accepted diagnostic runs; the original
unchanged full lifecycle file later passed all four cases and exited normally.

Tooling history retains the Python 3.9 archive-extraction API error and dependent
missing path; validated extraction then produced a passing immutable RC2 control
(one case, v31 only). A sandbox EPERM affected an initial process-status diagnostic
read; the authorized read-only diagnostic succeeded. It was not an application
or listener failure. Historical v32/review/final ledgers remain unchanged; their
hashes and earlier native/tooling events are retained separately. No original
failure is erased or relabeled as a successful run.

## STATIC / RELEASE CHECKS

JavaScript syntax/import resolution, v21–v32 registry, 520-object contract, YAML,
inline shell syntax and diff checks pass. Driver, migration, package/lockfile,
GitHub artifacts and Cloudflare Worker/config are unchanged from ce8e4fd.
Rollout documentation is synchronized to the reported paused v32 state and new
post-RC3 identity; it authorizes no production operation.

## SCHEMA VERSION

32. v31 Localization; v32 RC3 runtime-safety / Execution Settlement Authority;
v33 Stage 7; v34 Stage 8. Settings v1 remains DEFERRED_POST_LAUNCH. Body Energy
remains NOT_AUTHORIZED_NOT_PRESENTED. No Stage 7/8 or LIVE enablement.

## NATIVE_01

NONBLOCKING. NATIVE_01_NONBLOCKING_FOR_RC3 is retained under the approved REMOTE
Turso / HTTP-Hrana production invariant. This repair does not change driver
selection or reinterpret the earlier native ruling.

## PRODUCTION MUTATION

NONE. No provider reads/writes, sends, deployment, migration, maintenance change,
automation activation, key rotation, downgrade or backup restore in this session.

## EXISTING RC3 TAG

v1.2-phase4-public-beta-rc3 is NOT moved. Annotated tag object
80fb12c408a2824f1bf3058de54dda1aedee7353 remains pointed to
ce8e4fd76baab494d32de11e4d022311e303a066. RC1/RC2 remain immutable.

## NEW CANDIDATE

Final local commit/tree returned in session read-back. Recommended release identity
v1.2-phase4-public-beta-rc4, only after Architecture Owner approval. NOT_PUSHED;
NOT_CREATED; NOT_DEPLOYED. The existing RC3 identity is historical and unchanged.

## PRODUCTION CURRENT STATE

User-reported rollout state, not fresh provider verification: DB v32; Render
maintenance ON; existing RC2 deploy selected; auto-deploy OFF; GitHub disabled;
Cloudflare cron zero; SHADOW/presentation OFF; empty allowlist; LIVE zero;
original keys preserved; verified pre-v32 backup retained. Production stays paused.
Raw RC2 cannot be deployed against v32. A rollback binary must include this
historical-default admission repair and use RC2_V32_ROLLBACK OFF/OFF; unrepaired
ce8e4fd also fails the production default check. No schema downgrade/restore.

## EXACT NEXT ACTION

RETURN_TO_INDEPENDENT_REVIEW_FOR_DELIVERY_STATE_ADMISSION_REPAIR
