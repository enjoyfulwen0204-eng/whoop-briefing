import test from 'node:test';
import assert from 'node:assert/strict';
import { BRIEFING_STATUS, renderBriefingStatus } from '../src/briefingStatus.js';

test('briefing typed states retain scheduler evidence and render in each locale', () => {
  const evidence = { scheduler_stale:true, scheduler_age_ms:4*3_600_000,
    scheduler_state:'outage', cycle_open:true };
  for (const [locale, marker] of [
    ['zh-TW',/排程/], ['en',/scheduled check/], ['vi',/lịch kiểm tra/],
  ]) {
    for (const status of Object.values(BRIEFING_STATUS)) {
      const reply = renderBriefingStatus({ status, evidence, locale });
      assert.ok(reply.length > 10);
      if (locale !== 'zh-TW') assert.doesNotMatch(reply, /[\u3400-\u9fff]/u);
    }
    assert.match(renderBriefingStatus({ status:BRIEFING_STATUS.SCHEDULER_STALE,
      evidence, locale }), marker);
  }
});
