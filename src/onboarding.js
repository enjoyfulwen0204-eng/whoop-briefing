/**
 * 自助上線流程（V1.2 Phase 3.5）。
 *
 * 目標：一個全新的朋友只靠 Telegram 私訊就能把自己的 Health OS 開起來 ——
 * 不需要管理員建帳號、不需要綁定碼、不需要有人跑授權腳本、不需要複製 token。
 *
 *     /start → 建立身分 + 綁定這個私訊
 *            → 確認時區
 *            → Connect WHOOP（官方授權頁）
 *            → 公開 HTTPS callback 綁定 token
 *            → 自動 bootstrap（初次同步 + capability）
 *            → READY
 *
 * ## 狀態機（權威在 DB，見 onboardingStore.js）
 *
 *   STARTED ──► TIMEZONE_PENDING ──► WHOOP_AUTH_PENDING ──► WHOOP_AUTHORIZED
 *                                              ▲                    │
 *                                              │                    ▼
 *                                     ACTION_REQUIRED ◄──────── SYNCING ──► READY
 *
 * 每一步都可以從任何一個程序、任何一次重啟接回去：Telegram 那一側完全不保存
 * 對話狀態，每一則訊息都重新讀這一列。
 *
 * ## 安全邊界
 *
 *  - 只在**私訊**建立身分（updateProcessor 的 H-01 閘門已經擋掉群組與
 *    sender/chat 不一致，這裡再擋一次：綁定是整個系統最敏感的一步）。
 *  - 一個 chat 只會綁一個使用者，而且絕不搶走別人的綁定（identityStore 擋）。
 *  - 授權連結只含 WHOOP 官方 URL + 一次性 state。使用者永遠看不到
 *    client secret、token、內部 user_id。
 *  - 失敗一律 fail closed：狀態機停在 ACTION_REQUIRED，並給一個可以自己
 *    重來的動作，而不是讓人卡在中間無解。
 */

import { ONBOARDING } from './config.js';
import { ONBOARDING_STATE, ONBOARDING_FAILURE, USER_STATUS } from './schema.js';
import { prepareAuthorization, OAuthFlowError } from './oauthFlow.js';
import { log } from './logger.js';

/** `/start`（可帶 Telegram deep-link payload，忽略內容）。 */
export const START_COMMAND = /^\/start(?:@\w+)?(?:\s+\S+)?\s*$/i;
/** `/timezone [值]`、`/tz [值]`。 */
export const TIMEZONE_COMMAND = /^\/(?:timezone|tz)(?:@\w+)?(?:\s+(.+))?$/i;
/** `/connect`（重新取得 Connect WHOOP 連結）。 */
export const CONNECT_COMMAND = /^\/connect(?:@\w+)?\s*$/i;

/**
 * 把使用者輸入正規化成合法的 IANA 時區。
 *
 * 驗證交給執行環境的 Intl：能被 `timeZone` 接受、而且不是被靜默改寫的別名，
 * 才算數。刻意**不**自己維護白名單 —— 白名單一定會過期，而且會讓住在
 * 沒被列到的地方的人完全無法上線。
 *
 * 不從 Telegram 推測、不用 IP 定位：兩者都給不出可靠的 IANA 時區，而
 * 猜錯時區等於把整個人的「今天」算錯。
 *
 * @returns {?string} 合法 → 正規化後的名稱；不合法 → null
 */
export function normalizeTimezone(input) {
  const raw = String(input ?? '').trim();
  if (!raw || raw.length > 64) return null;
  // 只接受 IANA 的形狀（Area/City、Area/Sub/City、或 UTC），擋掉 offset 字串
  if (!/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,2}$/.test(raw)) return null;
  try {
    const resolved = new Intl.DateTimeFormat('en-US', { timeZone: raw }).resolvedOptions().timeZone;
    if (!resolved) return null;
    // ICU 會把合法的別名正規化成它自己的主要名稱
    // （Asia/Ho_Chi_Minh → Asia/Saigon、America/Argentina/Buenos_Aires → America/Buenos_Aires）。
    // 兩者是**同一個時區**，但把使用者打的名字換成一個他沒看過的舊名字很難懂。
    // 所以：只有大小寫不同時採用正規化的寫法，其餘保留使用者輸入的合法別名。
    return resolved.toLowerCase() === raw.toLowerCase() ? resolved : raw;
  } catch {
    return null;
  }
}

