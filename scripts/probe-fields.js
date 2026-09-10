#!/usr/bin/env node
/**
 * Capability probe：檢查「你這個 WHOOP 帳號實際上會回傳哪些欄位」。
 *
 * 為什麼需要：WHOOP One 與 Peak 是同一顆 5.0 硬體，能力差異不能靠 membership
 * 猜。唯一可信的判準是「API 這個欄位有沒有值」。
 *
 * 與舊版的差別：結果會**寫進 Turso 的 whoop_capabilities**，其他模組之後可以用
 * getCapability('spo2') 讀，而不是每次重新猜。
 *
 * 用法：
 *   npm run probe                （預設取樣 14 天）
 *   PROBE_DAYS=30 npm run probe
 */

import { loadDotEnvIfPresent, loadEnv } from '../src/config.js';
import { pickUser } from './pickUser.js';
import { createDb } from '../src/db.js';
import { createWhoopClient } from '../src/whoop.js';
import { probeCapabilities, STATUS } from '../src/capabilities.js';

loadDotEnvIfPresent();
const env = loadEnv({
  require: ['WHOOP_CLIENT_ID', 'WHOOP_CLIENT_SECRET', 'TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN'],
});

const DAYS = Number(process.env.PROBE_DAYS || 14);
const db = createDb({ url: env.tursoUrl, authToken: env.tursoToken });

const MARK = {
  [STATUS.SUPPORTED]: '✅',
  [STATUS.PARTIAL]: '⚠️ ',
  [STATUS.UNAVAILABLE]: '❌',
  [STATUS.UNKNOWN]: '❔',
  [STATUS.UNAUTHORIZED]: '🔒',
  [STATUS.APP_ONLY]: '🚫',
};

try {
  await db.migrate();
  const user = await pickUser(db);
  const whoop = createWhoopClient({
    db, userId: user.id, clientId: env.whoopClientId, clientSecret: env.whoopClientSecret,
  });

  console.log(`使用者：${user.id}（${user.displayName}，${user.timezone}）`);

  const { entries, scopeErrors } = await probeCapabilities({
    // ★ L-03 同一條：用這個使用者自己的時區，不是 bootstrap 預設
    db, whoop, userId: user.id, timezone: user.timezone, days: DAYS,
  });

  const group = (s) => entries.filter((e) => e.status === s);
  const line = (e) => {
    const n = e.status === STATUS.APP_ONLY || e.status === STATUS.UNAUTHORIZED
      ? ''
      : ` ${String(e.nonNullCount).padStart(3)}/${String(e.sampleCount).padEnd(3)}`;
    const v = e.latestValue === null || e.latestValue === undefined ? '' : `  最新 ${e.latestValue}`;
    const d = e.detail ? `  — ${e.detail}` : '';
    return `  ${MARK[e.status]} ${String(e.label ?? e.key).padEnd(22, ' ')}${n}${v}${d}`;
  };

  console.log(`\n=== Capability probe（取樣最近 ${DAYS} 天）===\n`);

  for (const [title, status] of [
    ['✅ SUPPORTED —— 每一筆都有值，可以放心用', STATUS.SUPPORTED],
    ['⚠️  PARTIAL —— 有時候有、有時候沒有', STATUS.PARTIAL],
    ['❌ UNAVAILABLE —— 這個帳號取不到（有樣本但全是 null）', STATUS.UNAVAILABLE],
    ['❔ UNKNOWN —— 樣本不足，無法判斷（不猜）', STATUS.UNKNOWN],
    ['🔒 UNAUTHORIZED —— token 缺 scope，重跑 npm run authorize 就會有', STATUS.UNAUTHORIZED],
    ['🚫 APP_ONLY —— WHOOP App 有，但官方 Developer API v2 沒有這個欄位', STATUS.APP_ONLY],
  ]) {
    const rows = group(status);
    if (!rows.length) continue;
    console.log(title);
    for (const e of rows) console.log(line(e));
    console.log('');
  }

  if (scopeErrors.length) {
    console.log('─'.repeat(70));
    console.log('⚠️  下列 resource 因為 scope 不足而拿不到：');
    for (const s of scopeErrors) console.log(`     - ${s.resource}`);
    console.log('\n   解法：在本機跑一次 `npm run authorize` 重新授權（會取得新的 scope）。');
    console.log('   在那之前，每日簡報與週報完全不受影響。');
    console.log('─'.repeat(70));
  }

  console.log('\n結果已寫入 Turso 的 whoop_capabilities（其他模組可用 getCapability 讀取）。\n');
} catch (err) {
  console.error(`❌ 失敗：${err.message}`);
  process.exitCode = 1;
} finally {
  db.close();
}
