/** Arithmetic only: no invented provider quota or default rollout duration.
 * Evidence-backed caller inputs are required. This does not archive authority. */
export function finiteBetaCapacity(input={}) {
 const fields=['capacityBytes','usedBytes','dailyBaseGrowthBytes','dailyShadowGrowthBytes','largestTransactionBytes','incidentResponseDays','approvedBetaDays'];
 if(!fields.every(k=>Number.isFinite(input[k])&&input[k]>=0)||input.capacityBytes===0||!input.providerEvidence||!input.growthEvidence)
  return {disposition:'F06_CAPACITY_ARCHITECTURE_APPROVAL_REQUIRED',reason:'VERIFIED_CAPACITY_AND_GROWTH_REQUIRED'};
 const reserve=input.dailyBaseGrowthBytes*input.incidentResponseDays+input.largestTransactionBytes;
 const daily=input.dailyBaseGrowthBytes+input.dailyShadowGrowthBytes;
 const remaining=input.capacityBytes-input.usedBytes-reserve;
 const maximumDays=daily===0?null:Math.max(0,Math.floor(remaining/daily));
 return {disposition:'F06_CAPACITY_ARCHITECTURE_APPROVAL_REQUIRED',
  fitsSuppliedEnvelope:remaining>=0&&maximumDays!==null&&input.approvedBetaDays<=maximumDays,
  reserveBytes:reserve,remainingBetaBytes:Math.max(0,remaining),maximumDays,stopShadowAtBytes:input.capacityBytes-reserve,
  archival:'ARCHITECTURE_APPROVAL_REQUIRED',permanentRetention:'NOT_PROVEN'};
}