/** 使用者看得到的顯示名稱：Telegram 的名字，沒有就用中性字串。 */
export function displayNameFrom(message) {
  const from = message?.from ?? {};
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ').trim();
  if (name) return name.slice(0, 60);
  if (from.username) return String(from.username).slice(0, 60);
  return 'Telegram 使用者';
}

// ---------------------------------------------------------------------------
// 訊息（全部是應用程式自己的文字，絕不回放外部輸入）
// ---------------------------------------------------------------------------

const tzLines = () => ONBOARDING.TIMEZONE_SUGGESTIONS.map((t) => `· ${t}`).join('\n');

export const MESSAGES = {
  welcome: () => [
    '👋 歡迎使用 WHOOP 健康助理。',
    '',
    '這個助理會讀你自己的 WHOOP 資料，只在這個私訊裡回覆你。',
    '設定只有兩步：先告訴我你的時區，再授權 WHOOP。',
    '',
    '**第 1 步：你的時區是？**',
    '直接輸入，例如：',
    tzLines(),
    '',
    '其他地區也可以 —— 輸入任何標準 IANA 時區名稱（例如 Europe/Berlin）。',
  ].join('\n'),

  timezoneInvalid: () => [
    '這個時區我不認得。',
    '',
    '請輸入標準的 IANA 時區名稱，例如：',
    tzLines(),
    '',
    '（格式是「地區/城市」，不是 +08:00 這種時差。）',
  ].join('\n'),

  timezoneSet: (tz, authUrl) => [
    `✅ 時區設定為 ${tz}。`,
    '',
    '**第 2 步：連接你的 WHOOP 帳號**',
    '',
    '點下面的連結，用**你自己的** WHOOP 帳號登入並授權：',
    authUrl,
    '',
    `連結 ${Math.round(ONBOARDING.OAUTH_STATE_TTL_MS / 60_000)} 分鐘內有效。過期的話輸入 /connect 取得新的。`,
  ].join('\n'),

  connectLink: (authUrl) => [
    '**連接你的 WHOOP 帳號**',
    '',
    '點下面的連結，用你自己的 WHOOP 帳號登入並授權：',
    authUrl,
    '',
    `連結 ${Math.round(ONBOARDING.OAUTH_STATE_TTL_MS / 60_000)} 分鐘內有效。`,
  ].join('\n'),

  connectCooldown: () => '剛剛才產生過一條授權連結，請先用那一條。若確定要換新的，稍等一下再輸入 /connect。',
  connectTooMany: () => '授權連結產生太多次了。請先完成其中一條的授權；若都失敗了，稍後再試或聯絡管理者。',

  authorizedSyncing: () => [
    '✅ WHOOP 連接完成。',
    '',
    '正在把你的資料同步進來（第一次會抓比較久的歷史，會在背景繼續）。',
    '完成之後我會再通知你。',
  ].join('\n'),

  ready: () => [
    '🎉 你的 Health OS 準備好了。',
    '',
    '現在可以直接問我問題，例如「我今天狀態怎樣？」。',
    '',
    '· /status 今天的狀態',
    '· /healthdata 目前的資料涵蓋範圍',
    '· /log 記錄喝酒、咖啡、生病、旅行等事件',
    '· /help 完整說明',
    '',
    '每天早上起床後我會自動送出當日簡報。',
  ].join('\n'),

  statusTimezonePending: () => [
    '設定還沒完成。',
    '',
    '**第 1 步：你的時區是？** 直接輸入，例如：',
    tzLines(),
  ].join('\n'),

  statusAuthPending: (tz) => [
    '設定還沒完成。',
    '',
    `時區：${tz} ✅`,
    '',
    '**第 2 步：連接 WHOOP** —— 輸入 /connect 取得授權連結。',
  ].join('\n'),

  statusSyncing: () => [
    '⏳ 你的 WHOOP 已經連接，資料還在同步中。',
    '',
    '完成之後我會通知你。第一次同步會抓一段歷史，需要一點時間。',
  ].join('\n'),

  actionRequired: (code) => {
    const head = '⚠️ 設定卡住了。';
    const body = {
      [ONBOARDING_FAILURE.OAUTH_DENIED]: '你在 WHOOP 的授權頁面取消了授權。',
      [ONBOARDING_FAILURE.OAUTH_STATE_INVALID]: '授權連結已經過期或被用過了。',
      [ONBOARDING_FAILURE.TOKEN_EXCHANGE_FAILED]: 'WHOOP 沒有完成授權交換。',
      [ONBOARDING_FAILURE.IDENTITY_UNVERIFIED]: '無法向 WHOOP 確認這是哪個帳號，為了避免把別人的資料算到你身上，已經中止。',
      [ONBOARDING_FAILURE.WHOOP_ACCOUNT_ALREADY_LINKED]: '這個 WHOOP 帳號已經連到另一個使用者了。請用你自己的 WHOOP 帳號。',
      [ONBOARDING_FAILURE.WHOOP_ACCOUNT_MISMATCH]: '這個帳號先前連的是另一個 WHOOP 帳號。換帳號會讓既有資料被錯誤歸屬，所以擋下來了。',
      [ONBOARDING_FAILURE.BOOTSTRAP_FAILED]: '初次同步一直失敗。',
      [ONBOARDING_FAILURE.REAUTH_REQUIRED]: 'WHOOP 授權失效了，需要重新連接。',
      [ONBOARDING_FAILURE.WHOOP_SCOPE_INCOMPLETE]:
        'WHOOP 的權限不完整 —— 這個助理至少需要「睡眠」與「恢復」的讀取權限才能運作。'
        + '請重新連接，並在 WHOOP 的授權頁面把要求的健康權限**全部勾選**。',
      [ONBOARDING_FAILURE.ACCOUNT_INACTIVE]: '這個帳號目前是停用狀態，需要管理者處理。',
    }[code] ?? '授權沒有完成。';
    return [head, '', body, '', '輸入 /connect 重新取得一條新的授權連結。'].join('\n');
  },

  notPrivate: () => null,
};

