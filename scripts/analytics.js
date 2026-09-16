#!/usr/bin/env node
/**
 * 分析工作的**本機 / 手動**執行器（V1.2 Phase 3）。
 *
 *   npm run analytics:status -- --user=<id>              唯讀：新鮮度、失效範圍、最近執行
 *   npm run analytics:light  -- [--user=<id>] [--force]   處理落後的輕量分析（有上限）
 *   npm run analytics:heavy  -- [--user=<id>] [--force]   處理落後的重量分析（有上限）
 *
 * ## 安全閘（與 scripts/reconcile.js 相同）
 *
 *   1. schema 版本用遷移系統的權威（schema_version 表）比對，不等於程式碼的
 *      版本就停；**不會** migrate。
 *   2. 寫入（light / heavy）只接受 `file:` 本機資料庫，除非明確設
 *      ANALYTICS_ALLOW_REMOTE=1。status 對遠端只讀。
 *   3. status 必須指定 --user。
 *
 * 這支腳本不呼叫 WHOOP、不呼叫 LLM、不送 Telegram、不改任何排程。
 */

import { loadDotEnvIfPresent, loadEnv, ANALYTICS_WORK } from '../src/config.js';
import { createDb } from '../src/db.js';
import { processPendingAnalytics, processAnalyticsForUser } from '../src/analyticsWorker.js';
import { SCHEMA_VERSION, ANALYTICS_CLASS } from '../src/schema.js';
import { currentVersion } from '../src/migrations.js';
import { describeError } from '../src/logger.js';

const argv = process.argv.slice(2);
const command = argv[0] ?? 'status';
const opt = (name) => {
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : null;
};
const flag = (name) => argv.includes(`--${name}`);

loadDotEnvIfPresent();
const env = loadEnv({ require: ['TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN'] });
const isLocalDb = /^file:/i.test(String(env.tursoUrl ?? ''));
const writes = command === 'light' || command === 'heavy';
if (writes && !isLocalDb && process.env.ANALYTICS_ALLOW_REMOTE !== '1') {
  console.error('❌ TURSO_DATABASE_URL 不是本機 file: 資料庫。');
  console.error('   對遠端資料庫執行分析會寫入衍生表。若你確定，請設 ANALYTICS_ALLOW_REMOTE=1。');
  process.exit(2);
}

const db = createDb({ url: env.tursoUrl, authToken: env.tursoToken });
const fmt = (v) => (v ? String(v).replace('T', ' ').slice(0, 19) : '—');

async function ensureSchema() {
  let v;
  try { v = await currentVersion(db.raw); } catch (err) {
    throw new Error(`無法讀取 schema_version（${describeError(err)}）；拒絕執行`);
  }
  if (!Number.isInteger(v) || v !== SCHEMA_VERSION) {
    throw new Error(`schema 版本 ${v} ≠ 程式碼 ${SCHEMA_VERSION}；請先有意識地執行 npm run migrate`);
  }
}

async function status() {
  const userId = opt('user');
  if (!userId) throw new Error('status 必須用 --user=<id> 指定使用者');
  await ensureSchema();
  const user = await db.getUser(userId);
  if (!user) throw new Error(`找不到使用者：${userId}`);
  const f = await db.getAnalyticsFreshness(user.id);
  const inv = await db.getAnalyticsInvalidation(user.id);
  console.log(`使用者 ${user.id}（${user.timezone}）｜資料庫 ${isLocalDb ? '本機 file:' : '遠端（唯讀）'}`);
  console.log(`\ngeneration ${f.generation}｜最近失效 ${fmt(f.lastInvalidatedAt)}｜髒自 ${fmt(f.dirtySince)}`);
  if (inv?.affectedFrom || inv?.affectedTo) {
    console.log(`受影響範圍 ${inv.affectedFrom ?? '?'} → ${inv.affectedTo ?? '?'}｜資源 ${inv.resources.join(',') || '—'}｜原因 ${inv.reasons.join(',') || '—'}`);
  }
  for (const cls of Object.values(ANALYTICS_CLASS)) {
    const w = f[cls];
    console.log(`\n${cls.padEnd(6)} ${w.status.padEnd(8)} done=${w.doneGeneration}｜上次成功 ${fmt(w.lastSuccessAt)}｜上次失敗 ${fmt(w.lastFailureAt)}`
      + `${w.lastErrorClass ? `｜錯誤 ${w.lastErrorClass}` : ''}${w.owner ? `｜持有中 ${w.owner} 至 ${fmt(w.leaseExpiresAt)}` : ''}`
      + `${w.nextAttemptAt ? `｜下次 ${fmt(w.nextAttemptAt)}` : ''}｜連續失敗 ${w.consecutiveFailures}`);
  }
  const runs = await db.recentAnalyticsRuns(user.id, { limit: 10 });
  console.log('\n最近執行：');
  if (!runs.length) console.log('   （無）');
  for (const r of runs) {
    console.log(`   #${String(r.id).padEnd(5)} ${r.class.padEnd(6)} gen ${String(r.generation).padEnd(4)} ${String(r.result ?? '執行中').padEnd(8)} ${fmt(r.startedAt)}${r.errorClass ? `｜${r.errorClass}` : ''}`);
  }
  const days = await db.getAnalyticsDailyState(user.id);
  console.log(`\n輕量物化：${days.length} 天${days.length ? `（${days[0].healthDate} → ${days.at(-1).healthDate}，最舊 generation ${Math.min(...days.map((d) => d.generation))}）` : ''}`);
}

async function run(cls) {
  await ensureSchema();
  const userId = opt('user');
  const force = flag('force');
  let processed;
  if (userId) {
    const user = await db.getUser(userId);
    if (!user) throw new Error(`找不到使用者：${userId}`);
    processed = [await processAnalyticsForUser({ db, userId: user.id, cls, owner: `script:${cls}:${process.pid}`, force })];
  } else {
    if (force) throw new Error('--force 需要 --user=<id>');
    processed = (await processPendingAnalytics({ db, cls, maxUsers: ANALYTICS_WORK.MAX_USERS_PER_RUN })).processed;
  }
  console.log(`\n${cls}：處理 ${processed.length} 位使用者（上限 ${ANALYTICS_WORK.MAX_USERS_PER_RUN}）`);
  for (const r of processed) {
    const extra = r.result === 'SKIPPED' ? ` (${r.reason})` : r.result === 'FAILED' ? ` ${r.errorClass}` : ` gen ${r.generation}${r.stillDirty ? '（期間又有新變動，仍然髒）' : ''}`;
    console.log(`  ${String(r.userId).padEnd(38)} ${String(r.result).padEnd(8)}${extra}`);
  }
}

try {
  if (command === 'status') await status();
  else if (command === 'light') await run(ANALYTICS_CLASS.LIGHT);
  else if (command === 'heavy') await run(ANALYTICS_CLASS.HEAVY);
  else { console.error(`未知指令：${command}（status | light | heavy）`); process.exitCode = 2; }
} catch (err) {
  console.error(`❌ ${describeError(err)}`);
  process.exitCode = 1;
} finally {
  db.close();
}
