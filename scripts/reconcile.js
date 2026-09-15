#!/usr/bin/env node
/**
 * WHOOP 對帳 + 增量同步的**本機 / 手動**執行器（V1.2 Phase 2）。
 *
 *   npm run reconcile:status -- --user=<id>              唯讀：狀態、最近執行、差異
 *   npm run reconcile:run -- --user=<id> [--resource=x]   跑一輪（可用 --force 忽略節流）
 *   npm run reconcile:run -- --user=<id> --resource=sleep --from=2026-06-01 --to=2026-07-01
 *                                                        明確窗（backfill / 修復；不動水位）
 *
 * ## 三道安全閘（這支腳本不能悄悄動到正式環境）
 *
 *   1. `--user` **必填**。不會自動挑「唯一的 ACTIVE 使用者」—— 正式 DB 裡那個
 *      唯一的使用者就是正式使用者。
 *   2. `run` 只接受 `file:` 本機資料庫，除非明確設 `RECONCILE_ALLOW_REMOTE=1`。
 *      `.env` 裡的 TURSO_DATABASE_URL 指向正式環境；沒有這個環境變數時，
 *      這支腳本對它**只讀不寫**（status），或直接拒絕（run）。
 *   3. `run` 不會 migrate：schema 版本不對就停，請先用 `npm run migrate`
 *      有意識地升級。
 *
 * 這支腳本不註冊 webhook、不送 Telegram、不改任何排程。
 */

import { loadDotEnvIfPresent, loadEnv, WHOOP_RECONCILE } from '../src/config.js';
import { createDb } from '../src/db.js';
import { createWhoopClient } from '../src/whoop.js';
import { createReconciler } from '../src/reconcile.js';
import { SCHEMA_VERSION } from '../src/schema.js';
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

const userId = opt('user');
if (!userId) {
  console.error('❌ 必須用 --user=<id> 明確指定使用者（這支腳本不會自動挑）。');
  process.exit(2);
}

const isLocalDb = /^file:/i.test(String(env.tursoUrl ?? ''));
if (command === 'run' && !isLocalDb && process.env.RECONCILE_ALLOW_REMOTE !== '1') {
  console.error('❌ TURSO_DATABASE_URL 不是本機 file: 資料庫。');
  console.error('   對遠端資料庫執行對帳會寫入它。若你確定，請設 RECONCILE_ALLOW_REMOTE=1。');
  process.exit(2);
}

const db = createDb({ url: env.tursoUrl, authToken: env.tursoToken });
const fmt = (v) => (v ? String(v).replace('T', ' ').slice(0, 19) : '—');

async function ensureSchema() {
  const rs = await db.raw.execute('PRAGMA user_version');
  const v = Number(rs.rows[0]?.user_version ?? 0);
  if (v !== SCHEMA_VERSION) {
    throw new Error(`schema 版本 ${v} ≠ 程式碼 ${SCHEMA_VERSION}；請先有意識地執行 npm run migrate`);
  }
}

