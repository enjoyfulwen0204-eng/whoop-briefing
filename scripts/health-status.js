#!/usr/bin/env node
/**
 * 系統體檢：同步進度、歷史涵蓋範圍、capability、資料品質。
 *
 * 用法：npm run health-status
 * 不呼叫 WHOOP / OpenRouter / Telegram —— 只讀 Turso，完全免費且安全。
 */

import { loadDotEnvIfPresent, loadEnv, WHOOP_SYNC } from '../src/config.js';
import { pickUser } from './pickUser.js';
import { createDb } from '../src/db.js';
import { STATUS } from '../src/capabilities.js';
import { localDate, addDays, daysBetween } from '../src/time.js';

loadDotEnvIfPresent();
const env = loadEnv({ require: ['TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN'] });
const db = createDb({ url: env.tursoUrl, authToken: env.tursoToken });
const user = await pickUser(db);
console.log(`使用者：${user.displayName}（${user.id}）｜時區 ${user.timezone}\n`);

const pad = (s, n) => String(s ?? '-').padEnd(n, ' ');

try {
  await db.migrate();
  const today = localDate(new Date(), env.timezone);

  // ---- 歷史涵蓋 ----
  const cov = await db.coverage(user.id);
  console.log('\n══════════ 健康資料 ══════════');
  if (!Number(cov.main_sleeps)) {
    console.log('  （還沒有任何健康資料 —— 排程跑過幾次之後就會開始累積）');
  } else {
    const span = cov.first_date && cov.last_date
      ? daysBetween(cov.last_date, cov.first_date) + 1 : 0;
    console.log(`  歷史區間      ${cov.first_date} ～ ${cov.last_date}（跨 ${span} 天）`);
    console.log(`  主睡眠        ${cov.main_sleeps} 筆`);
    console.log(`  小睡          ${cov.naps} 筆`);
    console.log(`  恢復          ${cov.recoveries} 筆（已評分 ${cov.scored_recoveries}）`);
    console.log(`  生理週期      ${cov.cycles} 筆`);
    console.log(`  運動          ${cov.workouts} 筆`);
    console.log(`  未評分睡眠    ${cov.unscored_sleeps} 筆`);

    // 資料品質：缺哪幾天
    const missing = Math.max(0, span - Number(cov.main_sleeps));
    const pct = span ? ((Number(cov.main_sleeps) / span) * 100).toFixed(1) : '0';
    console.log(`  涵蓋率        ${pct}%（區間內缺 ${missing} 天）`);
    const lag = daysBetween(today, cov.last_date);
    console.log(`  最新健康日    ${cov.last_date}${lag > 1 ? `  ⚠️ 已落後 ${lag} 天` : ''}`);
  }

  // ---- 同步狀態 ----
  console.log('\n══════════ 同步狀態 ══════════');
  const states = await db.getAllSyncState(user.id);
  if (!states.length) {
    console.log('  （尚未跑過同步）');
  } else {
    console.log(`  ${pad('resource', 18)}${pad('backfill', 12)}${pad('最早抓到', 26)}${pad('最後成功', 26)}錯誤`);
    for (const s of states) {
      const done = Number(s.backfill_complete) === 1;
      const target = addDays(today, -WHOOP_SYNC.BACKFILL_DAYS);
      let progress = done ? '✅ 完成' : '⏳ 進行中';
      if (!done && s.backfill_cursor) {
        const reached = String(s.backfill_cursor).slice(0, 10);
        const total = WHOOP_SYNC.BACKFILL_DAYS;
        const got = Math.max(0, total - Math.max(0, daysBetween(reached, target)));
        progress = `⏳ ${Math.min(100, Math.round((got / total) * 100))}%`;
      }
      console.log(
        `  ${pad(s.resource, 18)}${pad(progress, 12)}`
        + `${pad(s.backfill_cursor, 26)}${pad(s.last_success_at, 26)}${s.last_error ?? ''}`,
      );
    }
  }

  // ---- capability ----
  console.log('\n══════════ Capability ══════════');
  const caps = await db.getCapabilities(user.id);
  const list = Object.values(caps);
  if (!list.length) {
    console.log('  （還沒 probe 過 —— 跑 `npm run probe` 就會有）');
  } else {
    const group = (s) => list.filter((c) => c.status === s).map((c) => c.key);
    const show = (title, keys) => {
      if (keys.length) console.log(`  ${title}\n    ${keys.join(', ')}`);
    };
    show('✅ SUPPORTED', group(STATUS.SUPPORTED));
    show('⚠️  PARTIAL', group(STATUS.PARTIAL));
    show('❌ UNAVAILABLE（這個帳號取不到）', group(STATUS.UNAVAILABLE));
    show('❔ UNKNOWN（樣本不足，不猜）', group(STATUS.UNKNOWN));
    show('🔒 UNAUTHORIZED（需重跑 npm run authorize）', group(STATUS.UNAUTHORIZED));
    show('🚫 APP_ONLY（官方 API 沒有這個欄位）', group(STATUS.APP_ONLY));
    const probed = list[0]?.lastProbedAt;
    if (probed) console.log(`\n  最後 probe：${probed}`);
  }

  // ---- 報告 ----
  console.log('\n══════════ 最近的報告 ══════════');
  const runs = await db.recentRuns(user.id, 8);
  if (!runs.length) console.log('  （還沒有發過報告）');
  for (const r of runs) {
    console.log(`  ${pad(r.report_type, 8)}${pad(r.local_date, 12)}${pad(r.status, 8)}${r.sent_at}`);
  }

  // ---- token ----
  const tokens = await db.getTokens(user.id);
  console.log('\n══════════ WHOOP token ══════════');
  if (!tokens) {
    console.log('  ❌ 沒有 token —— 請跑 `npm run authorize`');
  } else {
    console.log(`  scope        ${tokens.scope}`);
    console.log(`  access 到期  ${tokens.expiresAt.toISOString()}`);
    const need = ['read:workout', 'read:body_measurement']
      .filter((sc) => !String(tokens.scope ?? '').includes(sc));
    if (need.length) {
      console.log(`\n  ⚠️  目前 token 缺少：${need.join(', ')}`);
      console.log('     → 在本機跑一次 `npm run authorize` 重新授權即可取得。');
      console.log('     → 在那之前，Daily Brief 與 Weekly Report 完全不受影響。');
    } else {
      console.log('  ✅ 已包含 workout / body_measurement scope');
    }
  }
  console.log('');
} catch (err) {
  console.error(`❌ 失敗：${err.message}`);
  process.exitCode = 1;
} finally {
  db.close();
}
