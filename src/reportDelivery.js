/**
 * 報告送出的**唯一**耐久邊界（H-01 + H-02）。
 *
 * ## 為什麼 daily 與 weekly 一定要共用這一支
 *
 * 稽核的要求寫得很清楚：不可以「兩個各自為政的修補，留下另一個沒被保護的
 * 送出邊界」。以前 daily.js 與 weekly.js 各自抄了一份「送出 → 標記」的流程，
 * 兩邊的錯誤處理已經有細微差異。只要還有兩份，就一定會再長出第三種行為。
 *
 * 所以外部送出只有這一個入口。要新增第三種報告時，也只能走這裡。
 *
 * ## 狀態機（權威在 report_claims.delivery_state）
 *
 *   UNCLAIMED
 *     │  claimReport()            ← 呼叫端負責，在昂貴工作之前
 *     ▼
 *   CLAIMED ──────────────────────────────────────────────┐
 *     │  「還沒有任何外部副作用」的保證區間：              │
 *     │  抓 45 天歷史、算 baseline、問模型都在這裡發生。   │ releaseClaim()
 *     │  租約過期被別人接手是**安全**的（重做零代價）。    │ （確定失敗，
 *     │                                                   │  還沒送出去）
 *     │  authorizeReportDelivery()  ← 原子圍欄：            ▼
 *     │    owner 相符 ∧ 租約有效 ∧ 仍是 CLAIMED        UNCLAIMED
 *     │    不成立 ⇒ 就地失效，**絕不送**
 *     ▼
 *   DELIVERY_STARTED（終局：從此不再自動送出任何東西）
 *     │
 *     ├─ Telegram 明確成功 + message_id ──▶ DELIVERED
 *     ├─ Telegram 明確拒收（可證明沒送出）▶ 退回 UNCLAIMED（可安全重試）
 *     └─ 其餘（讀不到 body／逾時／形狀壞）▶ AMBIGUOUS（終局，人工處置）
 *
 * ## 三個不變量
 *
 * 1. **授權先於副作用。** 打 Telegram 之前，資料庫就已經知道
 *    「這一份可能已經送出去了」。process 在任何一個瞬間死掉，
 *    醒來的人看到的都是 DELIVERY_STARTED，而那是終局。
 *
 * 2. **失去所有權就不可以送。** 圍欄是一句原子 SQL，不是「先查再寫」。
 *    租約過期的舊 owner 恢復執行時會被擋下來，而且**不會**去刪除
 *    接手者的狀態。
 *
 * 3. **模糊永遠不退回可重試。** 證明不了送達，就既不宣稱成功、
 *    也不自動再送一次。漏發一次可以補；重發一次收不回來。
 */

import { SEND_OUTCOME, classifySendOutcome } from './sendOutcome.js';
import { isSuppressedDelivery } from './accountLifecycle.js';
import { requireUserId } from './userContext.js';
import { log, describeError } from './logger.js';

/**
 * 一次送出嘗試的結果。
 *
 *   DELIVERED        Telegram 明確收下了（有 message_id）
 *   FENCED           送出前就失去所有權 → **什麼都沒送**，下一輪由新 owner 負責
 *   DEFINITE_FAILURE Telegram 明確拒收 → 什麼都沒送，發送權已歸還，可以重試
 *   AMBIGUOUS        可能送出去了，但證明不了 → **終局**，不再自動重送
 */
export const DELIVERY_RESULT = Object.freeze({
  DELIVERED: 'delivered',
  FENCED: 'fenced',
  DEFINITE_FAILURE: 'definite_failure',
  AMBIGUOUS: 'ambiguous',
  /**
   * ★ R2 / LIFE-FG-07：帳號啟用授權在送出前把它擋下來了。
   *
   * **什麼都沒送出去**，所以它絕不可以被當成 DELIVERED：
   * 標記成已送達會消耗掉這一天的遞送名額，讓使用者在合法重新啟用之後
   * 永遠收不到那天的晨報。語義上最接近 DEFINITE_FAILURE（確定沒送出、
   * 可以安全重來），但原因完全不同，所以獨立命名。
   */
  SUPPRESSED_INACTIVE: 'suppressed_inactive',
});

/**
 * 續租：把租約往後推，讓正常的長工作不會莫名失去所有權。
 *
 * ⚠️ 這是**效率**機制。即使它整個壞掉，正確性也不受影響 —— 送出前的圍欄
 * 才是安全邊界。所以它失敗只寫 log，絕不影響流程。
 */
export async function renewReportClaim({
  db, claimKey, claim, ttlMs, now = new Date(), stage = null,
}) {
  if (!claim?.owner || typeof db.renewClaim !== 'function') return true;
  try {
    const ok = await db.renewClaim({ ...claimKey, owner: claim.owner, ttlMs, now });
    if (!ok) {
      // 失去所有權了。這裡**不中止** —— 中止與否由送出前的圍欄決定，
      // 一個地方做決定就好。這只是一個早期訊號。
      log.warn('report_claim_renew_lost', { ...scopeOf(claimKey), stage });
    }
    return ok;
  } catch (err) {
    log.warn('report_claim_renew_failed', {
      ...scopeOf(claimKey), stage, error: describeError(err),
    });
    return true;
  }
}

const scopeOf = (claimKey) => ({
  user_id: claimKey.userId,
  report_type: claimKey.reportType,
  local_date: claimKey.localDateKey,
});

/**
 * 送出一份報告，並把送達狀態耐久地記下來。
 *
 * @param {object}  db
 * @param {object}  claimKey  { userId, reportType, localDateKey }
 * @param {object}  claim     claimReport() 的結果（可能 owner 為 null＝沒有 claim 機制）
 * @param {object}  telegram  已綁到該使用者的 client
 * @param {string}  text      **已經組好**的訊息全文
 * @returns {Promise<{result:string, messageId:?number, error:?string, authorized:boolean}>}
 */
