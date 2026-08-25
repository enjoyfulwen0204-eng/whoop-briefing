/**
 * 運維提醒。
 *
 * 要解決的問題：GitHub 的既有行為是「repo 連續 60 天沒有任何 commit，scheduled
 * workflow 會被自動停用」。那時簡報會**安靜地**停掉 —— 不會有錯誤通知，因為根本
 * 沒有 run 被觸發，系統裡沒有任何東西知道自己死了。
 *
 * 所以在還來得及的時候（預設 55 天）主動用 Telegram 提醒。
 *
 * 設計原則：這是附加功能，**絕不能影響簡報本身**。所有錯誤都在這裡吞掉並寫 log。
 */

import { REPO_FRESHNESS } from './config.js';
import { log, describeError } from './logger.js';

/** ISO 時間字串 → 距今幾天（小數）。無法解析回 null。 */
export function daysSince(iso, now = new Date()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return (now.getTime() - t) / 86_400_000;
}

export function buildStaleMessage(days, {
  disableAfter = REPO_FRESHNESS.DISABLE_AFTER_DAYS,
} = {}) {
  const left = Math.ceil(disableAfter - days);
  const lines = [
    '🛠 WHOOP 簡報系統維護提醒',
    '',
    `這個 repo 已經 ${Math.floor(days)} 天沒有新的 commit。`,
    `GitHub 會在滿 ${disableAfter} 天無活動時自動停用排程 —— 屆時每日簡報會安靜地停掉，`
      + '而且不會有任何錯誤通知（因為根本不會有 run 被觸發）。',
    '',
  ];
  lines.push(left > 0
    ? `還剩約 ${left} 天。推任何一個 commit 就會重置計時。`
    : '已經超過 60 天了，請去 GitHub 的 Actions 分頁確認排程是否還啟用中。');
  return lines.join('\n');
}

/**
 * 檢查 repo 有多久沒 commit，必要時發 Telegram 提醒。
 *
 * @param {object}  db            需要 claimErrorNotify（借用通知冷卻表）
 * @param {object}  telegram      需要 send
 * @param {Date}    now
 * @param {?string} lastCommitAt  ISO 時間字串。null / 空 = 不是 GitHub Actions 環境 → 跳過
 */
export async function checkRepoFreshness({ db, telegram, now = new Date(), lastCommitAt = null }) {
  // Render / 本機沒有這個資訊，也沒有 60 天停用問題 → 直接跳過
  if (!lastCommitAt) return { status: 'skipped', reason: 'no_commit_info' };

  const days = daysSince(lastCommitAt, now);
  if (days === null) {
    log.warn('repo_freshness_unparsable', { last_commit_at: String(lastCommitAt).slice(0, 40) });
    return { status: 'skipped', reason: 'unparsable' };
  }
  if (days < REPO_FRESHNESS.WARN_AFTER_DAYS) return { status: 'fresh', days };

  try {
    // 借用錯誤通知的冷卻表：同一天最多提醒一次，不然每 30 分鐘就洗一次版
    const allowed = await db.claimErrorNotify('repo_stale', REPO_FRESHNESS.NOTIFY_COOLDOWN_HOURS);
    if (!allowed) {
      log.info('repo_stale_suppressed', { days: Math.floor(days) });
      return { status: 'suppressed', days };
    }
    await telegram.send(buildStaleMessage(days));
    log.warn('repo_stale_notified', { days: Math.floor(days) });
    return { status: 'notified', days };
  } catch (err) {
    // 提醒失敗絕不能影響簡報
    log.error('repo_stale_notify_failed', { error: describeError(err) });
    return { status: 'failed', days, error: describeError(err) };
  }
}
