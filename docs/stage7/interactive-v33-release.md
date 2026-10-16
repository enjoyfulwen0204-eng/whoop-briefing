# Coach and Journal interactive v33 release

Base: deployed `2340e8bc305c6acde29bbfa540753e79dbd34408` (schema32).
Selected software: Stage7 Journal through `a1ec731` and reviewed Coach/composition/reply/schema source from `828b3ba`. The Production DOMAIN replay and read fences remain in place. No Stage8, v34/v35, new Worker endpoint, Morning Readiness or full-analysis implementation is included.

This release exposes manual `/coach`, `/journal`, localized contextual choices and the existing Settings entry through the existing authenticated Telegram ingress. Journal confirmation, correction, undo, skip and free-text handling retain existing durable action/delivery receipts. Automatic invitation scheduling is not activated by this interactive release; stored preferences do not grant producing authority.

Three-user admission requires exactly the immutable approved cohort digest in `stage7Cohort.js`, shared by configuration and provider construction. Private IDs remain outside source. The prior independently reviewed singleton configuration remains available for compatibility; it is not an added rollout stage. Existing lifecycle/auth/profile/source/privacy fences and individual notification preferences remain authoritative.

Deployment profile: `STAGE7_COMPANION=on` with exactly those three existing internal IDs; unfinished computation and presentation disabled (`PHASE4_BETA_SHADOW_RUNTIME=off`, `PHASE4_PUBLIC_BETA_MODE=off`, empty beta IDs, Body publication/alerts off). Existing Worker phase mode, release SHA and configuration proof must match this actual checkout/profile before scheduled service resumes. Do not bypass the old SHA/proof checks.

Only controlled32→33 is required. The existing migration CLI must have the exact clean release commit, verified private backup, all writers quiescent, existing lookup/audit keys and successful pre/postconditions. Do not auto-migrate at application startup. Same-schema recovery uses this v33 binary with `COMPANION_V33_RECOVERY` and companion/body/beta off, preserving all rows, callbacks and pending delivery state; old strict-v32 `2340e8bc` is not a post-migration recovery binary.

The focused release tests exercise real localhost HTTP ingress and Telegram API serialization (synthetic provider only), all three locales, Journal persistence/edit/undo/skip, private actor and duplicate fences, interruption/resume/no-op33 and the existing signed SYNC/canonical briefing recovery route. They are software evidence; only actual provider migration/deployment/readbacks and real Telegram delivery/callback acceptance can establish Production LIVE.
