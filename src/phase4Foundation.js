import { buildPhase4Core, fail } from './phase4Core.js';
import { foundationFlags } from './phase4Flags.js';
import { composePhase4Stores } from './phase4Repositories.js';

/** Public pre-gate entry point. There is deliberately no LIVE option, issuer,
 * provider, configuration override or serialized capability argument. */
export async function createPhase4Foundation({db,keys,now=()=>new Date(),configuration={}}) {
  foundationFlags(configuration);
  const core=await buildPhase4Core({processing:{client:db.raw,transaction:db.transaction,active:db.processingTransactionActive,afterCommit:db.afterProcessingCommit},keys,now,
    authorizeMode(mode){if(mode!=='SHADOW')fail('PHASE4_LIVE_NOT_AUTHORIZED');}});
  return composePhase4Stores(core);
}
