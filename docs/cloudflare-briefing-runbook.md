# Cloudflare briefing scheduler runbook (V1.1)

This runbook is intentionally inert. Commands below are for a reviewed production change window.

## V1.1 release facts

| Item | Value |
|---|---|
| Schema version | **8** (adds `briefing_evaluations`; additive, `IF NOT EXISTS`, never rebuilt) |
| Canonical timezone | **Asia/Taipei** (Kelvin's stored `users.timezone`) |
| Primary scheduler | Cloudflare Worker Cron, **every 10 minutes** |
| Fallback scheduler | GitHub Actions, **hourly at minute 17** |
| Wake readiness | main sleep SCORED + matching recovery SCORED + ≥ 30 min since sleep end |
| Normal delivery | `age ≤ 24 h` |
| Late delivery | `24 h < age ≤ 48 h` (inclusive) — labelled 補發, same `health_date` idempotency key |
| Missed | `age > 48 h` — persisted `MISSED`, exactly one short notification, terminal |
| Outage alert cooldown | 24 h for `scheduler_primary_stale`; 2 h for generic errors |

## Architecture

Cloudflare Cron (`*/10 * * * *`, UTC) signs a small POST to
`https://<render-host>/internal/briefing/run`. The Render webhook service awaits the existing
canonical briefing runner. GitHub Actions runs that same runner directly at `17 * * * *` as an
independent hourly backup. Overlap is safe because `report_claims` enforces at most one accepted
Telegram daily report per `(user_id, report_type, health_date)`.

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
| `BRIEFING_TRIGGER_SECRET` | ≥ 32 bytes; must match the Worker secret exactly |

If the scheduler variables are absent or the secret is too weak, the service still starts and
**inbound Telegram keeps working**; only `/internal/briefing/run` is disabled and returns `503`.
`/health` reports `scheduler: enabled | incomplete | weak_secret | disabled` and never a value.

**Cloudflare Worker `whoop-briefing-scheduler`** — only two settings, and no health credentials:

| Setting | How |
|---|---|
| `BRIEFING_ENDPOINT_URL` | `[vars]` in `wrangler.toml`, replaced from the placeholder |
| `BRIEFING_TRIGGER_SECRET` | `wrangler secret put` — never in `wrangler.toml`, never in git |
| Cron trigger | `*/10 * * * *` |

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
7. Confirm the Cron Trigger is `*/10 * * * *`; do not use cron time as a health date.
8. Confirm GitHub's workflow remains enabled at `17 * * * *`; it requires its existing seven
   repository secrets and no trigger secret.
9. Observe a natural invocation: authenticated request, aggregate completion, per-source heartbeat,
   and no duplicate report. Do not manually generate a briefing as a smoke test.

## Rotation and rollback

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

At a ten-minute cadence this Worker uses 144 invocations/day and at most three outbound subrequests
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
