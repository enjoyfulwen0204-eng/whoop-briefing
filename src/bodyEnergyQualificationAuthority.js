import {BODY_ENERGY_PROVISIONAL_POLICY} from './bodyEnergyProvisionalPolicy.js';
import {BODY_ENERGY_NOTIFICATION_POLICY} from './bodyEnergyNotificationPolicy.js';
import {requireUserId} from './userContext.js';
import {validateBodyEnergyQualificationPacket,BODY_ENERGY_RELEASE_CRITERIA} from './bodyEnergyReleaseCriteria.js';

/** Temporary release gate. Replace only with the exact genuinely reviewed
 * qualification packet after private evaluation and independent Final Gate.
 * An environment value/request cannot register approval or bypass this state. */
export const BODY_ENERGY_QUALIFICATION_REGISTRATION=Object.freeze({
  state:'PENDING_GENUINE_EVIDENCE_AND_FINAL_GATE',criteriaVersion:BODY_ENERGY_RELEASE_CRITERIA.version,
  qualificationId:null,approvedPacket:null,
});
const capabilities=new WeakMap();
const fail=code=>{throw Object.assign(new Error(code),{code});};
async function assertMemoryFixture(db){
  if(!db?.raw||db.raw.protocol!=='file')fail('BODY_ENERGY_FIXTURE_MEMORY_REQUIRED');
  const databases=(await db.raw.execute('PRAGMA database_list')).rows;
  // SQLite runtime admission can materialize its internal temp schema. It is
  // still the same memory-only fixture, never another attached database.
  if(databases.length<1||databases.length>2||databases.filter(row=>row.name==='main').length!==1
    ||new Set(databases.map(row=>row.name)).size!==databases.length
    ||databases.some(row=>!['main','temp'].includes(row.name)||row.file!==''))fail('BODY_ENERGY_FIXTURE_MEMORY_REQUIRED');
}
function cohort(users){
  if(!Array.isArray(users)||users.length<1||users.length>2)fail('BODY_ENERGY_CONTROLLED_COHORT_REQUIRED');
  return new Set(users.map(id=>requireUserId(id,'bodyEnergyCohort')));
}
export function authorizeBodyEnergyPublication({db,userIds,notificationUserIds=[],qualificationId}={}){
  const registration=BODY_ENERGY_QUALIFICATION_REGISTRATION;
  if(registration.state!=='APPROVED'||qualificationId!==registration.qualificationId
    ||!validateBodyEnergyQualificationPacket(registration.approvedPacket).complete)return null;
  if(!db?.raw)fail('BODY_ENERGY_DATABASE_AUTHORITY_REQUIRED');
  const users=cohort(userIds),notifications=new Set(notificationUserIds.map(id=>requireUserId(id,'bodyEnergyAlertConsent')));
  if([...notifications].some(id=>!users.has(id)))fail('BODY_ENERGY_ALERT_COHORT_REQUIRED');
  if(notifications.size&&(registration.approvedPacket.approvedNotificationPolicy!==BODY_ENERGY_NOTIFICATION_POLICY.version
    ||registration.approvedPacket.approvals?.bodyEnergyNotificationPolicy?.status!=='PASS'
    ||!/^[a-f0-9]{64}$/.test(registration.approvedPacket.approvals?.bodyEnergyNotificationPolicy?.evidenceSha256??'')))
    fail('BODY_ENERGY_ALERT_POLICY_NOT_QUALIFIED');
  const capability=Object.freeze({});capabilities.set(capability,{db,connection:db.raw,users,notifications,fixture:false});return capability;
}
/** The owner explicitly authorized this separate baseline-only presentation
 * policy. It does not approve or mutate the pending mature qualification packet.
 * Server composition binds the singleton to the existing canonical owner profile;
 * lifecycle, producing result, currentness and delivery are checked on every read. */
export function authorizeBodyEnergyOwnerProvisional({db,userIds,ownerUserId,notificationUserIds=[],qualificationId}={}){
  if(qualificationId!==BODY_ENERGY_PROVISIONAL_POLICY.version)return null;
  if(!db?.raw)fail('BODY_ENERGY_DATABASE_AUTHORITY_REQUIRED');
  const users=cohort(userIds),owner=requireUserId(ownerUserId,'bodyEnergyOwner');
  if(users.size!==1||!users.has(owner)||notificationUserIds.length)fail('BODY_ENERGY_PROVISIONAL_OWNER_ONLY');
  const capability=Object.freeze({});capabilities.set(capability,{db,connection:db.raw,users,notifications:new Set(),fixture:false,
    presentationPolicy:BODY_ENERGY_PROVISIONAL_POLICY.version});return capability;
}
/** Positive integration tests own an empty-filename in-memory DB; neither a
 * file-backed fixture nor a real provider destination can receive this grant. */
export async function authorizeBodyEnergyFixturePublication({db,userIds,notificationUserIds=[],presentationPolicy=null}={}){
  await assertMemoryFixture(db);
  if(presentationPolicy!==null&&presentationPolicy!==BODY_ENERGY_PROVISIONAL_POLICY.version)fail('BODY_ENERGY_PRESENTATION_POLICY_INVALID');
  if(presentationPolicy&&(userIds.length!==1||notificationUserIds.length))fail('BODY_ENERGY_PROVISIONAL_OWNER_ONLY');
  const users=cohort(userIds),notifications=new Set(notificationUserIds);
  if([...notifications].some(id=>!users.has(id)))fail('BODY_ENERGY_ALERT_COHORT_REQUIRED');
  const capability=Object.freeze({});capabilities.set(capability,{db,connection:db.raw,users,notifications,fixture:true,presentationPolicy});return capability;
}
export async function assertBodyEnergyPublication(capability,db,userId,{purpose='read'}={}){
  const grant=capabilities.get(capability),id=requireUserId(userId,'bodyEnergyPublication');
  if(!['read','alerts'].includes(purpose)||!grant||grant.db!==db||grant.connection!==db.raw||!grant.users.has(id)
    ||purpose==='alerts'&&!grant.notifications.has(id))fail('BODY_ENERGY_PUBLICATION_NOT_QUALIFIED');
  if(grant.fixture){
    await assertMemoryFixture(db);
  }else if(!grant.presentationPolicy&&(BODY_ENERGY_QUALIFICATION_REGISTRATION.state!=='APPROVED'
    ||!validateBodyEnergyQualificationPacket(BODY_ENERGY_QUALIFICATION_REGISTRATION.approvedPacket).complete))
    fail('BODY_ENERGY_PUBLICATION_NOT_QUALIFIED');
  return {fixture:grant.fixture,presentationPolicy:grant.presentationPolicy??null};
}
