#!/usr/bin/env node
/**
 * WHOOP webhook 事件的**本機**維運工具（V1.2 Phase 1）。正式排空由
 * Cloudflare 主排程／GitHub 備援共用的 canonical runner 持有；這支保留給
 * 狀態查詢與管理者明確手動排空。
 *
 *   npm run whoop:webhook:status   唯讀：帳本與墓碑的狀態統計
 *   npm run whoop:webhook:drain    排空：把還沒處理完的事件處理掉
 *
 * 這支腳本與正式排程重用同一個 drainWhoopWebhookEvents，不存在第二套處理邏輯。
 *
 * ## 這支腳本不會註冊任何 webhook
 *
 * 它只讀寫自己的資料庫。**不會**呼叫 WHOOP 的 webhook 設定 API、
 * 不會改 Developer Dashboard、不會送任何 Telegram 訊息。
 */

import { randomUUID } from 'node:crypto';
import { loadDotEnvIfPresent, loadEnv } from '../src/config.js';
import { createDb } from '../src/db.js';
import { createWhoopClient } from '../src/whoop.js';
import { drainWhoopWebhookEvents } from '../src/whoopWebhookProcessor.js';
import { log, describeError } from '../src/logger.js';

const command = process.argv[2] ?? 'status';

loadDotEnvIfPresent();
const env = loadEnv({ require: ['TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN'] });
const db = createDb({ url: env.tursoUrl, authToken: env.tursoToken });

async function status() {
  const stats = await db.whoopEventStats();
  if (!stats.length) {
    console.log('（事件帳本是空的 —— 正式環境的 WHOOP webhook 預設關閉）');
  } else {
    console.log('WHOOP webhook 事件：');
    for (const s of stats) console.log(`   ${s.state.padEnd(11)} ${s.eventType.padEnd(18)} ${s.count}`);
  }
  const tombs = await db.raw.execute(
    `SELECT resource_type, state, COUNT(*) n, SUM(blocked_count) blocked
       FROM whoop_resource_tombstones GROUP BY resource_type, state ORDER BY 1,2`,
  );
  if (!tombs.rows.length) {
    console.log('\n（沒有任何刪除墓碑）');
  } else {
    console.log('\n刪除墓碑：');
    for (const r of tombs.rows) {
      console.log(`   ${String(r.resource_type).padEnd(10)} ${String(r.state).padEnd(11)} `
        + `${r.n} 筆｜擋下復活 ${Number(r.blocked ?? 0)} 次`);
    }
  }
}

async function drain() {
  // 排空需要真的打 WHOOP API，所以這一步才要求 WHOOP 憑證。
  const full = loadEnv({
    require: ['TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN', 'WHOOP_CLIENT_ID', 'WHOOP_CLIENT_SECRET'],
  });
  // 每個使用者一個 client：token refresh 的租約與 CAS 圍欄都綁在 userId 上，
  // 絕不共用，也絕不另外實作一份 refresh 邏輯。
  const clients = new Map();
  // ★ R3 / R2-FG-01：每個 client 綁定處理這則事件時的帳號啟用世代。
  // 處理器把它傳進來（它剛剛才解析過使用者），所以這裡不必再讀一次。
  const whoopFor = (userId, { expectedLifecycleGeneration = null, maintenance = null } = {}) => {
    const key = `${userId}:${expectedLifecycleGeneration ?? 'none'}`;
    if (!clients.has(key)) {
      clients.set(key, createWhoopClient({
        db, userId, clientId: full.whoopClientId, clientSecret: full.whoopClientSecret,
        expectedLifecycleGeneration,
        requestSignal: maintenance?.signal ?? null,
        requestDeadlineAt: maintenance?.deadlineAt ?? null,
      }));
    }
    return clients.get(key);
  };

  const owner = `drain:${process.pid}:${randomUUID()}`;
  const summary = await drainWhoopWebhookEvents({ db, whoopFor, owner });
  console.log(`認領 ${summary.claimed} 則`);
  for (const [k, v] of Object.entries(summary.results)) console.log(`   ${k.padEnd(24)} ${v}`);
  if (!summary.claimed) console.log('（沒有待處理的事件）');
}

try {
  if (command === 'status') await status();
  else if (command === 'drain') await drain();
  else {
    console.error(`未知指令：${command}\n用法：node scripts/whoop-webhook.js [status|drain]`);
    process.exitCode = 1;
  }
} catch (err) {
  log.error('whoop_webhook_script_failed', { command, error: describeError(err) });
  console.error(`❌ ${describeError(err)}`);
  process.exitCode = 1;
} finally {
  db.close();
}
