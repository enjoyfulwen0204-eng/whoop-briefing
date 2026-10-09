import { runningReleaseSha } from '../src/phase4Release.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  BRIEFING_TRIGGER, canonicalTriggerMessage, signTriggerRequest, verifyTriggerRequest,
} from '../src/briefingTriggerAuth.js';
import { createBriefingEndpoint } from '../src/briefingEndpoint.js';
import {
  checkPeerScheduler, providerState, aggregateSchedulerState, SCHEDULER_POLICY,
} from '../src/schedulerWatchdog.js';
import { HEARTBEAT_COMPONENT } from '../src/guardianPolicy.js';
import {
  signRequest, retryableStatus, invoke, isRedirect,
  REDIRECT_MODE, ALLOWED_REDIRECT_MODES,
} from '../cloudflare/briefing-scheduler/worker.js';
import { BRIEFING_STATUS, renderBriefingStatus } from '../src/briefingStatus.js';
import { schedulerConfiguration } from '../src/bot/webhook.js';

const SECRET = 'test-only-secret-with-sufficient-entropy';
const NOW = 1_789_123_456_000;
const base = (overrides = {}) => ({
  timestamp: String(NOW), requestId: randomUUID(), method: 'POST',
  path: BRIEFING_TRIGGER.PATH, body: '{}', ...overrides,
});

test('reviewed Worker trigger is the Stage 6 window and keeps the authenticated Render endpoint', () => {
  const config = readFileSync(new URL('../cloudflare/briefing-scheduler/wrangler.toml', import.meta.url), 'utf8');
  assert.match(config, /crons = \[\]/);
  assert.doesNotMatch(config, /crons = \["\*\/10 \* \* \* \*"\]/);
  assert.match(config, /BRIEFING_ENDPOINT_URL = "https:\/\/whoop-telegram-webhook\.onrender\.com\/internal\/briefing\/run"/);
  assert.doesNotMatch(config, /^BRIEFING_TRIGGER_SECRET\s*=/m);
});

test('HMAC canonicalization matches Worker Web Crypto signing', async () => {
  const args = base({ requestId: 'request_1234567890' });
  assert.equal(await signRequest(args, SECRET), signTriggerRequest(args, SECRET));
  assert.match(canonicalTriggerMessage(args), /POST\n\/internal\/briefing\/run\n/);
});

test('authentication binds signature to timestamp, id, method, path, and body', () => {
  const args = base();
  const signature = signTriggerRequest(args, SECRET);
  assert.deepEqual(verifyTriggerRequest({ ...args, signature, secret: SECRET, now: NOW }), { ok: true });
  for (const changed of [
    { body: '{"changed":true}' }, { method: 'GET' }, { path: '/wrong' },
  ]) {
    assert.equal(verifyTriggerRequest({ ...args, ...changed, signature, secret: SECRET, now: NOW }).ok, false);
  }
  assert.equal(verifyTriggerRequest({ ...args, signature: '', secret: SECRET, now: NOW }).reason, 'missing_auth');
  assert.equal(verifyTriggerRequest({ ...args, signature: 'v1=00', secret: SECRET, now: NOW }).reason, 'invalid_signature');
  assert.equal(verifyTriggerRequest({ ...args, requestId: 'bad', signature, secret: SECRET, now: NOW }).reason, 'malformed_request_id');
});

test('authentication rejects stale, future, and malformed timestamps', () => {
  for (const [timestamp, reason] of [
    [String(NOW - BRIEFING_TRIGGER.MAX_CLOCK_SKEW_MS - 1), 'stale_timestamp'],
    [String(NOW + BRIEFING_TRIGGER.MAX_CLOCK_SKEW_MS + 1), 'future_timestamp'],
    ['not-a-time', 'malformed_timestamp'],
  ]) {
    const args = base({ timestamp });
    const signature = signTriggerRequest(args, SECRET);
    assert.equal(verifyTriggerRequest({ ...args, signature, secret: SECRET, now: NOW }).reason, reason);
  }
});

