/**
 * 測試替身：記憶體版 DB、假 Telegram、假 Claude。
 * 介面與正式版一致（**包含 multi-user 的 userId 必填**），
 * 所以 daily/weekly 流程可以原封不動測。
 *
 * 所有 per-user 操作都以 userId 為 key，缺 userId 一律拋 MissingUserIdError ——
 * 跟真的 db.js 行為一致，測試才抓得到「忘記帶 user」的 bug。
 */

import { requireUserId } from '../src/userContext.js';
import { REPORT_DELIVERY_STATE } from '../src/schema.js';

export function fakeDb({ failSentRecord = null } = {}) {
  const runs = [];
  const notifies = new Map();
  // 記憶體版的 lease lock / 報告發送權（語義與 db.js 的 SQL 版本一致）
  const locks = new Map();   // name -> { owner, expiresAt }
  const claims = new Map();  // "user|type|date" -> { owner, expiresAt, telegramSentAt, messageId }
  const users = new Map();   // userId -> user
  const links = new Map();   // chatId -> { userId, status }
  const tokensByUser = new Map();
  const proactiveState = new Map();   // userId -> lastCheckedHealthDate
  const proactiveEvents = [];         // claimed proactive_events rows
  const pendingQuestions = [];        // pending_questions rows
  let seq = 0;
  let eventSeq = 0;
  let pendingSeq = 0;
  const nextOwner = () => `fake-owner-${++seq}`;

  const DEFAULT_TOKEN = {
    accessToken: 'fake-access',
    refreshToken: 'fake-refresh',
    expiresAt: new Date(Date.now() + 3600_000),
    scope: 'offline read:recovery read:sleep read:cycles',
  };

  return {
    runs,
    notifies,
    locks,
    claims,
    users,
    links,
    migrate: async () => ({ from: 0, to: 2, rebuilt: [] }),

    // ----- 身分 -----
    async createUser({ id, displayName, timezone = 'Asia/Taipei', status = 'ACTIVE' }) {
      const u = { id, displayName, timezone, status };
      users.set(id, u);
      return u;
    },
    async getUser(userId) {
      return users.get(requireUserId(userId, 'getUser')) ?? null;
    },
    async listUsers({ status = null } = {}) {
      const all = [...users.values()];
      return status ? all.filter((u) => u.status === status) : all;
    },
    async listActiveUsers() {
      return [...users.values()].filter((u) => u.status === 'ACTIVE');
    },
    async linkTelegram({ chatId, userId }) {
      links.set(String(chatId), { userId: requireUserId(userId, 'linkTelegram'), status: 'ACTIVE' });
      return true;
    },
    async getTelegramLink(chatId) {
      const l = links.get(String(chatId));
      return l ? { chatId: String(chatId), ...l } : null;
    },
    async resolveUserByChatId(chatId) {
      const l = links.get(String(chatId));
      if (!l || l.status !== 'ACTIVE') return null;
      const u = users.get(l.userId);
      if (!u || u.status !== 'ACTIVE') return null;
      return { user: u, link: { chatId: String(chatId), ...l } };
    },
    async getActiveChatIdForUser(userId) {
      const uid = requireUserId(userId, 'getActiveChatIdForUser');
      for (const [chatId, l] of links) if (l.userId === uid && l.status === 'ACTIVE') return chatId;
      return null;
    },

    async acquireLock(name, { ttlMs, owner = nextOwner(), now = new Date() } = {}) {
      const cur = locks.get(name);
      if (cur && new Date(cur.expiresAt).getTime() > now.getTime()) return null;
      locks.set(name, { owner, expiresAt: new Date(now.getTime() + ttlMs).toISOString() });
      return owner;
    },
    async releaseLock(name, owner) {
      const cur = locks.get(name);
      if (!cur || cur.owner !== owner) return false;
      locks.delete(name);
      return true;
    },

    /**
     * 報告發送權 + 送達狀態機（語義與 db.js 的 SQL 版本逐條對應）。
     *
     * 這裡的每一個條件都必須跟真的 SQL 一樣嚴格，否則測試會通過一個
     * production 其實擋掉（或放行）的情境 —— 那比沒有測試更危險。
     */
    async claimReport({ userId, reportType, localDateKey, ttlMs, owner = nextOwner(), now = new Date() }) {
      const k = `${requireUserId(userId, 'claimReport')}|${reportType}|${localDateKey}`;
      const cur = claims.get(k);
      if (cur) {
        const state = cur.deliveryState ?? REPORT_DELIVERY_STATE.CLAIMED;
        const alreadySent = Boolean(cur.telegramSentAt)
          || state === REPORT_DELIVERY_STATE.DELIVERED;
        if (alreadySent) {
          return { granted: false, alreadySent: true, ambiguous: false, owner: null };
        }
        // 終局：跨過授權圍欄之後永遠不再授予，租約過不過期都一樣。
        if (state === REPORT_DELIVERY_STATE.DELIVERY_STARTED
            || state === REPORT_DELIVERY_STATE.AMBIGUOUS) {
          return { granted: false, alreadySent: false, ambiguous: true, owner: null };
        }
        if (new Date(cur.expiresAt).getTime() > now.getTime()) {
          return { granted: false, alreadySent: false, ambiguous: false, owner: null };
        }
      }
      claims.set(k, {
        owner,
        claimedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
        telegramSentAt: null,
        messageId: null,
        deliveryState: REPORT_DELIVERY_STATE.CLAIMED,
        deliveryStartedAt: null,
        deliveryAttempts: 0,
        deliveryDetail: null,
      });
      return { granted: true, owner };
    },
    async renewClaim({ userId, reportType, localDateKey, owner, ttlMs, now = new Date() }) {
      const k = `${requireUserId(userId, 'renewClaim')}|${reportType}|${localDateKey}`;
      const cur = claims.get(k);
      if (!cur || cur.owner !== owner || cur.telegramSentAt) return false;
      if ((cur.deliveryState ?? REPORT_DELIVERY_STATE.CLAIMED) !== REPORT_DELIVERY_STATE.CLAIMED) return false;
      if (new Date(cur.expiresAt).getTime() <= now.getTime()) return false;
      cur.expiresAt = new Date(now.getTime() + ttlMs).toISOString();
      return true;
    },
    /** 外部送出的授權圍欄。四個條件必須同時成立（見 db.js）。 */
    async authorizeReportDelivery({ userId, reportType, localDateKey, owner, now = new Date() }) {
      const k = `${requireUserId(userId, 'authorizeReportDelivery')}|${reportType}|${localDateKey}`;
      const cur = claims.get(k);
      if (!cur || !owner) return false;
      if (cur.owner !== owner) return false;                                   // 已經不是我的
      if (new Date(cur.expiresAt).getTime() <= now.getTime()) return false;    // 租約過期
      if ((cur.deliveryState ?? REPORT_DELIVERY_STATE.CLAIMED) !== REPORT_DELIVERY_STATE.CLAIMED) return false;
      if (cur.telegramSentAt) return false;
      cur.deliveryState = REPORT_DELIVERY_STATE.DELIVERY_STARTED;
      cur.deliveryStartedAt = now.toISOString();
      cur.deliveryAttempts = (cur.deliveryAttempts ?? 0) + 1;
      return true;
    },
    async markClaimSent({ userId, reportType, localDateKey, owner, messageId = null, now = new Date() }) {
      const k = `${requireUserId(userId, 'markClaimSent')}|${reportType}|${localDateKey}`;
      const cur = claims.get(k);
      if (!cur || cur.owner !== owner || cur.telegramSentAt) return false;
      if (cur.deliveryState !== REPORT_DELIVERY_STATE.DELIVERY_STARTED) return false;
      cur.telegramSentAt = now.toISOString();
      cur.messageId = messageId;
      cur.deliveryState = REPORT_DELIVERY_STATE.DELIVERED;
      return true;
    },
    async markClaimAmbiguous({ userId, reportType, localDateKey, owner, detail = null, now = new Date() }) {
      const k = `${requireUserId(userId, 'markClaimAmbiguous')}|${reportType}|${localDateKey}`;
      const cur = claims.get(k);
      if (!cur || cur.owner !== owner || cur.telegramSentAt) return false;
      if (cur.deliveryState !== REPORT_DELIVERY_STATE.DELIVERY_STARTED) return false;
      cur.deliveryState = REPORT_DELIVERY_STATE.AMBIGUOUS;
      cur.deliveryDetail = detail;
      return true;
    },
    async getClaim(userId, reportType, localDateKey) {
      const uid = requireUserId(userId, 'getClaim');
      const cur = claims.get(`${uid}|${reportType}|${localDateKey}`);
      return cur ? { ...cur, userId: uid, reportType, localDate: localDateKey } : null;
    },
    async releaseClaim({ userId, reportType, localDateKey, owner }) {
      const k = `${requireUserId(userId, 'releaseClaim')}|${reportType}|${localDateKey}`;
      const cur = claims.get(k);
      if (!cur || cur.owner !== owner || cur.telegramSentAt) return false;
      // 跨過圍欄之後就不可以再刪掉這一列（那會讓下一輪重新 claim 而重送）。
      if ((cur.deliveryState ?? REPORT_DELIVERY_STATE.CLAIMED) !== REPORT_DELIVERY_STATE.CLAIMED) return false;
      claims.delete(k);
      return true;
    },
    /** 只有「證明得了沒送出去」才可以走這條，把 DELIVERY_STARTED 退回 UNCLAIMED。 */
    async releaseClaimAfterFailedSend({ userId, reportType, localDateKey, owner }) {
      const k = `${requireUserId(userId, 'releaseClaimAfterFailedSend')}|${reportType}|${localDateKey}`;
      const cur = claims.get(k);
      if (!cur || cur.owner !== owner || cur.telegramSentAt) return false;
      if (cur.deliveryState !== REPORT_DELIVERY_STATE.DELIVERY_STARTED) return false;
      claims.delete(k);
      return true;
    },

    getTokens: async (userId) => {
      const uid = requireUserId(userId, 'getTokens');
      if (!tokensByUser.has(uid)) tokensByUser.set(uid, { ...DEFAULT_TOKEN, userId: uid });
      return tokensByUser.get(uid);
    },
    saveTokens: async (userId, t) => {
      const uid = requireUserId(userId, 'saveTokens');
      tokensByUser.set(uid, { ...t, userId: uid, expiresAt: new Date(t.expiresAt) });
    },
    findUserByWhoopUserId: async (whoopUserId, { excludeUserId = null } = {}) => {
      for (const [uid, t] of tokensByUser) {
        if (t.whoopUserId != null && String(t.whoopUserId) === String(whoopUserId)
            && uid !== String(excludeUserId ?? '')) return uid;
      }
      return null;
    },
    isSent: async (userId, type, key) => {
      const uid = requireUserId(userId, 'isSent');
      return runs.some((r) => r.userId === uid && r.reportType === type
        && r.localDateKey === key && r.status === 'SENT');
    },
    recordRun: async (r, { throwOnError = true } = {}) => {
      requireUserId(r.userId, 'recordRun');
      // 模擬「Turso 短暫故障」：SENT 寫不進去
      if (failSentRecord && r.status === 'SENT') {
        if (throwOnError) throw failSentRecord;
        return false;
      }
      // 模擬 uniq_report_sent：同 type+date 只能有一筆 SENT
      if (r.status === 'SENT' && runs.some(
        (x) => x.userId === r.userId && x.reportType === r.reportType
          && x.localDateKey === r.localDateKey && x.status === 'SENT',
      )) return false;
      runs.push(r);
      return true;
    },
    recentRuns: async (userId) => {
      const uid = requireUserId(userId, 'recentRuns');
      return runs.filter((r) => r.userId === uid).slice().reverse();
    },
    claimErrorNotify: async (scope, type, hours) => {
      const k = `${scope}|${type}`;
      const last = notifies.get(k);
      if (last && Date.now() - last < hours * 3600_000) return false;
      notifies.set(k, Date.now());
      return true;
    },
    claimGlobalErrorNotify: async (type, hours) => {
      const k = `global|${type}`;
      const last = notifies.get(k);
      if (last && Date.now() - last < hours * 3600_000) return false;
      notifies.set(k, Date.now());
      return true;
    },
    userLockName: (base, userId) => `${base}:${requireUserId(userId, 'userLockName')}`,

    // ----- Proactive Agent（沒有健康資料的最小合法實作）-----
    // 這個 fakeDb 本來就沒有 upsertSleeps 之類的方法，所以永遠沒有健康資料，
    // coverage() 回傳 last_date: null 讓 checkAndAct() 直接 no-op 提前返回——
    // 既有只測 daily/weekly 流程的測試因此完全不受影響。
    async coverage(userId) {
      requireUserId(userId, 'coverage');
      return {
        first_date: null, last_date: null, main_sleeps: 0, naps: 0,
        recoveries: 0, scored_recoveries: 0, unscored_sleeps: 0, cycles: 0, workouts: 0,
      };
    },
    async getProactiveState(userId) {
      const uid = requireUserId(userId, 'getProactiveState');
      return proactiveState.has(uid) ? { userId: uid, ...proactiveState.get(uid) } : null;
    },
    async setProactiveState(userId, { lastCheckedHealthDate, lastFingerprint = null }) {
      const uid = requireUserId(userId, 'setProactiveState');
      proactiveState.set(uid, { lastCheckedHealthDate, lastFingerprint });
      return true;
    },
    async isProactiveEnabled(userId) {
      requireUserId(userId, 'isProactiveEnabled');
      return true;
    },
    async setProactiveEnabled(userId) {
      requireUserId(userId, 'setProactiveEnabled');
      return true;
    },
    async resolveProactiveEvent(userId) {
      requireUserId(userId, 'resolveProactiveEvent');
      return true;
    },
    async getActiveInsights(userId) {
      requireUserId(userId, 'getActiveInsights');
      return [];
    },
    async getOpenPendingQuestion(userId) {
      requireUserId(userId, 'getOpenPendingQuestion');
      return null;
    },
    async getJournalEvents(userId) {
      requireUserId(userId, 'getJournalEvents');
      return [];
    },
    async getRecentProactiveEvents(userId) {
      requireUserId(userId, 'getRecentProactiveEvents');
      return [];
    },
    async claimProactiveEvent(userId, payload) {
      const uid = requireUserId(userId, 'claimProactiveEvent');
      const exists = proactiveEvents.some(
        (e) => e.userId === uid && e.idempotencyKey === payload.idempotencyKey,
      );
      if (exists) return { claimed: false, id: null };
      const id = ++eventSeq;
      proactiveEvents.push({ id, userId: uid, ...payload });
      return { claimed: true, id };
    },
    async markProactiveEventSent() {
      return true;
    },
    async openPendingQuestion(userId, q) {
      const uid = requireUserId(userId, 'openPendingQuestion');
      const id = ++pendingSeq;
      pendingQuestions.push({ id, userId: uid, ...q, status: 'OPEN' });
      return id;
    },
    proactiveEvents,
    pendingQuestions,

    close: () => {},
  };
}