// ---------------------------------------------------------------------------
// 自助身分建立
// ---------------------------------------------------------------------------

/**
 * 解析或建立這個私訊背後的內部使用者。**冪等而且併發安全。**
 *
 * 併發的多則 /start 會同時走到這裡。安全性來自**單一條原子語句**
 * （`claimTelegramChat`：主鍵衝突就 DO NOTHING），不是這裡的執行順序：
 * 恰好一個認領成功，其餘拿到贏家的 id。
 *
 * 輸的那幾個會留下「剛建好但沒有綁定」的 users 列，我們立刻把它們標成
 * DISABLED —— 它們不會出現在 listActiveUsers / listSchedulableUsers，
 * 沒有綁定、沒有 token、沒有任何資料。最終永遠只有**一個 ACTIVE 使用者、
 * 一個綁定、一份上線狀態**。刻意不真的刪除：留著才看得出發生過什麼。
 *
 * @returns {{user, onboarding, created:boolean}}
 */
export async function resolveOrCreateUser({ db, chatId, message, now = new Date() }) {
  const cid = String(chatId);
  const existing = await db.resolveUserByChatId(cid);
  if (existing?.user) {
    // 既有使用者第一次走到這裡（例如管理員用 CLI 建的）→ 依**證據**推導一列，
    // 絕不預設 READY（F02），也絕不把一個正在用的人打回 STARTED（有列就不動）。
    const onboarding = await db.ensureOnboardingDerived(existing.user.id, { now });
    return { user: existing.user, onboarding, created: false };
  }

  // 這個 chat 之前綁過但被撤銷／退役 → 不自動重綁，交給管理者處理。
  const link = await db.getTelegramLink(cid);
  if (link && link.status !== 'ACTIVE') {
    log.warn('onboarding_chat_previously_linked', { chat_id: cid, status: link.status });
    return { user: null, onboarding: null, created: false, blocked: 'link_retired' };
  }

  // ★ v17 §22：這個 chat 已經屬於一個**非 ACTIVE** 的使用者。
  //
  // resolveUserByChatId 對非 ACTIVE 一律回 null（那是對的：停用的人不該
  // 被當成已綁定的使用者），但如果就這樣往下走，每一次 /start 都會建一個
  // 新使用者、輸掉認領、再把自己停用 —— 留下無限增生的孤兒列，而且它們與
  // 真正被管理者停用的帳號在 user:list 裡長得一模一樣。
  //
  // 在**建立任何東西之前**就認出這個情況：不建使用者、不建第二條綁定、
  // 不重啟上線流程、不發授權連結、不改任何狀態。
  if (link && link.status === 'ACTIVE') {
    const owner = await db.getUser(link.userId).catch(() => null);
    if (owner && owner.status !== USER_STATUS.ACTIVE) {
      log.info('onboarding_chat_owner_inactive', { chat_id: cid });
      return { user: null, onboarding: null, created: false, blocked: 'account_inactive' };
    }
  }

  const user = await db.createUser({
    displayName: displayNameFrom(message),
    // 時區在下一步才確認。先放一個標記值，READY 之前不會有任何日期敏感的
    // 功能對這個人生效（排程器只看 READY）。
    timezone: 'UTC',
    status: USER_STATUS.ACTIVE,
    now,
  });

  // ★ 併發安全的關鍵：綁定用**單一條原子語句**認領（見 claimTelegramChat）。
  //
  // 20 則 /start 同時進來時，上面的「先查有沒有綁定」全部都會查到「沒有」，
  // 所以每一個都會建一個使用者。真正決定誰是這個 chat 的主人的是下面這一步 ——
  // 它由資料庫的主鍵決定，只有一個人會贏。輸的人把自己剛建的空帳號停用掉，
  // 於是最後永遠只有**一個 ACTIVE 使用者、一個綁定、一份上線狀態**。
  //
  // 刻意不用讀-改-寫的 linkTelegram：那一支的「已經綁在別人身上就拒絕」是
  // 應用層判斷，兩個並發的呼叫可以一起通過它然後互相覆蓋。
  const claim = await db.claimTelegramChat({ chatId: cid, userId: user.id, now });
  if (!claim.ok || claim.userId !== user.id) {
    // 認領輸掉的孤兒列：停用它。走 lifecycle 轉移路徑（唯一能改 status 的
    // 入口），所以它也會拿到一個一致的啟用世代。
    await db.transitionUserLifecycle({
      userId: user.id, targetStatus: USER_STATUS.DISABLED, now,
      // 這一列剛剛才被建立、而且認領輸了：沒有綁定、沒有 token、沒有上線
      // 狀態、沒有任何認領。清理步驟全是 no-op，但在 20 路併發的 /start
      // 底下會把贏家的正常流程餓到 SQLITE_BUSY。
      orphanCleanupOnly: true,
    }).catch(() => {});
    const winnerId = claim.userId ?? null;
    const winner = winnerId ? await db.getUser(winnerId) : null;
    if (winner && winner.status === USER_STATUS.ACTIVE) {
      const onboarding = await db.ensureOnboardingDerived(winner.id, { now });
      log.info('onboarding_lost_claim', { chat_id: cid });
      return { user: winner, onboarding, created: false };
    }
    log.warn('onboarding_link_failed', { chat_id: cid, reason: claim.reason ?? 'unknown' });
    return { user: null, onboarding: null, created: false, blocked: 'link_failed' };
  }
  const onboarding = await db.ensureOnboarding(user.id, { state: ONBOARDING_STATE.STARTED, now });
  log.info('onboarding_user_created', { user_id: user.id });
  return { user, onboarding, created: true };
}

