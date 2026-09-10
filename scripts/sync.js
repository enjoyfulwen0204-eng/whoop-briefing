#!/usr/bin/env node
/**
 * 手動同步 / backfill。
 *
 * 排程本來就會自動同步（每次執行、有節流），這支是給你想「立刻推進」時用的，
 * 尤其是第一次部署要把 365 天歷史抓回來的時候。
 *
 * 用法：
 *   npm run sync              跑一輪（忽略節流）
 *   npm run sync -- --until-done   一直跑到 backfill 全部完成為止
 */

import { loadDotEnvIfPresent, loadEnv, WHOOP_SYNC } from '../src/config.js';
import { pickUser } from './pickUser.js';
import { createDb } from '../src/db.js';
import { createWhoopClient } from '../src/whoop.js';
import { createSync } from '../src/sync.js';

loadDotEnvIfPresent();
const env = loadEnv({
  require: ['WHOOP_CLIENT_ID', 'WHOOP_CLIENT_SECRET', 'TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN'],
});

const untilDone = process.argv.includes('--until-done');
const db = createDb({ url: env.tursoUrl, authToken: env.tursoToken });
const user = await pickUser(db);

try {
  await db.migrate();
  const whoop = createWhoopClient({
  db,
  userId: user.id, clientId: env.whoopClientId, clientSecret: env.whoopClientSecret,
  });

  let round = 0;
  for (;;) {
    round += 1;
    // ★ L-03 同一條：health_date 的歸屬由時區決定，一定要用**這個使用者的**。
    // 用 bootstrap 時區同步別人的資料，會把睡眠記到錯的健康日上。
    const sync = createSync({
      db, whoop, userId: user.id, timezone: user.timezone, now: new Date(),
    });
    const results = await sync.syncAll({ force: true });

    console.log(`\n── 第 ${round} 輪 ──`);
    for (const r of results) {
      const back = r.backfill;
      const extra = back
        ? ` backfill: ${back.chunks ?? 0} chunks, ${back.complete ? '完成' : `到 ${String(back.cursor).slice(0, 10)}`}`
        : '';
      console.log(`  ${String(r.resource).padEnd(18)} ${r.status ?? 'ok'}${extra}`);
    }

    if (!untilDone) break;
    const states = await db.getAllSyncState(user.id);
    const pending = states.filter((s) => Number(s.backfill_complete) !== 1);
    if (!pending.length) {
      console.log('\n✅ 全部 backfill 完成。');
      break;
    }
    if (round > Math.ceil(WHOOP_SYNC.BACKFILL_DAYS / WHOOP_SYNC.BACKFILL_CHUNK_DAYS) + 5) {
      console.log('\n⚠️  輪數超過預期上限，先停下來。請看上面的錯誤訊息。');
      break;
    }
  }

  console.log('\n提示：跑 `npm run health-status` 看完整涵蓋範圍。\n');
} catch (err) {
  console.error(`❌ 同步失敗：${err.message}`);
  process.exitCode = 1;
} finally {
  db.close();
}
