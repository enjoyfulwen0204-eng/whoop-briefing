#!/usr/bin/env node
/**
 * 檢查「你這個 WHOOP 帳號實際上會回傳哪些欄位」。
 *
 * 為什麼需要：WHOOP One 之類的裝置不一定回傳 SpO2 / 皮膚溫度。
 * 這支會抓最近 14 天，逐一統計每個指標「有幾筆非 null」，
 * 讓你知道簡報裡會出現哪些項目。核心指標缺就會標「無資料」。
 *
 * 用法：npm run probe
 */

import { METRICS, loadDotEnvIfPresent, loadEnv } from '../src/config.js';
import { createDb } from '../src/db.js';
import { createWhoopClient } from '../src/whoop.js';
import { buildRecords, completedCycles, metricValueFromRecord } from '../src/analyze.js';
import { localDate } from '../src/time.js';

loadDotEnvIfPresent();
const env = loadEnv({
  require: ['WHOOP_CLIENT_ID', 'WHOOP_CLIENT_SECRET', 'TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN'],
});

const DAYS = Number(process.env.PROBE_DAYS || 14);
const db = createDb({ url: env.tursoUrl, authToken: env.tursoToken });

try {
  const whoop = createWhoopClient({
    db, clientId: env.whoopClientId, clientSecret: env.whoopClientSecret,
  });
  const now = new Date();
  const start = new Date(now.getTime() - DAYS * 86_400_000);

  const [sleeps, recoveries, cycles] = await Promise.all([
    whoop.sleeps(start, now),
    whoop.recoveries(start, now),
    whoop.cycles(start, now),
  ]);

  const records = buildRecords({ sleeps, recoveries, timezone: env.timezone });
  const cyclesDesc = completedCycles(cycles);

  console.log(`\n最近 ${DAYS} 天：`);
  console.log(`  睡眠紀錄 ${sleeps.length} 筆（其中主睡眠 ${records.length} 筆、小睡 ${sleeps.length - records.length} 筆）`);
  console.log(`  恢復紀錄 ${recoveries.length} 筆`);
  console.log(`  已完成 cycle ${cyclesDesc.length} 筆`);
  console.log(`  校正期(user_calibrating) ${recoveries.filter((r) => r?.score?.user_calibrating === true).length} 筆`);

  console.log('\n指標 / 有資料筆數 / 最新值：');
  for (const metric of METRICS) {
    let hits = 0;
    let latest = null;
    if (metric.source === 'cycle') {
      for (const c of cyclesDesc) {
        const v = metric.get(c);
        if (v !== null) { hits += 1; if (latest === null) latest = v; }
      }
    } else {
      for (const r of records) {
        const v = metricValueFromRecord(metric, r);
        if (v !== null) { hits += 1; if (latest === null) latest = v; }
      }
    }
    const total = metric.source === 'cycle' ? cyclesDesc.length : records.length;
    const tag = metric.tier === 'core' ? '核心' : '選配';
    const mark = hits === 0 ? '❌ 這個帳號沒有' : (hits < total ? '⚠️  部分有' : '✅');
    console.log(
      `  ${mark} [${tag}] ${metric.label.padEnd(12, ' ')} ${String(hits).padStart(3)}/${String(total).padEnd(3)}` +
      `  最新 ${latest === null ? '-' : metric.fmt(latest)}`,
    );
  }

  const dates = records.slice(0, 5).map((r) => `${r.date}(${localDate(r.sleep.end, env.timezone)})`);
  console.log(`\n最近幾天的主睡眠日期：${dates.join(', ')}\n`);
} catch (err) {
  console.error(`❌ 失敗：${err.message}`);
  process.exitCode = 1;
} finally {
  db.close();
}
