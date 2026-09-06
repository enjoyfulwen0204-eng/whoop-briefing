/**
 * 測試替身：記憶體版 DB、假 Telegram、假 Claude。
 * 介面與正式版一致，所以 daily/weekly 流程可以原封不動測。
 */

export function fakeDb({ failSentRecord = null } = {}) {
  const runs = [];
  const notifies = new Map();
  // 記憶體版的 lease lock / 報告發送權（語義與 db.js 的 SQL 版本一致）
  const locks = new Map();   // name -> { owner, expiresAt }
  const claims = new Map();  // "type|date" -> { owner, expiresAt, telegramSentAt, messageId }
  let seq = 0;
  const nextOwner = () => `fake-owner-${++seq}`;
  let tokens = {
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
    migrate: async () => {},

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

    async claimReport({ reportType, localDateKey, ttlMs, owner = nextOwner(), now = new Date() }) {
      const k = `${reportType}|${localDateKey}`;
      const cur = claims.get(k);
      if (cur?.telegramSentAt) return { granted: false, alreadySent: true, owner: null };
      if (cur && new Date(cur.expiresAt).getTime() > now.getTime()) {
        return { granted: false, alreadySent: false, owner: null };
      }
      claims.set(k, {
        owner,
        expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
        telegramSentAt: null,
        messageId: null,
      });
      return { granted: true, owner };
    },
    async markClaimSent({ reportType, localDateKey, owner, messageId = null, now = new Date() }) {
      const k = `${reportType}|${localDateKey}`;
      const cur = claims.get(k);
      if (!cur || cur.owner !== owner || cur.telegramSentAt) return false;
      cur.telegramSentAt = now.toISOString();
      cur.messageId = messageId;
      return true;
    },
    async getClaim(reportType, localDateKey) {
      const cur = claims.get(`${reportType}|${localDateKey}`);
      return cur ? { ...cur, reportType, localDate: localDateKey } : null;
    },
    async releaseClaim({ reportType, localDateKey, owner }) {
      const k = `${reportType}|${localDateKey}`;
      const cur = claims.get(k);
      if (!cur || cur.owner !== owner || cur.telegramSentAt) return false;
      claims.delete(k);
      return true;
    },

    getTokens: async () => tokens,
    saveTokens: async (t) => { tokens = { ...t, expiresAt: new Date(t.expiresAt) }; },
    isSent: async (type, key) => runs.some(
      (r) => r.reportType === type && r.localDateKey === key && r.status === 'SENT',
    ),
    recordRun: async (r, { throwOnError = true } = {}) => {
      // 模擬「Turso 短暫故障」：SENT 寫不進去
      if (failSentRecord && r.status === 'SENT') {
        if (throwOnError) throw failSentRecord;
        return false;
      }
      // 模擬 uniq_report_sent：同 type+date 只能有一筆 SENT
      if (r.status === 'SENT' && runs.some(
        (x) => x.reportType === r.reportType && x.localDateKey === r.localDateKey && x.status === 'SENT',
      )) return false;
      runs.push(r);
      return true;
    },
    recentRuns: async () => runs.slice().reverse(),
    claimErrorNotify: async (type, hours) => {
      const last = notifies.get(type);
      if (last && Date.now() - last < hours * 3600_000) return false;
      notifies.set(type, Date.now());
      return true;
    },
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

export function fakeCoach({ dailyText = '（假的教練文字）今天恢復不錯，Kelvin，放心去衝 💪', weeklyText = '（假的週回顧教練文字）', fail = false } = {}) {
  return {
    model: 'fake',
    daily: async () => (fail ? null : dailyText),
    weekly: async () => (fail ? null : weeklyText),
  };
}
