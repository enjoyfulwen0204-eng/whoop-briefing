#!/usr/bin/env node
/**
 * 建立 Turso 資料表（可重複執行，已存在就跳過）。
 * 用法：npm run migrate
 *
 * 注意：src/index.js 每次執行也會自動跑一次 migrate，所以這支主要是
 * 「第一次設定時想先確認 Turso 連得上」用的。
 */

import { loadDotEnvIfPresent, loadEnv } from '../src/config.js';
import { createDb } from '../src/db.js';

loadDotEnvIfPresent();
const env = loadEnv({ require: ['TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN'] });
const db = createDb({ url: env.tursoUrl, authToken: env.tursoToken });

try {
  await db.migrate();
  const tables = await db.raw.execute(
    "SELECT name FROM sqlite_master WHERE type IN ('table','index') ORDER BY name",
  );
  console.log('✅ Turso 資料表就緒：');
  for (const row of tables.rows) console.log(`   - ${row.name}`);

  // Multi-user：token 是 per-user 的，所以列出每個使用者的授權狀態
  const users = await db.listUsers();
  if (!users.length) {
    console.log('\n⚠️  還沒有任何內部使用者。請先建立一個，再跑 authorize。');
  } else {
    console.log('\n使用者與 WHOOP 授權狀態：');
    for (const u of users) {
      const t = await db.getTokens(u.id);
      const chat = await db.getActiveChatIdForUser(u.id);
      console.log(`   - ${u.displayName} (${u.id}) ${u.status} ${u.timezone}`
        + `｜WHOOP ${t ? `已授權（到期 ${t.expiresAt.toISOString()}）` : '未授權'}`
        + `｜Telegram ${chat ? '已綁定' : '未綁定'}`);
    }
  }
} catch (err) {
  console.error(`❌ Turso 連線 / 建表失敗：${err.message}`);
  process.exitCode = 1;
} finally {
  db.close();
}
