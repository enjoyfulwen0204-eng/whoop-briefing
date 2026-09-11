/**
 * setWebhook 註冊送出去的內容（入站序列化）。
 *
 * 這支腳本是 CLI，頂層就會執行，所以不能直接 import。改用子行程跑，並且用
 * `--import` 先把 global fetch 換掉 —— 全程離線，**不會**真的打 Telegram。
 *
 * 只擷取「方法名稱 + body」。URL 帶著 bot token，絕對不落地、不進斷言訊息。
 *
 * 守的三件事：
 *   1. max_connections=1 —— 入站刻意序列化。應用層的耐久順序控制是從
 *      「已經被耐久認領」才開始生效的；在那之前 Telegram 若同時開多條連線，
 *      N+1 有機會比 N 更早抵達 claim，而那時 DB 裡還沒有 N 可以擋。
 *      這一行把那個 pre-claim 窗口關掉。**不是**唯一的正確性機制。
 *   2. 絕不送 drop_pending_updates —— 正式環境還有待處理的真實訊息。
 *   3. 絕不呼叫 getUpdates —— 那會動到待處理佇列。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 跑一次註冊腳本，回傳它「本來會送出去」的請求。
 * fetch 被換成假的，所以沒有任何封包離開這台機器。
 */
async function captureRequests(action) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgreg-'));
  const out = path.join(dir, 'calls.json');
  const preload = path.join(dir, 'stub.mjs');
  fs.writeFileSync(preload, `
import fs from 'node:fs';
const calls = [];
globalThis.fetch = async (url, init) => {
  // 只留方法名稱與 body —— URL 含 bot token，刻意不保存。
  const method = String(url).split('/').pop();
  let body = null;
  try { body = init?.body ? JSON.parse(init.body) : null; } catch { body = '<non-json>'; }
  calls.push({ method, body });
  fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify(calls));
  const result = method === 'getWebhookInfo'
    ? { url: '', pending_update_count: 2 }
    : true;
  return { ok: true, json: async () => ({ ok: true, result }) };
};
`);
  await run(process.execPath, ['--import', `file://${preload}`, 'scripts/telegram-webhook.js', action], {
    cwd: ROOT,
    env: {
      ...process.env,
      TELEGRAM_BOT_TOKEN: 'test-token-not-real',
      TELEGRAM_WEBHOOK_SECRET: 'test-secret-not-real',
      TELEGRAM_WEBHOOK_URL: 'https://example.invalid/telegram/webhook',
    },
  });
  const calls = JSON.parse(fs.readFileSync(out, 'utf8'));
  fs.rmSync(dir, { recursive: true, force: true });
  return calls;
}

test('★★★ 註冊: setWebhook 送出 max_connections = 1（入站序列化）', async () => {
  const calls = await captureRequests('set');
  const setCall = calls.find((c) => c.method === 'setWebhook');
  assert.ok(setCall, '★ 必須真的送出 setWebhook');
  assert.equal(setCall.body.max_connections, 1,
    '★ 必須是 1 —— 多條併發連線不保證 update 會照 update_id 抵達 claim');
});

test('★★★ 註冊: 絕不送 drop_pending_updates（正式環境還有待處理訊息）', async () => {
  const calls = await captureRequests('set');
  const setCall = calls.find((c) => c.method === 'setWebhook');
  assert.ok(!('drop_pending_updates' in setCall.body),
    '★ 連這個參數都不可以出現 —— 待處理佇列必須被保留');
});

test('★★★ 註冊: 任何動作都不可以呼叫 getUpdates', async () => {
  for (const action of ['status', 'set', 'delete']) {
    const calls = await captureRequests(action);
    assert.ok(!calls.some((c) => c.method === 'getUpdates'),
      `★ ${action} 不可以動到待處理佇列`);
  }
});

test('★★ 註冊: 只訂閱 message，而且帶上 secret', async () => {
  const calls = await captureRequests('set');
  const body = calls.find((c) => c.method === 'setWebhook').body;
  assert.deepEqual(body.allowed_updates, ['message']);
  assert.ok(typeof body.secret_token === 'string' && body.secret_token.length > 0,
    '★ 一定要帶 secret —— 端點是公開可達的');
});
