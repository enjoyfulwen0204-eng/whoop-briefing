/**
 * 極小的有界併發 helper。
 *
 * 刻意不引入 p-limit 這類依賴：整個專案的 runtime 依賴只有 @libsql/client，
 * 而這裡需要的行為只有「同時最多 n 個、每個獨立成敗、絕不互相影響」。
 */

/**
 * 對 items 逐一執行 fn，同時最多 limit 個。
 *
 * **失敗隔離是重點**：任何一個 item 拋錯都被個別捕捉，其他 item 照跑到完，
 * 回傳值保留原本順序，成敗都明確標示。永遠不會因為一個人失敗而中斷整批。
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} limit 同時最多幾個（<1 視為 1）
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<Array<{ok: true, value: R} | {ok: false, error: unknown}>>}
 */
export async function mapWithConcurrency(items, limit, fn) {
  const list = Array.from(items ?? []);
  const max = Math.max(1, Math.floor(limit) || 1);
  const results = new Array(list.length);
  let next = 0;

  async function worker() {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= list.length) return;
      try {
        results[i] = { ok: true, value: await fn(list[i], i) };
      } catch (error) {
        // 個別捕捉：一個人失敗絕不影響其他人
        results[i] = { ok: false, error };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(max, list.length) }, worker));
  return results;
}
