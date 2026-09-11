/**
 * V1.1 正式環境固化（production hardening）。
 *
 * 這個檔案守的兩件事都不是程式邏輯的 bug，而是**部署層**的風險 ——
 * 那正是前幾輪的程式稽核看不到的地方。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDb } from '../src/db.js';
import { GLOBAL_SCOPE } from '../src/schema.js';
import { HEARTBEAT_COMPONENT, GUARDIAN_POLICY } from '../src/guardianPolicy.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// ===========================================================================
// ★★★ 排程器只能有一個擁有者
// ===========================================================================

/**
 * 正式環境的排程器是 GitHub Actions，而且**只有**它。
 *
 * render.yaml 以前宣告了一個一模一樣的 `type: cron` 跑 `npm start`。
 * Render 的 Blueprint 會從 repo 同步，所以只要有人重新連結或重新套用藍圖，
 * 那個 cron 就會被重新建立並啟用 —— 同一個 Turso、同一個 WHOOP 帳號，
 * 兩個排程器各跑各的。
 *
 * 資料不會壞（report_claims 擋重複發送、resource_locks 擋 refresh_token
 * 輪替競態），但 WHOOP 用量、OpenRouter 花費、主動代理的評估全部變成兩倍，
 * 而且沒有任何地方看得出來為什麼。
 */
test('★★★ 部署：repo 裡只能有一個排程器（render.yaml 不可以有 cron）', () => {
  const blueprint = read('render.yaml');
  const services = blueprint
    .split('\n')
    .filter((l) => /^\s*-\s*type:\s*\S+/.test(l))
    .map((l) => l.replace(/^\s*-\s*type:\s*/, '').trim());

  assert.ok(!services.includes('cron'),
    '★ render.yaml 不可以宣告 cron 服務 —— 排程的擁有者是 GitHub Actions');
  assert.ok(!/^\s*schedule:/m.test(blueprint),
    '★ render.yaml 不可以有任何 schedule（那就是第二個排程器）');
  assert.ok(!/startCommand:\s*npm start/.test(blueprint),
    '★ render.yaml 不可以跑 npm start（那是排程器的進入點）');
});

test('★★★ 部署：GitHub Actions 仍然是那一個排程器，且維持 30 分鐘', () => {
  const wf = read('.github/workflows/briefing.yml');
  assert.match(wf, /cron:\s*"\*\/30 \* \* \* \*"/, '★ 節奏必須維持每 30 分鐘');
  assert.match(wf, /concurrency:/, '★ 必須有 concurrency 保護，避免 run 重疊');
  assert.match(wf, /cancel-in-progress:\s*false/,
    '★ 不可以取消進行中的 run（跑到一半被砍會留下未完成的狀態）');
  assert.match(wf, /timeout-minutes:/, '★ 必須有 timeout，否則卡住的 run 會擋住後面每一次');
  assert.match(wf, /npm start/, '★ 排程跑的是 npm start');
  // 排程不可以每一輪都做破壞性的事
  assert.ok(!/npm run migrate|--force|backfill/.test(wf),
    '★ 排程不可以每輪跑遷移或強制 backfill');
});

test('★★ 部署：workflow 不可以把 secret 印出來', () => {
  const wf = read('.github/workflows/briefing.yml');
  assert.ok(!/echo\s+.*secrets\./.test(wf), '★ 不可以 echo secret');
  // secret 只能出現在 env: 區塊的 ${{ secrets.X }} 位置
  for (const line of wf.split('\n')) {
    if (!line.includes('secrets.')) continue;
    assert.match(line.trim(), /^[A-Z_]+:\s*\$\{\{\s*secrets\.[A-Z_]+\s*\}\}$/,
      `★ secret 只能直接指派給 env 變數：${line.trim()}`);
  }
});

// ===========================================================================
// ★★★ 排程死掉時要看得見
// ===========================================================================

/**
 * 這個系統健康的時候完全安靜，所以「排程死掉」和「一切正常」在使用者
 * 眼裡長得一模一樣。
 *
 * 唯一會注意到心跳變舊的是 Guardian，而 Guardian 跑在 cron 裡面 ——
 * 排程一停，就再也沒有人去看那個心跳。所以至少要有一個**唯讀、隨時可跑**
 * 的存活檢查，讓維運的人一個指令就問得到。
 */
test('★★★ 觀測：health-status 會讀 cron 心跳並判斷是否過期', () => {
  const src = read('scripts/health-status.js');
  assert.match(src, /getHeartbeat\(\s*GLOBAL_SCOPE,\s*HEARTBEAT_COMPONENT\.CRON\s*\)/,
    '★ 必須真的去讀全域的 cron 心跳');
  assert.match(src, /CRON_HEARTBEAT_MAX_AGE_MS/,
    '★ 過期判準必須沿用 Guardian 的政策，不可以自己另外寫一個數字');
});

test('★★★ 觀測：心跳的三種狀態都判斷正確', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hardening-'));
  const db = createDb({ url: `file:${path.join(dir, 't.db')}` });
  try {
    await db.migrate();
    const staleFor = (beat) => (beat?.lastOkAt
      ? (Date.now() - new Date(beat.lastOkAt).getTime()) > GUARDIAN_POLICY.CRON_HEARTBEAT_MAX_AGE_MS
      : null);

    // 1) 從來沒有跑完過一輪
    assert.equal(await db.getHeartbeat(GLOBAL_SCOPE, HEARTBEAT_COMPONENT.CRON), null,
      '★ 沒有心跳要回 null（而不是假裝健康）');

    // 2) 剛跑完
    await db.recordHeartbeat(GLOBAL_SCOPE, HEARTBEAT_COMPONENT.CRON, {
      detail: 'users=1', now: new Date(),
    });
    const fresh = await db.getHeartbeat(GLOBAL_SCOPE, HEARTBEAT_COMPONENT.CRON);
    assert.equal(staleFor(fresh), false, '★ 剛跑完不可以被判成過期');
    assert.equal(fresh.lastDetail, 'users=1');

    // 3) 停了四小時（排程是 30 分鐘一次 → 連漏 8 次）
    await db.recordHeartbeat(GLOBAL_SCOPE, HEARTBEAT_COMPONENT.CRON, {
      detail: 'users=1', now: new Date(Date.now() - 4 * 3600_000),
    });
    assert.equal(staleFor(await db.getHeartbeat(GLOBAL_SCOPE, HEARTBEAT_COMPONENT.CRON)), true,
      '★ 停掉四小時必須被判成過期');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('★★ 觀測：心跳門檻明顯大於排程週期（不會因為偶爾延遲就誤報）', () => {
  const THIRTY_MIN = 30 * 60_000;
  assert.ok(GUARDIAN_POLICY.CRON_HEARTBEAT_MAX_AGE_MS >= 4 * THIRTY_MIN,
    '★ 太短會被 GitHub Actions 正常的延遲誤觸發');
  assert.ok(GUARDIAN_POLICY.CRON_HEARTBEAT_MAX_AGE_MS <= 24 * 3600_000,
    '★ 太長就失去意義了');
});