// ---------------------------------------------------------------------------
// 授權連結
// ---------------------------------------------------------------------------

/**
 * 產生一條 Connect WHOOP 連結（每次都是**新的**一次性 state）。
 *
 * 濫用控制在 DB：冷卻 + 總量。超過就回一句話，不產生 state。
 */
export async function issueAuthLink({
  db, userId, clientId, redirectUri, now = new Date(),
  cooldownMs = ONBOARDING.AUTH_LINK_COOLDOWN_MS,
  maxOutstanding = ONBOARDING.MAX_OUTSTANDING_AUTH_LINKS,
}) {
  // ★ v17 §21：**先**確認帳號有資格，再動額度。
  //
  // 順序是重點：不合資格的帳號一次都不該消耗冷卻／配額，否則一個被停用的
  // 帳號在重新啟用之後會發現自己莫名其妙被冷卻著。真正的原子閘門仍然在
  // createOAuthState 裡（它在同一句 INSERT 裡驗 ACTIVE + 啟用世代）。
  const account = await db.getUser(userId).catch(() => null);
  if (!account || account.status !== USER_STATUS.ACTIVE) {
    log.info('onboarding_auth_link_account_inactive', { user_id: userId });
    return { ok: false, reason: 'account_inactive' };
  }

  // 兩道閘門都**會自己恢復**（F03）：
  //   冷卻 —— 純時間條件
  //   未完成數量 —— 過期／用掉的 state 不再計入，而且是一句原子 INSERT
  const budget = await db.recordAuthLinkIssued(userId, { cooldownMs, now });
  if (!budget.ok) return { ok: false, reason: budget.reason };
  try {
    const prepared = await prepareAuthorization({
      db, userId, clientId, redirectUri, ttlMs: ONBOARDING.OAUTH_STATE_TTL_MS, now, maxOutstanding,
    });
    return { ok: true, authUrl: prepared.authUrl, expiresAt: prepared.expiresAt };
  } catch (err) {
    if (err instanceof OAuthFlowError) {
      log.warn('onboarding_auth_link_failed', { user_id: userId, code: err.code });
      return { ok: false, reason: err.code === 'TOO_MANY_OUTSTANDING_STATES' ? 'too_many' : err.code };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// /start 與上線期間的訊息處理
// ---------------------------------------------------------------------------

/**
 * 還沒綁定的私訊送來一則訊息。**這是自助上線的入口。**
 *
 * 只有 `/start` 會建立身分；其他訊息（包含健康問題）一律只得到上線指引，
 * 絕不執行任何健康處理 —— 未知的人問「我的恢復怎樣」不可以看到別人的資料。
 *
 * `/link <code>` 仍然保留給管理者的復原路徑（由呼叫端先處理）。
 *
 * @returns {?string} 要回覆的文字；null = 完全不回
 */
export async function handleUnlinkedMessage({
  db, text, chatId, message, isPrivateChat = false,
  clientId, redirectUri, now = new Date(),
}) {
  if (!isPrivateChat) {
    log.warn('onboarding_rejected_non_private', { chat_id: String(chatId) });
    return null;
  }
  const raw = String(text ?? '').trim();
  if (!START_COMMAND.test(raw)) {
    // 不是 /start：給指引而不是沉默，但**不做任何事**。
    return '你還沒有連接帳號。輸入 /start 開始設定（只需要兩步）。';
  }

  const resolved = await resolveOrCreateUser({ db, chatId, message, now });
  if (!resolved.user) {
    return '這個聊天室目前無法自動設定，請聯絡管理者。';
  }
  return continueOnboarding({
    db, user: resolved.user, onboarding: resolved.onboarding,
    clientId, redirectUri, now, justCreated: resolved.created,
  });
}

/**
 * 已經綁定的使用者在上線期間送訊息（或按 /start、/connect、/timezone）。
 *
 * @returns {?string} 要回覆的文字；null = 這個人已經 READY，交給正常的 router
 */
export async function handleOnboardingMessage({
  db, user, text, clientId, redirectUri, now = new Date(),
}) {
  const onboarding = await db.getOnboarding(user.id);
  const raw = String(text ?? '').trim();

  // READY 的人只有 /connect 會被這一層處理（重新連接），其餘交給 router。
  if (onboarding.state === ONBOARDING_STATE.READY) {
    if (CONNECT_COMMAND.test(raw)) {
      const link = await issueAuthLink({ db, userId: user.id, clientId, redirectUri, now });
      if (!link.ok) return reasonMessage(link.reason);
      return MESSAGES.connectLink(link.authUrl);
    }
    return null;
  }

  // ---- 時區：可能是 /timezone <值>，也可能是等待中的純文字回覆 ----
  const tzCmd = TIMEZONE_COMMAND.exec(raw);
  const waitingForTimezone = onboarding.state === ONBOARDING_STATE.STARTED
    || onboarding.state === ONBOARDING_STATE.TIMEZONE_PENDING;
  const tzCandidate = tzCmd ? (tzCmd[1] ?? '') : (waitingForTimezone && !raw.startsWith('/') ? raw : null);

  if (tzCandidate !== null && tzCandidate !== undefined) {
    if (!String(tzCandidate).trim()) return MESSAGES.statusTimezonePending();
    const tz = normalizeTimezone(tzCandidate);
    // 不合法 → 不寫時區、**也不記確認**（F01-D）
    if (!tz) return MESSAGES.timezoneInvalid();
    await db.updateUser(user.id, { timezone: tz }, { now });
    // ★ F01：確認是一件**明確記錄下來的事**（timezone_confirmed_at），
    // 不是從 timezone 這個字串長什麼樣推論出來的。所以選 UTC 的人
    // 一樣算「確認過」，而預設值 UTC 的新使用者不算。
    await db.setOnboardingState(user.id, ONBOARDING_STATE.WHOOP_AUTH_PENDING, {
      timezoneConfirmed: true, failureCode: null, failureDetail: null, now,
    });
    const link = await issueAuthLink({ db, userId: user.id, clientId, redirectUri, now });
    if (!link.ok) return `✅ 時區設定為 ${tz}。\n\n${reasonMessage(link.reason)}`;
    return MESSAGES.timezoneSet(tz, link.authUrl);
  }

  if (CONNECT_COMMAND.test(raw)) {
    if (waitingForTimezone) return MESSAGES.statusTimezonePending();
    const link = await issueAuthLink({ db, userId: user.id, clientId, redirectUri, now });
    if (!link.ok) return reasonMessage(link.reason);
    // 重新連接：狀態回到「等授權」，把上一次的失敗訊息清掉。
    await db.setOnboardingState(user.id, ONBOARDING_STATE.WHOOP_AUTH_PENDING, {
      from: [ONBOARDING_STATE.WHOOP_AUTH_PENDING, ONBOARDING_STATE.ACTION_REQUIRED],
      failureCode: null, failureDetail: null, now,
    });
    return MESSAGES.connectLink(link.authUrl);
  }

  if (START_COMMAND.test(raw)) {
    return continueOnboarding({ db, user, onboarding, clientId, redirectUri, now });
  }

  // 上線期間的任何其他訊息（含健康問題）：只回目前狀態與下一步。
  // **不**執行健康處理 —— 這個人的資料還沒有同步進來，任何回答都會是假的。
  return statusMessage({ user, onboarding });
}

/** 依目前狀態決定「下一步要跟使用者說什麼」，必要時順手產生授權連結。 */
async function continueOnboarding({
  db, user, onboarding, clientId, redirectUri, now, justCreated = false,
}) {
  const state = onboarding?.state ?? ONBOARDING_STATE.STARTED;
  if (state === ONBOARDING_STATE.STARTED) {
    await db.setOnboardingState(user.id, ONBOARDING_STATE.TIMEZONE_PENDING, {
      from: [ONBOARDING_STATE.STARTED], now,
    });
    return MESSAGES.welcome();
  }
  if (state === ONBOARDING_STATE.TIMEZONE_PENDING) {
    return justCreated ? MESSAGES.welcome() : MESSAGES.statusTimezonePending();
  }
  if (state === ONBOARDING_STATE.WHOOP_AUTH_PENDING || state === ONBOARDING_STATE.ACTION_REQUIRED) {
    const link = await issueAuthLink({ db, userId: user.id, clientId, redirectUri, now });
    if (!link.ok) {
      return state === ONBOARDING_STATE.ACTION_REQUIRED
        ? `${MESSAGES.actionRequired(onboarding.failureCode)}\n\n${reasonMessage(link.reason)}`
        : `${MESSAGES.statusAuthPending(user.timezone)}\n\n${reasonMessage(link.reason)}`;
    }
    return state === ONBOARDING_STATE.ACTION_REQUIRED
      ? `${MESSAGES.actionRequired(onboarding.failureCode)}\n\n${MESSAGES.connectLink(link.authUrl)}`
      : MESSAGES.timezoneSet(user.timezone, link.authUrl);
  }
  return statusMessage({ user, onboarding });
}

/** 純粹的狀態報告（不產生 state、不改任何東西）。 */
export function statusMessage({ user, onboarding }) {
  switch (onboarding?.state) {
    case ONBOARDING_STATE.STARTED:
    case ONBOARDING_STATE.TIMEZONE_PENDING:
      return MESSAGES.statusTimezonePending();
    case ONBOARDING_STATE.WHOOP_AUTH_PENDING:
      return MESSAGES.statusAuthPending(user?.timezone ?? '未設定');
    case ONBOARDING_STATE.WHOOP_AUTHORIZED:
    case ONBOARDING_STATE.SYNCING:
      return MESSAGES.statusSyncing();
    case ONBOARDING_STATE.ACTION_REQUIRED:
      return MESSAGES.actionRequired(onboarding.failureCode);
    default:
      return MESSAGES.ready();
  }
}

function reasonMessage(reason) {
  if (reason === 'cooldown') return MESSAGES.connectCooldown();
  if (reason === 'too_many') return MESSAGES.connectTooMany();
  return '目前無法產生授權連結，請稍後再試一次（/connect）。';
}
