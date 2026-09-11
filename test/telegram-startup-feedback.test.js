import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDb } from '../src/db.js';
import { createSendReply } from '../src/bot/index.js';
import { createTelegramApi } from '../src/bot/api.js';
import { createUpdateProcessor, UPDATE_OUTCOME } from '../src/bot/updateProcessor.js';

const NOW = new Date('2026-09-11T10:00:30.000Z');
const update = (id, text = '我的 HRV 是多少？') => ({
  update_id: id,
  message: {
    message_id: id,
    chat: { id: 5001, type: 'private' },
    from: { id: 5001, is_bot: false },
    text,
  },
});

async function fixture({ typingFails = false, handleMessage } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-startup-'));
  const db = createDb({ url: `file:${path.join(dir, 'test.db')}` });
  await db.migrate();
  const user = await db.createUser({ displayName: 'Kelvin', timezone: 'Asia/Taipei' });
  await db.linkTelegram({ chatId: '5001', userId: user.id });
  const typing = [];
  const replies = [];
  const activeTimers = new Set();
  const setIntervalImpl = (fn) => {
    const timer = { fn, unref() {} };
    activeTimers.add(timer);
    return timer;
  };
  const clearIntervalImpl = (timer) => activeTimers.delete(timer);
  const processor = createUpdateProcessor({
    db,
    resolveUser: (chatId) => db.resolveUserByChatId(chatId),
    handleMessage: handleMessage ?? (async () => '正常答案'),
    sendReply: createSendReply({
      db,
      api: { async sendMessage(chatId, text) { replies.push({ chatId, text }); return { message_id: replies.length }; } },
    }),
    sendTyping: async (event) => {
      typing.push(event);
      if (typingFails) throw new Error('typing unavailable');
    },
    now: () => NOW,
    processStartedAtMs: NOW.getTime() - 30_000,
    setIntervalImpl,
    clearIntervalImpl,
    workerId: 'startup-test',
  });
  return {
    db, processor, typing, replies, activeTimers,
    cleanup() { db.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

test('fresh process marks only the first natural-language update as startup and still replies', async () => {
  const f = await fixture();
  try {
    const first = await f.processor.processUpdate(update(1));
    const second = await f.processor.processUpdate(update(2, '今天狀態怎樣'));
    assert.equal(first.outcome, UPDATE_OUTCOME.PROCESSED);
    assert.equal(second.outcome, UPDATE_OUTCOME.PROCESSED);
    assert.deepEqual(f.typing.map((x) => x.startup), [true, false]);
    assert.deepEqual(f.replies.map((x) => x.text), ['正常答案', '正常答案']);
    assert.equal(f.activeTimers.size, 0);
  } finally { f.cleanup(); }
});

test('a newly constructed process state is startup-eligible again', async () => {
  const a = await fixture();
  const b = await fixture();
  try {
    await a.processor.processUpdate(update(10));
    await b.processor.processUpdate(update(20));
    assert.equal(a.typing[0].startup, true);
    assert.equal(b.typing[0].startup, true);
  } finally { a.cleanup(); b.cleanup(); }
});

test('typing failure is non-fatal and final durable reply still succeeds', async () => {
  const f = await fixture({ typingFails: true });
  try {
    const result = await f.processor.processUpdate(update(30));
    assert.equal(result.outcome, UPDATE_OUTCOME.PROCESSED);
    assert.equal(result.replied, true);
    assert.equal(f.replies.length, 1);
    assert.equal(f.activeTimers.size, 0);
  } finally { f.cleanup(); }
});

test('commands do not receive typing or consume first natural-language startup eligibility', async () => {
  const f = await fixture();
  try {
    await f.processor.processUpdate(update(40, '/help'));
    await f.processor.processUpdate(update(41, '我的 HRV 是多少？'));
    assert.equal(f.typing.length, 1);
    assert.equal(f.typing[0].startup, true);
    assert.equal(f.replies.length, 2);
  } finally { f.cleanup(); }
});

test('processing error always clears the typing timer', async () => {
  const f = await fixture({ handleMessage: async () => { throw new Error('boom'); } });
  try {
    const result = await f.processor.processUpdate(update(50));
    assert.equal(result.outcome, UPDATE_OUTCOME.RETRY);
    assert.equal(f.replies.length, 0);
    assert.equal(f.activeTimers.size, 0);
  } finally { f.cleanup(); }
});

test('duplicate replay does not emit typing or duplicate the final reply', async () => {
  const f = await fixture();
  try {
    await f.processor.processUpdate(update(60));
    const replay = await f.processor.processUpdate(update(60));
    assert.equal(replay.outcome, UPDATE_OUTCOME.REPLAYED);
    assert.equal(f.typing.length, 1);
    assert.equal(f.replies.length, 1);
  } finally { f.cleanup(); }
});

test('slow processing refreshes typing and cleanup waits for the active refresh', async () => {
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const f = await fixture({ handleMessage: async () => pending });
  try {
    const processing = f.processor.processUpdate(update(70));
    while (f.activeTimers.size === 0) await new Promise((resolve) => setImmediate(resolve));
    const [timer] = f.activeTimers;
    timer.fn();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.typing.length, 2, 'one immediate action plus one refresh');
    finish('慢查詢的正常答案');
    const result = await processing;
    assert.equal(result.outcome, UPDATE_OUTCOME.PROCESSED);
    assert.equal(f.activeTimers.size, 0);
    assert.deepEqual(f.replies.map((x) => x.text), ['慢查詢的正常答案']);
  } finally { f.cleanup(); }
});

test('typing path cannot let N+1 overtake N in the same conversation', async () => {
  let finishN;
  const pendingN = new Promise((resolve) => { finishN = resolve; });
  const f = await fixture({
    handleMessage: async ({ text }) => text === 'N' ? pendingN : text,
  });
  try {
    const first = f.processor.processUpdate(update(80, 'N'));
    while (f.typing.length === 0) await new Promise((resolve) => setImmediate(resolve));
    const blocked = await f.processor.processUpdate(update(81, 'N+1'));
    assert.equal(blocked.outcome, UPDATE_OUTCOME.RETRY);
    assert.equal(f.replies.length, 0);
    finishN('N');
    assert.equal((await first).outcome, UPDATE_OUTCOME.PROCESSED);
    assert.deepEqual(f.replies.map((x) => x.text), ['N']);
    assert.equal(f.typing.length, 1, 'blocked N+1 never starts a parallel feedback path');
  } finally { f.cleanup(); }
});

test('Telegram API sends an ephemeral typing action with a short timeout path', async () => {
  const calls = [];
  const api = createTelegramApi({
    botToken: 'test-only',
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return { ok: true, async text() { return '{"ok":true,"result":true}'; } };
    },
  });
  await api.sendChatAction('5001');
  assert.match(calls[0].url, /\/sendChatAction$/);
  assert.deepEqual(calls[0].body, { chat_id: '5001', action: 'typing' });
});
