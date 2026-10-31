import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { emergencyKeywordHit } from '../src/bot/emergencyKeywords.js';
import { urgentReply } from '../src/bot/triage.js';
import { createRouter } from '../src/bot/router.js';
import { createUpdateProcessor } from '../src/bot/updateProcessor.js';
import { createWebhookHandler } from '../src/bot/webhook.js';
import { createPoller } from '../src/bot/polling.js';
import { TELEGRAM_BOT } from '../src/config.js';

const positive = [
  '我胸痛', '我不是没有胸痛', '我不再胸痛了', '呼吸困难',
  'tôi bị khó thở', 'kho tho qua', 'I have chest pain', 'I CAN’T BREATHE',
];
const keywords = [
  '胸痛', '胸口痛', '胸悶', '呼吸困難', '喘不過氣', '昏倒', '暈倒',
  '失去意識', '中風', '半邊麻', '說話不清楚', '胸闷', '呼吸困难',
  '喘不过气', '晕倒', '失去意识', '中风', '半边麻', '说话不清楚',
  'đau ngực', 'tức ngực', 'khó thở', 'ngất', 'bất tỉnh', 'đột quỵ',
  'dau nguc', 'tuc nguc', 'kho tho', 'ngat', 'bat tinh', 'dot quy',
  'chest pain', "can't breathe", 'can’t breathe', 'cant breathe', 'cannot breathe',
  'shortness of breath', 'fainted', 'passed out', 'stroke',
];
for (const text of positive) test(`required warning: ${text}`, () => assert.equal(emergencyKeywordHit(text), true));
for (const text of ['我昨晚睡得怎樣', '今天 Recovery 多少', 'what was my HRV']) {
  test(`no keyword: ${text}`, () => assert.equal(emergencyKeywordHit(text), false));
}
test('all listed substrings, case and Unicode canonical forms warn even in quoted/negated context', () => {
  for (const word of keywords) {
    for (const text of [word, word.toUpperCase(), word.normalize('NFD'), `not "${word}" any more`]) {
      assert.equal(emergencyKeywordHit(text), true, word);
    }
  }
});
test('non-text inputs and empty text do not match', () => {
  for (const value of [null, undefined, 0, {}, '', []]) assert.equal(emergencyKeywordHit(value), false);
});
const messages = {
  'zh-TW': '⚠️ 你提到的症狀可能需要立刻處理。請馬上就醫，或撥打急救電話：台灣 119、越南 115。我沒辦法判斷是不是緊急狀況，請不要等。',
  vi: '⚠️ Triệu chứng bạn nhắc đến có thể cần được xử lý ngay. Hãy đi khám ngay hoặc gọi cấp cứu: Việt Nam 115, Đài Loan 119. Tôi không thể đánh giá đây có phải tình huống khẩn cấp hay không, xin đừng chờ đợi.',
  en: "⚠️ The symptom you mentioned may need immediate attention. Please seek medical care now or call emergency services: Taiwan 119, Vietnam 115. I can't tell whether this is an emergency, so please don't wait.",
};
const user = { id: 'synthetic-s1', timezone: 'Asia/Taipei', lifecycleGeneration: 1 };
for (const locale of Object.keys(messages)) test(`router: exact ${locale} reply before any provider, Journal or follow-up access`, async () => {
  assert.equal(urgentReply(locale), messages[locale]);
  const reads = [];
  const db = new Proxy({ getLocale: async () => locale }, {
    get(target, key) { reads.push(key); if (key in target) return target[key]; throw Error(`unexpected business access: ${String(key)}`); },
  });
  const router = createRouter({ db, coachFor: () => assert.fail('LLM/provider must not be created'),
    journalFollowUp: () => assert.fail('follow-up must not consume emergency') });
  for (const text of [...positive, '我沒有胸痛', 'chest pain usually means what?', '記錄：我不是没有胸痛，今天 HRV 多少？']) {
    assert.equal(await router.handle({ text, chatId: '123', user }), messages[locale]);
  }
  assert.ok(reads.every(key => key === 'getLocale'));
});

const update = text => ({ update_id: 100, message: {
  message_id: 100, date: 1, chat: { id: 123, type: 'private' }, from: { id: 123, is_bot: false }, text,
} });
for (const transport of ['webhook', 'polling']) {
  for (const pending of ['settings-name', 'journal-note-confirm', 'follow-up-answer']) {
    test(`${transport}: keyword warning precedes ${pending}; one reply, zero business writes/reads`, async () => {
      for (const text of positive) {
        const state = { pending, value: 'original', generation: 1 };
        const before = structuredClone(state), calls = [], sent = [];
        const forbid = name => async () => { calls.push(name); state.value = 'changed'; throw Error(name); };
        // Only transport ownership/receipt bookkeeping and locale access are allowed.
        const db = {
          getLocale: async () => 'en', assertAccountActive: async () => {},
          claimTelegramUpdate: async () => ({ state: 'claimed' }),
          markTelegramUpdateProcessing: async () => true,
          completeTelegramUpdate: async () => true,
          getUpdateOffset: async () => 0, setUpdateOffset: async () => {},
        };
        const options = { db, resolveUser: async () => ({ user }),
          authenticatedIdentity: forbid('identity mutation'),
          phase4JournalControl: forbid('Journal control'),
          stage7Inbound: forbid('Journal note'), stage7Reply: forbid('Journal reply'),
          handleMessage: forbid('Settings/Coach/follow-up/scoped read'),
          sendReply: async result => { sent.push(result.reply); return { sent: true, messageId: 101 }; },
        };
        if (transport === 'webhook') {
          const processor = createUpdateProcessor(options);
          const handler = createWebhookHandler({ processUpdate: processor.processUpdate, secret: 'synthetic-s1-only' });
          const req = Readable.from([Buffer.from(JSON.stringify(update(text)))]);
          Object.assign(req, { url: TELEGRAM_BOT.WEBHOOK_PATH, method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'synthetic-s1-only' } });
          let status;
          await handler(req, { writeHead: code => { status = code; }, end: () => {} });
          assert.equal(status, 200);
        } else {
          const poller = createPoller({ ...options, api: { getUpdates: async () => [update(text)] } });
          assert.equal((await poller.pollOnce()).offset, 101);
        }
        assert.deepEqual(sent, [{ text: messages.en }]);
        assert.deepEqual(calls, []);
        assert.deepEqual(state, before);
      }
    });
  }
}
test('unlinked text cannot bypass safety into onboarding/link writes', async () => {
  const sent = [];
  const processor = createUpdateProcessor({ db: {}, resolveUser: async () => null,
    handleUnlinked: async () => assert.fail('onboarding must not run'),
    sendReply: async result => { sent.push(result.reply); return { sent: true }; } });
  assert.equal((await processor.processUpdate(update('我不是没有胸痛'))).outcome, 'processed');
  assert.deepEqual(sent, [{ text: messages.en }]);
});
test('identity rejection still precedes emergency replies', async () => {
  const processor = createUpdateProcessor({ db: {}, resolveUser: async () => assert.fail('unauthenticated identity'),
    sendReply: async () => assert.fail('no reply to forged chat') });
  const forged = update('chest pain'); forged.message.from.id = 456;
  assert.equal((await processor.processUpdate(forged)).outcome, 'ignored');
});
