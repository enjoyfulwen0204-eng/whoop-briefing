import { fail } from './phase4Core.js';

/** Stage 5 instants have an explicit offset and lossless millisecond precision.
 * Extra fractional zeroes are spelling, extra nonzero digits are information.
 * Date.parse alone accepts local time, rollover dates and precision loss. */
export function canonicalInstant(value) {
  const m=typeof value==='string'&&value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/);
  if(!m||Number(m[2])>23||Number(m[3])>59||Number(m[4])>59
    ||Number(m[8]??0)>23||Number(m[9]??0)>59||/[1-9]/.test((m[5]??'').slice(3)))fail('PHASE4_SEMANTIC_TIME_INVALID');
  const day=new Date(`${m[1]}T00:00:00.000Z`);
  if(!Number.isFinite(day.getTime())||day.toISOString().slice(0,10)!==m[1])fail('PHASE4_SEMANTIC_TIME_INVALID');
  const parsed=Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${(m[5]??'').padEnd(3,'0').slice(0,3)}${m[6]}`);
  if(!Number.isFinite(parsed))fail('PHASE4_SEMANTIC_TIME_INVALID');
  const canonical=new Date(parsed).toISOString();
  if(canonical.length!==24)fail('PHASE4_SEMANTIC_TIME_INVALID');
  return canonical;
}

export function semanticTime(value) {
  if(value===null||value===undefined||value==='')fail('PHASE4_SEMANTIC_TIME_REQUIRED');
  return canonicalInstant(value);
}

export function requireChronology(at,predecessor,now) {
  const value=canonicalInstant(at);
  if(Date.parse(value)>now.getTime()||predecessor&&Date.parse(value)<Date.parse(canonicalInstant(predecessor)))
    fail('PHASE4_SEMANTIC_CHRONOLOGY_INVALID');
  return value;
}
