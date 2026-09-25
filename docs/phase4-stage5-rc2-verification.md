# Phase 4 Stage 5 Intelligence Core RC2 verification

Historical verification record. Its v24 replay-authority claims are superseded by the [v25 RC4 repair](phase4-stage5-rc4-verification.md): missing v24 history is unavailable; only full durable snapshots authorize episode replay.

This is the implementation handoff for Stage 5 Repair Cycle 2. It preserves the
RC1 verification in `phase4-stage5-verification.md` and does not authorize Stage
6, Stage 7, LIVE intelligence, deployment, production migration, scheduler work,
feature-flag enablement, or a merge to `main`.

## Scope and schema

RC2 closes `S5-H-009` and the remaining `S5-M-006` processing-clock fallbacks.
The repair uses the existing v24 durable model: deterministic evidence runs and
items, evidence-to-episode revision membership, episode observations and events,
semantic events, insight revisions, privacy source links, and lifecycle/generation
envelopes. No schema, migration, scheduler, workflow, flag, or production
configuration changed.

## Independent reproduction

Before the source repair, the permanent black-box regression performed:

1. analyze the exact rooted request at `T`;
2. analyze a qualifying continuation at `T+1`;
3. capture a fresh valid context in the same generation;
4. replay the exact rooted `T` request.

Against the untouched RC1 source at
`9594ea8c1aff326d03e1edd7e97347792f713f18`, the test failed with
`PHASE4_EPISODE_TIME_ORDER_INVALID`. `analyzeMetric` selected the now-advanced
active episode before recognizing the existing deterministic run/item and its
episode-revision binding. The negative-gap guard therefore compared `T` with the
active episode's `T+1` observation and rejected an already durable replay.

The guard was correct for a new out-of-order observation. Its position was wrong
for exact replay.

## Replay architecture

Metric analysis now validates context and rooted sources, builds the baseline and
quality envelope, calculates the observation, and derives deterministic run/item
identity before consulting current episode chronology.

If the deterministic run exists, replay validates:

- user, execution mode, lifecycle, auth, input, and purge generation through the
  current context and artifact envelope;
- completed/readable/non-invalidated run and item state;
- canonical manifest JSON and hash;
- expected item content, provenance, and durable confidence;
- exactly one readable evidence-to-episode revision binding when an episode is
  required;
- the source observation membership and bound episode event;
- readable semantic-event history and source lineage.

The result is reconstructed at the bound historical episode revision. The current
episode remains persistence authority for its present revision, but it is not
chronology authority for an exact historical replay. The replay path performs no
semantic write.

Association replay similarly resolves the insight revision first bound to the
durable evidence item, including historical supporting and contradiction state.
It does not rerun current-state insight transitions, so replaying an older run
after later promotion or weakening returns the historical revision and appends no
new insight revision.

If no exact durable identity exists, analysis continues through the existing
active-episode path. An unseen older observation still trips
`PHASE4_EPISODE_TIME_ORDER_INVALID`; it cannot join a future episode or move the
episode backward. RC2 adds no Stage 6 backfill or reanalysis behavior.

Privacy remains stronger than replay availability. A purged or redacted required
source/run/item/binding fails closed and is never reconstructed from stale
historical content.

## Semantic clocks

The Stage 5 intelligence audit found lower-store processing-time fallbacks in:

- episode `open`;
- episode `revise` (and therefore reverse/resolve/expire transitions);
- insight `create`;
- insight `transition`;
- current insight `read` expiry evaluation.

Those operations now require an explicit valid semantic timestamp and fail with
`PHASE4_SEMANTIC_TIME_REQUIRED` when it is absent. A history-only insight read
does not evaluate semantic currentness and therefore needs no semantic clock.
Remaining `timestamp()` calls in the episode store set operational
`created_at`/`updated_at` metadata only. Registered analysis entry points already
pass request `asOfUtc` explicitly.

## Permanent adversarial proofs

`test/phase4-stage5-rc2.test.js` proves:

- `T -> T+1 -> replay T` returns the original run, item, episode, and revision 1
  while the durable active row remains revision 2;
- three repeated `T` replays converge with identical identities and no count
  change across runs, items, episodes, observations, memberships, events,
  semantic events, insights, insight revisions, or source links;
- `T -> T+1 -> T+2 -> replay T` returns revision 1 while the active row remains
  revision 3;
- a recreated Foundation/store process resolves the replay solely from durable
  state;
- two different processing clocks produce identical semantic calculation and
  episode projections;
- omitted lower-store semantic time fails closed for episode open/revise and
  insight create/read-current/transition;
- fresh same-generation replay succeeds, while an ABA-stale context is rejected;
- two users with equivalent times and semantic identities resolve only their own
  runs and episodes;
- LIVE analysis remains rejected and creates no LIVE rows;
- a genuinely unseen old observation fails deterministically on repeated attempts
  without any durable-count or active-row change.

The association tests additionally prove that an old run replayed after a later
`SUPPORTED` transition returns its historical `EMERGING` revision, and that
opposite evidence replay after weakening returns the historical current and
contradiction revisions without appending revisions. Existing transitive Journal
purge coverage proves `CONTENT_REDACTED` precedence and no replay resurrection.

## RC1 regression status

The focused Stage 5 gate remains green for:

- `S5-H-001` Journal revision/coverage historical as-of and purge behavior;
- `S5-H-002` full-universe missingness and the `14/30` promotion guardrail;
- `S5-M-003` canonical ordering and stable Benjamini-Hochberg identity mapping;
- `S5-M-004` 35:59:59, exact 36-hour, greater-than-36-hour, and 118-hour episode
  boundaries;
- `S5-M-005` DEGRADED evidence non-membership/non-support;
- `S5-M-007` durable confidence persist/reload equivalence;
- `S5-L-008` 2.49/2.50/2.51 and scale-aware close-threshold boundaries.

## Verification results

- Pre-repair independent reproduction: 0/1, expected
  `PHASE4_EPISODE_TIME_ORDER_INVALID` on the untouched source.
- RC2 adversarial file: 10/10 passed.
- Final focused Stage 5 gate: 75/75 passed.
- Association verification: 15/15 passed.
- v21-v24 and legacy migration matrix: 55/55 passed.
- Adjacent multi-user/lifecycle/journal/privacy/Body Energy matrix: 283/285 in
  the restricted sandbox; the two failures were loopback `EPERM` only.
- Controlled Foundation + Stage 5 aggregate: 214/215; all 214 logical tests
  passed and the sole file-level failure was native libSQL worker `SIGSEGV`.
- Repository serialized sweep: 2,507/2,533 in the restricted sandbox. All 26
  failures were environmental/process failures: 19 loopback bind `EPERM` and 7
  native worker `SIGSEGV`; there was no assertion mismatch.
- The five loopback-dependent files passed 75/75 with loopback permission.
- The seven aggregate `SIGSEGV` files reran as 139/141, with five files clean and
  two recurring native teardowns; those last two files then passed 11/11 and 11/11
  individually.

Static JavaScript syntax, whitespace, secret/debug, and branch/tree checks are
recorded in the RC2 implementation report after the final documentation commit.

## Authority boundary

All runtime entry points remain SHADOW-only and tenant/mode/generation fenced.
Schema remains v24. No production database, scheduler, deployment, feature flag,
`main`, Stage 6 worker, Stage 7 Quick Action/TRUSTED_REGISTRY, or Stage 8 surface
was changed.
