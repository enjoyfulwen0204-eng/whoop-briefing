import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNotifyMessage, guardProactiveMessage } from '../src/proactiveMessages.js';
import { buildQuestionText } from '../src/questionEngine.js';
import { renderFinding } from '../src/guardian.js';
import { GUARDIAN_SIGNAL } from '../src/guardianPolicy.js';

test('proactive notices, questions, and guardian alerts use each target locale', () => {
  const signal = { metric:'rhr', direction:'high', level:'STRONG', health_date:'2026-09-19' };
  const guardian = { scope:'user:alice', signal:GUARDIAN_SIGNAL.WHOOP_SYNC_STALE,
    detail:{ age_hours:48 }, summary:'SHOULD_NOT_LEAK' };
  for (const [locale, markers] of [
    ['zh-TW', [/靜息心率/, /昨天有喝酒嗎/, /小時沒有成功同步/]],
    ['en', [/Resting heart rate/, /Did you drink alcohol yesterday/, /has not synced successfully/]],
    ['vi', [/Nhịp tim nghỉ/, /Hôm qua bạn có uống rượu bia không/, /chưa đồng bộ thành công/]],
  ]) {
    const notify = buildNotifyMessage(signal, locale);
    const question = buildQuestionText({ category:'alcohol', signal, locale });
    const alert = renderFinding(guardian, locale);
    assert.match(notify, markers[0]);
    assert.match(question, markers[1]);
    assert.match(alert, markers[2]);
    assert.doesNotMatch(alert, /SHOULD_NOT_LEAK/);
    assert.equal(guardProactiveMessage(notify, {locale}).text, notify);
    if (locale !== 'zh-TW') for (const text of [notify,question,alert])
      assert.doesNotMatch(text, /[\u3400-\u9fff]/u);
  }
});
