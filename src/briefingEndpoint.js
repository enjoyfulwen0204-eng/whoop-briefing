import { BRIEFING_TRIGGER, verifyTriggerRequest, bodySha256 } from './briefingTriggerAuth.js';
import { log } from './logger.js';
import { validatePhaseRequest } from './phase4ExecutionStore.js';

export function createBriefingEndpoint({
  secret, runPhase, now = () => Date.now(), maxBodyBytes = BRIEFING_TRIGGER.MAX_BODY_BYTES,
}) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32) {
    throw new Error('BRIEFING_TRIGGER_SECRET must be at least 32 bytes');
  }
  if (typeof runPhase !== 'function') throw new Error('runPhase is required');
  const recent = new Map();
  const prune = (at) => {
    for (const [id, v] of recent) if (at - v.at > BRIEFING_TRIGGER.MAX_CLOCK_SKEW_MS) recent.delete(id);
  };

  return async function briefingEndpoint(req, body) {
    const rawUrl = String(req.url ?? '');
    const path = rawUrl.split('?')[0];
    if (path !== BRIEFING_TRIGGER.PATH) return null;
    if (rawUrl !== path) return { status: 400, body: { ok: false, error: 'query_not_allowed' } };
    if (req.method !== 'POST') return { status: 405, body: { ok: false, error: 'method_not_allowed' } };
    if (!String(req.headers?.['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
      return { status: 415, body: { ok: false, error: 'unsupported_media_type' } };
    }
    if (Buffer.byteLength(body) > maxBodyBytes) return { status: 413, body: { ok: false, error: 'body_too_large' } };
    let parsed;
    try {
      parsed = JSON.parse(body);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('bad');
    } catch {
      return { status: 400, body: { ok: false, error: 'invalid_json' } };
    }

    const timestamp = String(req.headers?.['x-briefing-timestamp'] ?? '');
    const requestId = String(req.headers?.['x-briefing-request-id'] ?? '');
    const signature = String(req.headers?.['x-briefing-signature'] ?? '');
    const at = now();
    const auth = verifyTriggerRequest({
      timestamp, requestId, method: req.method, path, body, signature, secret, now: at,
    });
    if (!auth.ok) {
      log.warn('briefing_trigger_rejected', { reason: auth.reason });
      return { status: 401, body: { ok: false, error: 'unauthorized' } };
    }

    try { validatePhaseRequest(parsed); }
    catch { return {status:400,body:{ok:false,error:'EXECUTION_REQUEST_INVALID'}}; }
    if(parsed.requestId!==requestId||parsed.triggerSource!=='cloudflare')return {status:400,body:{ok:false,error:'EXECUTION_IDENTITY_INVALID'}};
    prune(at);
    const identity=bodySha256(body),previous=recent.get(requestId);
    if(previous) {
      if(previous.identity!==identity)return {status:409,body:{ok:false,error:'REQUEST_ID_CONFLICT'}};
      return previous.promise;
    }
    const started=Date.now();
    log.info('briefing_trigger_received',{source:'cloudflare',phase:parsed.phase});
    const promise=(async()=>{
      try {
        const response=await runPhase({request:parsed,body});
        log.info('briefing_trigger_finished',{source:'cloudflare',phase:parsed.phase,duration_ms:Date.now()-started});
        return response;
      } catch(error) {
        const code=['REQUEST_ID_CONFLICT','REQUEST_PENDING','SYNC_HANDOFF_REJECTED','EXECUTION_CONFIG_CHANGED','RELEASE_CHECKOUT_MISMATCH'].includes(error?.code)?error.code:'PHASE_EXECUTION_FAILED';
        return {status:['REQUEST_ID_CONFLICT','REQUEST_PENDING'].includes(code)?409:['SYNC_HANDOFF_REJECTED','RELEASE_CHECKOUT_MISMATCH'].includes(code)?403:503,
          body:{ok:false,error:code}};
      }
    })();
    recent.set(requestId,{at,identity,promise});
    return promise;
  };
}
