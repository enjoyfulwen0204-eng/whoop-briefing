/**
 * WHOOP 資料取用層（lazy + 記憶化）。
 *
 * 為什麼要這層：
 *  - polling（每 15 分鐘）只抓最新的 Sleep / Recovery，成本極低。
 *  - 45 天歷史只有「真的要發報告」時才抓，而且 daily 與 weekly 同一次執行
 *    共用同一份，不會重複打 API（rate limit 友善）。
 *  - daily / weekly 的判斷與 retry 仍然完全獨立，這裡只是共用讀到的資料。
 */

import { BASELINE, WAKE } from './config.js';

const DAY_MS = 86_400_000;

export function createDataSource({ whoop, now = new Date() }) {
  let pollPromise = null;
  let historyPromise = null;

  function poll() {
    if (!pollPromise) {
      const start = new Date(now.getTime() - WAKE.POLL_LOOKBACK_DAYS * DAY_MS);
      pollPromise = (async () => {
        const [sleeps, recoveries] = await Promise.all([
          whoop.sleeps(start, now),
          whoop.recoveries(start, now),
        ]);
        return { sleeps, recoveries };
      })();
    }
    return pollPromise;
  }

  function history() {
    if (!historyPromise) {
      const start = new Date(now.getTime() - BASELINE.LOOKBACK_DAYS * DAY_MS);
      historyPromise = (async () => {
        const [sleeps, recoveries, cycles] = await Promise.all([
          whoop.sleeps(start, now),
          whoop.recoveries(start, now),
          whoop.cycles(start, now),
        ]);
        return { sleeps, recoveries, cycles };
      })();
    }
    return historyPromise;
  }

  return { poll, history };
}

/** 測試 / dry-run 用：直接餵假資料。 */
export function staticDataSource({ sleeps = [], recoveries = [], cycles = [] }) {
  return {
    poll: async () => ({ sleeps, recoveries }),
    history: async () => ({ sleeps, recoveries, cycles }),
  };
}
