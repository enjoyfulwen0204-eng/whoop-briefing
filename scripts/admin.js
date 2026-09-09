#!/usr/bin/env node
/**
 * 運維管理 CLI —— 讓第二個使用者可以被正常帶進系統，而不需要手動改資料庫。
 *
 * ## 為什麼需要這支
 *
 * identityStore.js 早就有 createUser / createLinkCode / updateUser /
 * revokeTelegramLink，schema 與安全性也都完整（綁定碼只存 hash、一次性、
 * WHOOP 帳號唯一性由 partial unique index 保證）。缺的只有**運維入口** ——
 * 在這支之前，要建立一個使用者只能直接寫 SQL。
 *
 * ## 這支腳本不做什麼
 *
 *  - **不重新實作任何身分邏輯**，全部呼叫既有的 store 函式。
 *  - **不刪除任何健康資料。** 停用使用者只改 users.status，資料一列都不動。
 *  - 不呼叫 WHOOP / OpenRouter / Telegram。只讀寫 Turso。
 *
 * ## 綁定碼的處理（重要）
 *
 * 原文只在產生的那一刻存在，DB 只有 SHA-256 hash。這支腳本把原文
 * **直接 console.log 到 stdout，而且絕不經過 structured logger** ——
 * logger 會把 `code` 這個 key 遮蔽掉，但更根本的理由是：原文不該進任何
 * 會被收集、轉發、留存的管道。印一次，看到就用掉。
 *
 * 用法：
 *   node scripts/admin.js user:create --name="Friend" [--timezone=Asia/Taipei]
 *   node scripts/admin.js user:list [--status=ACTIVE]
 *   node scripts/admin.js user:status --user=<id> --status=ACTIVE|PAUSED|DISABLED
 *   node scripts/admin.js link:new --user=<id> [--ttl-hours=24]
 *   node scripts/admin.js link:revoke --chat=<telegramChatId>
 *   node scripts/admin.js whoop:status --user=<id>
 */

import { loadDotEnvIfPresent, loadEnv } from '../src/config.js';
import { createDb } from '../src/db.js';
import { USER_STATUS } from '../src/schema.js';

// ---------------------------------------------------------------------------
// 參數解析（刻意極簡：--key=value 與 --key value 都接受）
// ---------------------------------------------------------------------------
export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq > 0) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      // 沒有值、或下一個又是旗標 → 當成 boolean
      out[a.slice(2)] = next && !next.startsWith('--') ? next : true;
      if (next && !next.startsWith('--')) i += 1;
    }
  }
  return out;
}

export const USAGE = `WHOOP 簡報系統 —— 運維管理指令

  user:create   --name="顯示名稱" [--timezone=Asia/Taipei]
                建立一個新的內部使用者，印出他的 internal user id。

  user:list     [--status=ACTIVE|PAUSED|DISABLED]
                列出使用者（含 Telegram 綁定與 WHOOP 授權狀態）。

  user:status   --user=<id> --status=ACTIVE|PAUSED|DISABLED
                改變使用者狀態。**不會刪除任何資料。**
                非 ACTIVE 的使用者不會被排程處理。

  link:new      --user=<id> [--ttl-hours=24]
                產生一次性 Telegram 綁定碼。原文只會印出這一次。

  link:revoke   --chat=<telegramChatId>
                解除某個 Telegram chat 的綁定（狀態改成 REVOKED）。

  whoop:status  --user=<id>
                看這個使用者的 WHOOP 授權狀態（不呼叫 WHOOP）。
`;

/** 缺少必要參數時統一的錯誤。 */
class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

function requireArg(args, key, hint) {
  const v = args[key];
  if (v === undefined || v === true || String(v).trim() === '') {
    throw new UsageError(`缺少 --${key}${hint ? `（${hint}）` : ''}`);
  }
  return String(v).trim();
}

const pad = (s, n) => String(s ?? '-').padEnd(n, ' ');

