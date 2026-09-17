/**
 * 運維腳本共用的使用者選擇邏輯。
 */
import { USER_STATUS } from '../src/schema.js';

/**
 * 運維腳本的使用者選擇。
 *   --user=<id> 指定；沒帶時若系統只有一個 ACTIVE 使用者就用它，
 *   有多個就要求明確指定（絕不預設挑第一個）。
 *
 * ## ★ R2 / LIFE-FG-03：`--user=<id>` 不再是繞過帳號生命週期的後門
 *
 * 舊版的 `--user=` 分支只做 `getUser()` —— 於是手動同步、盤點、對帳這三支
 * 正式的健康處理腳本都可以對一個被停用的帳號做完整的健康工作，而且不留
 * 任何痕跡。那不是「運維方便」，那是把停用降級成一個建議。
 *
 * 現在預設**只選 ACTIVE**，而且回傳值帶著啟用世代，呼叫端必須把它往下傳。
 * 真的要對停用帳號做資料修復時，必須明確寫出 `--allow-inactive` ——
 * 那是一個看得見的決定，而且那條路不可以產生 READY 證據或使用者可見的
 * 健康結論（見各腳本的說明）。
 *
 * @returns {object} user，含 lifecycleGeneration
 */
export async function pickUser(db, argv = process.argv.slice(2)) {
  const eq = argv.find((a) => a.startsWith('--user='));
  const i = argv.indexOf('--user');
  const explicit = eq ? eq.slice(7) : (i >= 0 ? argv[i + 1] : null);
  const allowInactive = argv.includes('--allow-inactive');

  const gate = (u) => {
    if (u.status !== USER_STATUS.ACTIVE && !allowInactive) {
      throw new Error(
        `使用者 ${u.id} 的狀態是 ${u.status}（非 ACTIVE）。`
        + '正式的健康處理不對停用帳號執行；確定要做資料修復請加 --allow-inactive。',
      );
    }
    return u;
  };

  if (explicit) {
    const u = await db.getUser(explicit);
    if (!u) throw new Error(`找不到使用者：${explicit}`);
    return gate(u);
  }
  const all = await db.listActiveUsers();
  if (all.length === 0) throw new Error('系統裡還沒有任何 ACTIVE 使用者');
  if (all.length > 1) {
    throw new Error(
      `有 ${all.length} 個 ACTIVE 使用者，請用 --user=<id> 明確指定：\n`
      + all.map((u) => `  ${u.id}  ${u.displayName}  ${u.timezone}`).join('\n'),
    );
  }
  return gate(all[0]);
}

/**
 * 這一輪腳本要用的啟用脈絡。
 *
 * ACTIVE 使用者 → 捕捉到的啟用世代（受約束）。
 * 明確的 `--allow-inactive` 整備模式 → LIFECYCLE_UNFENCED（看得見的例外）。
 */
export function lifecycleContextFor(user, argv = process.argv.slice(2)) {
  if (user.status === USER_STATUS.ACTIVE && Number.isInteger(user.lifecycleGeneration)) {
    return user.lifecycleGeneration;
  }
  if (argv.includes('--allow-inactive')) return 'LIFECYCLE_UNFENCED_ADMIN';
  throw new Error(`使用者 ${user.id} 沒有可用的啟用脈絡（狀態 ${user.status}）`);
}
