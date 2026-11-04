# Cloudflare / Render v33 recovery runbook

目前正式入口：`node src/recoveryEntry.js`；Render `whoop-telegram-webhook` 為 Starter、Oregon、1 instance、Auto Deploy OFF。DB schema v33；不允許自動 migration。Stage 8 LIVE、BODY_ENERGY_PUBLICATION／ALERTS 保持 OFF。

- UTC Cron：`*/10 0-3 * * *`、`10 4-23 * * *`，44 次／日；兩種都做完整 SYNC。
- 順序：SYNC → companion → extras；UTC 19:10／20:10／21:10 加 analytics。companion/extras 各 45 秒、analytics 90 秒，不能把 HTTP 200 當成沒有 DEFERRED_BUDGET。
- 配對：Render `PHASE4_RELEASE_SHA` = 實際 deploy commit；Worker `BRIEFING_RELEASE_SHA` 同值，proof 在 Render instance 計算。Discovery on、scope sync、execution mode OFF。OFF 不會關閉 SYNC。
- GitHub workflow 已停用，secrets 已移除；不要把歷史備援當成現行 writer。
- 避開台北 08:00–12:00；等自然 :10 cron 結束才開始授權部署。新 Live 後等兩分鐘，SSH 核對三個 SHA；不符時斷線等一分鐘，最多五次。失敗依當次 Owner 指定 SHA 回退，不自行回到 legacy A。
- 環境更新工具可能同時觸發部署，操作後先讀回 deploy 清單，避免重複 deploy；不要更動 secrets。驗收 `/health`、精確 SHA、啟動拒絕錯誤，以及下一次自然 SYNC/companion/extras 的狀態、耗時與 deferred_steps。
- 不手動觸發排程、同步、分析或測試訊息。服務設定的歷史觀測不能代替下一次操作前的讀回。

## 用 Render SSH 計算 Config Proof

以下是恢復版本的操作步驟；不執行下方歷史版本的 migration 或金鑰輪替。

1. 先取得部署與 SSH 存取授權。若 Web Shell 不穩定，使用專用
   `~/.ssh/render_whoop` Ed25519 金鑰；不得覆蓋既有金鑰、輸出或複製私鑰。
   只將 `.pub` 公鑰加入 Render Account Settings → SSH Public Keys，名稱
   `whoop-codex`。這是帳戶層級存取，僅用於本服務。
