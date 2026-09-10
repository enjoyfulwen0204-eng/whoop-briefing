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
 *   pending_questions   `WHERE user_id = ? AND id = ? AND status = 'OPEN'`
 *   proactive_events    `WHERE user_id = ? AND id = ? AND outcome IS NULL`
 *
 * 所以「使用者剛好在收割的同一瞬間回答」只會有一個贏家：
 *   - 回答先到 → pending 變 ANSWERED → 收割器的 UPDATE 影響 0 列 → 跳過，
 *     連帶也不會去碰那筆事件
 *   - 收割先到 → pending 變 EXPIRED → 使用者的 resolvePendingQuestion
 *     （條件同樣是 status='OPEN'）影響 0 列 → router 把它當成沒有 pending
 *
 * 重跑收割器是天然冪等的：第二個閘門會影響 0 列。
 *
 * ## F-01：兩段寫入留下的半完成狀態，必須能自我修復
 *
 * 「問題收成 EXPIRED」與「事件寫 NO_RESPONSE」是**兩次**寫入，中間可能：
 *
 *   - process 死掉
 *   - 或者 `getOpenPendingQuestion()` 的**惰性過期**搶先把問題收成
 *     EXPIRED（它每次 cron 的 checkAndAct、每則使用者訊息、`/status`
 *     都會觸發，而且它只收問題、不碰事件）
 *
 * 兩者留下同一個半完成狀態：`question = EXPIRED` 而 `outcome = NULL`。
 *
 * 舊版的收割器只看 `status = 'OPEN'`，所以這個狀態**永遠**修不回來，
 * 事件會一直停在 NULL，Guardian 也會一直誤報「有事件卡住」。
 *
 * 現在收割器同時收 OPEN 與 EXPIRED（見
 * `listReapablePendingQuestions`），已經是 EXPIRED 的直接跳到第二個閘門。
 * `outcome IS NULL` 保證重跑仍然冪等，也保證已經有結果的事件不被覆寫。
 * ANSWERED 與 SUPERSEDED 從來不在清單裡，所以它們永遠不可能變成
 * NO_RESPONSE。
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
 * @returns {Promise<{expired:number, repaired:number, noResponse:number, skipped:number}>}
 *   expired    這一次真的從 OPEN 收成 EXPIRED 的問題數
 *   repaired   問題早就是 EXPIRED（惰性過期或中途死掉），這次只補事件
 *   noResponse 真的補寫成 NO_RESPONSE 的事件數
 *   skipped    競態下輸掉、或已經有結果、或沒有連到事件的數量
 */
export async function reapExpiredProactiveQuestions({ db, userId, now = new Date() }) {
  const uid = requireUserId(userId, 'reapExpiredProactiveQuestions');
  const out = { expired: 0, repaired: 0, noResponse: 0, skipped: 0 };

  if (typeof db.listReapablePendingQuestions !== 'function') return out;

  let stale;
  try {
    stale = await db.listReapablePendingQuestions(uid, {
      now, intent: PROACTIVE_QUESTION_INTENT,
    });
  } catch (err) {
    log.warn('proactive_reap_list_failed', { user_id: uid, error: String(err?.message ?? err).slice(0, 200) });
    return out;
  }
  if (!stale.length) return out;

  for (const q of stale) {
    try {
      // 閘門 1：把問題推到 EXPIRED。
      //
      // F-01：這裡要處理**兩種**來源的列。
      //
      //   status === 'OPEN'     還沒有人收過 → 由我們來收。輸掉這個原子
      //                         閘門代表使用者剛好在同一瞬間回答了
      //                         （resolvePendingQuestion 用同一個
      //                         `status = 'OPEN'` 條件），那就什麼都不做。
      //
      //   status === 'EXPIRED'  已經被惰性過期（或前一次中途死掉的收割）
      //                         收走了。問題那一層已經是終局，**不需要也
      //                         不可能**再贏一次 expirePendingQuestion。
      //                         直接往下走去補事件的 outcome —— 這正是
      //                         「兩段寫入」留下的半完成狀態的修復路徑。
      //
      // 關鍵：EXPIRED 這條路徑**不**因為 expirePendingQuestion 回 false
      // 就跳過。舊版就是卡在這裡，導致事件永遠停在 NULL。
      if (q.status === 'OPEN') {
        const won = await db.expirePendingQuestion(uid, q.id, { now });
        if (!won) {
          // 使用者贏了 → 這題是 ANSWERED，絕不可以寫 NO_RESPONSE
          out.skipped += 1;
          continue;
        }
        out.expired += 1;
      } else {
        // 已經是 EXPIRED：只是來補事件的，不重複計入 expired
        out.repaired += 1;
      }

      // 目標事件。
      //
      // ⚠️ RF-01：這裡**不再**自己從 context 推事件 id。目標由
      // `listReapablePendingQuestions` 用**與選取條件完全相同的 SQL
      // 運算式**算出來（見 UNRESOLVED_EVENT_ID_SQL），所以「選到的那一列」
      // 與「要收尾的那個事件」在結構上不可能不一致。
      //
      // 那個運算式已經做完三件事：同一個使用者、outcome IS NULL、
      // 欄位連結優先於 context 連結。context 裡偽造成別人的事件 id 在
      // 那一步就被 `e.user_id = pending_questions.user_id` 濾掉了。
      const target = q.unresolvedEventId ?? null;
      if (!target) {
        // OPEN 但沒有連到任何未結案的事件（例如孤兒問題）：已經收成
        // EXPIRED 就夠了，沒有事件要收尾。
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

  if (out.expired || out.repaired || out.noResponse) {
    log.info('proactive_questions_reaped', {
      user_id: uid,
      expired: out.expired,
      repaired: out.repaired,
      no_response: out.noResponse,
      skipped: out.skipped,
    });
  }
  return out;
}
