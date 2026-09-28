export const TRIGGER_SOURCES=Object.freeze(['cloudflare','github','event','manual']);
export function requireTriggerSource(source) {
  if(!TRIGGER_SOURCES.includes(source))throw new Error('SCHEDULER_TRIGGER_REQUIRED');return source;
}
export const STAGE6_BUDGETS=Object.freeze({
  cloudflare:Object.freeze({maxWallMs:45000,safetyMarginMs:15000,maxJobs:8,maxItems:48,maxItemsPerTenant:6,leaseMs:60000}),
  github:Object.freeze({maxWallMs:90000,safetyMarginMs:15000,maxJobs:16,maxItems:128,maxItemsPerTenant:8,leaseMs:120000}),
  event:Object.freeze({maxWallMs:25000,safetyMarginMs:15000,maxJobs:2,maxItems:8,maxItemsPerTenant:4,leaseMs:40000}),
  manual:Object.freeze({maxWallMs:45000,safetyMarginMs:15000,maxJobs:8,maxItems:48,maxItemsPerTenant:6,leaseMs:60000}),
});
export function stage6Budget(source,overrides={}) {
  requireTriggerSource(source);const budget={...STAGE6_BUDGETS[source],...overrides};
  if(Object.keys(overrides).some(key=>!Object.hasOwn(STAGE6_BUDGETS[source],key))
    ||Object.values(budget).some(value=>!Number.isSafeInteger(value)||value<1)
    ||budget.maxWallMs>90000||budget.safetyMarginMs<1000||budget.safetyMarginMs>=budget.maxWallMs
    ||budget.maxJobs>100||budget.maxItems>500||budget.maxItemsPerTenant>32
    ||budget.leaseMs<budget.maxWallMs||budget.leaseMs>120000)throw new Error('PHASE4_DRAIN_BUDGET_INVALID');
  return Object.freeze(budget);
}
