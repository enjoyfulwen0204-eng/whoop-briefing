// Same source-validation failures as stage8MorningIntelligence. A failed
// optional step is skipped, never retried with replacement data or authority.
const recoverable=new Set(['PHASE4_PARENT_STALE','PHASE4_PARENT_NOT_FOUND','CONTENT_REDACTED','PHASE4_SOURCE_DELETED','PHASE4_SOURCE_NOT_FOUND','PHASE4_SOURCE_NOT_CURRENT','PHASE4_RESOURCE_FENCED','PHASE4_CAPABILITY_FENCED','PHASE4_INCOMPLETE_PROVENANCE','PHASE4_PARENT_LINK_MISSING','PHASE4_SOURCE_LINK_REQUIRED']);
const steps=new Set(['insight','daily','coach','weekly','low','family_daily','family_alert','family_weekly']);
export async function runCompanionStep({db,keys,userId,step,run}){
 if(!steps.has(step))throw Object.assign(Error('COMPANION_STEP_INVALID'),{code:'COMPANION_STEP_INVALID'});
 const started=Date.now();let status='EXCEPTION';
 try{const result=await run();status=typeof result?.status==='string'&&/^[A-Z][A-Z0-9_]{0,63}$/.test(result.status)?result.status:'UNKNOWN';return result;}
 catch(error){
  const code=error?.code??error?.message;
  // Nested source failures poison their transaction. Continue only after the
  // step has unwound it; never clear the failure or reuse a caller transaction.
  if(!recoverable.has(code)||typeof db.processingTransactionActive!=='function'||db.processingTransactionActive())throw error;
  try{console.log(JSON.stringify({event:'companion_step_skipped',step,code,user:keys.lookup(['companion-diagnostic-user-v1',userId])}));}catch{/* Diagnostics cannot change authority. */}
  status='SKIPPED';return {status:'SKIPPED'};
 }finally{
  try{console.log(JSON.stringify({event:'companion_step_timing',user:keys.lookup(['companion-diagnostic-user-v1',userId]),step,status,duration_ms:Math.max(0,Date.now()-started)}));}catch{/* Diagnostics cannot change authority. */}
 }
}
