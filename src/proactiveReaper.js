/**
 * 主動問題的過期收割器（V1.1 Phase 5）。
 *
 * ## 要補完的洞
 *
 * 在這之前，主動問題的生命週期只有三條邊：
 *
 *   OPEN → ANSWERED      使用者回答了
 *   OPEN → SUPERSEDED    又問了新的一題
 *   OPEN → EXPIRED       **惰性**：只有在下一次讀取時才會被標記
 *
 * 最後那條是惰性的，所以「使用者再也沒有傳任何訊息」時，那一列會永遠
 * 停在 OPEN。更嚴重的是：即使它被標成 EXPIRED，對應的那筆
 * `proactive_events` 也**從來沒有人去收尾**——`outcome` 永遠是 NULL。
 * 於是「問了但沒人理」這件事在資料上完全不存在，事後無法回答
 * 「我們問過幾次？被無視幾次？」——而那正是之後要調 TTL 唯一能依據的東西。
 *
 * `PROACTIVE_OUTCOME.NO_RESPONSE` 這個列舉值早就宣告好了，只是從來沒有
 * 任何一行程式寫過它。這個檔案就是那一行。
 *
 * ## 為什麼不會污染反騷擾政策
 *
 * `attention.decide()` 只讀 `decision` / `createdAt` / `signals` 三個欄位，
 * **完全沒有讀 `outcome`**（見 test/characterization.test.js 的 A11-A13）。
 * 收割器只寫 `outcome` 與 `resolved_at`，一個字都不碰前面三個欄位，
 * 所以冷卻、新鮮度、持續性、每日上限在結構上就不可能被影響——
 * 這不是「實作時有小心」，是 decide() 根本看不到那個欄位。
 *
 * ## 競態安全
 *
 * 兩個原子閘門，各自靠單一條件式 UPDATE：
 *
 *   pending_questions   `WHERE id = ? AND status = 'OPEN'`
 *   proactive_events    `WHERE id = ? AND outcome IS NULL`
 *
 * 所以「使用者剛好在收割的同一瞬間回答」只會有一個贏家：
 *   - 回答先到 → pending 變 ANSWERED → 收割器的 UPDATE 影響 0 列 → 跳過，
 *     連帶也不會去碰那筆事件
 *   - 收割先到 → pending 變 EXPIRED → 使用者的 resolvePendingQuestion
 *     （條件同樣是 status='OPEN'）影響 0 列 → router 把它當成沒有 pending
 *
 * 重跑收割器是天然冪等的：第二次兩個閘門都會影響 0 列。
 *
 * ## 範圍
 *
 * **只收主動代理發出的問題**（intent = PROACTIVE_QUESTION_INTENT）。
 * 反應式追問沒有對應的 proactive_events 列，沒有需要補寫的終局狀態，
 * 維持既有的惰性過期即可——這裡不去改它的語義。
 */

import { PROACTIVE_OUTCOME, PROACTIVE_QUESTION_INTENT } from './schema.js';
import { requireUserId } from './userContext.js';
import { log } from './logger.js';

/**
 * 收割一個使用者所有過期未答的主動問題。
 *
 * **永遠不拋錯**：這是背景維護工作，絕不可以讓簡報或同步失敗。
 *
 * @returns {Promise<{expired:number, noResponse:number, skipped:number}>}
 *   expired    真的從 OPEN 收走的問題數
 *   noResponse 真的補寫成 NO_RESPONSE 的事件數
 *   skipped    競態下輸掉、或已經有結果、或沒有連到事件的數量
 */
export async function reapExpiredProactiveQuestions({ db, userId, now = new Date() }) {
  const uid = requireUserId(userId, 'reapExpiredProactiveQuestions');
  const out = { expired: 0, noResponse: 0, skipped: 0 };

  if (typeof db.listExpiredOpenQuestions !== 'function') return out;

  let stale;
  try {
    stale = await db.listExpiredOpenQuestions(uid, {
      now, intent: PROACTIVE_QUESTION_INTENT,
    });
  } catch (err) {
    log.warn('proactive_reap_list_failed', { user_id: uid, error: String(err?.message ?? err).slice(0, 200) });
    return out;
  }
  if (!stale.length) return out;

  for (const q of stale) {
    try {
      // 閘門 1：OPEN → EXPIRED。輸掉代表使用者剛好回答了，什麼都不要做。
      const won = await db.expirePendingQuestion(uid, q.id, { now });
      if (!won) {
        out.skipped += 1;
        continue;
      }
      out.expired += 1;

      // 連回那筆事件。優先用 context 裡記的 id（開問題時就寫進去了），
      // 查不到再用 pending_question_id 反查。
      const eventId = Number(q.context?.proactive_event_id) || null;
      let target = eventId;
      if (!target && typeof db.getProactiveEventByPendingQuestion === 'function') {
        const ev = await db.getProactiveEventByPendingQuestion(uid, q.id);
        target = ev?.id ?? null;
      }
      if (!target) {
        out.skipped += 1;
        continue;
      }

      // 閘門 2：只有 outcome 還是 NULL 才寫。已經有結果的絕不覆寫。
      const wrote = await db.resolveProactiveEventIfUnresolved(
        uid, target, PROACTIVE_OUTCOME.NO_RESPONSE, { now },
      );
      if (wrote) out.noResponse += 1;
      else out.skipped += 1;
    } catch (err) {
      out.skipped += 1;
      log.warn('proactive_reap_item_failed', {
        user_id: uid,
        pending_question_id: q.id,
        error: String(err?.message ?? err).slice(0, 200),
      });
    }
  }

  if (out.expired || out.noResponse) {
    log.info('proactive_questions_reaped', {
      user_id: uid, expired: out.expired, no_response: out.noResponse, skipped: out.skipped,
    });
  }
  return out;
}
