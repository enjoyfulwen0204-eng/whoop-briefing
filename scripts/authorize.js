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
 * 用法：
 *   npm run authorize
 *
 * 如果本機瀏覽器 redirect 有問題，還有備案（見 README「備案：用 Postman 授權」），
 * 拿到 code 之後可以直接：
 *   node scripts/authorize.js --code <貼上你的code>
 *
 * 全程使用官方標準 OAuth authorization-code flow，沒有偽裝 User-Agent
 * 或任何奇怪的 workaround。
 */

import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { URL } from 'node:url';

import { WHOOP, loadDotEnvIfPresent, loadEnv } from '../src/config.js';
import { buildAuthorizeUrl, exchangeCode } from '../src/whoop.js';
import { createDb } from '../src/db.js';

loadDotEnvIfPresent();

const env = loadEnv({
  require: [
    'WHOOP_CLIENT_ID', 'WHOOP_CLIENT_SECRET', 'WHOOP_REDIRECT_URI',
    'TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN',
  ],
});

const argv = process.argv.slice(2);
const codeArgIndex = argv.indexOf('--code');
const manualCode = codeArgIndex >= 0 ? argv[codeArgIndex + 1] : null;

const db = createDb({ url: env.tursoUrl, authToken: env.tursoToken });

async function saveAndReport(tokens) {
  await db.migrate();
  await db.saveTokens(tokens);
  const check = await db.getTokens();
  console.log('\n✅ 授權完成，token 已寫進 Turso');
  console.log(`   scope            : ${check.scope}`);
  console.log(`   access token 到期 : ${check.expiresAt.toISOString()}`);
  console.log(`   refresh token     : 已儲存（長度 ${String(check.refreshToken).length}，不顯示內容）`);
  if (!check.refreshToken) {
    console.log('\n⚠️  沒有拿到 refresh token！請確認 WHOOP App 的 scope 有勾 offline。');
  }
  console.log('\n下一步：npm run check   （確認四個服務都通）\n');
}

async function manual() {
  console.log('使用你提供的 authorization code 換 token…');
  const tokens = await exchangeCode({
    code: manualCode,
    clientId: env.whoopClientId,
    clientSecret: env.whoopClientSecret,
    redirectUri: env.whoopRedirectUri,
  });
  await saveAndReport(tokens);
}

async function browserFlow() {
  const redirect = new URL(env.whoopRedirectUri);
  const port = Number(redirect.port || 80);
  const state = crypto.randomBytes(16).toString('hex'); // WHOOP 要求 state 至少 8 字元
  const authUrl = buildAuthorizeUrl({
    clientId: env.whoopClientId,
    redirectUri: env.whoopRedirectUri,
    state,
  });

  console.log('\n=== WHOOP 一次性授權 ===');
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
      if (gotState !== state) {
        reply('❌ state 不符，為安全起見中止');
        server.close();
        reject(new Error('state 不符（可能是舊的分頁或 CSRF）'));
        return;
      }
      reply('✅ 收到授權，正在換 token…');
      server.close();
      resolve(code);
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

  const tokens = await exchangeCode({
    code: result,
    clientId: env.whoopClientId,
    clientSecret: env.whoopClientSecret,
    redirectUri: env.whoopRedirectUri,
  });
  await saveAndReport(tokens);
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
  if (manualCode) await manual();
  else await browserFlow();
} catch (err) {
  console.error(`\n❌ 授權失敗：${err.message}\n`);
  process.exitCode = 1;
} finally {
  db.close();
}
