/**
 * 已知 bug 的回歸測試（audit 編號 R5 / R6）。
 *
 * 這個檔案先於修正被寫出來：每一個 test 都描述「正確的行為應該是什麼」，
 * 在修 code 之前跑會失敗。修好之後永久留著防止回歸。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { weekOverWeek } from '../src/analyze.js';
import { clamp, safeSlice } from '../src/format.js';
import { TELEGRAM_MAX_CHARS } from '../src/config.js';

// ---------------------------------------------------------------------------
// R5：前週平均為 0 時，direction 不可誤判成 'flat'
// ---------------------------------------------------------------------------

/** 造一個 weeklyStats 形狀的最小物件（只有 weekOverWeek 會用到的欄位）。 */
function week(averages) {
  const out = {};
  for (const [key, mean] of Object.entries(averages)) {
    out[key] = { mean, n: mean === null ? 0 : 7, display: String(mean), label: key };
  }
  return { averages: out };
}

test('R5：前週睡眠債為 0、上週有 40 分鐘 → 不可回 flat', () => {
  const last = week({ sleep_debt: 40 * 60_000 });
  const prev = week({ sleep_debt: 0 });
  const wow = weekOverWeek(last, prev);

  assert.equal(wow.sleep_debt.delta, 40 * 60_000, 'delta 要算得出來');
  assert.equal(wow.sleep_debt.pct, null, '除以 0 不能算百分比，維持 null');
  assert.equal(
    wow.sleep_debt.direction, 'up',
    '前週是 0、上週是 40 分鐘，明明變差了，不可以說「差不多」',
  );
});

test('R5：前週為 0、上週也是 0 → 這才是真的 flat', () => {
  const wow = weekOverWeek(week({ sleep_debt: 0 }), week({ sleep_debt: 0 }));
  assert.equal(wow.sleep_debt.delta, 0);
  assert.equal(wow.sleep_debt.pct, null);
  assert.equal(wow.sleep_debt.direction, 'flat');
});

test('R5：前週為 0、上週下降（負 delta）→ down', () => {
  const wow = weekOverWeek(week({ recovery_score: -5 }), week({ recovery_score: 0 }));
  assert.equal(wow.recovery_score.direction, 'down');
});

test('R5：任一週缺資料仍然是 unknown（既有行為不可改變）', () => {
  const wow = weekOverWeek(week({ hrv: 55 }), week({ hrv: null }));
  assert.equal(wow.hrv.direction, 'unknown');
  assert.equal(wow.hrv.delta, null);
  assert.equal(wow.hrv.pct, null);
});

test('R5：正常情況（前週 > 0）行為完全不變', () => {
  const wow = weekOverWeek(week({ hrv: 55 }), week({ hrv: 50 }));
  assert.equal(wow.hrv.delta, 5);
  assert.ok(Math.abs(wow.hrv.pct - 10) < 1e-9);
  assert.equal(wow.hrv.direction, 'up');

  const flat = weekOverWeek(week({ hrv: 50.5 }), week({ hrv: 50 }));
  assert.equal(flat.hrv.direction, 'flat', '±2% 內仍然是 flat');
});

// ---------------------------------------------------------------------------
// R6：字串截斷不可切斷 emoji 的 surrogate pair
// ---------------------------------------------------------------------------

/** 有沒有落單的 surrogate（切壞 emoji 的徵兆）。 */
function hasLoneSurrogate(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

test('R6：clamp 剛好切在 emoji 中間時不可產生半個字元', () => {
  // 💪 是 surrogate pair（2 個 code unit）。鋪滿 emoji，讓每一個可能的
  // 截斷點都有機會落在 pair 中間。
  const text = '💪'.repeat(TELEGRAM_MAX_CHARS);
  const out = clamp(text);

  assert.ok(out.length <= TELEGRAM_MAX_CHARS, `長度 ${out.length} 不可超過上限`);
  assert.ok(!hasLoneSurrogate(out), 'clamp 後不可出現落單的 surrogate');
  assert.ok(out.endsWith('...'), '仍然要有截斷標記');
});

test('R6：各種長度都不會切壞（掃過 pair 邊界的兩種對齊）', () => {
  for (const pad of [0, 1]) {
    const text = 'a'.repeat(pad) + '💪'.repeat(TELEGRAM_MAX_CHARS);
    const out = clamp(text);
    assert.ok(!hasLoneSurrogate(out), `pad=${pad} 時切壞了`);
    assert.ok(out.length <= TELEGRAM_MAX_CHARS);
  }
});

test('R6：safeSlice 不會切斷 surrogate pair，也不會留下懸空的 ZWJ', () => {
  assert.equal(typeof safeSlice, 'function', 'format.js 要 export safeSlice');

  // 切在 pair 中間 → 整個 emoji 被丟掉
  assert.equal(safeSlice('a💪b', 2), 'a');
  // 切在 pair 之後 → 完整保留
  assert.equal(safeSlice('a💪b', 3), 'a💪');
  // 純 ASCII 行為不變
  assert.equal(safeSlice('abcdef', 3), 'abc');
  // 邊界
  assert.equal(safeSlice('abc', 0), '');
  assert.equal(safeSlice('abc', 99), 'abc');

  // ZWJ 組合字（👩‍💻 = 👩 + ZWJ + 💻）切在 ZWJ 之後 → 不可留下懸空 ZWJ
  const zwj = '👩‍💻';
  const cut = safeSlice(zwj, 3); // 👩(2) + ZWJ(1)
  assert.ok(!cut.endsWith('‍'), '不可以用 ZWJ 結尾');
  assert.ok(!hasLoneSurrogate(cut));
});

test('R6：沒超過上限時 clamp 原封不動回傳（既有行為不可改變）', () => {
  const short = '早安 Kelvin 💪';
  assert.equal(clamp(short), short);
  assert.equal(clamp('a'.repeat(TELEGRAM_MAX_CHARS)).length, TELEGRAM_MAX_CHARS);
});