function request(args, signature, extra = {}) {
  return {
    url: args.path, method: args.method,
    headers: {
      'content-type': 'application/json', 'x-briefing-timestamp': args.timestamp,
      'x-briefing-request-id': args.requestId, 'x-briefing-signature': signature,
      ...extra,
    },
  };
}

const phaseArgs = (extra = {}) => {
  const args = base(extra);
  args.body = JSON.stringify({releaseSha:runningReleaseSha(),requestId:args.requestId,phase:'SYNC',triggerSource:'cloudflare',executionMode:'OFF',configProof:'a'.repeat(64)});
  return args;
};
test('endpoint caches exact phase retry and returns canonical aggregate result', async () => {
  let calls=0;
  const endpoint=createBriefingEndpoint({secret:SECRET,now:()=>NOW,runPhase:async()=>{
    calls++;await new Promise(r=>setTimeout(r,5));
    return {status:200,body:{ok:true,phase:'SYNC',source:'cloudflare',syncComplete:true,drainAuthorized:false,result:{users:2,failed:0}}};
  }});
  const args=phaseArgs(),req=request(args,signTriggerRequest(args,SECRET));
  const [a,b]=await Promise.all([endpoint(req,args.body),endpoint(req,args.body)]);
  assert.equal(calls,1);assert.deepEqual(a,b);assert.equal(a.status,200);assert.deepEqual(a.body.result,{users:2,failed:0});
});
test('different request identities execute independently; durable tenant ownership handles overlap', async () => {
  let calls=0;
  const endpoint=createBriefingEndpoint({secret:SECRET,now:()=>NOW,runPhase:async()=>{
    calls++;await new Promise(r=>setTimeout(r,5));return {status:200,body:{ok:true}};
  }});
  const a=phaseArgs(),b=phaseArgs();
  const results=await Promise.all([endpoint(request(a,signTriggerRequest(a,SECRET)),a.body),endpoint(request(b,signTriggerRequest(b,SECRET)),b.body)]);
  assert.equal(calls,2);assert.ok(results.every(r=>r.status===200));
});
test('endpoint rejects media type, malformed/large body, auth failure, and preserves partial status', async () => {
  const endpoint=createBriefingEndpoint({secret:SECRET,now:()=>NOW,runPhase:async()=>({status:207,body:{ok:false,syncComplete:false}})});
  const args=phaseArgs(),sig=signTriggerRequest(args,SECRET);
  assert.equal((await endpoint(request(args,sig,{'content-type':'text/plain'}),args.body)).status,415);
  assert.equal((await endpoint(request(args,sig),'{')).status,400);
  assert.equal((await endpoint(request(args,sig),'x'.repeat(1025))).status,413);
  assert.equal((await endpoint(request(args,'bad'),args.body)).status,401);
  assert.equal((await endpoint({...request(args,sig),url:`${args.path}?unexpected=1`},args.body)).status,400);
  assert.equal((await endpoint(request(args,sig),args.body)).status,207);
});

test('scheduler-only env is fail-closed without taking down inbound configuration', () => {
  assert.deepEqual(schedulerConfiguration({}, ''), { enabled: false, state: 'disabled' });
  assert.deepEqual(schedulerConfiguration({ whoopClientId: 'only-one' }, ''),
    { enabled: false, state: 'incomplete' });
  assert.deepEqual(schedulerConfiguration({
    whoopClientId: 'id', whoopClientSecret: 'secret', telegramChatId: 'chat',
  }, SECRET), { enabled: true, state: 'enabled' });
});

