import { WHOOP_SYNC } from './config.js';
import { V18_READY_REQUIRED_RESOURCES } from './schema.js';
export const SYNC_OUTCOMES = Object.freeze(['COMPLETE_SUCCESS','NO_NEW_DATA_SUCCESS','INTENTIONALLY_INAPPLICABLE',
  'PARTIAL','REQUIRED_RESOURCE_FAILED','AUTH_FAILED','TIMEOUT','CANCELLED']);
export const syncAuthorizesDrain = result => ['COMPLETE_SUCCESS','NO_NEW_DATA_SUCCESS','INTENTIONALLY_INAPPLICABLE'].includes(result?.outcome);
export function summarizeSync(results, { expectedResources = WHOOP_SYNC.RESOURCES } = {}) {
  if (!Array.isArray(results)) return Object.freeze({outcome:'PARTIAL',complete:false,resources:[],processed:0});
  const statuses = results.map(r => r?.status);
  let outcome;
  if (statuses.includes('cancelled')) outcome = 'CANCELLED';
  else if (statuses.includes('timeout')) outcome = 'TIMEOUT';
  else if (statuses.some(s => ['auth_failed','stale_authorization'].includes(s)) || results.some(r=>r.failureOutcome==='AUTH_FAILED')) outcome = 'AUTH_FAILED';
  else if (results.some(r => V18_READY_REQUIRED_RESOURCES.includes(r.resource) && ['failed','scope_missing'].includes(r.status))) outcome = 'REQUIRED_RESOURCE_FAILED';
  else if ([...new Set([...expectedResources,...V18_READY_REQUIRED_RESOURCES])].some(name => !results.some(r => r.resource === name))
    || results.some(r => !['ok','throttled','scope_missing'].includes(r.status)
      || r.backfill?.complete === false)) outcome = 'PARTIAL';
  else if (statuses.every(s => s === 'scope_missing')) outcome = 'INTENTIONALLY_INAPPLICABLE';
  else if (results.every(r => r.status !== 'ok' || Number(r.fetched ?? r.incremental?.fetched ?? 0) === 0)) outcome = 'NO_NEW_DATA_SUCCESS';
  else outcome = 'COMPLETE_SUCCESS';
  const processed = results.reduce((n,r) => n+Number(r.written ?? r.incremental?.written ?? 0)+Number(r.backfill?.written ?? 0),0);
  return Object.freeze({outcome,complete:syncAuthorizesDrain({outcome}),resources:[...results],processed});
}
/** Preserve the repository's iterable resource API. Typed fields are immutable;
 * serialization always emits the canonical object rather than losing outcome. */
export function typedSyncResult(results, options) {
  const summary = summarizeSync(results, options), out = [...results];
  Object.defineProperties(out, Object.fromEntries(Object.entries(summary).map(([key,value])=>[key,{value}])));
  Object.defineProperty(out, 'toJSON', {value:()=>summary});
  return Object.freeze(out);
}
export function aggregateSyncOutcome(results = [], { failed = 0 } = {}) {
  for (const outcome of ['CANCELLED','TIMEOUT','AUTH_FAILED','REQUIRED_RESOURCE_FAILED','PARTIAL'])
    if (results.some(result => result.outcome === outcome)) return outcome;
  if (failed) return 'PARTIAL';
  if (!results.length || results.every(result => result.outcome === 'INTENTIONALLY_INAPPLICABLE')) return 'INTENTIONALLY_INAPPLICABLE';
  return results.some(result => result.outcome === 'COMPLETE_SUCCESS') ? 'COMPLETE_SUCCESS' : 'NO_NEW_DATA_SUCCESS';
}
