import test from 'node:test';
import assert from 'node:assert/strict';
import { renderAssertions, assemblePublication } from '../src/assertionRenderer.js';
import { FACT_ROLE } from '../src/publishableFacts.js';

test('the same approved assertion facts render independently in three locales', () => {
  const factSet = { facts: [
    { factId:'a', metric:'recovery', role:FACT_ROLE.CURRENT_VALUE, display:'58%', publishable:true },
    { factId:'b', metric:'hrv', role:FACT_ROLE.BASELINE, display:'42 ms', publishable:true },
  ] };
  const expected = { 'zh-TW':'恢復 58%', en:'Recovery: 58%', vi:'Phục hồi: 58%' };
  for (const locale of ['zh-TW','en','vi']) {
    const result = renderAssertions(factSet, locale);
    assert.equal(result.factIds.join(','), 'a,b');
    const payload = assemblePublication({ assertionLines:result.lines, locale });
    assert.ok(payload.includes(expected[locale]));
    if (locale !== 'zh-TW') assert.doesNotMatch(payload, /[\u3400-\u9fff]/u);
  }
});
