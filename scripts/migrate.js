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

  const tokens = await db.getTokens();
  console.log(tokens
    ? `\n✅ 已有 WHOOP token（到期 ${tokens.expiresAt.toISOString()}）`
    : '\n⚠️  還沒有 WHOOP token，請跑：npm run authorize');
} catch (err) {
  console.error(`❌ Turso 連線 / 建表失敗：${err.message}`);
  process.exitCode = 1;
} finally {
  db.close();
}
