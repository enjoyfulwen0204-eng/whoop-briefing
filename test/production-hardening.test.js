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

function readReadmeUnderTest() {
  const original = read('README.md');
  const mutation = process.env.RC5_README_MUTATION ?? process.env.RC4_README_MUTATION;
  if (!mutation) return original;
  const fraction = Number(
    process.env.RC5_README_MUTATION_AT ?? process.env.RC4_README_MUTATION_AT ?? 0.5,
  );
  const offset = Math.floor(original.length * Math.min(1, Math.max(0, fraction)));
  return `${original.slice(0, offset)}\n${mutation}\n${original.slice(offset)}`;
}

function assertReadmeSchedulerContract(readme) {
  const whole = readme.replace(/\s+/g, ' ');

  // Positive truths: these may live in different README sections, but all are required.
  assert.match(whole, /Cloudflare Worker Cron.{0,80}主排程|主排程.{0,80}Cloudflare Worker Cron/i,
    '★ README 必須識別 Cloudflare Worker Cron 為主排程');
  assert.match(whole, /GitHub Actions.{0,80}備援|備援.{0,80}GitHub Actions/i,
    '★ README 必須識別 GitHub Actions 為備援');
  assert.match(whole, /cloudflare\/briefing-scheduler\/wrangler\.toml/i,
    '★ README 必須指出 Cloudflare primary cadence source');
  assert.match(whole, /\.github\/workflows\/briefing\.yml/i,
    '★ README 必須指出 GitHub backup cadence source');
  assert.match(whole, /Render.{0,100}(?:沒有|不含|刻意不含) production cron/i,
    '★ README 必須明示 Render 不是 production cron owner');
  assert.match(whole, /scheduler readiness.{0,160}"scheduler":"enabled"/i,
    '★ scheduler readiness 必須要求 enabled');
  assert.match(whole, /webhook drain.{0,240}FAST 對帳.{0,240}(?:watchdog|Guardian)/i,
    '★ canonical runner 必須涵蓋報告以外的 scheduler-owned 工作');
  assert.match(whole, /報告已結案只會跳過報告遞送/i,
    '★ settled reports 必須只跳過 report delivery');
  assert.match(whole, /`src\/index\.js`.{0,320}Canonical scheduler\/application runner/i,
    '★ src/index.js 必須描述成 canonical runner');
  assert.match(whole, /正常排程健康處理.{0,200}`?ACTIVE`?.{0,160}`?READY`?/i,
    '★ normal scheduled health processing 必須同時要求 ACTIVE 與 READY');
  assert.match(whole, /`?ACTIVE`?.{0,40}(?:帳號|account).{0,40}(?:生命週期|lifecycle).{0,40}(?:允許|permits).{0,40}(?:正常處理|normal processing)/i,
    '★ README 必須說明 ACTIVE 的 lifecycle 語義');
  assert.match(whole, /`?READY`?.{0,50}(?:上線|onboarding).{0,80}(?:bootstrap|資源存取).{0,80}(?:可排程|scheduler eligibility|eligible)/i,
    '★ README 必須說明 READY 的 onboarding 語義');

  // Negative contradiction classes: scan the complete normalized README, not one line/section.
  const contradictions = [
    [
      /Render (?:controls|sets|owns|manages) (?:the )?(?:production )?scheduler (?:cadence|frequency|schedule)/i,
      'Render 不可以控制 production scheduler cadence',
    ],
    [
      /執行頻率.{0,160}render\.yaml.{0,160}(?:兩邊都要改|也要改)|render\.yaml.{0,80}(?:controls|sets|owns|manages).{0,40}(?:cadence|frequency|schedule)/i,
      'render.yaml 不可以是 cadence 變更控制面',
    ],
    [
      /Render (?:runs|hosts|owns|provides|uses) (?:the )?(?:production )?cron/i,
      'Render 不可以執行 production cron',
    ],
    [
      /Render.{0,40}(?:執行|運行|提供|擁有).{0,30}(?:production )?cron/i,
      'README 不可以宣稱 Render 擁有 production cron',
    ],
    [
      /GitHub Actions (?:is|serves as|acts as) (?:the )?(?:primary|main) (?:production )?scheduler/i,
      'GitHub Actions 不可以被稱為 primary production scheduler',
    ],
    [
      /GitHub Actions.{0,40}(?:是|擔任|作為).{0,30}(?:正式環境的)?主排程/i,
      'README 不可以把 GitHub Actions 稱為主排程',
    ],
    [
      /HTTP 200 (?:from )?\/health (?:alone )?(?:means|proves|indicates|equals).{0,30}(?:scheduler is )?(?:ready|enabled|available)/i,
      'HTTP 200 不可以等同 scheduler readiness',
    ],
    [
      /HTTP 200.{0,50}(?:就代表|即代表|等於).{0,40}(?:scheduler|排程).{0,30}(?:ready|enabled|可用|就緒)/i,
      'README 不可以讓 HTTP 200 單獨代表 scheduler-ready',
    ],
    [
      /Once reports? (?:are )?(?:settled|not due).{0,50}(?:whole|entire).{0,30}(?:scheduled )?run (?:exits|ends|stops)/i,
      'settled reports 不可以終止 whole scheduled run',
    ],
    [
      /都成立就直接結束，連 WHOOP 都不打|報告(?:已)?(?:結案|不用發|不待發).{0,30}(?:就|後|時).{0,40}(?:整輪|整個).{0,20}(?:結束|退出)/i,
      'README 不可以把 report settlement 當成整輪結束',
    ],
    [
      /(?:failed operation|operation|it) retries? on the next run.{0,20}30 minutes later/i,
      'README 不可以承諾 next run 30 minutes later',
    ],
    [
      /下一輪[（(]?\s*30\s*分鐘後/i,
      'README 不可以保留固定 30 分鐘 next-run 模型',
    ],
    [
      /src\/index\.js.{0,120}判斷今天有沒有事要做.{0,120}(?:daily|weekly)/i,
      'src/index.js 不可以被描述成 report-only entrypoint',
    ],
    [
      /runBriefing.{0,100}(?:only|just|solely|只).{0,100}(?:reports?|daily|weekly|報告|簡報)/i,
      'runBriefing 不可以被描述成 report-only',
    ],
    [
      /(?:All|Every) ACTIVE users? (?:are|is) (?:selected|scheduled|processed) by the scheduler|scheduler.{0,50}(?:selects|schedules|processes) (?:all|every) ACTIVE users?/i,
      'README 不可以宣稱所有 ACTIVE 使用者都會被排程',
    ],
    [
      /排程.{0,30}(?:撈出|選出|選取|處理)(?:所有|每個)?\s*`?ACTIVE`?\s*使用者/i,
      'README 不可以把 ACTIVE 單獨當成排程選取條件',
    ],
    [
      /ACTIVE status alone (?:makes|renders).{0,50}(?:eligible|scheduled)|ACTIVE alone (?:is|makes).{0,50}(?:sufficient|eligible)/i,
      'ACTIVE alone 不可以被描述成足以排程',
    ],
    [
      /(?:只要|僅需).{0,20}`?ACTIVE`?.{0,30}(?:就|即可|足以).{0,30}(?:排程|符合資格)|`?ACTIVE`?.{0,30}(?:本身|單獨).{0,30}(?:足以|即可).{0,30}(?:排程|符合資格)/i,
      'README 不可以宣稱 ACTIVE 單獨就符合排程資格',
    ],
    [
      /READY (?:onboarding )?state is not required for scheduling|READY is (?:optional|unnecessary) for (?:normal )?(?:scheduling|scheduled processing)/i,
      'READY 不可以被描述成排程的非必要條件',
    ],
    [
      /`?READY`?.{0,30}(?:不是必要|不需要|可有可無).{0,30}(?:排程|資格)|(?:排程|資格).{0,30}(?:不要求|不需要).{0,20}`?READY`?/i,
      'README 不可以宣稱 READY 對排程資格是 optional',
    ],
    [
      /onboarding state (?:does not|doesn't) (?:affect|matter for|determine) scheduler eligibility/i,
      'onboarding state 必須影響 scheduler eligibility',
    ],
    [
      /(?:scheduler.{0,30}(?:selects|processes) only (?:onboarding-complete|READY) users?|排程只看上線完成[（(]?\s*READY)/i,
      'READY 不可以被描述成 normal scheduling 的唯一資格',
    ],
  ];
  for (const [pattern, message] of contradictions) {
    assert.doesNotMatch(whole, pattern, `★ ${message}`);
  }
}

// ===========================================================================
// ★★★ Render 不可以成為第三個排程器
// ===========================================================================

/**
 * 正式環境由 Cloudflare Worker Cron 主觸發，GitHub Actions 獨立備援。
 *
 * render.yaml 以前宣告了一個一模一樣的 `type: cron` 跑 `npm start`。
 * Render 的 Blueprint 會從 repo 同步，所以只要有人重新連結或重新套用藍圖，
 * 那個 cron 就會被重新建立並啟用 —— 同一個 Turso、同一個 WHOOP 帳號，
 * 形成不受控的第三個排程來源。
 *
 * 資料不會壞（report_claims 擋重複發送、resource_locks 擋 refresh_token
 * 輪替競態），但 WHOOP 用量、OpenRouter 花費、主動代理的評估全部變成兩倍，
 * 而且沒有任何地方看得出來為什麼。
 */
test('★★★ 部署：Render blueprint 不可以宣告第三個排程器', () => {
  const blueprint = read('render.yaml');
  const services = blueprint
    .split('\n')
    .filter((l) => /^\s*-\s*type:\s*\S+/.test(l))
    .map((l) => l.replace(/^\s*-\s*type:\s*/, '').trim());

  assert.ok(!services.includes('cron'),
    '★ render.yaml 不可以宣告 cron 服務 —— Cloudflare 主排程與 GitHub 備援已經是完整拓撲');
  assert.ok(!/^\s*schedule:/m.test(blueprint),
    '★ render.yaml 不可以有任何 schedule（那會成為第三個排程器）');
  assert.ok(!/startCommand:\s*npm start/.test(blueprint),
    '★ render.yaml 不可以跑 npm start（那是排程器的進入點）');
});

test('★★★ RC3/RC4/RC5 README whole-file scheduler and eligibility contract', () => {
  assertReadmeSchedulerContract(readReadmeUnderTest());
});

test('★★★ 部署：Cloudflare 是 10 分鐘主排程，GitHub 是錯開的每小時備援', () => {
  const wf = read('.github/workflows/briefing.yml');
  assert.match(wf, /cron:\s*"17 \* \* \* \*"/, '★ GitHub 必須是每小時第 17 分備援');
  const worker = fs.readFileSync('cloudflare/briefing-scheduler/wrangler.toml', 'utf8');
  assert.match(worker, /crons\s*=\s*\["\*\/10 \* \* \* \*"\]/,
    '★ Cloudflare 必須是每 10 分鐘主排程');
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
 * Guardian 與 scheduler watchdog 都在 canonical runner 裡；只要 Cloudflare 或
 * GitHub 還有一方活著，就能看見另一方的 heartbeat 變舊。兩邊同時停止時，
 * repo 內無法自我偵測，所以仍要有一個**唯讀、隨時可跑**的存活檢查。
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

    // 3) 停了四小時（遠超過 10 分鐘主排程與每小時備援的正常 cadence）
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
  const PRIMARY_CADENCE_MS = 10 * 60_000;
  const BACKUP_CADENCE_MS = 60 * 60_000;
  assert.ok(GUARDIAN_POLICY.CRON_HEARTBEAT_MAX_AGE_MS >= 12 * PRIMARY_CADENCE_MS,
    '★ 門檻必須容忍多個 Cloudflare primary cadence');
  assert.ok(GUARDIAN_POLICY.CRON_HEARTBEAT_MAX_AGE_MS >= 2 * BACKUP_CADENCE_MS,
    '★ 太短會被 GitHub Actions 正常的延遲誤觸發');
  assert.ok(GUARDIAN_POLICY.CRON_HEARTBEAT_MAX_AGE_MS <= 24 * 3600_000,
    '★ 太長就失去意義了');
});
