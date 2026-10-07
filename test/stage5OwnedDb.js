/** Synthetic file-backed regression fixture. Real installed SQL/transactions,
 * with connection ownership isolated from the native finalizer race. */
import {createOwnedFileDb} from '../src/db.js';
import {fixtureKeys} from './localDb.js';
export function createOwnedDb({url}) {
  const db=createOwnedFileDb({url,phase4Keys:fixtureKeys}),close=db.close;
  const collect=async()=>{global.gc?.();await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));};
  // Frozen migration regressions explicitly target the Stage 5 schema. New
  // Stage 6 migration tests pass targetVersion:28 instead of changing them.
  return {...db,migrate:options=>db.migrate({targetVersion:27,...options}),close:async()=>{await collect();close();await collect();}};
}
