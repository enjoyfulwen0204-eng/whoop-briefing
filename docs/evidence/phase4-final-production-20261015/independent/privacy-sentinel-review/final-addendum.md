# Independent privacy sentinel/import-cycle addendum

**Scoped sentinel repair: GO. Global integrated release: NO-GO. Full foundation privacy gate: NO-GO with two retained baseline failures.** No release or Production migration approval is given.

Latest reviewed test checkpoint `d539277abbb13191f6110dac92a2cb32a0cd2511`, tree `678bbdfb73aede1d5737cae5f6c99c88302802be`. Runtime source is byte-identical to reviewed repair `aa2c45d6f75b91ff3d2ac82a32ee4ecae427d2f2` (tree `55be0005d700d2229d2f4e19ff4eb6593cebb2e8`), src tree `ebdbdd02c76a8bbf583e628b01e96649eaadcdce`. Review clone is clean and detached. All325 runtime file hashes are in `aa2-integration-identity.json`; canonical runtime manifest SHA-256 `366b8464b7b9677d03c4863e509ce56e0d2f4686cd2e0fee78f8229318e45b5d`.

## Defect and exact repair

Independently reproduced both original standalone failures on6f5ebdc: body-provisional-policy and stage7-cards each exited1 with `Cannot access 'HEALTH_REDACTED' before initialization` from phase4Redaction.js18. These are real module initialization defects, not invalid test expectations. Original failing TAPs/results/hashes remain here.

The runtime diff is exactly three files: dependency-free phase4PrivacySentinels.js introduces the two existing literal declarations; phase4V22Backfill imports and reexports them; phase4Redaction imports those strings from the leaf while retaining EXPERIMENT_SENTINELS/addPrivacyLink from Backfill. The literal declaration bytes are identical. Independently checked the runtime values and existing Backfill export API. Normalizing only these declared import/reexport changes makes **both entire existing source files byte-identical to6f5ebdc**. No privacy predicate, SQL, receipt text, experiment-sentinel construction, schema/enrollment logic or other function body changed. Protected triage/safety/schema33/34/35 files remain unchanged.

Independent fresh processes imported each of privacy sentinels, Backfill, Redaction, Stage7 cards, Body Energy qualification authority, Stage8 LIVE producer and ResultAuthority directly: **7/7 exit0, no fixture/order imports**, no native signal. This also resolves the direct ResultAuthority initialization path observed earlier; no ordering workaround was used for this matrix.

## Exact test results and limits

Onaa2 the independent command ran module-initialization, the two formerly failing product files, ordered-v35-recovery, phase4-privacy and phase4-foundation-privacy in isolated test-file processes with concurrency1. **41 definitions:39PASS/2FAIL,0skip/cancel; exit1;23.977070s.**

- Product+initialization:24/24PASS.
- Original phase4-privacy suite:8/8PASS, including real transitive content erasure, receipt redaction value/action barriers, replay suppression, tenant isolation, failed T1 recovery, cache ACK, lifecycle/ABA and stale-delivery fencing.
- Local ordered migration/recovery: original aa2 version1/1PASS but had empty Telegram/workout/Journal witnesses. The test-only d539 successor remedies that evidence limit. I independently reviewed the entire successor diff, verified identical runtime src, and reran the populated test: **1/1PASS, exit0,3.560234s** (an earlier direct run is also retained, not counted as a second distinct definition). It explicitly migrates32→33→34 and compares all original source rows; Telegram/workout are already populated at32. At34 it creates an authentic explicit caffeine Journal fact through Foundation and requires all8 source tables to have nonempty witnesses. It then executes the first additive35 CREATE without its marker, admits34, resumes35, repeats the35 no-op, preserves all preexisting34 DDL and all8 source table rows/provenance byte-for-byte, checks integrity/FK, keeps same-schema feature-off runtimes null and creates zero LIVE executions/publications. The nonempty Journal preservation witness is34→35; Journal was empty32→34. This is local synthetic file evidence only; it does not qualify Production migration, backups, rollback or downgrade.
- Extended foundation privacy:6PASS/**2FAIL**. AMBIGUOUS and DELIVERED occupied-question-window purge cases fail at phase4-foundation-privacy.test.js105 with `PHASE4_PURGE_CLOSURE_UNPROVEN` in stage5PrivacyIndex203. I checked out exact6f5ebdc, ran those same two definitions, and independently reproduced **0PASS/2FAIL with the same code/location**, then restored clean aa2. They are unchanged baseline/integration failures; no new sentinel regression is observed. Source analysis and the parent’s scoped diagnostic identify a completed LIVE method=SYNTHETIC evidence run with null input_manifest_json: the old Journal-question fixture creates this scaffold without an independently authenticated root manifest, and the oracle explicitly refuses to certify an unrooted readable node. No oracle change was made. The fixture/suite remains failing; it cannot be reported as a green full privacy gate until separately corrected with legitimate evidence.

The earlier independent669/669 scoped evidence was executed at6f5ebdc, not rerun as669 ataa2. Its implementation remains unchanged except the reviewed literal/import relocation; carry it forward only with that explicit delta qualification. It is not a full repository suite.

## Continuing release gates

The prior report's weekly CURRENT completion, native cleanup/actual service containment, Linux0.5CPU/512MiB HTTP capacity, original Stage6 metadata recovery/503 bookkeeping, full monitored convergence and controlled Production migration/deployment gates remain NO-GO. The two baseline purge-closure failures are additionally retained as an open foundation privacy gate. No original database, grant, token, release state or candidate source was modified by this reviewer.

The subsequently described uncommitted coverage-clock/event-loop diagnostics were not reviewed as a new immutable checkpoint and confer no qualification.

Evidence: `d539-populated-ordered-recovery.json`/TAP, `aa2-source-delta-verification.json`, `aa2-independent-init-matrix.json`, `aa2-product-init-ordered-privacy.*`, baseline6f standalone failures and `6f-foundation-question-purge-baseline.*`. These independently distinguish the fixed entry defect from unchanged privacy failure. Report and evidence hashes are in `addendum-artifact-hashes.json`.
