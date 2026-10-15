// Pure bounded controller selection; grants and execution authority stay in
// their original monitored runtime. No DB mutation or permit issuance here.
import assert from 'node:assert/strict';
export function syntheticSelection(cohort,environment){
 const focused=environment.STAGE6_SYNTHETIC_FOCUSED==='1',maxLegs=focused?Number(environment.STAGE6_SYNTHETIC_FOCUSED_LEGS??1):4093,target=environment.STAGE6_SYNTHETIC_TARGET;
 assert.ok(!focused||Number.isSafeInteger(maxLegs)&&maxLegs>=1&&maxLegs<=6);assert.ok(!target||focused&&cohort.some(t=>t.id===target));
 return {focused,maxLegs,target};
}
export function nextSyntheticTenant(cohort,jobs,pending,leg,selection){
 const candidates=pending?cohort.filter(t=>t.id===pending.userId):selection.target?cohort.filter(t=>t.id===selection.target):cohort.map((_,i)=>cohort[(leg+i)%cohort.length]);
 const tenant=candidates.find(t=>pending||jobs.some(j=>j.user_id===t.id&&j.completed_generation<j.requested_generation));assert.ok(tenant);return tenant;
}