// ---------------------------------------------------------------------------
// 各個子指令。全部吃 { db, args, out }，回傳 exit code。
// out 是注入點，測試不需要攔截 console。
// ---------------------------------------------------------------------------
export const COMMANDS = {
  async 'user:create'({ db, args, out }) {
    const displayName = requireArg(args, 'name', '顯示名稱');
    const timezone = args.timezone && args.timezone !== true
      ? String(args.timezone).trim()
      : 'Asia/Taipei';

    const user = await db.createUser({ displayName, timezone });
    out(`✅ 已建立使用者`);
    out(`   internal user id：${user.id}`);
    out(`   顯示名稱：${user.displayName}`);
    out(`   時區：${user.timezone}`);
    out(`   狀態：${user.status}`);
    out('');
    out('接下來：');
    out(`   1. node scripts/admin.js link:new --user=${user.id}`);
    out('      把印出來的綁定碼給對方，請他在 Telegram 傳 /link <碼>');
    out(`   2. npm run authorize -- --user=${user.id}`);
    out('      完成 WHOOP 授權（需要對方本人在場同意）');
    return 0;
  },

  async 'user:list'({ db, args, out }) {
    const status = args.status && args.status !== true ? String(args.status).trim() : null;
    if (status && !Object.values(USER_STATUS).includes(status)) {
      throw new UsageError(`不合法的 --status：${status}（可用：${Object.values(USER_STATUS).join(' / ')}）`);
    }
    const users = await db.listUsers(status ? { status } : {});
    if (!users.length) {
      out(status ? `（沒有狀態為 ${status} 的使用者）` : '（系統裡還沒有任何使用者）');
      return 0;
    }

    out(`${pad('internal user id', 38)}${pad('名稱', 14)}${pad('狀態', 10)}${pad('時區', 18)}${pad('Telegram', 14)}WHOOP`);
    out('-'.repeat(110));
    for (const u of users) {
      const chatId = await db.getActiveChatIdForUser(u.id);
      const tokens = await db.getTokens(u.id);
      out(
        pad(u.id, 38) + pad(u.displayName, 14) + pad(u.status, 10)
        + pad(u.timezone, 18) + pad(chatId ?? '未綁定', 14)
        + (tokens ? '已授權' : '未授權'),
      );
    }
    return 0;
  },

  async 'user:status'({ db, args, out }) {
    // 明確要求 user id：絕不在多個使用者之間猜
    const userId = requireArg(args, 'user', 'internal user id');
    const status = requireArg(args, 'status', Object.values(USER_STATUS).join(' / '));
    if (!Object.values(USER_STATUS).includes(status)) {
      throw new UsageError(`不合法的 --status：${status}（可用：${Object.values(USER_STATUS).join(' / ')}）`);
    }

    const before = await db.getUser(userId);
    if (!before) throw new UsageError(`找不到使用者：${userId}`);

    const after = await db.updateUser(userId, { status });
    out(`✅ ${after.displayName}：${before.status} → ${after.status}`);
    if (status !== USER_STATUS.ACTIVE) {
      out('   這個使用者不會再被排程處理。');
      out('   **所有健康資料、journal、綁定都完整保留**，改回 ACTIVE 就會恢復。');
    } else {
      out('   這個使用者會重新被排程處理。');
    }
    return 0;
  },

  async 'link:new'({ db, args, out }) {
    const userId = requireArg(args, 'user', 'internal user id');
    const rawTtl = args['ttl-hours'];
    const ttlHours = rawTtl !== undefined && rawTtl !== true ? Number(rawTtl) : 24;
    if (!Number.isFinite(ttlHours) || ttlHours <= 0) {
      throw new UsageError(`不合法的 --ttl-hours：${rawTtl}`);
    }

    const user = await db.getUser(userId);
    if (!user) throw new UsageError(`找不到使用者：${userId}`);

    const { code, expiresAt } = await db.createLinkCode(userId, { ttlMs: ttlHours * 3600_000 });

    // ★ 原文只印這一次，而且刻意不經過 structured logger。
    out('');
    out(`綁定碼（給 ${user.displayName}，只會顯示這一次）：`);
    out('');
    out(`    ${code}`);
    out('');
    out(`有效期限：${expiresAt}（${ttlHours} 小時）`);
    out('請對方在 Telegram 對 bot 傳：');
    out(`    /link ${code}`);
    out('');
    out('這組碼只能用一次。資料庫裡只存雜湊，遺失就重新產生一組。');
    return 0;
  },

  async 'link:revoke'({ db, args, out }) {
    const chatId = requireArg(args, 'chat', 'Telegram chat id');
    const link = await db.getTelegramLink(chatId);
    if (!link) {
      out(`（chat ${chatId} 沒有任何綁定紀錄，不需要處理）`);
      return 0;
    }
    const ok = await db.revokeTelegramLink(chatId);
    out(ok ? `✅ 已解除綁定：chat ${chatId}` : `（chat ${chatId} 沒有需要更新的綁定）`);
    out('   健康資料完全不受影響。要重新綁定請用 link:new 產生新的碼。');
    return 0;
  },

  async 'whoop:status'({ db, args, out }) {
    const userId = requireArg(args, 'user', 'internal user id');
    const user = await db.getUser(userId);
    if (!user) throw new UsageError(`找不到使用者：${userId}`);

    const tokens = await db.getTokens(userId);
    out(`使用者：${user.displayName}（${user.id}）`);
    if (!tokens) {
      out('WHOOP 授權：尚未授權');
      out(`  請執行：npm run authorize -- --user=${user.id}`);
      return 0;
    }
    // 絕不印出 token 本身，只印它的狀態
    const expiresAt = tokens.expiresAt instanceof Date
      ? tokens.expiresAt.toISOString()
      : String(tokens.expiresAt);
    out('WHOOP 授權：已授權');
    out(`  whoop_user_id：${tokens.whoopUserId ?? '（未知）'}`);
    out(`  access token 到期：${expiresAt}`);
    out(`  scope：${tokens.scope ?? '（未記錄）'}`);

    const missing = ['read:workout', 'read:body_measurement']
      .filter((s) => !String(tokens.scope ?? '').includes(s));
    if (missing.length) {
      out(`  ⚠️ 缺少 scope：${missing.join(', ')} —— 重跑 authorize 才會拿到`);
    }
    return 0;
  },
};

