// Test-only process death after a committed checkpoint, with its lease held.
import { createOwnedDb } from './stage5OwnedDb.js';
import { fixtureKeys } from './localDb.js';
import { buildPhase4Core } from '../src/phase4Core.js';
import { composePhase4Stores } from '../src/phase4Repositories.js';
import { createReanalysisQueue } from '../src/phase4ReanalysisQueue.js';
const filename=process.argv[2];
if(!filename?.includes('/stage6-crash-')||!filename.endsWith('/synthetic.db'))throw Error('SYNTHETIC_DB_REQUIRED');
const db=createOwnedDb({url:`file:${filename}`}),now=()=>new Date('2026-09-25T12:00:00.000Z');
const core=await buildPhase4Core({processing:{client:db.raw,transaction:db.transaction,active:db.processingTransactionActive,
  afterCommit:db.afterProcessingCommit,afterCompletion:db.afterProcessingCompletion},keys:fixtureKeys,now,
  authorizeMode:mode=>{if(mode!=='SHADOW')throw Error('SHADOW_ONLY');}});
const stores=composePhase4Stores(core),q=createReanalysisQueue(core);
await stores.withContext('a',{executionMode:'SHADOW'},async context=>{
  const lease=await q.claim(context,'RECOMPUTE_DERIVED');
  await q.owned(context,lease,async()=>{
    await stores.bodyEnergy.compute(context,{asOfEpochMs:now().getTime()});
    await q.checkpoint(context,lease,'["USER","a"]');
  });
  process.exit(99);
});