test('Worker re-signs each retry while preserving logical request ID', async () => {
  assert.equal(retryableStatus(503), true);
  assert.equal(retryableStatus(401), false);
  const requests = [];
  const statuses = [503, 200];
  const startedTimers=[],clearedTimers=[];
  let retryClock = NOW;
  const result = await invoke({
    BRIEFING_ENDPOINT_URL: 'https://example.invalid/internal/briefing/run',
    BRIEFING_TRIGGER_SECRET: SECRET, BRIEFING_EXECUTION_MODE: 'OFF', BRIEFING_RELEASE_SHA: 'b'.repeat(40), BRIEFING_CONFIG_PROOF: 'a'.repeat(64),
  }, {
    now: () => retryClock,
    sleep: async () => { retryClock += 120_000; },
    setTimer:(fn,ms)=>{const timer=setTimeout(fn,ms);startedTimers.push(timer);return timer;},
    clearTimer:timer=>{clearedTimers.push(timer);clearTimeout(timer);},
    fetchImpl: async (_url, options) => {
      requests.push(options);
      const status = statuses.shift();
      return new Response(JSON.stringify(status===200?{ok:true,phase:'SYNC',source:'cloudflare',syncComplete:true,drainAuthorized:false,result:{settlementState:'FINALIZED_SUCCESS'}}:{}),{status});
    },
  });
  assert.equal(result.attempt, 2);
  assert.equal(startedTimers.length,3,'two attempts and abortable backoff each have a deadline');
  assert.deepEqual(clearedTimers,startedTimers,'every actual timer must be cleared exactly once');
  assert.equal(requests.length, 2);
  assert.equal(new Set(requests.map((r) => r.headers['x-briefing-request-id'])).size, 1);
  assert.deepEqual(requests.map((r) => Number(r.headers['x-briefing-timestamp'])),
    [NOW, NOW + 120_000]);
  assert.equal(new Set(requests.map((r) => r.headers['x-briefing-signature'])).size, 2);
  for (const r of requests) {
    assert.deepEqual(verifyTriggerRequest({
      timestamp: r.headers['x-briefing-timestamp'], requestId: r.headers['x-briefing-request-id'],
      signature: r.headers['x-briefing-signature'], secret: SECRET, method: 'POST',
      path: BRIEFING_TRIGGER.PATH, body: r.body, now: Number(r.headers['x-briefing-timestamp']),
    }), { ok: true });
  }
  const first = requests[0];
  assert.equal(verifyTriggerRequest({
    timestamp: first.headers['x-briefing-timestamp'], requestId: first.headers['x-briefing-request-id'],
    signature: first.headers['x-briefing-signature'], secret: SECRET, method: 'POST',
    path: BRIEFING_TRIGGER.PATH, body: first.body,
    now: NOW + BRIEFING_TRIGGER.MAX_CLOCK_SKEW_MS + 1,
  }).reason, 'stale_timestamp');

  let authAttempts = 0;
  await assert.rejects(() => invoke({
    BRIEFING_ENDPOINT_URL: 'https://example.invalid/internal/briefing/run',
    BRIEFING_TRIGGER_SECRET: SECRET, BRIEFING_EXECUTION_MODE: 'OFF', BRIEFING_RELEASE_SHA: 'b'.repeat(40), BRIEFING_CONFIG_PROOF: 'a'.repeat(64),
  }, {
    now: () => NOW, sleep: async () => {},
    fetchImpl: async () => {
      authAttempts += 1;
      return new Response('unauthorized',{status:401});
    },
  }), /authentication/);
  assert.equal(authAttempts, 1);
});

