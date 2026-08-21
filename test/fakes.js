/**
 * 測試替身：記憶體版 DB、假 Telegram、假 Claude。
 * 介面與正式版一致，所以 daily/weekly 流程可以原封不動測。
 */

export function fakeDb() {
  const runs = [];
  const notifies = new Map();
  let tokens = {
    accessToken: 'fake-access',
    refreshToken: 'fake-refresh',
    expiresAt: new Date(Date.now() + 3600_000),
    scope: 'offline read:recovery read:sleep read:cycles',
  };

  return {
    runs,
    notifies,
    migrate: async () => {},
    getTokens: async () => tokens,
    saveTokens: async (t) => { tokens = { ...t, expiresAt: new Date(t.expiresAt) }; },
    isSent: async (type, key) => runs.some(
      (r) => r.reportType === type && r.localDateKey === key && r.status === 'SENT',
    ),
    recordRun: async (r) => {
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
