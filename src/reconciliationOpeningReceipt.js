import {requirePhase4Keys} from './phase4Keys.js';
const modes=new Set(['incremental','explicit_window','deep_slice','point_in_time']);
const outcomes=new Set(['ready','input_fenced','pending_fenced']);
const fields=new Set(['keys','executionIdentity','executionScope','userId','resource','scope','owner','intent','leaseExpiresAt','lastAttemptAt','runId','mode','from','to','token','inputProof','outcome']);
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const invalid=()=>{throw Object.assign(Error('RECONCILIATION_OPENING_RECEIPT_INVALID'),{code:'RECONCILIATION_OPENING_RECEIPT_INVALID'});};
const instant=value=>{
 if(value===null)return null;
 if(value instanceof Date&&!Number.isFinite(value.getTime()))invalid();
 const text=value instanceof Date?value.toISOString():value;
 if(typeof text!=='string'||!Number.isFinite(Date.parse(text))||new Date(text).toISOString()!==text)invalid();
 return text;
};
/** Closed scalar receipt schema. An old numeric grant/run ID is not authority. */
export function parseOpeningReceipt(serialized){
 if(typeof serialized!=='string'||serialized.length>66)invalid();
 let value;try{value=JSON.parse(serialized);}catch{invalid();}
 if((value===0||digest(value))&&serialized===JSON.stringify(value))return value;invalid();
}
/** A full keyed digest binds the original input identity and every actual
 * opened bound. Persist no proof/window/token object or health payload. */
export function openingReceiptProof(metadata){
 if(!metadata||typeof metadata!=='object'||Reflect.ownKeys(metadata).length!==fields.size
  ||Reflect.ownKeys(metadata).some(name=>!fields.has(name)||!('value' in Object.getOwnPropertyDescriptor(metadata,name))))invalid();
 const {keys,executionIdentity,executionScope,userId,resource,scope,owner,intent,leaseExpiresAt,lastAttemptAt,runId,mode,from,to,token,inputProof,outcome}=metadata;
 if(!Number.isSafeInteger(runId)||runId<1||!modes.has(mode)||!outcomes.has(outcome)||!['recent','deep'].includes(scope)
  ||[executionIdentity,executionScope,userId,resource,scope,owner,intent].some(v=>typeof v!=='string'||!v)
  ||token!==null&&(typeof token!=='string'||!token)
  ||(outcome==='input_fenced'?inputProof!==null:!digest(inputProof)))invalid();
 const start=instant(from),end=instant(to);if(end===null||start!==null&&Date.parse(start)>=Date.parse(end))invalid();
 const expiry=instant(leaseExpiresAt),attempt=instant(lastAttemptAt);if(expiry===null||attempt===null||Date.parse(expiry)<=Date.parse(attempt))invalid();
 if(mode!=='point_in_time'&&start===null)invalid();
 return requirePhase4Keys(keys).lookup(['reconciliation-opening-receipt-v1',executionIdentity,executionScope,userId,resource,scope,owner,intent,expiry,attempt,
  runId,mode,start,end,token,inputProof,outcome]);
}