async function status() {
  const user = await db.getUser(userId);
  if (!user) throw new Error(`找不到使用者：${userId}`);
  console.log(`使用者 ${user.id}（${user.timezone}）｜資料庫 ${isLocalDb ? '本機 file:' : '遠端（唯讀）'}`);

  const states = await db.getAllReconciliationState(user.id);
  console.log('\n對帳狀態：');
  if (!states.length) console.log('   （尚未跑過任何一輪）');
  for (const s of states) {
    console.log(`   ${s.resource.padEnd(17)} 水位 ${fmt(s.windowWatermark)}｜上次成功 ${fmt(s.lastSuccessAt)}`
      + `｜續傳 ${s.continuationToken ? '有' : '無'}｜連續失敗 ${s.consecutiveFailures}`
      + `${s.owner ? `｜持有中 ${s.owner}` : ''}`
      + `${s.lastErrorClass ? `｜最後錯誤 ${s.lastErrorClass}` : ''}`
      + `${s.nextAttemptAt ? `｜退避到 ${fmt(s.nextAttemptAt)}` : ''}`);
  }

  const runs = await db.recentReconciliationRuns(user.id, { limit: 15 });
  console.log('\n最近執行：');
  if (!runs.length) console.log('   （無）');
  for (const r of runs) {
    console.log(`   #${String(r.id).padEnd(5)} ${r.resource.padEnd(17)} ${String(r.result ?? '執行中').padEnd(8)}`
      + ` ${r.mode.padEnd(15)} 頁 ${r.pages} 抓 ${r.fetched} 寫 ${r.written} 擋 ${r.blocked}`
      + ` ${fmt(r.startedAt)}${r.errorClass ? `｜${r.errorClass}` : ''}`);
  }

  const disc = await db.listDiscrepancies(user.id);
  console.log('\n差異（只記錄，不刪除）：');
  if (!disc.length) console.log('   （無）');
  for (const d of disc) {
    console.log(`   ${d.resource.padEnd(10)} ${d.resourceId.padEnd(38)} ${d.kind} ×${d.seenCount}`
      + ` 首見 ${fmt(d.firstSeenAt)} 最近 ${fmt(d.lastSeenAt)}`);
  }

  const tombs = await db.raw.execute({
    sql: `SELECT resource_type, resource_id, reconcile_verdict, reconcile_checked_at
            FROM whoop_resource_tombstones WHERE user_id = ? AND state = 'ACTIVE'
           ORDER BY resource_type, resource_id`,
    args: [user.id],
  });
  console.log('\nACTIVE 墓碑的對帳診斷：');
  if (!tombs.rows.length) console.log('   （無 ACTIVE 墓碑）');
  for (const t of tombs.rows) {
    console.log(`   ${String(t.resource_type).padEnd(10)} ${String(t.resource_id).padEnd(38)}`
      + ` ${t.reconcile_verdict ?? '未檢查'} ${fmt(t.reconcile_checked_at)}`);
  }
}

async function run() {
  await ensureSchema();
  const full = loadEnv({
    require: ['TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN', 'WHOOP_CLIENT_ID', 'WHOOP_CLIENT_SECRET'],
  });
  const user = await db.getUser(userId);
  if (!user) throw new Error(`找不到使用者：${userId}`);

  const whoop = createWhoopClient({
    db, userId: user.id, clientId: full.whoopClientId, clientSecret: full.whoopClientSecret,
  });
  const reconciler = createReconciler({ db, whoop, userId: user.id, timezone: user.timezone });

  const resource = opt('resource');
  const from = opt('from');
  const to = opt('to');
  let results;
  if (from || to) {
    if (!resource || !from || !to) throw new Error('明確窗需要 --resource、--from、--to 三個都給');
    if (!WHOOP_RECONCILE.RESOURCES.includes(resource) || resource === 'body_measurement') {
      throw new Error(`資源 ${resource} 不支援明確窗`);
    }
    results = [await reconciler.reconcileResource(resource, {
      explicitWindow: { from: new Date(from), to: new Date(to) },
    })];
  } else {
    results = await reconciler.reconcileAll({
      resources: resource ? [resource] : WHOOP_RECONCILE.RESOURCES,
      force: flag('force'),
    });
  }

  console.log(`\n使用者 ${user.id}｜擁有者 ${reconciler.owner}`);
  for (const r of results) {
    const extra = r.result === 'SKIPPED' ? ` (${r.reason})`
      : r.result === 'FAILED' ? ` ${r.errorClass}${r.retryable ? '（會重試）' : '（不重試）'}`
        : ` 頁 ${r.pages ?? 0} 抓 ${r.fetched ?? 0} 寫 ${r.written ?? 0} 擋 ${r.blocked ?? 0}`
          + `${r.missing ? ` 遠端缺 ${r.missing}` : ''}`
          + `${r.tombstonesChecked ? ` 墓碑檢 ${r.tombstonesChecked}/未解 ${r.tombstonesUnresolved}` : ''}`;
    console.log(`  ${String(r.resource).padEnd(17)} ${String(r.result).padEnd(8)}${extra}`);
  }
  console.log('\n提示：`npm run reconcile:status -- --user=<id>` 看完整狀態。\n');
}

try {
  if (command === 'status') await status();
  else if (command === 'run') await run();
  else { console.error(`未知指令：${command}（status | run）`); process.exitCode = 2; }
} catch (err) {
  console.error(`❌ ${describeError(err)}`);
  process.exitCode = 1;
} finally {
  db.close();
}
