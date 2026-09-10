/**
 * 敘述再稽核：**每一條**會把文字送到使用者面前的路徑（R3-H-02）。
 *
 * 系統有四條發布路徑。R3 之後它們共用同一個架構：
 *
 *   daily      renderDaily()  確定性報告 + 選配教練文字（guardExplanation）
 *   weekly     renderWeekly() 確定性報告 + 選配教練文字（guardExplanation）
 *   Q&A        renderAssertions() 確定性斷言 + 選配說明（guardExplanation）
 *   proactive  確定性樣板（**沒有 LLM**）+ validateDeterministicMessage 深度防禦
 *
 * 這個檔案問的是：同一組攻擊，在**每一條**路徑上是不是都擋得住，
 * 而且正常的鼓勵話語在每一條路徑上都留得住。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { guardExplanation, validateDeterministicMessage } from '../src/publishGuard.js';
import { guardProactiveMessage } from '../src/proactiveMessages.js';

/**
 * 四條路徑對「LLM 產生的文字」的處置。
 *
 * proactive 沒有 LLM，所以它的「LLM 片段」在結構上不存在 —— 這裡用
 * 深度防禦檢查代表它，並在下面單獨驗證「這條路徑真的沒有呼叫 coach」。
 */
const EXPLANATION_PATHS = [
  { name: 'daily', run: (t) => guardExplanation(t, { label: 'daily' }) },
  { name: 'weekly', run: (t) => guardExplanation(t, { label: 'weekly' }) },
  { name: 'qa', run: (t) => guardExplanation(t, { label: 'qa' }) },
];

const MUST_DISCARD = [
  ['1  Recovery 55 → 99', '你今天的恢復是 99%。'],
  ['2  Recovery 55 → 30', '恢復為 30%。'],
  ['3  睡眠 99 挪給恢復', '恢復。今天的數值是 99%。'],
  ['5  HRV 無資料 → 30ms', '你的 HRV 是 30ms。'],
  ['6  HRV 九九毫秒', 'HRV 九九毫秒。'],
  ['7  未支援的方向', '你的 HRV 偏高。'],
  ['9  中文數字', '恢復是三十%。'],
  ['10 英文數字', 'Recovery is thirty percent.'],
  ['11 指標同義詞', '你的恢復度是 30%。'],
  ['13 數字在前', '30% 是今天的恢復。'],
  ['16 WHOOP Age', 'WHOOP 的年齡是三十歲。'],
  ['18 Healthspan', 'WHOOP Healthspan 分數 88。'],
  ['20 aspirin', '服用阿斯匹靈。'],
  ['22 虛構藥名', 'Take Zorblax every night.'],
  ['24 治療祈使', '去打一針。'],
  ['25 診斷語言', '你有睡眠呼吸中止。'],
  ['26 監測指示', '每小時量一次血壓。'],
  ['27 九成九', '恢復九成九。'],
];

const MUST_KEEP = [
  ['鼓勵', '早安 Kelvin，今天整體看起來穩定，照平常節奏走就好，記得多補水 💛'],
  ['早睡', '今天可以早點睡，讓身體多一點修復時間。'],
  ['減量', '訓練量稍微降一點，明天再加回來就好。'],
  ['就醫提醒', '如果你覺得不舒服，還是找醫師看一下比較安心。'],
  ['資料不足', '資料還不夠多，這只是初步觀察，我會繼續留意。'],
  ['慣用語', '一起加油，第一次看到這個規律，十分穩定。'],
];

for (const [name, text] of MUST_DISCARD) {
  for (const p of EXPLANATION_PATHS) {
    test(`★★★ 敘述再稽核[${p.name}]: 丟掉「${name}」`, () => {
      const g = p.run(text);
      assert.equal(g.used, 'discarded', `★ ${p.name} 放行了：${text}`);
      assert.equal(g.text, null, '★ 原文一個字都不可以留下');
    });
  }
}

for (const [name, text] of MUST_KEEP) {
  for (const p of EXPLANATION_PATHS) {
    test(`★★ 敘述再稽核[${p.name}] false positive: 保留「${name}」`, () => {
      const g = p.run(text);
      assert.equal(g.used, 'llm', `★ ${p.name} 誤擋了：${g.violations.join()}`);
      assert.equal(g.text, text);
    });
  }
}

// ===========================================================================
// proactive：結構上就沒有 LLM
// ===========================================================================

test('★★★ 敘述再稽核[proactive]: 這條路徑沒有任何 LLM 呼叫（原始碼層級）', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync('src/proactiveAgent.js', 'utf8');
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
  assert.ok(!/coach/i.test(code),
    '★ proactiveAgent 一旦開始呼叫 LLM，這個檔案的前提就不成立了');
});

test('★★★ 敘述再稽核[proactive]: 確定性樣板可以含指標與數字', () => {
  const good = '留意一下：你的 HRV 最近持續偏低，不是單一天的雜訊。';
  const r = guardProactiveMessage(good, { label: 'test' });
  assert.equal(r.text, good, `★ 樣板輸出被誤擋：${r.violations.join()}`);
});

for (const [name, text] of [
  ['治療', '建議你吃一顆阿斯匹靈。'],
  ['虛構藥名', 'You should take Zorblax.'],
  ['診斷', '你可能得了自律神經失調。'],
  ['強因果', '熬夜導致你的恢復下降。'],
  ['即時宣稱', '你現在的心率偏高。'],
  ['監測指示', '每小時量一次血壓。'],
  ['專有分數', '你的 WHOOP Age 是 30 歲。'],
]) {
  test(`★★★ 敘述再稽核[proactive] 深度防禦: 擋下「${name}」`, () => {
    const r = guardProactiveMessage(text, { label: 'test' });
    assert.notEqual(r.text, text, `★ 放行了：${text}`);
    assert.ok(r.violations.length > 0);
    assert.equal(validateDeterministicMessage(text).ok, false);
  });
}
