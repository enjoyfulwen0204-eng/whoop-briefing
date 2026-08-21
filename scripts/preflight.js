#!/usr/bin/env node
/**
 * 一鍵健康檢查：確認 Turso / WHOOP / Claude / Telegram 四個服務都通。
 *
 * 用法：
 *   npm run check            （會發一則測試訊息到 Telegram，順便確認 chat id 正確）
 *   node scripts/preflight.js --no-send   （不發 Telegram 訊息，只驗證 bot token）
 */

import { loadDotEnvIfPresent, loadEnv } from '../src/config.js';
import { createDb } from '../src/db.js';
import { createWhoopClient } from '../src/whoop.js';
import { createCoach } from '../src/coach.js';
import { createTelegram } from '../src/telegram.js';
import { localDate, localTime } from '../src/time.js';

loadDotEnvIfPresent();

const noSend = process.argv.includes('--no-send');
const results = [];
const ok = (name, detail) => results.push({ name, state: '✅', detail });
const bad = (name, detail) => results.push({ name, state: '❌', detail });
const warn = (name, detail) => results.push({ name, state: '⚠️ ', detail });

let env;
try {
  env = loadEnv();
  ok('環境變數', '全部必填項目都有值');
} catch (err) {
  bad('環境變數', err.message);
  report();
  process.exit(1);
}

console.log(`現在時間：UTC ${new Date().toISOString()} ／ ${env.timezone} ${localDate(new Date(), env.timezone)} ${localTime(new Date(), env.timezone)}\n`);

const db = createDb({ url: env.tursoUrl, authToken: env.tursoToken });

// ---- 1. Turso ----
let tokens = null;
try {
  await db.migrate();
  tokens = await db.getTokens();
  ok('Turso', tokens
    ? `連線正常，已有 WHOOP token（到期 ${tokens.expiresAt.toISOString()}）`
    : '連線正常，但還沒有 WHOOP token');
  if (!tokens) warn('WHOOP token', '請先跑 npm run authorize');
} catch (err) {
  bad('Turso', err.message);
}

// ---- 2. WHOOP ----
if (tokens) {
  try {
    const whoop = createWhoopClient({
      db, clientId: env.whoopClientId, clientSecret: env.whoopClientSecret,
    });
    const page = await whoop.apiGet('/recovery', { limit: 1 });
    const n = page?.records?.length ?? 0;
    ok('WHOOP API', `讀得到資料（本次取回 ${n} 筆 recovery）`);
    const scope = (await db.getTokens())?.scope ?? '';
    if (!String(scope).includes('offline')) {
      warn('WHOOP scope', `scope 裡沒有 offline（目前：${scope}），refresh token 可能拿不到`);
    } else {
      ok('WHOOP scope', scope);
    }
  } catch (err) {
    bad('WHOOP API', err.message);
  }
}

// ---- 3. Claude ----
try {
  const coach = createCoach({ apiKey: env.anthropicApiKey, model: env.anthropicModel });
  const text = await coach.daily({
    localDate: localDate(new Date(), env.timezone),
    stage: 'cold',
    sampleCount: 0,
    metrics: [],
    trends: { enabled: false, alerts: [] },
  });
  if (text) ok('Claude', `${env.anthropicModel} 回應正常（${text.length} 字）`);
  else bad('Claude', '呼叫失敗，詳細原因看上面的 coach_daily_failed log');
} catch (err) {
  bad('Claude', err.message);
}

// ---- 4. Telegram ----
try {
  const res = await fetch(`https://api.telegram.org/bot${env.telegramBotToken}/getMe`);
  const json = await res.json();
  if (json.ok) ok('Telegram bot', `@${json.result.username}`);
  else bad('Telegram bot', 'bot token 無效');

  if (json.ok && !noSend) {
    const tg = createTelegram({
      botToken: env.telegramBotToken, chatId: env.telegramChatId, db,
    });
    const sent = await tg.send('✅ WHOOP 簡報系統設定完成，測試訊息（收到這則就代表 chat id 正確）');
    ok('Telegram 發送', `已送出，message_id=${sent.messageId}`);
  } else if (json.ok) {
    warn('Telegram 發送', '本次用 --no-send 跳過，未驗證 chat id');
  }
} catch (err) {
  bad('Telegram', err.message);
}

db.close();
report();

function report() {
  console.log('\n================ 檢查結果 ================');
  for (const r of results) console.log(`${r.state} ${r.name.padEnd(14, ' ')} ${r.detail}`);
  const failed = results.filter((r) => r.state === '❌');
  console.log('==========================================');
  if (failed.length) {
    console.log(`\n有 ${failed.length} 項沒過，請照上面的訊息修正後再跑一次 npm run check\n`);
    process.exitCode = 1;
  } else {
    console.log('\n🎉 全部通過。可以部署到 Render 了。\n');
  }
}
