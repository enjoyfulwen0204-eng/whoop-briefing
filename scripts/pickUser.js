/**
 * 運維腳本共用的使用者選擇邏輯。
 */
/**
 * 運維腳本的使用者選擇。
 *   --user=<id> 指定；沒帶時若系統只有一個 ACTIVE 使用者就用它，
 *   有多個就要求明確指定（絕不預設挑第一個）。
 */
export async function pickUser(db, argv = process.argv.slice(2)) {
  const eq = argv.find((a) => a.startsWith('--user='));
  const i = argv.indexOf('--user');
  const explicit = eq ? eq.slice(7) : (i >= 0 ? argv[i + 1] : null);

  if (explicit) {
    const u = await db.getUser(explicit);
    if (!u) throw new Error(`找不到使用者：${explicit}`);
    return u;
  }
  const all = await db.listActiveUsers();
  if (all.length === 0) throw new Error('系統裡還沒有任何 ACTIVE 使用者');
  if (all.length > 1) {
    throw new Error(
      `有 ${all.length} 個 ACTIVE 使用者，請用 --user=<id> 明確指定：\n`
      + all.map((u) => `  ${u.id}  ${u.displayName}  ${u.timezone}`).join('\n'),
    );
  }
  return all[0];
}
