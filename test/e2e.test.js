/**
 * 端到端：直接跑 src/index.js 的 main()，把 WHOOP / OpenRouter / Telegram 三個
 * 外部服務都攔下來，Turso 換成本機 SQLite 檔案。
 * 驗證整條線接得起來，而且第二次執行不會重複發。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { main } from '../src/index.js';
import { createDb } from '../src/db.js';
import { addDays, localDate } from '../src/time.js';
import { WHOOP_SYNC } from '../src/config.js';
import { makeDataset } from './fixtures.js';

const TZ = 'Asia/Taipei';
const U = 'u-e2e-test';

function installMockFetch({ dataset, calls }) {
  const original = globalThis.fetch;

  const page = (records, url) => {
    const limit = Number(url.searchParams.get('limit') || 25);
    const token = url.searchParams.get('nextToken');
    const offset = token ? Number(token) : 0;
    const slice = records.slice(offset, offset + limit);
    const next = offset + limit < records.length ? String(offset + limit) : null;
    return { records: slice, next_token: next };
  };

  const json = (body, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  });

  globalThis.fetch = async (input, init = {}) => {
    const raw = typeof input === 'string' ? input : input.url;
    const url = new URL(raw);
    calls.push({ host: url.host, path: url.pathname });

    if (url.host === 'api.prod.whoop.com') {
      if (url.pathname === '/oauth/oauth2/token') {
        return json({
          access_token: 'e2e-access', refresh_token: 'e2e-refresh',
          expires_in: 3600, scope: 'offline read:recovery read:sleep read:cycles',
        });
      }
      if (url.pathname === '/developer/v2/activity/sleep') return json(page(dataset.sleeps, url));
      if (url.pathname === '/developer/v2/recovery') return json(page(dataset.recoveries, url));
      if (url.pathname === '/developer/v2/cycle') return json(page(dataset.cycles, url));
      return json({ error: 'unexpected path' }, 404);
    }

    if (url.host === 'openrouter.ai') {
      const body = JSON.parse(init.body);
      calls.push({
        host: 'openrouter', path: url.pathname, model: body.model, reasoning: body.reasoning,
      });
      return json({
        id: 'gen_e2e',
        object: 'chat.completion',
        model: body.model,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: '早安 Kelvin，今天狀態看起來不錯，放心去衝 💪' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 500, completion_tokens: 80, total_tokens: 580 },
      });
    }

    if (url.host === 'api.telegram.org') {
      const body = JSON.parse(init.body);
      calls.push({ host: 'telegram', text: body.text, parse_mode: body.parse_mode });
      return json({ ok: true, result: { message_id: 4242 } });
    }

    throw new Error(`測試沒預期到的外部呼叫：${raw}`);
  };

  return () => { globalThis.fetch = original; };
}

test('端到端：main() 完整跑一次會發出簡報，第二次不重複發', async () => {
  const now = new Date('2026-08-21T00:00:00Z'); // 台灣 08:00
  const dataset = makeDataset({ days: 45, now });
  const today = localDate(now, TZ);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whoop-e2e-'));
  const dbUrl = `file:${path.join(dir, 'e2e.db')}`;
  const cwd = process.cwd();
  const savedEnv = { ...process.env };
  const calls = [];
  const restoreFetch = installMockFetch({ dataset, calls });

  try {
    // 換到暫存目錄，確保不會誤讀到專案裡真正的 .env
    process.chdir(dir);
    Object.assign(process.env, {
      WHOOP_CLIENT_ID: 'cid',
      WHOOP_CLIENT_SECRET: 'sec',
      WHOOP_REDIRECT_URI: 'http://localhost:8788/callback',
      OPENROUTER_API_KEY: 'sk-or-test',
      OPENROUTER_MODEL: 'anthropic/claude-sonnet-5',
      TELEGRAM_BOT_TOKEN: '123:abc',
      TELEGRAM_CHAT_ID: '999',
      TURSO_DATABASE_URL: dbUrl,
      TURSO_AUTH_TOKEN: 'unused-for-file-url',
      TIMEZONE: TZ,
    });
    delete process.env.DRY_RUN;

    // Multi-user：先建一個內部使用者並綁定 Telegram，再塞一組還有效的 token
    // （模擬已經跑過 authorize + /link）
    const seed = createDb({ url: dbUrl });
    await seed.migrate();
    await seed.createUser({ id: U, displayName: 'E2E', timezone: TZ, status: 'ACTIVE' });
    await seed.linkTelegram({ chatId: '999', userId: U });
    await seed.saveTokens(U, {
      accessToken: 'seed-access',
      refreshToken: 'seed-refresh',
      // 到期時間要用真實時鐘算（token 是否過期本來就跟注入的 now 無關）
      expiresAt: new Date(Date.now() + 40 * 60_000), // 還有 40 分鐘 → 不該 refresh
      scope: 'offline read:recovery read:sleep read:cycles',
    });
    seed.close();

    // ---- 第一次執行 ----
    const first = await main({ now });
    assert.equal(first.errors.length, 0, JSON.stringify(first.errors));
    assert.equal(first.failed, 0, JSON.stringify(first.perUser));
    const firstUser = first.perUser.find((p) => p.userId === U);
    assert.equal(firstUser.daily, 'sent');
    assert.equal(firstUser.weekly, 'not_run', '不是週一，weekly 不該跑');

    const tg = calls.filter((c) => c.host === 'telegram');
    assert.equal(tg.length, 1);
    assert.match(tg[0].text, /早安，Kelvin/);
    assert.match(tg[0].text, /HRV/);
    assert.doesNotMatch(tg[0].text, /早安 Kelvin，今天狀態看起來不錯/);
    assert.equal(tg[0].parse_mode, undefined, 'Telegram 要用 plain text，不設 parse_mode');
    assert.ok(tg[0].text.length <= 4096);

    const ai = calls.filter((c) => c.host === 'openrouter');
    assert.equal(ai.length, 0, '健康發布不呼叫 prose provider');

    // token 還有效 → 不該打 token endpoint
    assert.equal(calls.filter((c) => c.path === '/oauth/oauth2/token').length, 0);

    // 分頁真的有翻頁（45 天 > 25 筆）
    const sleepCalls = calls.filter((c) => c.path === '/developer/v2/activity/sleep');
    assert.ok(sleepCalls.length >= 2, `應該有分頁，實際 ${sleepCalls.length} 次`);

    // DB 有 SENT 紀錄
    const check = createDb({ url: dbUrl });
    assert.equal(await check.isSent(U, 'daily', today), true);
    const runs = await check.recentRuns(U, 5);
    assert.equal(runs[0].report_type, 'daily');
    assert.equal(runs[0].status, 'SENT');
    assert.equal(String(runs[0].user_id), U, '紀錄必須明確歸屬這個使用者');
    assert.equal(Number(runs[0].telegram_message_id), 4242);
    check.close();

    // ---- 第二次執行：同一個 health_date 已 SENT → 不會重複發 ----
    // 這次還是會輪詢 WHOOP：快速返回的條件是「今天與昨天兩個 health_date 都已 SENT」，
    // 而測試 DB 是全新的、昨天那筆從來沒發過，所以條件不成立。但重點是不會重複發。
    const before = calls.length;
    const second = await main({ now });
    const secondUser = second.perUser.find((p) => p.userId === U);
    assert.equal(secondUser.daily, 'already_sent');
    assert.equal(second.errors.length, 0);
    const after = calls.slice(before);
    assert.equal(
      after.filter((c) => c.host === 'telegram').length, 0,
      `不可重複發訊息，實際：${JSON.stringify(after)}`,
    );
    assert.equal(
      after.filter((c) => c.host === 'openrouter').length, 0,
      '已發過就不該再花錢呼叫模型',
    );

    // ---- 第三次執行：把「昨天」也補記成 SENT → 走快速返回，完全不打外部服務 ----
    const seed2 = createDb({ url: dbUrl });
    const yesterdayKey = addDays(today, -1);
    await seed2.recordRun({
      userId: U,
      reportType: 'daily',
      localDateKey: yesterdayKey,
      healthDate: yesterdayKey,
      status: 'SENT',
    });
    seed2.close();

    // ⚠️ V1.1 Phase 7：報告排程與資料新鮮度已經解耦。
    //
    // 「兩天都已 SENT 且非週一」現在只代表**報告**沒事做，不代表整輪沒事做：
    // 這個帳號的 backfill 還沒跑完，而 backfill 一向不受 MIN_INTERVAL_MS
    // 節流（見 resourceSyncDue），所以同步仍然應該繼續推進。以前它被
    // 報告排程綁住，365 天的 backfill 只能在有報告要發的那幾輪前進。
    //
    // 真正該保證的是：**不可以再發一次報告、不可以再花錢呼叫模型**。
    const before3 = calls.length;
    const third = await main({ now });
    assert.equal(third.users, 1);
    const thirdUser = third.perUser.find((p) => p.userId === U);
    assert.equal(thirdUser.daily, 'not_run', '報告已送出 → 不可以再跑一次日報');
    assert.equal(thirdUser.weekly, 'not_run');

    const after3 = calls.slice(before3);
    assert.equal(
      after3.filter((c) => c.host === 'telegram').length, 0,
      `不可以再送出任何 Telegram 訊息，實際：${JSON.stringify(after3)}`,
    );
    assert.equal(
      after3.filter((c) => c.host === 'openrouter').length, 0,
      '已發過就不該再花錢呼叫模型',
    );

    // ---- 第四次執行：backfill 完成 + 剛同步過 → 真正的 no-op，零外部呼叫 ----
    const seed3 = createDb({ url: dbUrl });
    for (const resource of WHOOP_SYNC.RESOURCES) {
      await seed3.saveSyncState(U, resource, {
        backfillComplete: true,
        lastSuccessAt: now.toISOString(),
      }, { now });
    }
    seed3.close();

    const before4 = calls.length;
    const fourth = await main({ now });
    const fourthUser = fourth.perUser.find((p) => p.userId === U);
    assert.equal(
      fourthUser.skipped, 'nothing_due',
      '報告沒事做 + 同步在節流窗內 → 這一輪真的沒事做',
    );
    assert.equal(
      calls.slice(before4).length, 0,
      `完全沒事做時不該有任何外部呼叫，實際：${JSON.stringify(calls.slice(before4))}`,
    );
  } finally {
    restoreFetch();
    process.chdir(cwd);
    for (const k of Object.keys(process.env)) {
      if (!(k in savedEnv)) delete process.env[k];
    }
    Object.assign(process.env, savedEnv);
  }
});

test('端到端：token 快過期時會先 refresh 再撈資料，新 token 寫進 DB', async () => {
  const now = new Date('2026-08-21T00:00:00Z');
  const dataset = makeDataset({ days: 45, now });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whoop-e2e2-'));
  const dbUrl = `file:${path.join(dir, 'e2e.db')}`;
  const cwd = process.cwd();
  const savedEnv = { ...process.env };
  const calls = [];
  const restoreFetch = installMockFetch({ dataset, calls });

  try {
    process.chdir(dir);
    Object.assign(process.env, {
      WHOOP_CLIENT_ID: 'cid',
      WHOOP_CLIENT_SECRET: 'sec',
      OPENROUTER_API_KEY: 'sk-or-test',
      OPENROUTER_MODEL: 'anthropic/claude-sonnet-5',
      TELEGRAM_BOT_TOKEN: '123:abc',
      TELEGRAM_CHAT_ID: '999',
      TURSO_DATABASE_URL: dbUrl,
      TURSO_AUTH_TOKEN: 'unused',
      TIMEZONE: TZ,
    });

    const seed = createDb({ url: dbUrl });
    await seed.migrate();
    await seed.createUser({ id: U, displayName: 'E2E', timezone: TZ, status: 'ACTIVE' });
    await seed.linkTelegram({ chatId: '999', userId: U });
    await seed.saveTokens(U, {
      accessToken: 'about-to-expire',
      refreshToken: 'seed-refresh',
      expiresAt: new Date(Date.now() + 2 * 60_000), // 只剩 2 分鐘 → 必須 refresh
      scope: 'offline read:recovery read:sleep read:cycles',
    });
    seed.close();

    const res = await main({ now });
    assert.equal(res.errors.length, 0, JSON.stringify(res.errors));
    assert.equal(res.failed, 0, JSON.stringify(res.perUser));
    const resUser = res.perUser.find((p) => p.userId === U);
    assert.equal(resUser.daily, 'sent');

    // refresh 只發生一次，而且在任何資料請求之前
    const tokenIdx = calls.findIndex((c) => c.path === '/oauth/oauth2/token');
    const dataIdx = calls.findIndex((c) => c.path?.startsWith('/developer/v2/'));
    assert.ok(tokenIdx >= 0, '應該要 refresh');
    assert.ok(tokenIdx < dataIdx, 'refresh 必須在撈資料之前');
    assert.equal(calls.filter((c) => c.path === '/oauth/oauth2/token').length, 1);

    const check = createDb({ url: dbUrl });
    const t = await check.getTokens(U);
    assert.equal(t.accessToken, 'e2e-access');
    assert.equal(t.refreshToken, 'e2e-refresh');
    check.close();
  } finally {
    restoreFetch();
    process.chdir(cwd);
    for (const k of Object.keys(process.env)) {
      if (!(k in savedEnv)) delete process.env[k];
    }
    Object.assign(process.env, savedEnv);
  }
});
