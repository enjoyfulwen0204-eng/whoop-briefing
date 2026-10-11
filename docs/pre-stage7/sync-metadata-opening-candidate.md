# Ordered reconciliation opening candidate

This local author successor starts from frozen `d4e80d74e2dd8dea4ab7dabc18890de82d441e93`
(tree `3c878b72fc9bcd125d12254183a977f5aca56bb8`). Root's single unchanged 110 ms
Morning fixture failed on that candidate: all three reports, FAST, proactive,
analysis preparation and Prediction completed, but only one Healthspan completed.
The original three-leg limit and 15-second reserve remain unchanged. The failed
Root observation and raw run stay preserved in `reviews/sync-d4e-morning-root-observation.json`
and `reviews/sync-d4e-morning-110ms-root.attempt1.log`.

Actual installed Hrana measurement found claim, run opening and pending opening
cost seven HTTP requests each. The state read costs one, so pairing that read
alone cannot remove another protected root. The successor composes only the
fixed ordered metadata chain: claim, current state, original window calculation,
run opening, input-proof capture and conditional pending opening. There are no
parallel writes or provider calls inside it. Original store SQL predicates and
runtime, tenant, parent execution, ownership, receipt and COMMIT checks still run.
The original lifecycle SQL is followed by fresh lifecycle checks after the
operations and before COMMIT. Non-durable operation retains the separate calls.

The immutable named intent includes user, actual resource key, scope, owner,
lease, lifecycle, mode, normalized explicit window, admitted window anchor and
applicable deep-slice policy. Caller window/policy fields are copied before the
first await and used by both the key and actual operations. A distinct admitted
cycle can perform new work; a busy result for an earlier cycle cannot authorize
it. Without an explicit window anchor, the actual durable claim's original
started-at timestamp supplies the admitted anchor; a retry cannot turn elapsed
wall time into a new logical grant. The receipt contains only zero for a busy grant, a positive acknowledged run
ID, or a negative run ID for a fenced input/false pending opening. Health rows,
window objects and input-proof data never become receipt results.

A replay never calls claim, opens a run or opens a pending window. It freshly
checks the original lifecycle and current resource lease, then validates the
exact unfinished tenant/resource/owner/run ID, mode, explicit bounds and pending
bounds. Closed or missing runs, changed modes, expired or replaced grants return
SKIPPED without provider work. A stored false result remains false for that same
intent. Actual submitted unknown COMMIT, cancellation and deadline remain
indeterminate; no callback replay or substitute grant is attempted.

False pending opening acknowledges its actual diagnostic run first, then uses
the original failure/closure path after ACK. It never starts provider work or
claims a successful watermark. Definite SQL errors before ACK roll back the
entire unacknowledged opening chain. They do not fabricate an acknowledged run,
lease, pending window or receipt. After a successful opening ACK, the captured
input proof must match a fresh authorization/privacy/lifecycle/source-binding
read, all original runtime fences are checked with their actual client, and the
actual resource lease must still be held before provider/effect
work. The original post-response and publication/effect fences remain in place.

Initial composition smoke observed 2,237 HTTP / 3,218 SQL, versus d4e's
2,399 / 3,404. Adding the required fresh post-ACK input assertion measured
2,252 / 3,233. The exact frozen successor must be measured again with the fresh
lease check included; these draft measurements are count observations, not
110 ms reserve or production qualifications. The first adversarial draft run
preserves one failed assertion: authorization changed between capture and pending
allowed one synthetic provider call before the original post-response fence.
The added post-ACK boundary check repairs that composition gap; final controls
must pass on its actual successor. A later draft also preserved post-ACK sync
takeover and moving-clock retry failures. The actual runtime-fence assertion and
original admitted anchor address those findings; neither failed draft is approved.

Controls exercise actual Hrana/SQLite SQL failure and rollback, false pending
expiry/takeover diagnostic truth, busy and distinct-cycle behavior, unknown
COMMIT/cancellation/deadline, consumed and active grant replay, caller metadata
mutation, post-ACK authorization/source binding/lifecycle/resource/runtime-owner
changes, and all inherited settlement/page boundaries. All raw attempts are
retained. The previously reproduced native proactive SIGSEGV remains a limitation;
this successor does not claim that whole file passes or repairs the native fault.

Production STOP, all required stages, 120-second work, 165-second server,
900-second epoch and 561-second caller bounds remain unchanged. Repository
schema, Cloudflare/workflows, configuration and pilot are unchanged. No real
providers, credentials/environment files, private health, live DB, push, deploy
or production operation occurs. This is author evidence only. Root coordinates
one unchanged 110 ms run after freeze and a different reviewer assesses the delta.