/**
 * 純函式入口：吃 db 與 argv，回傳 exit code。
 * 不碰 process、不建立連線 —— 所以測試可以直接呼叫。
 */
export async function runAdmin({ db, argv, out = console.log }) {
  const [command, ...rest] = argv;
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    out(USAGE);
    return command ? 0 : 1;
  }
  const handler = COMMANDS[command];
  if (!handler) {
    out(`不認得的指令：${command}\n`);
    out(USAGE);
    return 1;
  }
  try {
    return await handler({ db, args: parseArgs(rest), out });
  } catch (err) {
    if (err instanceof UsageError) {
      out(`❌ ${err.message}\n`);
      out(USAGE);
      return 1;
    }
    throw err;
  }
}

// 直接執行時才連資料庫（被 import 時不連）
if (import.meta.url === `file://${process.argv[1]}`) {
  loadDotEnvIfPresent();
  const env = loadEnv({ require: ['TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN'] });
  const db = createDb({ url: env.tursoUrl, authToken: env.tursoToken });
  let code = 1;
  try {
    await db.migrate();
    code = await runAdmin({ db, argv: process.argv.slice(2) });
  } catch (err) {
    console.error(`❌ ${err?.message ?? err}`);
    code = 1;
  } finally {
    try { db.close(); } catch { /* 關連線失敗不影響結果 */ }
  }
  process.exit(code);
}
