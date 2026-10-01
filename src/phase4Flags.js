import { fail } from './phase4Core.js';

export const FOUNDATION_FLAG_NAMES = Object.freeze(['PHASE4_SCHEMA_WRITES','PHASE4_JOURNAL_REVISIONS','PHASE4_BODY_ENERGY_SHADOW',
  'PHASE4_EVIDENCE_SHADOW','PHASE4_EPISODES_SHADOW','PHASE4_REANALYSIS_WORKER','PHASE4_INSIGHT_MEMORY',
  'PHASE4_PROACTIVE_DECISIONS_SHADOW','PHASE4_OUTBOUND_PROPOSALS_SHADOW','PHASE4_DELIVERY_CUTOVER',
  'PHASE4_OUTBOUND_DELIVERY','PHASE4_MORNING_BRIEF','PHASE4_QA_CONTEXT']);
export const FOUNDATION_FLAGS = Object.freeze(Object.fromEntries(FOUNDATION_FLAG_NAMES.map(n=>[n,false])));
/** Foundation runtime flags remain disabled. Public Beta's separate SHADOW
 * runtime and presentation authorities do not enable these Foundation flags. */
export function foundationFlags(configuration={}) {
  if(FOUNDATION_FLAG_NAMES.some(n=>configuration[n]===true || configuration[n]==='true' || configuration[n]==='1'))
    fail('PHASE4_RUNTIME_NOT_AUTHORIZED');
  return FOUNDATION_FLAGS;
}
