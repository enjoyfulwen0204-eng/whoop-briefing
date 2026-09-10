import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDb } from '../src/db.js';
import { createRouter } from '../src/bot/router.js';
import { createPoller } from '../src/bot/polling.js';
import { composeAnswer } from '../src/bot/answer.js';
import { runDaily } from '../src/daily.js';
import { runWeekly } from '../src/weekly.js';
import { staticDataSource } from '../src/dataSource.js';
import { makeDataset } from './fixtures.js';
import { fakeDb, fakeTelegram } from './fakes.js';
import { PROACTIVE_QUESTION_INTENT } from '../src/schema.js';
import { PROACTIVE_PROCESSING_LEASE as LEASE } from '../src/proactivePolicy.js';
import { reapExpiredProactiveQuestions as reap } from '../src/proactiveReaper.js';

const AT = new Date('2026-02-06T10:00:00Z');
async function setup(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'production-cut-'));
  const url = `file:${path.join(dir, 'test.db')}`;
  const db = createDb({ url });
  try {
    await db.migrate();
    for (const id of ['alice', 'bob']) await db.createUser({ id, displayName: id, timezone: 'UTC' });
    await fn(db, url);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}
const journals = (db, id = 'alice') => db.getJournalEvents(id, { from: '2026-02-01', to: '2026-02-10' });
const journal = (db) => db.addJournalEvent('alice', { healthDate: '2026-02-05', eventAt: AT.toISOString(), category: 'alcohol', numericValue: 2 });
const parsed = { category: 'alcohol', numeric_value: 2, unit: 'drinks', day_offset: 0, date_explicit: false, confidence: .95 };
async function question(db) {
  const e = await db.claimProactiveEvent('alice', { healthDate: '2026-02-06', idempotencyKey: 'q', signals: [], decision: 'ASK_CONTEXT', policyVersion: 'test' }, { now: AT });
  const q = await db.openPendingQuestion('alice', { chatId: '1001', question: '昨天有喝酒嗎？', intent: PROACTIVE_QUESTION_INTENT, contextJson: { proactive_event_id: e.id, question_target_date: '2026-02-05', health_date: '2026-02-06', category: 'alcohol' }, ttlMs: 86400000 }, { now: AT });
  await db.markProactiveEventSent('alice', e.id, { pendingQuestionId: q }, { now: AT });
  return { e, q };
}
const attacks = ['你有心臟病。', '你的脈搏偏快。', '你的血壓偏高。', '你的脈搏為９９bpm。', '建議你每天服用阿斯匹靈。', '晚餐後吃 Zorblax。', 'WHOOP 顯示你的生物年紀很年輕。', '', null, undefined, '  ', {}, 42];
for (const attack of attacks) test(`production health output never consumes provider prose: ${JSON.stringify(attack)}`, async () => {
  let calls = 0;
  const emit = async () => { calls++; return attack; };
  const coach = { ask: emit, daily: emit, weekly: emit };
  const result = { available: true, intent: 'today_status', health_date: '2026-02-06', metrics: { recovery: { value: 55, display: '55%' }, sleep_performance: { value: 99, display: '99%' } } };
  const qa = await composeAnswer({ question: 'HRV 999?', result, coach });
  assert.match(qa, /恢復 55%/); assert.match(qa, /睡眠表現 99%/);
  for (const run of [runDaily, runWeekly]) {
    const data = makeDataset({ days: 45, now: new Date('2026-08-24T00:00:00Z') });
    const telegram = fakeTelegram();
    await run({ db: fakeDb(), userId: 'alice', coach, telegram, source: staticDataSource(data), timezone: 'UTC', now: data.now });
    assert.match(telegram.sent[0], /HRV/);
    if (typeof attack === 'string' && attack.trim()) assert.ok(!telegram.sent[0].includes(attack));
  }
  assert.equal(calls, 0);
});

for (const explicit of [false, true]) test(`ambiguous legacy reactive question date explicit=${explicit}`, () => setup(async db => {
  await db.openPendingQuestion('alice', { chatId: '1001', question: '昨天有喝酒嗎？', intent: 'today_status', contextJson: { health_date: '2026-02-06' }, ttlMs: 86400000 }, { now: AT });
  const router = createRouter({ db, now: () => AT, coachFor: () => ({ json: async () => ({ ...parsed, date_explicit: explicit }) }) });
  const reply = await router.handle({ text: explicit ? '今天喝了兩杯' : '喝了兩杯', chatId: '1001', user: await db.getUser('alice') });
  const rows = await journals(db);
  if (explicit) assert.equal(rows[0].health_date, '2026-02-06');
  else { assert.equal(rows.length, 0); assert.match(reply, /哪一天/); }
  assert.equal((await journals(db, 'bob')).length, 0);
}));