export function fakeTelegram({ failWith = null, print = false } = {}) {
  const sent = [];
  return {
    sent,
    send: async (text) => {
      if (failWith) throw failWith;
      sent.push(text);
      if (print) process.stdout.write(`\n${'='.repeat(64)}\n${text}\n${'='.repeat(64)}\n`);
      return { messageId: 1000 + sent.length };
    },
    notifyError: async (type, msg) => {
      sent.push(`[ERROR:${type}] ${msg}`);
      return true;
    },
  };
}

/**
 * 假教練。
 *
 * ★ H-05 之後敘述層唯一的模型介面是 narrativePlan：它拿到一份已經寫好的
 * 句子清單，只能回一串 id。這個替身預設回「照原順序全選」，也就是一個
 * 合法計畫 —— 所以正常路徑上 narrativeSource 會是 'model'，但輸出的每一個
 * 字仍然來自應用程式。
 *
 * daily/weekly 保留只是為了讓還在呼叫它們的舊測試不炸；敘述層**不再使用**
 * 它們（narrative.js 會明確拒絕舊的 generate 介面）。
 */
export function fakeCoach({
  dailyText = '（假的教練文字）今天恢復不錯，Kelvin，放心去衝 💪',
  weeklyText = '（假的週回顧教練文字）',
  fail = false,
  plan = null,
} = {}) {
  return {
    model: 'fake',
    daily: async () => (fail ? null : dailyText),
    weekly: async () => (fail ? null : weeklyText),
    async narrativePlan(fragments) {
      if (fail) return null;               // 供應商不可用
      if (plan) return plan(fragments);    // 測試指定的（可能不合法的）計畫
      return { order: fragments.map((f) => f.id) };
    },
  };
}
