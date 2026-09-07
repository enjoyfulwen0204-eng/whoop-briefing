#!/usr/bin/env node
/**
 * 一次性 WHOOP 授權腳本（在你自己的電腦上跑一次就好）。
 *
 * 做的事：
 *  1. 開一個本機小網站等 WHOOP 導回來（預設 http://localhost:8788/callback）
 *  2. 幫你開瀏覽器到 WHOOP 授權頁
 *  3. 你按「Allow」後，拿 authorization code 換第一組 token
 *  4. 把 access_token / refresh_token / 到期時間寫進 Turso
 *
 * ## Multi-user
 *
 * **必須明確指定要授權給哪個內部使用者**：
 *   npm run authorize -- --user=<internalUserId>
 *
 * 沒帶 --user 會直接失敗（絕不預設成「第一個使用者」或某個人）。
 * 使用者必須存在且為 ACTIVE。
 *
 * OAuth state 由 DB 產生（32 bytes 隨機、只存 hash、一次性、10 分鐘到期），
 * 而且**在產生的那一刻就綁死這個 userId** —— callback 完全不信任外部傳來的
 * 身分，所以不可能把 A 的授權存到 B 身上。
 *
 * 備案（見 README）：拿到 code 之後可以直接
 *   node scripts/authorize.js --user=<id> --code <code> --state <state>
 *
 * 全程使用官方標準 OAuth authorization-code flow，沒有偽裝 User-Agent
 * 或任何奇怪的 workaround。
 */

import http from 'node:http';
import { spawn } from 'node:child_process';
import { URL } from 'node:url';

import { WHOOP, loadDotEnvIfPresent, loadEnv } from '../src/config.js';
import { exchangeCode } from '../src/whoop.js';
import { createDb } from '../src/db.js';
import {
  OAuthFlowError, assertAuthorizable, completeAuthorization, prepareAuthorization,
} from '../src/oauthFlow.js';

loadDotEnvIfPresent();

const env = loadEnv({
  require: [
    'WHOOP_CLIENT_ID', 'WHOOP_CLIENT_SECRET', 'WHOOP_REDIRECT_URI',
    'TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN',
  ],
});

const argv = process.argv.slice(2);
const flag = (name) => {
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : null;
};
const targetUserId = flag('user');
const manualCode = flag('code');
const manualState = flag('state');

if (!targetUserId) {
  console.error('\n❌ 必須指定要授權給哪個內部使用者：\n');
  console.error('   npm run authorize -- --user=<internalUserId>\n');
  console.error('（可用 node -e 或 scripts/health-status.js 查現有使用者）\n');
  process.exit(1);
}

const db = createDb({ url: env.tursoUrl, authToken: env.tursoToken });

/** 換 token 的實作。注入給 completeAuthorization，測試時可換成 mock。 */
const exchange = ({ code }) => exchangeCode({
  code,
  clientId: env.whoopClientId,
  clientSecret: env.whoopClientSecret,
  redirectUri: env.whoopRedirectUri,
});

async function report(userId) {
  const check = await db.getTokens(userId);
  const user = await db.getUser(userId);
  console.log(`\n✅ 授權完成，token 已寫進 Turso（使用者 ${user.displayName} / ${userId}）`);
  console.log(`   scope            : ${check.scope}`);
  console.log(`   access token 到期 : ${check.expiresAt.toISOString()}`);
  console.log(`   refresh token     : 已儲存（長度 ${String(check.refreshToken).length}，不顯示內容）`);
  if (check.whoopUserId) console.log(`   WHOOP user id    : ${check.whoopUserId}`);
  if (!check.refreshToken) {
    console.log('\n⚠️  沒有拿到 refresh token！請確認 WHOOP App 的 scope 有勾 offline。');
  }
  console.log('\n下一步：npm run check\n');
}

async function manual() {
  if (!manualState) {
    throw new OAuthFlowError(
      'NO_STATE',
      '手動模式也必須帶 --state（就是 authorize URL 裡那個），'
      + '否則無法安全確認這組 code 屬於哪個使用者。',
    );
  }
  console.log('使用你提供的 authorization code 換 token…');
  const res = await completeAuthorization({
    db, rawState: manualState, code: manualCode, exchange,
  });
  await report(res.userId);
}

async function browserFlow() {
  const redirect = new URL(env.whoopRedirectUri);
  const port = Number(redirect.port || 80);
  // state 由 DB 產生並綁死 targetUserId（只存 hash、一次性、10 分鐘）
  const { user, state, authUrl } = await prepareAuthorization({
    db,
    userId: targetUserId,
    clientId: env.whoopClientId,
    redirectUri: env.whoopRedirectUri,
  });

  console.log('\n=== WHOOP 一次性授權 ===');
  console.log(`使用者       : ${user.displayName}（${user.id}）`);
  console.log(`redirect uri : ${env.whoopRedirectUri}`);
  console.log(`scope        : ${WHOOP.SCOPES}`);
  console.log('\n如果瀏覽器沒有自動打開，請手動複製下面這行貼到瀏覽器：\n');
  console.log(authUrl);
  console.log('');

  const result = await new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://localhost:${port}`);
      if (url.pathname !== redirect.pathname) {
        res.writeHead(404).end('not found');
        return;
      }
      const code = url.searchParams.get('code');
      const gotState = url.searchParams.get('state');
      const error = url.searchParams.get('error');

      const reply = (msg) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<html><body style="font-family:sans-serif;padding:40px">
          <h2>${msg}</h2><p>可以關掉這個視窗，回到終端機看結果。</p></body></html>`);
      };

      if (error) {
        reply(`❌ WHOOP 回報錯誤：${error}`);
        server.close();
        reject(new Error(`WHOOP 授權被拒或失敗：${error}`));
        return;
      }
      if (!code) {
        reply('❌ 沒有收到 authorization code');
        server.close();
        reject(new Error('callback 沒有帶 code'));
        return;
      }
      // state 驗證交給 completeAuthorization（原子消耗 + 綁定使用者），
      // 這裡只做最基本的存在性檢查
      if (!gotState) {
        reply('❌ callback 沒有帶 state，為安全起見中止');
        server.close();
        reject(new Error('callback 沒有帶 state'));
        return;
      }
      reply('✅ 收到授權，正在換 token…');
      server.close();
      resolve({ code, state: gotState });
    });

    server.on('error', reject);
    server.listen(port, () => {
      console.log(`（本機伺服器已啟動，正在等 WHOOP 導回 port ${port}…）`);
      openBrowser(authUrl);
    });

    setTimeout(() => {
      server.close();
      reject(new Error('等了 5 分鐘沒有收到授權，已中止。請重跑一次。'));
    }, 5 * 60 * 1000).unref();
  });

  const res = await completeAuthorization({
    db, rawState: result.state, code: result.code, exchange,
  });
  await report(res.userId);
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    spawn(cmd, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref();
  } catch {
    /* 開不起來沒關係，上面已經印出網址讓你手動貼 */
  }
}

try {
  await db.migrate();
  // 先驗使用者：不存在 / 不是 ACTIVE 就立刻停，不要白跑一趟 OAuth
  await assertAuthorizable(db, targetUserId);
  if (manualCode) await manual();
  else await browserFlow();
} catch (err) {
  const code = err instanceof OAuthFlowError ? `[${err.code}] ` : '';
  console.error(`\n❌ 授權失敗：${code}${err.message}\n`);
  process.exitCode = 1;
} finally {
  db.close();
}
