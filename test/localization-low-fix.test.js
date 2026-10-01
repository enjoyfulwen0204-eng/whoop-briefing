import test from 'node:test';
import assert from 'node:assert/strict';
import { deliverPublicBetaSummary } from '../src/publicBetaSummaryDelivery.js';

test('async-null Beta presentation returns typed no-current-summary and never sends', async () => {
  let sends = 0;
  const result = await deliverPublicBetaSummary({
    db: { getLocale: async () => 'en' }, user: { id: 'alice' }, env: {},
    presentation: { eligible: () => true, withCurrentSummary: async () => {
      await Promise.resolve();
      return null;
    } },
    makeTelegram: () => ({ send: async () => { sends++; } }),
  });
  assert.deepEqual(result, { status: 'no_current_summary' });
  assert.equal(sends, 0);
});