test('scheduler role policy follows the Taipei window and the three-hour GitHub expectation', async () => {
  const outside=new Date('2026-09-25T12:00:00.000Z');
  for(const minutes of [120,131,137,157,180])assert.equal(providerState({lastOkAt:new Date(outside.getTime()-minutes*60000).toISOString()},'github',outside).state,'healthy');
  for(const minutes of [181,226,272,273,420])assert.equal(providerState({lastOkAt:new Date(outside.getTime()-minutes*60000).toISOString()},'github',outside).state,'stale');
  for(const value of ['malformed',new Date(outside.getTime()+1).toISOString()])assert.equal(providerState({lastOkAt:value},'github',outside).state,'stale');
  const at=new Date('2026-09-25T01:00:00.000Z');let alerts=0;
  const systemTelegram={notifyError:async()=>{alerts++;return true;}};
  const heartbeats=new Map([[HEARTBEAT_COMPONENT.GITHUB,{lastOkAt:new Date(at.getTime()-13*3600000).toISOString()}]]);
  const db={getHeartbeat:async(_scope,component)=>heartbeats.get(component)??null};
  for(let minute=0;minute<180;minute+=10) {
    const now=new Date(at.getTime()+minute*60000);heartbeats.set(HEARTBEAT_COMPONENT.CLOUDFLARE,{lastOkAt:now.toISOString()});
    await checkPeerScheduler({db,source:'cloudflare',systemTelegram,now});
  }
  assert.equal(alerts,0,'healthy morning primary does not complain about the backup');
  heartbeats.set(HEARTBEAT_COMPONENT.CLOUDFLARE,{lastOkAt:new Date(at.getTime()-3600000).toISOString()});
  heartbeats.set(HEARTBEAT_COMPONENT.GITHUB,{lastOkAt:at.toISOString()});
  const degraded=await checkPeerScheduler({db,source:'github',systemTelegram,now:at});
  assert.equal(degraded.overall,'degraded');assert.equal(degraded.alerted,true);assert.equal(alerts,1);
  heartbeats.clear();assert.equal((await checkPeerScheduler({db,source:'cloudflare',systemTelegram,now:at})).overall,'outage');
  db.getHeartbeat=async()=>{throw Error('db timeout');};
  assert.equal((await checkPeerScheduler({db,source:'github',systemTelegram,now:at})).overall,'unknown');
});

test('primary outage alerts obey cooldown, delivery failure, and concurrent atomic claims', async () => {
  const outageNow=Date.parse('2026-09-25T01:00:00.000Z');
  const heartbeats = new Map([
    [HEARTBEAT_COMPONENT.CLOUDFLARE, { lastOkAt: new Date(outageNow - 2 * 3600_000).toISOString() }],
    [HEARTBEAT_COMPONENT.GITHUB, { lastOkAt: new Date(outageNow).toISOString() }],
  ]);
  const db = { getHeartbeat: async (_scope, component) => heartbeats.get(component) };
  let currentHour = 0;
  let lastClaim = -Infinity;
  let sends = 0;
  const systemTelegram = { notifyError: async () => {
    if (currentHour - lastClaim < 2) return false;
    lastClaim = currentHour;
    sends += 1;
    return sends !== 1; // first delivery failure is surfaced as alerted=false
  } };
  const first = await checkPeerScheduler({ db, source: 'github', systemTelegram, now: new Date(outageNow) });
  assert.equal(first.alerted, false);
  for (currentHour = 1; currentHour < 24; currentHour += 1) {
    heartbeats.set(HEARTBEAT_COMPONENT.GITHUB,
      { lastOkAt: new Date(outageNow + currentHour * 3600_000).toISOString() });
    await checkPeerScheduler({
      db, source: 'github', systemTelegram, now: new Date(outageNow + currentHour * 3600_000),
    });
  }
  assert.equal(sends, 2, 'a mock 2h cooldown is evaluated only during the remaining morning window');

  currentHour = 49;
  lastClaim = -Infinity;
  sends = 0;
  let claimed = false;
  const atomicTelegram = { notifyError: async () => {
    await new Promise((resolve) => setImmediate(resolve));
    if (claimed) return false;
    claimed = true;
    sends += 1;
    return true;
  } };
  const pair = await Promise.all([
    checkPeerScheduler({ db, source: 'github', systemTelegram: atomicTelegram, now: new Date(outageNow + 49 * 3600_000) }),
    checkPeerScheduler({ db, source: 'github', systemTelegram: atomicTelegram, now: new Date(outageNow + 49 * 3600_000) }),
  ]);
  assert.equal(sends, 1);
  assert.deepEqual(pair.map((r) => r.alerted).sort(), [false, true]);
});

