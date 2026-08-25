/**
 * 驗證真正送到 OpenRouter 的 request body 長什麼樣。
 * 用本機假伺服器攔下請求，不需要真的 API key、也不會花錢。
 *
 * 要確認的重點：
 *  - 打的是 OpenAI 格式的 /chat/completions（OpenRouter 沒有 /v1/messages）
 *  - 有 reasoning:{enabled:false}（教練文字不需要推理，省 token）
 *  - 沒有 temperature / top_p / top_k，語氣全靠 system prompt
 *  - model 走環境變數、max_tokens 抓足夠但不過大
 *  - 遇到 400 會自動退一階參數；429/5xx 會重試；全掛才回 null
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createCoach, buildDailyUserMessage, SYSTEM_PROMPT } from '../src/coach.js';
import { buildBriefing } from '../src/daily.js';
import { localDate } from '../src/time.js';
import { makeDataset, degradedOverrides } from './fixtures.js';

const TZ = 'Asia/Taipei';
const MODEL = 'anthropic/claude-sonnet-5';

function okResponse(text = '早安 Kelvin，今天狀態不錯，放心去衝 💪') {
  return {
    id: 'gen-test',
    object: 'chat.completion',
    model: MODEL,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: text },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 420, completion_tokens: 90, total_tokens: 510 },
  };
}

/** 起一個假的 OpenRouter，把收到的 request 記下來。 */
async function mockApi(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      seen.push({ path: req.url, headers: req.headers, body: parsed });
      const out = handler(parsed, seen.length);
      res.writeHead(out.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out.json));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    seen,
    baseUrl: `http://127.0.0.1:${port}/api/v1`,
    close: () => new Promise((r) => server.close(r)),
  };
}

/** 測試用 coach：不真的等 backoff。 */
function coachFor(api, extra = {}) {
  return createCoach({
    apiKey: 'test-key',
    model: MODEL,
    baseUrl: api.baseUrl,
    backoffFor: () => 0,
    ...extra,
  });
}

function sampleBriefing() {
  const ds = makeDataset({ days: 45, overrides: degradedOverrides() });
  return buildBriefing({
    ...ds, timezone: TZ, healthDate: localDate(ds.now, TZ), wakeSleepId: 'sleep-000-uuid',
  });
}

test('daily 呼叫：OpenAI 格式 + reasoning 關掉，且沒有 temperature/top_p/top_k', async () => {
  const api = await mockApi(() => ({ status: 200, json: okResponse() }));
  try {
    const coach = coachFor(api);
    const text = await coach.daily(sampleBriefing());

    assert.equal(text, '早安 Kelvin，今天狀態不錯，放心去衝 💪');
    assert.equal(api.seen.length, 1, '第一階參數就該成功，不用重試');

    const { path, headers, body } = api.seen[0];
    assert.equal(path, '/api/v1/chat/completions');
    assert.equal(headers.authorization, 'Bearer test-key', 'OpenRouter 用 Bearer，不是 x-api-key');
    assert.equal(body.model, MODEL);
    assert.deepEqual(body.reasoning, { enabled: false });
    assert.equal(body.max_tokens, 1200);

    for (const banned of ['temperature', 'top_p', 'top_k', 'thinking', 'output_config']) {
      assert.ok(!(banned in body), `不該送 ${banned}`);
    }

    assert.equal(body.messages.length, 2);
    assert.equal(body.messages[0].role, 'system');
    assert.equal(body.messages[0].content, SYSTEM_PROMPT);
    assert.equal(body.messages[1].role, 'user');
    assert.match(body.messages[1].content, /今日指標（程式已判定）/);
    assert.match(body.messages[1].content, /判定：差很多/);
    assert.match(body.messages[1].content, /趨勢預警/);
  } finally {
    await api.close();
  }
});

test('模型不吃某個參數時（400）會自動退一階，不會整個失敗', async () => {
  const api = await mockApi((body, n) => {
    if (n === 1 && body.reasoning) {
      return {
        status: 400,
        json: { error: { code: 400, message: 'reasoning is not supported by this model' } },
      };
    }
    return { status: 200, json: okResponse('退一階之後成功') };
  });
  try {
    const text = await coachFor(api).daily(sampleBriefing());
    assert.equal(text, '退一階之後成功');
    assert.equal(api.seen.length, 2);
    assert.ok(!('reasoning' in api.seen[1].body));
  } finally {
    await api.close();
  }
});

test('429 會重試，重試成功就照樣回文字', async () => {
  const api = await mockApi((_body, n) => {
    if (n === 1) return { status: 429, json: { error: { code: 429, message: 'rate limited' } } };
    return { status: 200, json: okResponse('重試之後成功') };
  });
  try {
    const text = await coachFor(api).daily(sampleBriefing());
    assert.equal(text, '重試之後成功');
    assert.equal(api.seen.length, 2);
  } finally {
    await api.close();
  }
});

test('OpenRouter 一直掛 → 重試用完後回 null（上層走 fallback，不讓整份簡報消失）', async () => {
  const api = await mockApi(() => ({
    status: 500,
    json: { error: { code: 500, message: 'boom' } },
  }));
  try {
    const text = await coachFor(api, { maxRetries: 2 }).daily(sampleBriefing());
    assert.equal(text, null);
    // 兩階參數 × 每階重試 2 次 = 4 次請求（400 才退階，500 不退階 → 只有第一階打）
    assert.equal(api.seen.length, 2, '5xx 不該退參數階梯，只重試');
  } finally {
    await api.close();
  }
});

test('200 但 body 裡包 error（上游 provider 掛了）也算失敗 → 回 null', async () => {
  const api = await mockApi(() => ({
    status: 200,
    json: { error: { code: 502, message: 'upstream provider error' } },
  }));
  try {
    const text = await coachFor(api, { maxRetries: 1 }).daily(sampleBriefing());
    assert.equal(text, null);
  } finally {
    await api.close();
  }
});

test('weekly 呼叫用較大的 max_tokens，system prompt 會加上週回顧指示', async () => {
  const api = await mockApi(() => ({ status: 200, json: okResponse('上週整體很穩') }));
  try {
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
    const text = await coachFor(api).weekly(weekly);
    assert.equal(text, '上週整體很穩');
    const body = api.seen[0].body;
    assert.equal(body.max_tokens, 1800);
    assert.match(body.messages[0].content, /每週回顧/);
    assert.match(body.messages[1].content, /上週區間/);
  } finally {
    await api.close();
  }
});

test('教練輸入不含原始 API payload（只給算好的結論）', () => {
  const msg = buildDailyUserMessage(sampleBriefing());
  assert.ok(!msg.includes('score_state'), '不該把 WHOOP 原始欄位丟給模型');
  assert.ok(!msg.includes('sleep-000-uuid'));
  assert.ok(!msg.includes('hrv_rmssd_milli'));
  assert.match(msg, /HRV/);
  assert.match(msg, /整體：/);
});
