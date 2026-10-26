// Server-selected LIVE-only scheduling policy. This grants no execution,
// tenant, source, quota, retry or publication authority. The existing worker
// still owns every fresh fence, atomic unit, deadline and durable receipt.
export const STAGE8_LIVE_DRAIN_BUDGET=Object.freeze({maxItemsPerTenant:12});