test('briefing status is vendor/topology-free in every product state', () => {
  const forbidden = /Cloudflare|GitHub|cron|heartbeat|Render|Worker|Actions|endpoint|primary|backup|主排程|備援/i;
  for (const status of Object.values(BRIEFING_STATUS)) {
    for (const schedulerState of ['healthy', 'degraded', 'outage', 'unknown', 'uninitialized']) {
      const message = renderBriefingStatus({
        status,
        evidence: { scheduler_state: schedulerState, scheduler_stale: schedulerState === 'outage' },
      });
      assert.doesNotMatch(message, forbidden, `${status}/${schedulerState}`);
    }
  }
});

test('redirects are terminal, never followed, and placeholder/query URLs fail closed', async () => {
  for (const [status, location] of [
    [301, 'https://render.example/other'],
    [302, 'https://cross-origin.example/internal/briefing/run'],
    [302, 'http://render.example/internal/briefing/run'],
    [301, 'https://render.example/internal/briefing/run'],
  ]) {
    let calls = 0;
    await assert.rejects(() => invoke({
      BRIEFING_ENDPOINT_URL: 'https://render.example/internal/briefing/run',
      BRIEFING_TRIGGER_SECRET: SECRET, BRIEFING_EXECUTION_MODE: 'OFF', BRIEFING_RELEASE_SHA: 'b'.repeat(40), BRIEFING_CONFIG_PROOF: 'a'.repeat(64),
    }, {
      now: () => NOW, sleep: async () => {},
      fetchImpl: async (_url, options) => {
        calls += 1;
        // ★ 不能寫死 'error'：Workers runtime 不实作它。這裡只能斷言
        // 「是 runtime 真的收的值」且「不跟隨重新導向」。
        assert.ok(ALLOWED_REDIRECT_MODES.includes(options.redirect),
          `redirect 必須是 Workers 支援的值，實際是 ${options.redirect}`);
        assert.notEqual(options.redirect, 'follow', '簽名過的請求絕不可以被轉送');
        return new Response('redirect target hidden',{status,headers:{location}});
      },
    }), (err) => {
      assert.match(err.message, /redirect/);
      assert.equal(err.category, 'redirect', '3xx 必須被归類為 redirect');
      assert.equal(err.nonRetryable, true);
      return true;
    });
    assert.equal(calls, 1);
  }
  // ★ 每一個都要斷言**確切的拒絕理由**，而且 fetch 一旦被呼叫就算失敗。
  //
  // 之前這裡是裸的 assert.rejects()：把守衛拿掉之後，invoke() 會掉到真正的
  // fetch、打不到那個主機、丟出 TypeError —— 測試照樣「通過」。它驗證的是
  // DNS 解析失敗，不是我們的驗證邏輯。
  for (const [url, expected] of [
    ['https://REPLACE_WITH_RENDER_HOST/internal/briefing/run', /configuration/],
    ['https://placeholder.example/internal/briefing/run', /configuration/],
    ['https://render.example/internal/briefing/run?x=1', /configuration/],
    ['https://render.example/internal/briefing/run#x', /configuration/],
    ['http://render.example/internal/briefing/run', /configuration/],
    ['https://render.example/internal/briefing/run/', /configuration/],
    ['https://render.example/other', /configuration/],
  ]) {
    let fetched = 0;
    await assert.rejects(
      () => invoke({ BRIEFING_ENDPOINT_URL: url, BRIEFING_TRIGGER_SECRET: SECRET }, {
        sleep: async () => {},
        fetchImpl: async () => { fetched += 1; throw new Error('network must not be reached'); },
      }),
      (err) => {
        assert.match(err.message, expected, `wrong rejection reason for ${url}`);
        assert.equal(err.category, 'configuration', `${url} must be a configuration error`);
        assert.equal(err.nonRetryable, true, `${url} must not be retried`);
        return true;
      },
    );
    assert.equal(fetched, 0, `★ ${url} 必須在送出任何請求之前就被擋下`);
  }
  // 密鑰太短同樣是設定錯誤，而且同樣不可以先打網路。
  {
    let fetched = 0;
    await assert.rejects(
      () => invoke({
        BRIEFING_ENDPOINT_URL: 'https://render.example/internal/briefing/run',
        BRIEFING_TRIGGER_SECRET: 'short',
      }, { fetchImpl: async () => { fetched += 1; return { ok: true, status: 200, text: async () => '' }; } }),
      /configuration/,
    );
    assert.equal(fetched, 0);
  }
});

