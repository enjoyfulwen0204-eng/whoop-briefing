#!/usr/bin/env node
/**
 * 用假資料把整條流程跑一遍，把「真的會發到 Telegram 的訊息」印在畫面上。
 * 不需要 WHOOP / Turso / Telegram 帳號。
 *
 * 用法：
 *   npm run dry-run            假資料 + 假教練文字（完全離線）
 *   npm run dry-run -- --live  假資料 + 真的呼叫 Claude 生成教練文字
 *                              （需要 ANTHROPIC_API_KEY，會花一點點錢）
 */

import { runDaily } from '../src/daily.js';
import { runWeekly } from '../src/weekly.js';
import { staticDataSource } from '../src/dataSource.js';
import { createCoach } from '../src/coach.js';
import { loadDotEnvIfPresent, COACH } from '../src/config.js';
import { localDate, localWeekday } from '../src/time.js';
import { TelegramError } from '../src/telegram.js';
import { makeDataset, degradedOverrides, trendOverrides } from '../test/fixtures.js';
import { fakeDb, fakeTelegram, fakeCoach } from '../test/fakes.js';

loadDotEnvIfPresent();

const live = process.argv.includes('--live');
const TZ = process.env.TIMEZONE || 'Asia/Taipei';

if (live && !process.env.ANTHROPIC_API_KEY) {
  console.error('--live 需要 ANTHROPIC_API_KEY（放在 .env 裡）');
  process.exit(1);
}

const coachFor = (fail = false) => {
  if (fail) return fakeCoach({ fail: true });
  if (live) {
    return createCoach({
      apiKey: process.env.ANTHROPIC_API_KEY,
      model: process.env.ANTHROPIC_MODEL || COACH.DEFAULT_MODEL,
    });
  }
  return fakeCoach({
    dailyText: '（離線假文字）早安 Kelvin，今天身體給的訊號我看到了，先照上面的重點調整一下節奏 💛',
    weeklyText: '（離線假文字）上週整體算穩，我們下週把入睡時間再往前拉一點點就好 💪',
  });
};

function mondayMorning() {
  let d = new Date('2026-08-24T00:00:00Z');
  while (localWeekday(localDate(d, TZ)) !== 1) d = new Date(d.getTime() + 86_400_000);
  return d;
}

function banner(title) {
  console.log(`\n\n${'█'.repeat(70)}`);
  console.log(`█  情境：${title}`);
  console.log(`${'█'.repeat(70)}`);
}

function show(label, text) {
  console.log(`\n--- ${label}（${text.length} 字元 / 上限 4096）---`);
  console.log('┌' + '─'.repeat(68));
  for (const line of text.split('\n')) console.log(`│ ${line}`);
  console.log('└' + '─'.repeat(68));
}

async function scenario({ title, dataset, now, coachFails = false, telegramFails = false }) {
  banner(title);
  const db = fakeDb();
  const telegram = telegramFails
    ? {
      sent: [],
      send: async () => { throw new TelegramError('模擬 Telegram 502'); },
      notifyError: async () => { console.log('  ❌ 不該發生：Telegram 掛了還去呼叫 Telegram'); },
    }
    : fakeTelegram();

  const res = await runDaily({
    db,
    telegram,
    coach: coachFor(coachFails),
    source: staticDataSource(dataset),
    timezone: TZ,
    now,
  });

  console.log(`\n結果：status=${res.status}${res.reason ? ` reason=${res.reason}` : ''}`);
  if (res.briefing) {
    console.log(`基準階段：${res.briefing.stage}（有效紀錄 ${res.briefing.baselineTotalRecords} 筆）`);
    console.log(`趨勢預警：${res.briefing.trends.level}`);
  }
  console.log(`DB 紀錄：${JSON.stringify(db.runs.map((r) => ({ t: r.reportType, d: r.localDateKey, s: r.status, detail: r.detail })))}`);
  if (telegram.sent?.length) show('Telegram 訊息', telegram.sent[0]);
  return { db, telegram, res };
}

// ---------------------------------------------------------------------------
console.log('WHOOP 早晨簡報 — 假資料 dry run');
console.log(`模式：${live ? '真的呼叫 Claude' : '離線（假教練文字）'}｜時區：${TZ}`);

const normal = makeDataset({ days: 45 });
await scenario({ title: '一切正常（>=30 筆正式基準）', dataset: normal, now: normal.now });

const degraded = makeDataset({ days: 45, overrides: { ...trendOverrides(), ...degradedOverrides() } });
await scenario({
  title: '多項指標明顯偏離 + 連續 3 天走低（趨勢預警）',
  dataset: degraded,
  now: degraded.now,
});

const cold = makeDataset({ days: 4, overrides: degradedOverrides() });
await scenario({ title: '冷啟動 <7 筆（只顯示數據、不給燈）', dataset: cold, now: cold.now });

const provisional = makeDataset({ days: 15 });
await scenario({ title: '冷啟動 7–29 筆（暫定基準，顯示 n/30）', dataset: provisional, now: provisional.now });

const whoopOne = makeDataset({ days: 45, omitFields: ['spo2', 'skin_temp'] });
await scenario({
  title: 'WHOOP One：沒有 SpO2 / 皮膚溫度（自動略過那幾行）',
  dataset: whoopOne,
  now: whoopOne.now,
});

await scenario({
  title: 'Claude 掛掉 → 照樣發數據簡報 + fallback 說明',
  dataset: normal,
  now: normal.now,
  coachFails: true,
});

const tooSoon = makeDataset({ days: 45, wakeMinutesAgo: 12 });
await scenario({ title: '起床才 12 分鐘 → 這一輪先不發', dataset: tooSoon, now: tooSoon.now });

await scenario({
  title: 'Telegram 掛掉 → 記 FAILED，且不遞迴呼叫 Telegram',
  dataset: normal,
  now: normal.now,
  telegramFails: true,
});

// ---- 每週回顧 ----
banner('每週回顧（週一）+ 同一天 daily 不互相阻擋');
{
  const now = mondayMorning();
  const dataset = makeDataset({ days: 45, now });
  const db = fakeDb();
  const telegram = fakeTelegram();
  const ctx = {
    db, telegram, coach: coachFor(), source: staticDataSource(dataset), timezone: TZ, now,
  };
  const d = await runDaily(ctx);
  const w = await runWeekly(ctx);
  console.log(`\ndaily=${d.status}  weekly=${w.status}（兩者互不影響）`);
  if (telegram.sent[0]) show('Telegram 訊息 1（每日）', telegram.sent[0]);
  if (telegram.sent[1]) show('Telegram 訊息 2（每週回顧）', telegram.sent[1]);
}

console.log('\n✅ dry run 結束。上面每一則就是實際會出現在 Telegram 的樣子。\n');