export async function deliverReport({
  db, claimKey, claim, telegram, text, now = () => new Date(),
}) {
  requireUserId(claimKey?.userId, 'deliverReport');
  const scope = scopeOf(claimKey);
  const owner = claim?.owner ?? null;
  const fenceable = Boolean(owner) && typeof db.authorizeReportDelivery === 'function';

  // -------------------------------------------------------------------------
  // 1) 授權：不可逆副作用的唯一入口
  // -------------------------------------------------------------------------
  if (fenceable) {
    const authorized = await db.authorizeReportDelivery({
      ...claimKey, owner, now: new Date(now()),
    });
    if (!authorized) {
      // 所有權已經不在了。**絕不送**，而且**絕不 releaseClaim** ——
      // 那一列現在可能屬於接手者，刪掉它等於把對方的保護拆掉。
      log.warn('report_delivery_fenced', scope);
      return {
        result: DELIVERY_RESULT.FENCED, messageId: null, error: null, authorized: false,
      };
    }
  }

  // -------------------------------------------------------------------------
  // 2) 外部副作用。從這一刻起「沒發生」已經不再是一個可能的答案。
  // -------------------------------------------------------------------------
  let sent;
  try {
    sent = await telegram.send(text);
  } catch (err) {
    const outcome = classifySendOutcome(err);

    if (outcome === SEND_OUTCOME.DEFINITE_FAILURE) {
      // Telegram 親口說沒收下（或連線根本沒建立）→ 可以安全地退回重試。
      // 把整列刪掉，回到 UNCLAIMED，下一輪重新走完整流程。
      if (fenceable) await releaseAfterDefiniteFailure({ db, claimKey, owner, scope });
      log.warn('report_delivery_definite_failure', {
        ...scope, stage: err?.sendStage ?? null, error: describeError(err),
      });
      return {
        result: DELIVERY_RESULT.DEFINITE_FAILURE, messageId: null,
        error: describeError(err), authorized: true,
      };
    }

    // 模糊：Telegram 可能已經把訊息交給使用者了。**終局**。
    if (fenceable && typeof db.markClaimAmbiguous === 'function') {
      try {
        await db.markClaimAmbiguous({
          ...claimKey, owner, detail: err?.sendStage ?? 'unknown', now: new Date(now()),
        });
      } catch (markErr) {
        // 標記失敗也不可以退回可重試：狀態仍然停在 DELIVERY_STARTED，
        // 而那同樣是終局。兩條路都不會重送。
        log.error('report_claim_ambiguous_mark_failed', {
          ...scope, error: describeError(markErr),
        });
      }
    }
    log.error('report_delivery_ambiguous', {
      ...scope, stage: err?.sendStage ?? null, error: describeError(err),
    });
    return {
      result: DELIVERY_RESULT.AMBIGUOUS, messageId: null,
      error: describeError(err), authorized: true,
    };
  }

  // -------------------------------------------------------------------------
  // 3) 證明送達。這個極小的 UPDATE 才是防重發的關鍵證據 ——
  //    它比整筆 report_runs insert 更可能成功。
  // -------------------------------------------------------------------------
  // ---- ★ R2 / LIFE-FG-07：被啟用授權擋下 = **沒有送出** -------------------
  //
  // withDeliveryAuthorization 在帳號停用／換過啟用期時回一個標記結果而不是
  // 拋錯。舊版把它當成「成功但沒有 message_id」，於是 markClaimSent 會把這
  // 一天標成 DELIVERED —— 使用者重新啟用之後那天的晨報就再也發不出來了。
  //
  // 正確處置：把發送權還回去（確定沒送出，重來零風險），讓新的啟用期可以
  // 重新認領並真的送出。
  if (isSuppressedDelivery(sent)) {
    if (fenceable) await releaseAfterDefiniteFailure({ db, claimKey, owner, scope });
    log.info('report_delivery_suppressed_inactive', scope);
    return {
      result: DELIVERY_RESULT.SUPPRESSED_INACTIVE, messageId: null,
      error: null, authorized: true,
    };
  }

  const messageId = sent?.messageId ?? null;
  if (fenceable && typeof db.markClaimSent === 'function') {
    try {
      const marked = await db.markClaimSent({
        ...claimKey, owner, messageId, now: new Date(now()),
      });
      // 標記不成功不代表沒送到 —— 狀態留在 DELIVERY_STARTED（終局），
      // 所以仍然不會重送。大聲記下來讓人看得到。
      if (!marked) log.warn('report_claim_mark_noop', scope);
    } catch (err) {
      log.error('report_claim_mark_failed', { ...scope, error: describeError(err) });
    }
  }

  return {
    result: DELIVERY_RESULT.DELIVERED, messageId, error: null, authorized: true,
  };
}

/**
 * 明確失敗（還沒送出去）之後把發送權還回去。
 *
 * releaseClaim 只接受 delivery_state = CLAIMED 的列，而我們現在是
 * DELIVERY_STARTED，所以要先原子地退回去。退不回去就維持終局狀態 ——
 * 少發一次，不會多發一次。
 */
async function releaseAfterDefiniteFailure({ db, claimKey, owner, scope }) {
  if (typeof db.releaseClaimAfterFailedSend !== 'function') {
    log.warn('report_claim_release_unsupported', scope);
    return;
  }
  try {
    const released = await db.releaseClaimAfterFailedSend({ ...claimKey, owner });
    if (!released) log.warn('report_claim_release_noop', scope);
  } catch (err) {
    log.warn('report_claim_release_failed', { ...scope, error: describeError(err) });
  }
}
