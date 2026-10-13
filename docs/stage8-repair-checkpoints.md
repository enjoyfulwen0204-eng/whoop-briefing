# Stage 8 Independent Review Repair Checkpoints

Baseline: `5dc3462de7e67e63246657e9c7e4ae92249bf108`. Dedicated branch only; Production and credentials untouched. F02 remains Owner Accepted Risk.

## P0 safety and recovery

Deterministic urgency and symptom education now precede Stage 8 routing. Recovery profiles reject all active Stage 8 gates and delivery cutover before database/provider access. Configuration proof includes Stage 8 cohort/gates/cutover, and retained runtimes fence changes during processing and send.

Verification: `p0-focused.tap`, 32/32 passed, zero skipped/cancelled. This is synthetic code evidence, not LIVE acceptance. Stage 6 source was not imported.
