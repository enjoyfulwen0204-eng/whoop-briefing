import { createHash } from 'node:crypto';

/** Engineering constants, not a validated clinical measure. This registry has
 * no publication gate, worker, transport, environment or model dependency. */
export const BODY_ENERGY = Object.freeze({
  algorithm:'body-energy-v1.2.0', constants:'body-energy-constants-v3', baseline:'robust-baseline-v1',
  metrics:'body-energy-metrics-v1', manifest:'body-energy-inputs-v1',
  sleepWeight:0.65, autonomicWeight:0.35, initialFloor:40, initialGain:0.60,
  baselineTarget:30, baselineLookback:45, baselineMinimum:7, madScale:1.4826, iqrScale:1.349,
  zLimit:3, wakeMaxHours:36, freshMinutes:90, requiredSyncMaxHours:24, loadSyncMaxHours:6,
  cycleWakeToleranceHours:2, firstWakeHours:8, earlyDepletion:1.60, lateDepletion:2.30,
  cycleMultiplier:0.85, cycleExponent:1.25, workoutMultiplier:0.75, workoutExponent:1.15,
  workoutCap:24, strainMax:21, napMinMinutes:20, napMaxMinutes:180, napWaitMinutes:15,
  napBase:2, napPerMinute:0.06, napCap:12, napDayCap:15, checkpointMs:900000,
  correctionHorizonDays:45,
});
// Public, non-health constants only. Health content uses per-artifact salted
// keyed digests in bodyEnergyStore, never this unkeyed constants digest.
export const BODY_ENERGY_CONSTANTS_HASH=createHash('sha256')
  .update(JSON.stringify(Object.fromEntries(Object.entries(BODY_ENERGY).sort(([a],[b])=>a<b?-1:a>b?1:0)))).digest('hex');
export function bodyEnergyVersion(version=BODY_ENERGY.algorithm) {
  if(version!==BODY_ENERGY.algorithm)throw new Error('BODY_ENERGY_ALGORITHM_UNREGISTERED');
  return BODY_ENERGY;
}
