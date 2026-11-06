import {BASELINE} from './config.js';
import {addDays,localDate} from './time.js';
import {computeDailyMetrics} from './dailyMetrics.js';
import {seriesByMetric,whatChangedToday} from './analytics/index.js';

export const MORNING_RESOURCES=Object.freeze(['sleep','recovery','cycle']);
/** Read back the canonical versions admitted by the existing sync writer.
 * Never render provider fragments rejected by tombstone/version/tenant fences.
 * The caller binds and rechecks the existing Coach source-generation snapshot.
 */
export async function readMorningHistory({db,userId,timezone,now}){
 const to=localDate(now,timezone),from=addDays(to,-BASELINE.LOOKBACK_DAYS);
 const [sleeps,recoveries,cycles]=await Promise.all([
  db.getSleeps(userId,{from,to,includeNaps:true}),db.getRecoveries(userId,{from,to}),
  db.getCycles(userId,{fromIso:new Date(now.getTime()-BASELINE.LOOKBACK_DAYS*86400000).toISOString(),toIso:now.toISOString()}),
 ]);
 const revive=rows=>rows.map(row=>{
  if(typeof row.raw_json!=='string')throw Object.assign(Error('MORNING_SOURCE_UNAVAILABLE'),{code:'MORNING_SOURCE_UNAVAILABLE'});
  return JSON.parse(row.raw_json);
 });
 return {sleeps:revive(sleeps),recoveries:revive(recoveries),cycles:revive(cycles)};
}

/** The report and What Changed share exactly one in-memory history. No second
 * database observation, and no invented workout/body-measurement evidence. */
export function morningInsights(history,timezone,healthDate){
 const wrap=rows=>rows.map(row=>({raw_json:JSON.stringify(row),nap:row.nap===true?1:0}));
 const rows=computeDailyMetrics({sleepRows:wrap(history.sleeps),recoveryRows:wrap(history.recoveries),
  cycleRows:wrap(history.cycles),timezone,available:{workouts:false,bodyMeasurement:false}});
 const series=seriesByMetric(rows);
 return {historyDays:rows.length,whatChanged:whatChangedToday(series,healthDate,{maxItems:Object.keys(series).length})};
}
