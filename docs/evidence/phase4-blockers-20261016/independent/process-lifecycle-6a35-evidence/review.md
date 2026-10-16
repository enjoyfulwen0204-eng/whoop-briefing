# Independent lifecycle and real-process restart review

**Scoped GO for these two synthetic witnesses at exact6a35. Global NO_GO remains.**

Fresh detached checkout `6a35a871d06f1028e7cefc643ba523d50e52a769`, src tree `c8b636b3e07a69c6c025a6d8a3a639ea3873faf6`, test tree `2a4ad53a5f30d9e1862967f203b3379264afe871`. Independent diff against59cb contains exactly three added test/helper files and no runtime/config/package/schema change. Every protected src/test/package file, HEAD and tree binding remained unchanged through the runs. Node v22.23.2 Darwin arm64; no NODE_OPTIONS or added GC/profiler. No candidate, Production or original campaign mutation.

## Independent executions

1. Ordinary sandbox lifecycle attempt:0 PASS/1 FAIL,exit1,2.480572458s. Actual server startup was denied with `listen EPERM: operation not permitted 0.0.0.0` before the shutdown witness. Preserved as ENVIRONMENT_DENIAL, not a functional PASS or proof of a runtime defect. TAP SHA256 `b739aac877aa6643f77a5bf31b37e22f913c5adeaeb54e04d81dc7900929e317`.
2. Real process restart:1 PASS/0 FAIL/0 CANCEL,exit0,80.4561205s wait4 elapsed; peak RSS467,189,760B. Original test ceiling180000ms, external190s watchdog did not fire. Fourteen distinct real child PIDs. TAP SHA256 `e0aa2de9c191204690f34f41e2189093c8e370f8c148d8edda6316c3d93cbc54`.
3. After restart exited, permission for the exact unchanged lifecycle command was requested through exec_command require_escalated and approved. Provider fetch remained blocked by the test. This permission restoration yielded1 PASS/0 FAIL/0 CANCEL,exit0,TAP duration4288.490125ms; peak RSS was not collected for this approved run. Test ceiling180000ms unchanged. TAP SHA256 `145ac341e9072692a7a6a784683c51ab976ffd5982cd2a7e763b5bf703f19bd1`. Original denial is preserved; no bind/test/runtime change or denial bypass occurred. This is not a runtime fix or a native pass-retry inference.

## What the witnesses establish

The actual exported webhook main starts its real listener and configured continuation loop against a disposable, genuinely migrated/populated local fixture. The test holds an already-executed metadata query's ACK. Actual SIGTERM does not close the DB during the hold; after release, shutdown joins it, closes the server, calls DB close exactly once, and a repeated SIGTERM does not close again. Its fetch counter remains zero. This witnesses actual startup/signal/shutdown composition, rather than only a fake loop. The hold is150ms, so this new witness alone is not the >5s abort-deadline test; the prior exact59cb independent delayed-ACK counterexample already covers that longer join boundary.

The restart helper confines file DB creation to its fresh synthetic tmpdir prefix and fixed fixture basename, uses the original owned-file DB/admission/foundation/runtime, minimal PATH/TMPDIR environment and fixture keys, and blocks provider fetch. It does not import Production credentials or create a new authority adapter. Genuine SYNC/source metadata and original LIVE producer execute; no producer/result/receipt is fabricated.

The crash witness uses synchronous fs.writeSync to preserve counts immediately before a kernel SIGKILL at the actual pre-progress-write gap after finalized LIVE work. It observed one original SYNC, one LIVE execution and nine work receipts. A fresh PID returned BUSY with exactly those counts while the original60s subject lock remained live. The test waited for its original natural expiry with no fake clock/lease update/reset. The first post-expiry fresh PID replayed the same child with nine receipts and no new LIVE execution. Further fresh processes continued original bounded runtime work to CURRENT: still one SYNC,11 LIVE executions,81 receipts,two completed jobs. One final PID returned `{status:'IDLE',invoked:0}` with all counts unchanged. It does not create another SYNC or bypass signed parent/progress/replay admission. Fourteen actual distinct PIDs were recorded.

Static review found no changed authority, admission, cohort, mode, producer, ordinal/deadline or privacy predicate in this test-only successor. The helper is not wired into Production. The selected synthetic crash is after finalized work/before progress, not arbitrary mid-transaction or native cleanup failure coverage. SIGKILL recovery does not itself prove signal/memory containment for production LIVE work.

## Reuse and remaining gates

The runtime src tree is byte-identical to independently reviewed59cb. Its previous20 focused authority/ordinal/lease/revocation/delayed-ACK checks and two full WEEKLY + owned DAILY/IMPORTANT functional files remain exact59cb evidence reusable for unchanged runtime bytes. Those whole functional files were not rerun or relabelled as6a35 executions. New6a35 witnesses ran with their actual6a35 release identity.

No native fix, process-memory containment, Linux HTTP transport or Render0.5CPU/512MiB qualification follows. Retained baseline SIGSEGV, withdrawn fairness native abort, generic14PASS/1CANCEL cleanup diagnostics and multi-GiB full-class resource results remain failures/limitations. Original campaign settlement, migration/quiescence, provider access and operational rollout remain outside this scoped acceptance. Whole release remains NO_GO.

Test identities: lifecycle `fdb5243f979b5e9d1da3a689763e2d5d32487f7e2543d83f4341890f47bd2d4e`; restart `87b897f565e9b713bf68e12bc25d7c50885a379fc8e290b9dd5468c726d6e9c9`; child helper `ca9860c7c2740bb799dafdc281a1d0b66e6961349594539770445b36009cadf4`. Adjacent result, TAP, restart-event and binding JSON preserve execution details; artifact-hashes.json pins the report and evidence.
