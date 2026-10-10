/** Synthetic local fixtures only. These keys are never application defaults. */
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createOwnedFileDb,createDb as createApplicationDb} from '../src/db.js';
import { createPhase4Keys } from '../src/phase4Keys.js';
export * from '../src/db.js';
export const fixtureKeys = createPhase4Keys({ lookupKey: Buffer.alloc(32, 71), auditKey: Buffer.alloc(32, 83) });
export function createDb(options) {
  if (options.url !== ':memory:' && !options.url?.startsWith('file:')) throw new Error('synthetic_local_database_only');
  if(options.url === ':memory:'){
    // The normal native driver rotates unnamed memory connections. Use the
    // existing privately owned file seam, with memory-like fixture lifetime,
    // so private admission and transaction identity stay faithfully enforced.
    const dir=mkdtempSync(join(tmpdir(),'owned-memory-fixture-'));
    const db=createOwnedFileDb({url:'file:'+join(dir,'fixture.db'),phase4Keys:fixtureKeys}),close=db.close;
    return {...db,close:()=>{close();rmSync(dir,{recursive:true,force:true});}};
  }
  return createApplicationDb({ phase4Keys: fixtureKeys, ...options });
}