2. 從 `srv-dahs71qd0e5s738n94c0` 服務的 Connect → SSH 複製當前連線目標，
   使用 `ssh -i ~/.ssh/render_whoop -o IdentitiesOnly=yes <Dashboard 顯示的目標>`。
   首次連線須核對 [Render 官方區域 fingerprint](https://render.com/docs/ssh#renders-public-key-fingerprints)，
   不得停用 host-key verification；不要使用 ephemeral shell。
3. 等自然 cron 完成後開始變更窗口。只儲存 `PHASE4_RELEASE_SHA`，部署指定 commit，
   核對 live SHA、`/health` 和啟動錯誤，再重新 SSH 到新 instance。
4. 在遠端專案根目錄核對 `git rev-parse HEAD`、`RENDER_GIT_COMMIT` 與
   `PHASE4_RELEASE_SHA` 全部等於已批准的完整 SHA，並確認 `RENDER_SERVICE_ID`
   是上述服務。任何不符立即停止，不計算 proof。
5. 只在遠端 Node 程序內，以現有 `phase4AuthorityKeys(process.env)`、
   `publicBetaConfiguration(process.env)` 呼叫
   `configurationProof(keys, config, process.env)`；不啟動 App、資料庫、migration、
   runtime admission 或任何 provider。不要輸出環境變數、message 或 stack；
   失敗只回傳固定錯誤碼。
6. Proof 只經 SSH 回傳到當次操作的記憶體，直接套用 Cloudflare 的
   `BRIEFING_CONFIG_PROOF`，同時更新 `BRIEFING_RELEASE_SHA`；不要寫入 shell history、
   repo、文件、報告或應用程式 log，也不可把 Render 環境值搬到本機計算。
   其餘 Worker 設定與 secret 維持原值。
7. 部署 Worker 後等下一次自然 cron，核對 readiness 200、companion 200 與失敗 0 人；
   不手動觸發、不發測試訊息。若失敗，依該次 Owner 批准的已知 SHA／proof 配對回退，
   保留 main 與原資料，不自行修改程式或金鑰。

本小節的文件 commit 與執行版本分開；僅文件變更不需要重新部署。

## 歷史 V1.2 / v20–v32 參考（不適用目前 production）

以下保留作為歷史參考。Free 方案、GitHub 備援、舊 migration、舊 scope 和建立金鑰的指令均不可直接執行；相關引用文件保留，完整快照另存 archive/evidence-20261104。

<details><summary>歷史內容</summary>

## V1.2 scheduler facts

| Item | Value |
|---|---|
| Historical V1.2 schema | **20**; Phase 4 repository target is **31** |
| Canonical timezone | **Asia/Taipei** (Kelvin's stored `users.timezone`) |
| Historical V1.2 primary scheduler | Cloudflare Worker Cron, **every 10 minutes all day** |
| Phase 4 repository target | Cloudflare Worker Cron, `*/10 0-3 * * *` UTC |
| Fallback scheduler | GitHub Actions, **hourly at minute 17** |
| Wake readiness | main sleep SCORED + matching recovery SCORED + ≥ 30 min since sleep end |
| Normal delivery | `age ≤ 24 h` |
| Late delivery | `24 h < age ≤ 48 h` (inclusive) — labelled 補發, same `health_date` idempotency key |
| Missed | `age > 48 h` — persisted `MISSED`, exactly one short notification, terminal |
| Outage alert cooldown | 24 h for `scheduler_primary_stale`; 2 h for generic errors |

## Architecture

The historical V1.2 Cloudflare Cron (`*/10 * * * *`, UTC) signs a small POST to
`https://<render-host>/internal/briefing/run`. The Render webhook service awaits the existing
canonical briefing runner. GitHub Actions runs that same runner directly at `17 * * * *` as an
independent hourly backup. Overlap is safe because `report_claims` enforces at most one accepted
Telegram daily report per `(user_id, report_type, health_date)`.

Both triggers therefore also share the same production-maintenance ownership:

- webhook ledger drain runs once per canonical invocation with both a 25-event count bound and an
  independent 25-second wall-clock budget; the deadline cancels provider I/O and retry waits, event
  claims and leases make overlap safe, and ingress may remain disabled while a backlog drains;
- existing daily/weekly claim work keeps its delivery priority; normal incremental sync follows,
  then FAST reconciliation runs when durable per-user/per-resource state is due (about every 24 hours),
  before proactive and synchronous analytics work;
- DEEP reconciliation remains operator-triggered;
- Phase 3 `analytics:light` / `analytics:heavy` workers remain dormant.

The 25-second webhook budget is independent of the rest of a canonical run. FAST reconciliation
retains its existing resource/page caps, and normal user work retains the configured bounded user
concurrency. These bounds reserve scheduler time after webhook maintenance; they do not claim a
single hard wall-clock limit for every possible multi-user sync/report workload.

Normal detection delay is approximately 10 minutes plus provider/startup latency. With Cloudflare
unavailable, the GitHub backup's configured upper bound is approximately 60 minutes plus GitHub's
unbounded scheduling delay. If both providers fail there is no internal alert or delivery guarantee.

## Required configuration

**Render web service `whoop-telegram-webhook`** (values are set in the Render dashboard, never in git):

| Variable | Purpose |
|---|---|
| `TELEGRAM_BOT_TOKEN` | inbound webhook + outbound delivery |
| `TELEGRAM_WEBHOOK_SECRET` | Telegram webhook authentication |
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | production database |
| `OPENROUTER_API_KEY` | narrative generation |
| `TELEGRAM_CHAT_ID` | system-level notifications from the canonical runner |
| `WHOOP_CLIENT_ID`, `WHOOP_CLIENT_SECRET` | the scheduler route runs the canonical runner, which polls WHOOP |
| `WHOOP_REDIRECT_URI` | Phase 3.5 OAuth callback; must exactly match the WHOOP Dashboard value |
| `BRIEFING_TRIGGER_SECRET` | ≥ 32 bytes; must match the Worker secret exactly |

If the scheduler variables are absent or the secret is too weak, the service still starts and
**inbound Telegram keeps working**; only `/internal/briefing/run` is disabled and returns `503`.
`/health` reports `scheduler: enabled | incomplete | weak_secret | disabled` and never a secret
value. HTTP 200 alone means only that the web process is live; scheduler readiness requires
`scheduler: "enabled"`. Optional WHOOP event ingress remains off unless
`WHOOP_WEBHOOK_ENABLED=true`; it is not a scheduler prerequisite.

**Cloudflare Worker `whoop-briefing-scheduler`** — only two settings, and no health credentials:

| Setting | How |
|---|---|
| `BRIEFING_ENDPOINT_URL` | `[vars]` in `wrangler.toml`, replaced from the placeholder |
| `BRIEFING_TRIGGER_SECRET` | `wrangler secret put` — never in `wrangler.toml`, never in git |
| Historical V1.2 Cron trigger | `*/10 * * * *`; Phase 4 checked-in target is `*/10 0-3 * * *` |

## Provision and validate

> **Activation order:** provision all Render scheduler variables before deploying the new SHA.
> Missing scheduler-only configuration now leaves Telegram inbound online and keeps the scheduler
> route fail-closed as unavailable (`503`), but pre-provisioning avoids a partially activated
> production state. The scheduler route never fails open.

1. Create a Worker using `cloudflare/briefing-scheduler`; do not add WHOOP, Turso, OpenRouter, or
   Telegram credentials to it.
2. Authenticate Wrangler using the account's standard least-privilege procedure.
3. Replace only the placeholder `BRIEFING_ENDPOINT_URL` with the exact Render HTTPS endpoint.
4. Generate one strong random value outside shell history and configure the same value as the
   Render `BRIEFING_TRIGGER_SECRET` and via `wrangler secret put BRIEFING_TRIGGER_SECRET`.
5. Add `WHOOP_CLIENT_ID`, `WHOOP_CLIENT_SECRET`, `TELEGRAM_CHAT_ID`, and
   `BRIEFING_TRIGGER_SECRET` to the existing Render webhook service. Preserve its existing
   Telegram bot token, Turso, and OpenRouter settings.
6. Deploy the reviewed Render SHA first, verify `/health`, then deploy with `wrangler deploy`.
7. For Phase 4, follow the staged transition and read back only `*/10 0-3 * * *` after propagation; do not use cron time as a health date.
8. Confirm GitHub's workflow remains enabled at `17 * * * *`; it requires its existing seven
   repository secrets and no trigger secret.
9. Observe a natural invocation: authenticated request, aggregate completion, per-source heartbeat,
   and no duplicate report. Do not manually generate a briefing as a smoke test.

## Rotation and rollback

These are historical V1.2 controls. After Phase 4 v31 migration, use the
[v31-compatible rollback contract](phase4-deployment-control.md#rollback-and-disaster-recovery);
the old v20 binary cannot run against v31.

- Rotation: update Render and Worker secret during one controlled window. Brief authentication
  failures are safe and non-retryable; never log either value.
- Disable Cloudflare: remove/disable its Cron Trigger. GitHub remains the backup.
- Disable GitHub: disable only the workflow schedule after Cloudflare heartbeat is proven healthy.
- Worker rollback: deploy the previously reviewed Worker version or disable the Cron Trigger.
- Render rollback: deploy the prior application SHA and remove `BRIEFING_TRIGGER_SECRET` only after
  the Worker trigger is disabled.
- GitHub rollback: restore the previous reviewed cron expression independently.
- Never enable a Render cron concurrently with these triggers.

The two providers can watch each other only while at least one still runs. If both stop, an external
third-party monitor is required; this repository cannot truthfully detect total silence by itself.

## Free-plan operating envelope

The historical all-day cadence uses 144 invocations/day. The checked-in Phase 4
morning-window target uses 24 invocations/day. Each invocation makes at most three outbound subrequests
per invocation. The Worker performs only UUID generation, SHA-256/HMAC, one small fetch, bounded
response draining, and short retry waits. Each request timeout is two minutes and three attempts fit
inside Cloudflare's 15-minute Cron wall-time limit. Network wait does not consume CPU time, but the
Free plan's CPU allowance remains tight; verify CPU metrics after deployment. Cron execution is UTC
and is not guaranteed, which is why the independent GitHub backup remains enabled.

## WHOOP request budget and supported scale

This V1.1 deployment is supported for its current personal, one-user use. A not-yet-settled daily
briefing performs lightweight sleep/recovery polling on each invocation; full resource sync remains
throttled to approximately hourly. Existing WHOOP handling backs off and retries `429` responses.
At 144 primary invocations plus best-effort backup runs, the expected one-user budget is roughly
122–250 WHOOP calls/day. Ten users can require roughly 1,220–2,500 calls/day. Do not expand toward
100 users under this design: the repository's documented 10,000-request/day allowance would be at
risk. Reassess batching/cadence before onboarding more than ten active users. OpenRouter is not
called until wake eligibility is satisfied and the durable report claim is acquired.

</details>
