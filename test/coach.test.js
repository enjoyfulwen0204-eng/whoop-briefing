/**
 * 驗證真正送到 Anthropic API 的 request body 長什麼樣。
 * 用本機假伺服器攔下請求，不需要真的 API key、也不會花錢。
 *
 * 要確認的重點（Sonnet 5 的規矩）：
 *  - 有 thinking:{type:"disabled"} 與 output_config.effort="low"（省 token）
 *  - 沒有 temperature / top_p / top_k（Sonnet 5 設非預設值會回 400）
 *  - model 走環境變數、max_tokens 抓足夠但不過大
 *  - 遇到 400 會自動退一階參數，不會整個掛掉
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createCoach, buildDailyUserMessage, SYSTEM_PROMPT } from '../src/coach.js';
import { buildBriefing } from '../src/daily.js';
import { localDate } from '../src/time.js';
import { makeDataset, degradedOverrides } from './fixtures.js';

const TZ = 'Asia/Taipei';

function okResponse(text = '早安 Kelvin，今天狀態不錯，放心去衝 💪') {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 420, output_tokens: 90 },
  };
}

/** 起一個假的 Anthropic API，把收到的 request body 記下來。 */
async function mockApi(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      seen.push({ path: req.url, body: parsed });
      const out = handler(parsed, seen.length);
      res.writeHead(out.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out.json));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    seen,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => server.close(r)),
  };
}

function sampleBriefing() {
  const ds = makeDataset({ days: 45, overrides: degradedOverrides() });
  return buildBriefing({
    ...ds, timezone: TZ, today: localDate(ds.now, TZ), wakeSleepId: 'sleep-000-uuid',
  });
}

test('daily 呼叫：thinking disabled + effort low，且沒有 temperature/top_p/top_k', async () => {
  const api = await mockApi(() => ({ status: 200, json: okResponse() }));
  try {
    const coach = createCoach({ apiKey: 'test-key', model: 'claude-sonnet-5', baseUrl: api.baseUrl });
    const text = await coach.daily(sampleBriefing());

    assert.equal(text, '早安 Kelvin，今天狀態不錯，放心去衝 💪');
    assert.equal(api.seen.length, 1, '第一階參數就該成功，不用重試');

    const body = api.seen[0].body;
    assert.equal(api.seen[0].path, '/v1/messages');
    assert.equal(body.model, 'claude-sonnet-5');
    assert.deepEqual(body.thinking, { type: 'disabled' });
    assert.deepEqual(body.output_config, { effort: 'low' });
    assert.equal(body.max_tokens, 1200);

    for (const banned of ['temperature', 'top_p', 'top_k']) {
      assert.ok(!(banned in body), `不可以送 ${banned}（Sonnet 5 會回 400）`);
    }

    assert.equal(body.system, SYSTEM_PROMPT);
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].role, 'user');
    assert.match(body.messages[0].content, /今日指標（程式已判定）/);
    assert.match(body.messages[0].content, /判定：差很多/);
    assert.match(body.messages[0].content, /趨勢預警/);
  } finally {
    await api.close();
  }
});

test('模型不吃某個參數時（400）會自動退一階，不會整個失敗', async () => {
  const api = await mockApi((body, n) => {
    if (n === 1 && body.output_config) {
      return {
        status: 400,
        json: { type: 'error', error: { type: 'invalid_request_error', message: 'output_config not supported' } },
      };
    }
    return { status: 200, json: okResponse('退一階之後成功') };
  });
  try {
    const coach = createCoach({ apiKey: 'test-key', model: 'claude-sonnet-5', baseUrl: api.baseUrl });
    const text = await coach.daily(sampleBriefing());
    assert.equal(text, '退一階之後成功');
    assert.equal(api.seen.length, 2);
    assert.ok(!('output_config' in api.seen[1].body));
    assert.deepEqual(api.seen[1].body.thinking, { type: 'disabled' });
  } finally {
    await api.close();
  }
});

test('Claude 一直掛 → 回 null（上層走 fallback，不讓整份簡報消失）', async () => {
  const api = await mockApi(() => ({
    status: 500,
    json: { type: 'error', error: { type: 'api_error', message: 'boom' } },
  }));
  try {
    const coach = createCoach({ apiKey: 'test-key', model: 'claude-sonnet-5', baseUrl: api.baseUrl });
    const text = await coach.daily(sampleBriefing());
    assert.equal(text, null);
  } finally {
    await api.close();
  }
});

test('weekly 呼叫用較大的 max_tokens，system prompt 會加上週回顧指示', async () => {
  const api = await mockApi(() => ({ status: 200, json: okResponse('上週整體很穩') }));
  try {
    const coach = createCoach({ apiKey: 'test-key', model: 'claude-sonnet-5', baseUrl: api.baseUrl });
    const weekly = {
      last: {
        startDate: '2026-08-17', endDate: '2026-08-23', days: 7,
        averages: { recovery_score: { mean: 66, n: 7, display: '66%', label: '恢復' } },
        best: { date: '2026-08-19', display: '78%' },
        worst: { date: '2026-08-21', display: '52%' },
      },
      prev: { days: 7 },
      wow: { recovery_score: { delta: 3, pct: 4.7, direction: 'up' } },
    };
    const text = await coach.weekly(weekly);
    assert.equal(text, '上週整體很穩');
    const body = api.seen[0].body;
    assert.equal(body.max_tokens, 1800);
    assert.match(body.system, /每週回顧/);
    assert.match(body.messages[0].content, /上週區間/);
  } finally {
    await api.close();
  }
});

test('教練輸入不含原始 API payload（只給算好的結論）', () => {
  const msg = buildDailyUserMessage(sampleBriefing());
  assert.ok(!msg.includes('score_state'), '不該把 WHOOP 原始欄位丟給 Claude');
  assert.ok(!msg.includes('sleep-000-uuid'));
  assert.ok(!msg.includes('hrv_rmssd_milli'));
  assert.match(msg, /HRV/);
  assert.match(msg, /整體：/);
});
