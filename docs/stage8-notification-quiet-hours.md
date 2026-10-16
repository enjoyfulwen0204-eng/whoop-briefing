# Stage 8 notification quiet hours

Subject IMPORTANT alerts and automatic Owner summaries use the **recipient's**
canonical `journal_tracking_preferences.quiet_start` / `quiet_end` and user
timezone. Missing preference rows use the existing 22:00–08:00 defaults without
creating a preference or opting anyone into a feature. An equal start/end means
no quiet interval, matching the existing Companion policy.

Admission checks precede attempts. The final source/consent validation and latest
recipient-policy read share one consistent read-only transaction; the clock is checked
synchronously immediately before the provider callback. A policy change or a
clock crossing quiet-start before provider admission prevents the request and is
recorded as definite non-send if an attempt already started. A request already
in flight cannot be recalled; its actual/ambiguous provider truth is preserved.

Owner quiet periods defer existing PROPOSED/FAILED_DEFINITE work without closing
it or consuming retries. Existing DELIVERY_STARTED recovery still records
AMBIGUOUS and never resends. Normal expiry, authority and retry limits remain.
Interactive owner/self reads and consent management do not use this send gate.

A subject analysis may legitimately finish with NO_ELIGIBLE_WORK while quiet;
its health calculations and any real episodes/insights are not relabelled empty.
If quiet starts after proposal but before attempt, the proposal is retained.
There is **no guaranteed delayed alert**, new notification scheduler, artificial
generation or quota reset. A subsequent legitimate analysis can re-evaluate
eligibility under its original durable authority; replay alone does not promise
delivery after quiet hours.
