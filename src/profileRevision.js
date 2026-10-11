import {createHash} from 'node:crypto';
import {requireUserId} from './userContext.js';
export const PROFILE_REVISION_PREFIX='canonical-profile-revision:v1:';
export const profileRevisionKey=uid=>PROFILE_REVISION_PREFIX+createHash('sha256').update(requireUserId(uid,'profileRevision')).digest('hex');
const invalid=()=>{throw Error('PROFILE_REVISION_INVALID');};
/** Existing durable key-value storage; reserved forever, never an expiring
 * Settings session. All canonical profile writers share this transaction. */
export async function profileRevision(client,uid,{initialize=true}={}) {
 const key=profileRevisionKey(uid);
 if(initialize)await client.execute({sql:`INSERT INTO telegram_state(key,value,updated_at)
  SELECT ?,'0',updated_at FROM users WHERE id=? ON CONFLICT(key) DO NOTHING`,args:[key,uid]});
 const row=(await client.execute({sql:'SELECT value FROM telegram_state WHERE key=?',args:[key]})).rows[0];
 if(!row||typeof row.value!=='string'||! /^(0|[1-9][0-9]*)$/.test(row.value)||!Number.isSafeInteger(Number(row.value)))invalid();
 return Number(row.value);
}
export async function assertProfileRevision(client,uid,expected) {
 const revision=await profileRevision(client,uid);
 if(expected!==undefined&&(!Number.isSafeInteger(expected)||revision!==expected))throw Error('PROFILE_REVISION_CONFLICT');
 return revision;
}
export async function advanceProfileRevision(client,uid,revision,now) {
 if(revision>=Number.MAX_SAFE_INTEGER)invalid();
 const rs=await client.execute({sql:'UPDATE telegram_state SET value=?,updated_at=? WHERE key=? AND value=?',
  args:[String(revision+1),now.toISOString(),profileRevisionKey(uid),String(revision)]});
 if(rs.rowsAffected!==1)throw Error('PROFILE_REVISION_CONFLICT');
}
