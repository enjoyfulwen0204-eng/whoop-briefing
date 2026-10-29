# Round 4 local v33 candidate scope

Base: `9a8c951deee42ad9f6fd9c5828edad44f246d5f7`. Local candidate only; no release authorization.

The only supported process entry is `node src/recoveryEntry.js` (npm start / bot:webhook).
It loads no environment file, requires both exact checkout pins, original key material,
canonical production DB identity, the original trusted STAGE8_SCHEMA_TRANSITION profile,
Advanced OFF and sync-only continuation. Existing business and signed scheduler paths
retain their original Admission and privacy/tenant/lifecycle authority. Polling,
supervisor, maintenance and legacy startup reject before creating clients. Remote
migration is refused before SQL at runMigrations and legacy controlledMigration;
legacy and Stage8 migration CLI main entries reject before opening clients. Retained
operator helper modules are not selected by recovery entry; this is not a sandbox
against arbitrary newly written JavaScript importing raw database clients.
Local file migration exists only to seed synthetic
fixtures; this artifact contains no production index-remediation operator.

Runtime Admission is restricted to v33; its canonical catalog/retired-object/key checks
remain strict. The two retired production indexes require a separately authorized
operator after all old A writers/schedulers are quiescent. This candidate will reject
them; it will not drop them or replay migrations.

Lifecycle transitions retain report claims. Atomic takeover only permits CLAIMED;
DELIVERY_STARTED, AMBIGUOUS and DELIVERED never become new send authority across a
lifecycle transition. Existing known definite-failure handling is unchanged. Original
Telegram operation, Stage7 delivery/attempt/message/callback identities are retained.

Stage7 source-only deltas are exact patches from d1040ccf8e798e3058fb9fdbf28c8106f356bd3a
and 29ee2aef00fde3ec20919bbb4561bef33eb84bec. All five target files matched their preimages
at B. Their dependencies (intent exports, profileRevision initialize:false,
workStepOptions discardResult/replay) already exist at B. No H/R22 tree integration.
Emoji/callback/confirm/missing/undo implementations outside these patches are unchanged.
No real callback acceptance is claimed. Testing is limited to three Round4 targets.

Production gates remain open: operator-only two-index remediation and old-writer
exclusion; actual original-key/profile/connection Admission; writer/scheduler cutover
and original receipt/unknown-ACK continuity; independent exact release authorization;
real Stage7 callback acceptance. Stage6 Option C and Advanced OFF are preserved.