test('redirect rejection is terminal and never retried three times', async () => {
  let attempts = 0;
  await assert.rejects(() => invoke({
    BRIEFING_ENDPOINT_URL: 'https://render.example/internal/briefing/run',
    BRIEFING_TRIGGER_SECRET: SECRET, BRIEFING_EXECUTION_MODE: 'OFF', BRIEFING_RELEASE_SHA: 'b'.repeat(40), BRIEFING_CONFIG_PROOF: 'a'.repeat(64),
  }, {
    now: () => NOW, sleep: async () => {},
    fetchImpl: async () => {
      attempts += 1;
      // undici 在 redirect:'error' 下就是丟這種 TypeError
      throw new TypeError('fetch failed: unexpected redirect');
    },
  }), (err) => {
    assert.equal(err.category, 'redirect');
    assert.equal(err.nonRetryable, true);
    return true;
  });
  assert.equal(attempts, 1, '★ 重新導向是永久狀況，不可以重試三次');
});

test('worker failure categories are distinguishable and leak nothing', async () => {
  const cases = [
    ['authentication', 401, null],
    ['http_4xx', 400, null],
    ['http_5xx', 500, null],
  ];
  for (const [category, status] of cases) {
    await assert.rejects(() => invoke({
      BRIEFING_ENDPOINT_URL: 'https://render.example/internal/briefing/run',
      BRIEFING_TRIGGER_SECRET: SECRET, BRIEFING_EXECUTION_MODE: 'OFF', BRIEFING_RELEASE_SHA: 'b'.repeat(40), BRIEFING_CONFIG_PROOF: 'a'.repeat(64),
    }, {
      now: () => NOW, sleep: async () => {},
      fetchImpl: async () => new Response('secret-bearing server text that must never surface',{status}),
    }), (err) => {
      assert.equal(err.category, category, `status ${status} -> ${category}`);
      assert.doesNotMatch(err.message, /secret-bearing/, '★ 伺服器回傳的文字不可以進錯誤訊息');
      return true;
    });
  }
  // 逾時要被分類成 timeout
  await assert.rejects(() => invoke({
    BRIEFING_ENDPOINT_URL: 'https://render.example/internal/briefing/run',
    BRIEFING_TRIGGER_SECRET: SECRET, BRIEFING_EXECUTION_MODE: 'OFF', BRIEFING_RELEASE_SHA: 'b'.repeat(40), BRIEFING_CONFIG_PROOF: 'a'.repeat(64),
  }, {
    now: () => NOW, sleep: async () => {}, timeoutMs: 1,
    setTimer: (fn) => { queueMicrotask(fn); return Symbol('t'); }, clearTimer: () => {},
    fetchImpl: (_u, { signal }) => new Promise((_r, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }),
  }), (err) => { assert.equal(err.category, 'timeout'); return true; });
});

