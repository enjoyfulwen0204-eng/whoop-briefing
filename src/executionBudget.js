import { AsyncLocalStorage } from 'node:async_hooks';
const executionScope=new AsyncLocalStorage();
export const currentExecutionBudget=()=>executionScope.getStore();
export const withExecutionBudget=(budget,fn)=>executionScope.run(budget,fn);
/** Bounded execution clock (work, admission or authoritative whole phase). All late continuations retain this aborted signal;
 * callers must also fence durable writes at transaction commit. */
export class ExecutionBudgetError extends Error {
  constructor(code = 'SYNC_TIMEOUT') { super(code); this.name = 'ExecutionBudgetError'; this.code = code; }
}
export const SYNC_BUDGET_MS = 180_000;
export const SETTLEMENT_MARGIN_MS = 15_000;
export function createExecutionBudget({ budgetMs = SYNC_BUDGET_MS, signal, nowMs = Date.now, startedAtMs = nowMs() } = {}) {
  if (!Number.isSafeInteger(budgetMs) || budgetMs < 1 || budgetMs > 225_000) throw new Error('SYNC_BUDGET_INVALID');
  const startedAt = startedAtMs, deadlineAt = startedAt + budgetMs, controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(new ExecutionBudgetError()), Math.max(0,deadlineAt-nowMs()));
  const assert = () => {
    if (combined.aborted || nowMs() >= deadlineAt)
      throw new ExecutionBudgetError(combined.reason?.code==='SYNC_CANCELLED'||signal?.aborted && signal.reason?.code!=='SYNC_TIMEOUT' ? 'SYNC_CANCELLED' : 'SYNC_TIMEOUT');
  };
  const api={ signal: combined, startedAt, deadlineAt, assert,
    remainingMs: () => Math.max(0, deadlineAt - nowMs()),
    run: async fn => executionScope.run(api,async()=>{ assert(); const result = await abortable(Promise.resolve().then(()=>{assert();return fn();}), combined); assert(); return result; }),
    cancel: () => controller.abort(new ExecutionBudgetError('SYNC_CANCELLED')),
    close: () => clearTimeout(timer),
  };
  return Object.freeze(api);
}
export async function abortable(work, signal) {
  if (!signal) return work;
  if (signal.aborted) { void Promise.resolve(work).catch(()=>{}); throw signal.reason ?? new ExecutionBudgetError(); }
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason ?? new ExecutionBudgetError());
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try { const result = await Promise.race([work, aborted]); if (signal.aborted) throw signal.reason ?? new ExecutionBudgetError(); return result; }
  finally { signal.removeEventListener('abort', onAbort); }
}
export function abortableResponse(work, signal) {
  const response = Promise.resolve(work).then(value => {
    if (signal?.aborted) {
      try { void value.body?.cancel().catch(() => {}); } catch {}
    }
    return value;
  });
  return abortable(response, signal);
}
export async function boundedBody(response, { signal, maxBytes = 4*1024*1024 } = {}) {
  if (!response.body?.getReader) {
    // Test transport seam. Real fetch Responses always expose a stream or null.
    if (response.body === null) return '';
    return abortable(response.text ? response.text() : response.json().then(JSON.stringify), signal);
  }
  const reader = response.body.getReader(), chunks = []; let size = 0, done = false;
  try {
    while (true) {
      const part = await abortable(reader.read(), signal);
      if (part.done) { done = true; break; }
      size += part.value.byteLength;
      if (size > maxBytes) throw new ExecutionBudgetError('RESPONSE_TOO_LARGE');
      chunks.push(part.value);
    }
    const joined = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder().decode(joined);
  } finally {
    if (!done) { try { void reader.cancel().catch(() => {}); } catch {} }
    try { reader.releaseLock(); } catch {}
  }
}