for (const loss of ['expiry', 'settled', 'clarification']) test(`answer parser resumes after ${loss}: no mutation`, () => setup(async db => {
  const { e, q } = await question(db); let clock = AT;
  const router = createRouter({ db, now: () => clock, coachFor: () => ({ json: async () => {
    if (loss === 'expiry') clock = new Date(+AT + LEASE.TTL_MS + 1);
    else {
      await db.resolveProactiveEventIfUnresolved('alice', e.id, 'ABANDONED', { now: clock });
      await db.raw.execute({ sql: 'DELETE FROM resource_locks WHERE name = ?', args: [LEASE.name('alice', e.id)] });
    }
    return loss === 'clarification' ? null : parsed;
  } }) });
  const reply = await router.handle({ text: '喝了兩杯', chatId: '1001', user: await db.getUser('alice') });
  assert.equal((await journals(db)).length, 0); assert.doesNotMatch(reply, /✅ 已記錄/);
  const pending = await db.raw.execute('SELECT id FROM pending_questions');
  assert.deepEqual(pending.rows.map(r => Number(r.id)), [q], 'no new clarification');
}));

for (const fault of ['expiry_before_commit', 'storage_error_swallowed', 'terminal_before_start']) test(`answer storage fence ${fault}`, () => setup(async db => {
  const { e } = await question(db); let clock = AT;
  const name = LEASE.name('alice', e.id), owner = await db.acquireLock(name, { ttlMs: LEASE.TTL_MS, now: clock });
  if (fault === 'terminal_before_start') await db.resolveProactiveEventIfUnresolved('alice', e.id, 'ABANDONED', { now: clock });
  await assert.rejects(db.withAnswerOwnership('alice', { name, owner, eventId: e.id }, () => clock, async () => {
    await journal(db);
    if (fault === 'expiry_before_commit') clock = new Date(+AT + LEASE.TTL_MS + 1);
    if (fault === 'storage_error_swallowed') { try { await db.raw.execute('INSERT INTO missing_table VALUES (1)'); } catch {} }
  }));
  assert.equal((await journals(db)).length, 0);
}));

test('answer transaction isolates two users and terminal event ownership', () => setup(async db => {
  const { e } = await question(db), name = LEASE.name('alice', e.id);
  const owner = await db.acquireLock(name, { ttlMs: 1000, now: AT });
  await assert.rejects(db.withAnswerOwnership('bob', { name, owner, eventId: e.id }, () => AT, () => journal(db)));
  assert.equal((await journals(db)).length, 0);
}));

const update = { update_id: 500, message: { chat: { id: 1001, type: 'private' }, from: { id: 1001, is_bot: false }, text: '/log alcohol 2' } };
for (const crash of ['claimed', 'processing', 'during_dispatch', 'after_commit', 'offset', 'outage']) test(`Telegram durable retry ${crash}`, () => setup(async (db, url) => {
  let clock = AT, fail = true, calls = 0;
  const poll = (store, worker) => createPoller({ db: store, workerId: worker, now: () => clock, sleepImpl: async () => {}, resolveUser: async () => db.getUser('alice'), api: { getUpdates: async () => [update] }, handleMessage: async () => {
    calls++;
    await journal(store);
    if (crash === 'during_dispatch' && fail) throw new Error('worker died after uncommitted insert');
    await store.raw.execute("UPDATE users SET display_name = display_name || '!' WHERE id = 'alice'");
    return 'recorded';
  } });
  if (crash === 'claimed' || crash === 'processing') {
    await db.claimTelegramUpdate(500, { owner: 'dead', leaseMs: 1000, now: clock });
    if (crash === 'processing') await db.markTelegramUpdateProcessing(500, { owner: 'dead', now: clock });
  } else {
    const broken = { ...db };
    if (crash === 'after_commit') broken.completeTelegramUpdate = async () => { throw new Error('lost completion'); };
    if (crash === 'offset') broken.setUpdateOffset = async () => { throw new Error('lost offset'); };
    if (crash === 'outage') broken.claimTelegramUpdate = async () => { throw new Error('DB down'); };
    await poll(broken, 'first').pollOnce();
    if (crash === 'outage' || crash === 'during_dispatch') assert.equal((await journals(db)).length, 0);
  }
  fail = false; clock = new Date(+AT + 3600000);
  const restarted = createDb({ url });
  try {
    await poll(restarted, 'restarted').pollOnce();
    await poll(restarted, 'duplicate').pollOnce();
    assert.equal((await journals(db)).length, 1);
    assert.equal((await db.getUser('alice')).displayName, 'alice!');
    assert.equal((await journals(db, 'bob')).length, 0);
    assert.equal((await db.getTelegramUpdate(500)).status, 'COMPLETED');
    assert.equal(await db.getUpdateOffset(), 501);
    if (crash === 'after_commit' || crash === 'offset') assert.equal(calls, 1);
  } finally { restarted.close(); }
}));

