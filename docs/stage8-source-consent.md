# Stage 8 source-user sharing consent

Owner status and owner follow preferences do not authorize access to another person's health data. Access requires a current, explicit source-user grant for the same server-configured recipient and one of `DAILY_SUMMARY`, `IMPORTANT_ALERT`, or `WEEKLY_SUMMARY`, together with a separate enabled owner subscription. Missing, corrupt, revoked or obsolete consent denies access.

The source authenticates their own private Telegram binding. A displayed permission binds both principals' lifecycle, WHOOP authorization, onboarding enrollment revision, profile revision, privacy generation and private destination binding. A changed principal cannot inherit the grant. Settings uses its existing private actor, nonce, revision and expiry flow; each grant/revoke has an explicit desired value. Only classes the source has authorized appear in the owner's subject controls. The configured recipient is shown using a verified name or a localized service-owner label plus an opaque alias.

The existing v34/v35 `telegram_state` store contains non-health control records, outside expiring Settings sessions:

- Opaque HMAC-derived per-source/recipient/class keys identify a signed consent head and retained signed revision records.
- A transaction writes the next revision record, compares and swaps the exact prior head, and records a signed operation receipt. Revision and operation records are inserted once by this module and never pruned or overwritten by it.
- Signed records bind their opaque principal identifiers, class, both authority snapshots, revision, previous seal, operation digest and timestamp. They contain no health measurements, raw user IDs or chat IDs.
- Verification requires a matching revision record and rejects a head when a later adjacent revision barrier exists. Replaying an old operation never writes or revives a revoked grant. Deleting a head does not permit revision reset because its retained revision key still exists.
- This is an application-enforced control ledger using existing storage, not a new database-immutable table. It does not protect against an administrator deleting or restoring the entire database and its history. Recovery must preserve the current consent heads and revision/operation barriers.

Consent changes atomically invalidate pending owner deliveries and physically retract the copied authorization/payload health content. Delivery identities and attempt truth remain: withdrawal during an already-started attempt retains an ambiguous no-resend barrier, and later provider settlement records its actual result without rehydrating the erased copy. A regrant does not revive an old proposal or semantic identity. Already delivered Telegram messages cannot be recalled by this contract.

Owner enumeration, configuration, scoped synthesis, pending reads, authorization and delivery validation all require source consent. Captured owner authorizations include its revision and seal. Final dispatch revalidates after the last separate runtime-fence await immediately before starting provider IO. Withdrawal after that final admission may race with an already in-flight provider request; its persisted barrier and provider outcome remain distinct.

The runtime owns the consent factory and pins its recipient. A supplied store must be issued by that factory for the same connection, keys and recipient. There is no request-controlled verifier or rollout override. Disabling owner monitoring denies grants and access while authenticated sources retain the ability to revoke. No settings default creates consent or follow subscriptions.

Focused software evidence is in `test/stage8-source-consent.test.js`. Existing owner-positive synthetic fixtures invoke the source-side grant explicitly through `test/stage8SourceConsentFixture.js`; owner follow alone never grants it. These tests do not establish Production consent, health results, delivery or real-user interaction.
