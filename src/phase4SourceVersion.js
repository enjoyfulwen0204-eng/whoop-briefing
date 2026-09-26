// Health adapters own this tuple grammar: updated_at, synced_at, as_of_utc,
// score_state. Opaque external versions are never interpreted as timestamps.
import { canonicalJson } from './phase4EntityStore.js';
const instant=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  &&Number.isFinite(Date.parse(value));
export const canonicalSourceTime=value=>instant(value)?new Date(value).toISOString():value;
export function canonicalSourceVersion(value) {
  let tuple;try {tuple=JSON.parse(value);}catch{return value;}
  if(!Array.isArray(tuple)||tuple.length!==4||tuple.slice(0,3).some(v=>v!==null&&!instant(v))
    ||tuple[3]!==null&&typeof tuple[3]!=='string')return value;
  return canonicalJson([...tuple.slice(0,3).map(canonicalSourceTime),tuple[3]]);
}
export const healthSourceVersion=row=>canonicalSourceVersion(canonicalJson([
  row.updated_at??null,row.synced_at??null,row.as_of_utc??null,row.score_state??null]));
export const canonicalObservation=row=>Object.fromEntries(Object.entries(row??{}).map(([key,value])=>[key,
  key==='sourceVersion'?canonicalSourceVersion(value):['observedAt','ingestedAt'].includes(key)?canonicalSourceTime(value):value]));
