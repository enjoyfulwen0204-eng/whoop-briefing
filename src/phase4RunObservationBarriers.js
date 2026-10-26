// Transport scheduling only. Each eligible original barrier still performs
// fresh context/owner observations. No accepted proof, clock or row survives.
// Run only after the original complete producer/receipt observation finishes.
export async function finishRunObservationBranches(branches,observe){
 const pending=[];
 for(let index=0;index<3;index++){
  const branch=branches[index];if(branch.error)break;
  pending.push(Promise.resolve().then(observe));
  if(index===0&&branch.found||index===1&&!branch.found)break;
 }
 const settled=await Promise.allSettled(pending);
 for(let index=0;index<3;index++){
  const branch=branches[index];if(branch.error)throw branch.error;
  if(settled[index].status==='rejected')throw settled[index].reason;
  if(index===0&&branch.found)return true;
  if(index===1&&!branch.found)return false;
  if(index===2)return branch.found;
 }
}
