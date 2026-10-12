# Second owner pilot authorization — 2026-10-12

The owner authorized an additional US$2 of incremental testing for 24 hours
from the first newly authorized optional execution, with at most 12 additional
attempts including retries and continuations. This is distinct from the expired
October 11 authorization and does not grant recurring funding.

The typed allowance is `OWNER_SECOND_PILOT_APPROVAL_SHA256`. Configuration keeps
its original canonical owner, consent hash and pilot ID, selects this allowance,
and uses `PHASE4_BETA_PILOT_START_AT=FIRST_RESERVATION`. The actual permit identity
includes the distinct reviewed allowance. Its fixed v32 coordination component
is `phase4_beta_pilot_permit_owner_20261012_v2`.

Availability, discovery, deployment and restart do not start the window. The
first durable reservation captures the database clock and seals start, expiry,
original lifecycle, original ledger digest and attempt 1 transactionally.
Every subsequent optional execution must reserve another slot. An operator
initiated test SYNC also reserves a slot before its submission; ordinary user
Morning Brief SYNC is not optional testing and remains independent.

The original `phase4_beta_pilot_permit_v1` record is read and authenticated,
never replaced. Its exact owner/consent/configuration, four consumed attempts
and expired epoch must match. The second ledger cannot be reset by changing
IDs, release, process, or clock. The existing HMAC, CAS, READY/lifecycle fences,
monotonic observations, absolute deadline, cancellation, uncertain-commit
semantics, work limits and STOP remain. No migration or new schema version.

Stop optional tests when the ordinary usage estimate cannot support the next
bounded attempt under US$2. Keep ordinary reports available. Unknown reservation
or execution outcomes require durable reconciliation and never automatic refund
or resubmission. At expiry or 12 reservations, optional admission/discovery
close; genuine Body Energy publication and notification gates stay separate.
