import { isLifecycleFenced, LifecycleContextError } from './accountLifecycle.js';

export const SCHEDULED_OUTPUT_WRITERS = Object.freeze([
  'savePredictionModel', 'savePrediction', 'recordPredictionActual',
  'saveHealthspanMetrics', 'saveHealthspanSnapshot',
]);

/** Short durable-write fences. Calculations and network I/O stay outside transactions.
 * Phase 3 async analytics keeps its stronger owner/generation/lease fence separately.
 */
export function lifecycleOutputDb(db, { userId, expectedLifecycleGeneration, writers }) {
  if (!isLifecycleFenced(expectedLifecycleGeneration)) throw new LifecycleContextError('lifecycleOutputDb');
  const check = () => db.assertAccountActive(userId, expectedLifecycleGeneration);
  const view = { ...db };
  for (const name of writers) {
    if (typeof db[name] !== 'function') continue;
    view[name] = (...args) => {
      const uid = name === 'recordPredictionActual' ? args[0]?.userId : args[0];
      if (uid !== userId) throw new Error('lifecycle_output_user_mismatch');
      return db.transaction(() => db[name](...args), { before: check, after: check });
    };
  }
  return view;
}
