import {requireRuntimeAdmission} from './runtimeAdmission.js';
const grants=new WeakMap();
/** Server composition only. Admission, the configured owner cohort and exact
 * v34 binary are prerequisites; request/model data cannot mint this brand. */
export function issueStage8LiveAuthority({db,keys,admission,userIds,enabled}){
 if(![34,35].includes(requireRuntimeAdmission(db.raw,admission,keys,db.transaction))||typeof enabled!=='function'||!enabled()
  ||!Array.isArray(userIds)||!userIds.length||userIds.some(v=>typeof v!=='string'||!v))throw Error('STAGE8_SERVER_AUTHORITY_REQUIRED');
 const grant=Object.freeze({});grants.set(grant,{client:db.raw,keys,userIds:new Set(userIds),enabled});return grant;
}
export function allowsStage8LiveAuthority(grant,client,keys,userId){
 const value=grants.get(grant);return Boolean(value&&value.client===client&&value.keys===keys&&value.userIds.has(userId)&&value.enabled());
}
