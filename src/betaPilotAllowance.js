// Owner-approved financial monitoring policy, NOT a provider billing certificate.
// Exact owner decision: US$2 first 24h, formal worst-case proof waived.
export const OWNER_PILOT_APPROVAL_SHA256='16a81ce80b2b81fc4d051066c4e82e96a1383e2398b165a4a42bc8e136571e8f';
const allowance=Object.freeze({kind:'OWNER_APPROVED_MONITORED_ALLOWANCE',id:OWNER_PILOT_APPROVAL_SHA256,
 approvalSha256:OWNER_PILOT_APPROVAL_SHA256,budgetMicroUsd:2_000_000,
 estimatedMicroUsdPerAttempt:100_000,operationalEstimateMicroUsd:1_200_000,maxAttempts:12,warningAttempt:10});
export const reviewedPilotAllowance=id=>id===allowance.id?allowance:null;
export const isReviewedPilotAllowance=value=>value===allowance;
export function pilotStopRequested(environment={}){
 const value=environment.PHASE4_BETA_PILOT_STOP??'off';
 if(!['off','on'].includes(value))throw Object.assign(Error('BETA_PILOT_DENIED'),{code:'BETA_PILOT_DENIED'});
 return value==='on';
}