test('real AbortController path aborts each hanging attempt and clears every timer', async () => {
  let attempts = 0;
  const startedTimers=[],clearedTimers=[];
  let fireDeadline;
  await assert.rejects(() => invoke({
    BRIEFING_ENDPOINT_URL: 'https://render.example/internal/briefing/run',
    BRIEFING_TRIGGER_SECRET: SECRET, BRIEFING_EXECUTION_MODE: 'OFF', BRIEFING_RELEASE_SHA: 'b'.repeat(40), BRIEFING_CONFIG_PROOF: 'a'.repeat(64),
  }, {
    now: () => NOW, sleep: async () => {}, timeoutMs: 1,
    setTimer:fn=>{fireDeadline=fn;const timer=Symbol('timer');startedTimers.push(timer);return timer;},
    clearTimer:timer=>{clearedTimers.push(timer);},
    fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
      attempts += 1;
      queueMicrotask(fireDeadline);
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')),
        { once: true });
    }),
  }), e=>e.category==='timeout');
  assert.equal(attempts, 2);
  assert.equal(startedTimers.length,3);
  assert.deepEqual(clearedTimers,startedTimers);
});

test('CLI and Render endpoint reference the same phase-aware canonical runner', async () => {
  const index = await import('../src/index.js');
  assert.equal(index.main, index.runBriefing);
  const webhookSource = (await import('node:fs')).readFileSync('src/bot/webhook.js', 'utf8');
  const cliSource = (await import('node:fs')).readFileSync('scripts/phase4-run.js', 'utf8');
  assert.match(webhookSource, /import \{ runExecutionPhase \} from '\.\.\/phase4Execution\.js'/);
  assert.match(cliSource, /import \{ runExecutionPhase \} from '\.\.\/src\/phase4Execution\.js'/);
  assert.doesNotMatch(webhookSource, /\b(?:exec|spawn)\s*\(|npm start/);
  assert.match(cliSource, /cliTriggerSource\(process\.env\)/);
  const sourcePolicy=(await import('node:fs')).readFileSync('src/phase4Release.js','utf8');
  assert.match(sourcePolicy,/GITHUB_SOURCE_UNSUPPORTED/);
  assert.match(sourcePolicy,/GITHUB_EVENT_NAME==='workflow_dispatch'/);
  assert.match(cliSource, /process\.exitCode=result\.body\.ok\?0:1/);
});

test('zero-user execution is successful liveness, records heartbeat, and sends no alerts', async () => {
  const index = await import('../src/index.js');
  const heartbeats = [];
  let alerts = 0;
  const db = {
    migrate: async () => {}, listActiveUsers: async () => [],
    recordHeartbeat: async (...args) => { heartbeats.push(args); }, close: () => {},
  };
  const env = {
    timezone: 'Asia/Taipei', dryRun: true, maxUserConcurrency: 3,
    telegramBotToken: 'test', telegramChatId: 'test', tursoUrl: 'file:test', tursoToken: '',
    repoLastCommitAt: null,
  };
  const result = await index.runBriefing({
    triggerSource: 'cloudflare', deps: {
      db, env, makeTelegram: () => ({ send: async () => {}, notifyError: async () => { alerts += 1; } }),
    },
  });
  assert.equal(result.outcome, 'nothing_due');
  assert.equal(result.users, 0);
  assert.equal(heartbeats.length, 2);
  assert.equal(alerts, 0);
});

test('provider liveness is separate from per-user outcomes', async () => {
  const index = await import('../src/index.js');
  const env = {
    timezone: 'Asia/Taipei', dryRun: true, maxUserConcurrency: 2,
    telegramBotToken: 'test', telegramChatId: 'test', tursoUrl: 'file:test', tursoToken: '',
    repoLastCommitAt: null,
  };
  const run = async (users, runUser) => {
    const heartbeats = [];
    const db = {
      migrate: async () => {}, listActiveUsers: async () => users,
      recordHeartbeat: async (...args) => { heartbeats.push(args); },
      getHeartbeat: async () => null, hasErrorNotify: async () => false,
      clearErrorNotify: async () => false, close: () => {},
    };
    const result = await index.runBriefing({ triggerSource: 'cloudflare', deps: { db, env, runUser } });
    return { result, heartbeats };
  };
  const ok = async () => ({ skipped: false, errors: [], sync:{outcome:'NO_NEW_DATA_SUCCESS'} });
  const bad = async () => ({ skipped: false, errors: [new Error('isolated failure')] });

  // 零使用者：服務活著，只是沒事做。
  const zero = await run([], ok);
  assert.equal(zero.result.outcome, 'nothing_due');
  assert.equal(zero.result.runState, 'alive');
  assert.equal(zero.heartbeats.length, 2);

  // 全部成功。
  const all = await run([{ id: 'u1' }, { id: 'u2' }], ok);
  assert.equal(all.result.outcome, 'completed');
  assert.equal(all.result.runState, 'alive');
  assert.equal(all.heartbeats.length, 2);

  // ★ 部分失敗：排程器仍然活著（它準時跑到了），heartbeat 照寫。
  // 以前一個使用者失敗就整輪不寫，於是對等監看會發出假的離線警報。
  const partial = await run([{ id: 'u1' }, { id: 'u2' }],
    async ({ user }) => (user.id === 'u1' ? bad() : ok()));
  assert.equal(partial.result.outcome, 'partial_failure');
  assert.equal(partial.result.failed, 1);
  assert.equal(partial.result.runState, 'alive');
  assert.equal(partial.heartbeats.length, 2, '★ 部分失敗不可以抹掉供應商存活訊號');
  assert.match(String(partial.heartbeats[0][2].detail), /failed=1/);

  // ★ 全員失敗：這個供應商實際上什麼也沒產出 —— 不算存活。
  const none = await run([{ id: 'u1' }, { id: 'u2' }], bad);
  assert.equal(none.result.outcome, 'all_users_failed');
  assert.equal(none.result.runState, 'unhealthy');
  assert.equal(none.heartbeats.length, 0, '★ 全員失敗不可以宣稱健康');
});

/**
 * ★ 2026-09-13 正式環境事故的回歸測試。
 *
 * Worker 之前用 `redirect: 'error'`。Node/undici 接受它，所以本機測試、
 * `wrangler deploy --dry-run` 、以及用 Node 發出的手動簽名請求全部都通過了。
 * 但 Cloudflare Workers runtime 沒有實作 'error'：它在**送出請求之前**就丟
 * TypeError，於是每一次 Cron 執行都在 0 個 subrequest 的情況下死掉，
 * 看起來就像「排程完全沒被觸發」。
 *
 * 所以這裡不測行為，直接釘住**常數本身**。
 */
test('redirect mode is one the Workers runtime actually implements', () => {
  assert.ok(ALLOWED_REDIRECT_MODES.includes(REDIRECT_MODE));
  assert.notEqual(REDIRECT_MODE, 'error', "Workers runtime 不實作 redirect:'error'");
  assert.notEqual(REDIRECT_MODE, 'follow', '簽名過的請求絕不可以被轉送到別的主機');
  assert.equal(REDIRECT_MODE, 'manual');

  // 原始碼裡也不可以再出現 'error'。
  const source = readFileSync(
    new URL('../cloudflare/briefing-scheduler/worker.js', import.meta.url), 'utf8',
  );
  const optionLines = source.split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))   // 排掉註解：註解裡要能寫出這個錯誤值來解釋它
    .filter((l) => /redirect:/.test(l));
  assert.ok(optionLines.length > 0);
  for (const line of optionLines) {
    assert.doesNotMatch(line, /redirect:\s*'error'/, `★ ${line.trim()}`);
  }

  for (const [status, redirect] of [[301, true], [302, true], [307, true], [308, true],
    [200, false], [299, false], [400, false], [503, false]]) {
    assert.equal(isRedirect(status), redirect, `isRedirect(${status})`);
  }
});
