// Internal server composition only. Durable reply recipes contain opaque
// authority/profile metadata, never manifests or copied physiological inputs.
const boundaries=new WeakMap();
export function registerBodyEnergyTelegramReplyBoundary(db,verify){
  if(!db?.raw||typeof verify!=='function')throw Error('BODY_ENERGY_REPLY_BOUNDARY_REQUIRED');
  boundaries.set(db.raw,verify);
}
export async function verifyBodyEnergyTelegramReplyBoundary(db,recipe,userId){
  const verify=boundaries.get(db?.raw);if(!verify)return false;
  try{return await verify(recipe,userId)===true;}catch{return false;}
}
