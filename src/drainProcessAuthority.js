import {randomUUID} from 'node:crypto';
import {readSync,readFileSync} from 'node:fs';
import {Socket} from 'node:net';
import {requirePhase4Keys} from './phase4Keys.js';
import {currentDurableExecution} from './phase4ExecutionContext.js';
const issued=new WeakMap();
const cancelled=()=>Object.assign(Error('SYNC_CANCELLED'),{code:'SYNC_CANCELLED'});
const slotName=(keys,userId)=>'phase4:drain-parent:'+keys.lookup(['drain-parent-slot-v1','SHADOW',userId]);
const now="strftime('%Y-%m-%dT%H:%M:%fZ','now')";
export async function acquireDrainParentSlot({db,keys,userId,ttlMs}){
 requirePhase4Keys(keys);
 if(!Number.isSafeInteger(ttlMs)||ttlMs<1000||ttlMs>140000)throw Error('DRAIN_PARENT_BOUND_REQUIRED');
 const name=slotName(keys,userId),owner=randomUUID(),expiry=`strftime('%Y-%m-%dT%H:%M:%fZ','now','+' || ? || ' seconds')`;
 const result=await db.raw.batch([{sql:`INSERT INTO resource_locks(name,owner,acquired_at,expires_at) VALUES(?,?,${now},${expiry}) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,acquired_at=excluded.acquired_at,expires_at=excluded.expires_at WHERE resource_locks.expires_at<=${now}`,args:[name,owner,ttlMs/1000]},
  {sql:'SELECT owner,expires_at FROM resource_locks WHERE name=?',args:[name]}],'write');
 if(result[0].rowsAffected!==1||result[1].rows[0]?.owner!==owner)throw Object.assign(Error('DRAIN_CHILD_BUSY'),{code:'DRAIN_CHILD_BUSY'});
 return Object.freeze({name,owner,expiresAt:result[1].rows[0].expires_at});
}
export async function releaseDrainParentSlot(db,slot){
 await db.raw.execute({sql:'DELETE FROM resource_locks WHERE name=? AND owner=? AND expires_at=?',args:[slot.name,slot.owner,slot.expiresAt]});
}
// fd4 is a dedicated nonblocking ownership socket, never health data. EOF is
// synchronously observable even while a preparation callback occupies JS.
export function createDrainParentControl({parentPid,fd=4}){
 if(process.platform!=='linux'||!Number.isInteger(parentPid)||parentPid!==process.ppid||!process.connected)throw Error('DRAIN_PARENT_CHANNEL_REQUIRED');
 const controller=new AbortController(),byte=Buffer.alloc(1);let closed=false;
 const stop=()=>{if(!controller.signal.aborted)controller.abort(cancelled());};
 const socket=new Socket({fd,readable:true,writable:false});socket.on('error',stop);socket.on('end',stop);socket.unref();socket.resume();
 const flags=/^flags:\s+(\d+)/m.exec(readFileSync('/proc/self/fdinfo/'+fd,'utf8'));
 if(!flags||(parseInt(flags[1],8)&2048)===0){socket.destroy();throw Error('NONBLOCKING_PARENT_CHANNEL_REQUIRED');}
 const assert=()=>{
  if(closed||controller.signal.aborted||process.ppid!==parentPid||!process.connected){stop();throw cancelled();}
  try{if(readSync(fd,byte,0,1,null)===0){stop();throw cancelled();}}
  catch(error){if(!['EAGAIN','EWOULDBLOCK'].includes(error.code)){stop();throw cancelled();}}
 };
 return Object.freeze({signal:controller.signal,assert,stop,close(){closed=true;socket.destroy();}});
}
export function issueDrainProcessAuthority({db,keys,userId,request,slot,control,notify=()=>{}}){
 requirePhase4Keys(keys);
 if(request.phase!=='STAGE6_DRAIN'||request.executionMode!=='SHADOW'||slot.name!==slotName(keys,userId)
  ||typeof slot.owner!=='string'||!Number.isFinite(Date.parse(slot.expiresAt))||typeof control.assert!=='function')throw Error('DRAIN_PARENT_AUTHORITY_REQUIRED');
 control.assert();const token=Object.freeze({});issued.set(token,{db,keys,request,userId,slot,control,notify});return token;
}
export function drainProcessLocalAuthority(token,{db,keys,request}){
 if(token===undefined)return undefined;const p=issued.get(token);
 if(!p||p.db!==db||p.keys!==keys||p.request!==request)throw Error('DRAIN_PARENT_AUTHORITY_REQUIRED');
 return p.control.assert;
}
export function drainProcessPublicationFence(token,db){
 if(token===undefined)return null;const p=issued.get(token),execution=currentDurableExecution();
 if(!p||p.db!==db||execution?.claim.request.requestId!==p.request.requestId)throw Error('DRAIN_PARENT_AUTHORITY_REQUIRED');
 p.control.assert();return {sql:`SELECT json(CASE WHEN EXISTS(SELECT 1 FROM resource_locks WHERE name=? AND owner=? AND expires_at=? AND expires_at>${now}) THEN 'true' ELSE 'DRAIN_PARENT_LEASE_REVOKED' END) verified`,args:[p.slot.name,p.slot.owner,p.slot.expiresAt]};
}
export function notifyDrainProcessBoundary(stage){const p=issued.get(currentDurableExecution()?.processAuthority);if(p){p.control.assert();p.notify(stage);}}
