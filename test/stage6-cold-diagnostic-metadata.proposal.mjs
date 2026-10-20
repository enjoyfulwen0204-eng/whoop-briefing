/** PURE DIAGNOSTICS ONLY. No native/DB/provider/CLI/authority on import.
 * Callback writes finite private diagnostic records, never execution receipts.
 */
import assert from 'node:assert/strict';
export const DIAGNOSTIC_CONTRACT='stage6-native-cold-diagnostic-record-v1';
export const SETTLEMENT_RESERVE_MS=15000;
export const NATIVE_STAGES=Object.freeze(['APP_IMPORT_ENTER','APP_BOOTSTRAP_FAILURE','APP_ENTER','SETUP_ENTER','SETUP_RETURNED','ADMISSION_ENTER','ADMISSION_RETURNED','COLD_BOUNDARY_ENTER','COLD_BOUNDARY_RETURNED','CALL_INTENT_DURABLE','CALL_RETURNED','LEG_METADATA_READY','APP_FAILURE','DB_CLOSE_ENTER','DB_CLOSE_RETURNED','TRANSPORT_IDLE_ENTER','TRANSPORT_IDLE_RETURNED','REPORT_WRITTEN','WORK_BOUND_REACHED']);
export const MAX_NATIVE_RECORDS=23;
const own=(value,key)=>Object.getOwnPropertyDescriptor(value,key)?.value;
export function diagnosticRecord(input){
 assert.equal(Object.getPrototypeOf(input),Object.prototype);
 const fields=['phase','stage','callIntents','elapsedMs','failureCode','errorMessageSha256','terminalComplete','activeFetches','unresolvedStreams','unknownProtocolReplies'];
 assert.deepEqual(Reflect.ownKeys(input).sort(),[...fields].sort());
 const out={contract:DIAGNOSTIC_CONTRACT};
 for(const key of fields){const property=Object.getOwnPropertyDescriptor(input,key);assert.ok(property&&Object.hasOwn(property,'value'));out[key]=own(input,key);}
 assert.ok(['A','B'].includes(out.phase));assert.ok(NATIVE_STAGES.includes(out.stage));
 assert.ok(out.callIntents===null||Number.isSafeInteger(out.callIntents)&&out.callIntents>=0&&out.callIntents<=3);
 assert.ok(out.elapsedMs===null||Number.isFinite(out.elapsedMs)&&out.elapsedMs>=0&&out.elapsedMs<1e12);
 assert.ok(out.failureCode===null||['ERR_ASSERTION','NATIVE_COLD_PROOF_REFUSED'].includes(out.failureCode));
 assert.ok(out.errorMessageSha256===null||typeof out.errorMessageSha256==='string'&&/^[a-f0-9]{64}$/.test(out.errorMessageSha256));
 assert.ok(out.terminalComplete===null||typeof out.terminalComplete==='boolean');
 for(const field of ['activeFetches','unresolvedStreams','unknownProtocolReplies'])assert.ok(out[field]===null||Number.isSafeInteger(out[field])&&out[field]>=0&&out[field]<1e9);
 return Object.freeze(out);
}
export function createDiagnosticPublisher({phase,writeExclusive,elapsedMs}){
 assert.ok(['A','B'].includes(phase));assert.equal(typeof writeExclusive,'function');assert.equal(typeof elapsedMs,'function');let reserved=0;
 return input=>{
  assert.ok(reserved<MAX_NATIVE_RECORDS,'FINITE_DIAGNOSTIC_RECORD_LIMIT');
  const fields=['stage','callIntents','failureCode','errorMessageSha256','terminalComplete','activeFetches','unresolvedStreams','unknownProtocolReplies'];
  assert.equal(Object.getPrototypeOf(input),Object.prototype);assert.deepEqual(Reflect.ownKeys(input).sort(),[...fields].sort());const payload={};
  for(const key of fields){const property=Object.getOwnPropertyDescriptor(input,key);assert.ok(property&&Object.hasOwn(property,'value'));payload[key]=property.value;}
  const record=diagnosticRecord({phase,...payload,elapsedMs:elapsedMs()});
  const ordinal=++reserved; // consume before write; diagnostics never retry/grant work
  writeExclusive(`${phase}-progress-${String(ordinal).padStart(2,'0')}.private.json`,record);
  return record;
 };
}
