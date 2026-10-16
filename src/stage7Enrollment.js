/** The existing v33 onboarding row and monotonic actor/profile generations
 * identify this enrollment. No automatic delivery may outlive that authority. */
export async function captureStage7Enrollment({core,db,actor}){
 const row=(await core.client.execute({sql:`SELECT state,state_changed_at,updated_at,created_at,
  timezone_confirmed_at,whoop_authorized_at,sync_started_at,ready_at FROM user_onboarding WHERE user_id=?`,
  args:[actor.control.userId]})).rows[0];
 if(!row||row.state!=='READY')return null;
 return {version:'stage7-ready-enrollment-v1',...row,lifecycleGeneration:actor.state.lifecycle_generation,
  authGeneration:actor.state.auth_generation,profileRevision:await db.getProfileRevision(actor.control.userId)};
}
export const sameStage7Enrollment=(selected,current)=>Boolean(selected&&current&&JSON.stringify(selected)===JSON.stringify(current));
export async function assertStage7Enrollment({core,db,actor,row}){
 if(!sameStage7Enrollment(JSON.parse(row?.schedule_json??'null')?.enrollment,await captureStage7Enrollment({core,db,actor})))
  throw Object.assign(Error('STAGE7_ENROLLMENT_FENCED'),{code:'STAGE7_ENROLLMENT_FENCED'});
}
