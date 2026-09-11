#!/usr/bin/env node
/**
 * Telegram webhook 註冊工具。
 *
 *   npm run telegram:webhook:status   看現在的狀態（唯讀）
 *   npm run telegram:webhook:set      註冊 webhook
 *   npm run telegram:webhook:delete   取消註冊（回到沒有 webhook 的狀態）
 *
 * ## 安全規則（寫死在程式裡，不是靠人記得）
 *
 * 1. **永遠不呼叫 getUpdates。** 那會動到待處理佇列。
 * 2. **永遠不送 drop_pending_updates=true。** 正式環境現在有一則真實的待處理
 *    訊息，它必須活到 webhook 上線之後被正常處理掉。setWebhook 預設會保留
 *    佇列，這裡刻意連這個參數都不傳。
 * 3. 不印 token、不印 secret。URL 會印（它不是祕密，認證靠 secret 標頭）。
 *
 * ## 為什麼 secret 是必要的
 *
 * webhook 端點是公開可達的。沒有 secret，任何人都能 POST 一則假造的
 * 「某某使用者說了什麼」進來，讓系統寫進他的 Journal。
 */

import { loadDotEnvIfPresent, loadEnv, TELEGRAM_BOT } from '../src/config.js';

loadDotEnvIfPresent();

const action = process.argv[2] ?? 'status';
const VALID = new Set(['status', 'set', 'delete']);
if (!VALID.has(action)) {
  console.error(`用法：node scripts/telegram-webhook.js <${[...VALID].join('|')}>`);
  process.exit(2);
}

const env = loadEnv({ require: ['TELEGRAM_BOT_TOKEN'] });
const base = `https://api.telegram.org/bot${env.telegramBotToken}`;

/** 呼叫 Telegram API。**絕不**把 token 寫進任何輸出。 */
async function call(method, payload = null) {
  const res = await fetch(`${base}/${method}`, payload ? {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  } : undefined);
  const json = await res.json().catch(() => ({ ok: false, description: '回應不是 JSON' }));
  if (!json.ok) throw new Error(`${method} 失敗：${json.description ?? res.status}`);
  return json.result;
}

function printStatus(info) {
  console.log('── Telegram webhook 現況 ──');
  console.log(`  url                  ${info.url ? info.url : '（未設定）'}`);
  console.log(`  pending_update_count ${info.pending_update_count ?? 0}`);
  console.log(`  custom_certificate   ${info.has_custom_certificate ? 'yes' : 'no'}`);
  console.log(`  max_connections      ${info.max_connections ?? '（預設）'}`);
  console.log(`  secret 已設定         ${info.url ? '（Telegram 不會回報，看你設定時有沒有給）' : '—'}`);
  if (info.last_error_message) {
    console.log(`  ⚠️ last_error        ${info.last_error_message}`);
    console.log(`     last_error_date   ${info.last_error_date
      ? new Date(info.last_error_date * 1000).toISOString() : '-'}`);
  }
}

try {
  if (action === 'status') {
    printStatus(await call('getWebhookInfo'));
  }

  if (action === 'set') {
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
    const url = process.env.TELEGRAM_WEBHOOK_URL;
    if (!secret) throw new Error('缺少 TELEGRAM_WEBHOOK_SECRET');
    if (!url) {
      throw new Error(
        '缺少 TELEGRAM_WEBHOOK_URL（例如 https://<你的服務>.onrender.com'
        + `${TELEGRAM_BOT.WEBHOOK_PATH}）`,
      );
    }
    if (!/^https:\/\//.test(url)) throw new Error('TELEGRAM_WEBHOOK_URL 必須是 https');
    if (!url.endsWith(TELEGRAM_BOT.WEBHOOK_PATH)) {
      throw new Error(`TELEGRAM_WEBHOOK_URL 必須以 ${TELEGRAM_BOT.WEBHOOK_PATH} 結尾`);
    }

    const before = await call('getWebhookInfo');
    console.log(`註冊前待處理訊息：${before.pending_update_count ?? 0} 則（會被保留）`);

    // ⚠️ 刻意**不傳** drop_pending_updates —— 預設就是保留佇列。
    await call('setWebhook', {
      url,
      secret_token: secret,
      allowed_updates: ['message'],
      max_connections: 10,
    });
    console.log(`✅ 已註冊：${url}`);

    const after = await call('getWebhookInfo');
    printStatus(after);
    if ((after.pending_update_count ?? 0) < (before.pending_update_count ?? 0)) {
      console.log('\n⚠️ 待處理訊息數變少了 —— 請確認沒有東西把佇列清掉。');
    }
  }

  if (action === 'delete') {
    // 一樣不傳 drop_pending_updates：取消註冊之後佇列要留著。
    await call('deleteWebhook');
    console.log('✅ 已取消註冊（待處理訊息保留）');
    printStatus(await call('getWebhookInfo'));
  }
} catch (err) {
  console.error(`❌ ${err.message}`);
  process.exitCode = 1;
}
