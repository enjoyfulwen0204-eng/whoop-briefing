import {createHash} from 'node:crypto';
// Owner-authorized existing three subjects, independently reconciled against
// Production ACTIVE/READY/private bindings on 2026-10-16. No identities or
// health data are published here. This is a fixed cohort, never all READY users.
const APPROVED_THREE_DIGEST='778e727d8f31f759ef26ff5776a071987263380e1063ba65f297d487b2060f46';
export function isApprovedStage7Three(userIds){
 if(!Array.isArray(userIds)||userIds.length!==3||userIds.some(id=>typeof id!=='string'||!id||id!==id.trim())||new Set(userIds).size!==3)return false;
 return createHash('sha256').update(JSON.stringify([...userIds].sort())).digest('hex')===APPROVED_THREE_DIGEST;
}