test('v6 additive migration preserves populated replay rows and operation receipt across restart', () => setup(async (db, url) => {
  await db.claimTelegramUpdate(500, { owner: 'a', now: AT });
  await db.markTelegramUpdateProcessing(500, { owner: 'a', now: AT });
  await db.processTelegramOperation(500, { owner: 'a', now: () => AT }, async () => { await journal(db); return { reply: 'saved' }; });
  await db.migrate(); await db.migrate();
  const restarted = createDb({ url });
  try {
    const result = await restarted.processTelegramOperation(500, { owner: 'a', now: () => AT }, async () => { throw new Error('must not replay'); });
    assert.deepEqual(result, { reply: 'saved' }); assert.equal((await journals(db)).length, 1);
  } finally { restarted.close(); }
}));

test('ambiguous operation commit response replays receipt without duplicate actions', () => setup(async db => {
  await db.claimTelegramUpdate(500, { owner: 'first', now: AT });
  await db.markTelegramUpdateProcessing(500, { owner: 'first', now: AT });
  const original = db.raw.transaction;
  let inject = true;
  db.raw.transaction = async (...args) => {
    const tx = await original(...args), commit = tx.commit.bind(tx);
    tx.commit = async () => { await commit(); if (inject) { inject = false; throw new Error('commit succeeded, response lost'); } };
    return tx;
  };
  await assert.rejects(db.processTelegramOperation(500, { owner: 'first', now: () => AT }, async () => {
    await journal(db); return { userId: 'alice', reply: 'saved' };
  }));
  db.raw.transaction = original;
  const later = new Date(+AT + 3600000);
  await db.claimTelegramUpdate(500, { owner: 'second', now: later });
  await db.markTelegramUpdateProcessing(500, { owner: 'second', now: later });
  const result = await db.processTelegramOperation(500, { owner: 'second', now: () => later }, async () => { throw new Error('duplicate action'); });
  assert.equal(result.userId, 'alice'); assert.equal((await journals(db)).length, 1);
}));

test('same update under another resolved user cannot rerun or redirect committed action', () => setup(async db => {
  let clock = AT, userId = 'alice';
  const replies = [];
  const make = store => createPoller({ db: store, now: () => clock, workerId: userId, sleepImpl: async () => {}, api: { getUpdates: async () => [update] }, resolveUser: async () => db.getUser(userId), handleMessage: async ({ user }) => {
    await db.addJournalEvent(user.id, { healthDate: '2026-02-05', eventAt: AT.toISOString(), category: 'alcohol' }); return user.id;
  }, sendReply: async r => replies.push(r) });
  await make({ ...db, completeTelegramUpdate: async () => { throw new Error('interrupted'); } }).pollOnce();
  clock = new Date(+AT + 3600000); userId = 'bob';
  await make(db).pollOnce();
  assert.equal((await journals(db)).length, 1); assert.equal((await journals(db, 'bob')).length, 0);
  assert(replies.every(r => r.userId === 'alice' && r.reply === 'alice'));
}));

test('Telegram transaction loses its lease during parsing: no committed answer side effect', () => setup(async db => {
  await question(db); let clock = AT;
  const router = createRouter({ db, now: () => clock, coachFor: () => ({ json: async () => {
    clock = new Date(+AT + 3600000); return parsed;
  } }) });
  const poller = createPoller({ db, now: () => clock, workerId: 'slow', sleepImpl: async () => {}, resolveUser: async () => db.getUser('alice'), api: { getUpdates: async () => [{ ...update, message: { ...update.message, text: '喝了兩杯' } }] }, handleMessage: input => router.handle(input) });
  await poller.pollOnce();
  assert.equal((await journals(db)).length, 0);
  assert.notEqual(await db.getUpdateOffset(), 501);
  assert.equal((await db.raw.execute('SELECT * FROM telegram_operations')).rows.length, 0);
}));
