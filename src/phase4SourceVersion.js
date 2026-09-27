// Adapter-owned health tuples use the shared lossless instant contract.
// Non-tuple external version strings remain opaque.
import { canonicalJson } from './phase4EntityStore.js';
import { canonicalInstant } from './phase4Time.js';
export const canonicalSourceTime=value=>value==null?value:canonicalInstant(value);
export function canonicalSourceVersion(value) {
  let tuple;try {tuple=JSON.parse(value);}catch{return value;}
  if(!Array.isArray(tuple)||tuple.length!==4||tuple[3]!==null&&typeof tuple[3]!=='string'
    ||tuple.slice(0,3).some(v=>v!==null&&(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}T/.test(v))))return value;
  return canonicalJson([...tuple.slice(0,3).map(canonicalSourceTime),tuple[3]]);
}
export const healthSourceVersion=row=>canonicalJson([
  ...[row.updated_at,row.synced_at,row.as_of_utc].map(value=>canonicalSourceTime(value??null)),row.score_state??null]);
export const canonicalObservation=row=>Object.fromEntries(Object.entries(row??{}).map(([key,value])=>[key,
  key==='sourceVersion'?canonicalSourceVersion(value):['observedAt','ingestedAt'].includes(key)?canonicalSourceTime(value):value]));
