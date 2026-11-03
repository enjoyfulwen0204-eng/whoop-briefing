import {timingSafeEqual} from 'node:crypto';
import {workStepOptions} from './phase4WorkStep.js';
const fail=()=>{throw Object.assign(Error('MORNING_SNAPSHOT_INVALID'),{code:'MORNING_SNAPSHOT_INVALID'});};
/** Minimum immutable values for this original send attempt, never a replacement
 * for its claim/receipt. A new lifecycle or a different claim cannot reuse it. */
export function createMorningSnapshotStore({db,keys}){
 const control=async userId=>{
  const row=(await db.raw.execute({sql:`SELECT u.status,u.lifecycle_generation,t.auth_generation,p.purge_generation,p.pending_purge_count
   FROM users u JOIN user_whoop_tokens t ON t.user_id=u.id JOIN phase4_user_state p ON p.user_id=u.id WHERE u.id=?`,args:[userId]})).rows[0];
  if(!row||row.status!=='ACTIVE'||row.pending_purge_count!==0)return null;
  return row;
 };
 const identity=(userId,healthDate,claim,c)=>[userId,healthDate,claim.lifecycleGeneration,claim.owner,c.auth_generation,c.purge_generation];
 const key=scope=>'morning-snapshot:'+keys.lookup(['morning-snapshot-v1',...scope]);
 const seal=(scope,body)=>JSON.stringify({body,signature:keys.lookup(['morning-snapshot-v1',...scope,body])});
 function open(scope,raw){
  if(raw==null)return null;
  try{const v=JSON.parse(raw),b=v.body,expected=keys.lookup(['morning-snapshot-v1',...scope,b]);
   if(Object.keys(v).sort().join(',')!=='body,signature'||Object.keys(b).sort().join(',')!=='minutes,recovery,sleep'
    ||!Number.isFinite(b.minutes)||b.minutes<0||!Number.isFinite(b.recovery)||b.recovery<0||b.recovery>100
    ||!/^[a-f0-9]{64}$/.test(b.sleep)||!/^[a-f0-9]{64}$/.test(v.signature)
    ||!timingSafeEqual(Buffer.from(v.signature,'hex'),Buffer.from(expected,'hex')))fail();
   return b;
  }catch{fail();}
 }
 return Object.freeze({
  async capture({userId,healthDate,claim,briefing}){
   const metric=k=>briefing.metrics.find(m=>m.key===k)?.value;
   const body={sleep:keys.lookup(['morning-sleep-v1',briefing.sleepId]),recovery:metric('recovery_score'),minutes:metric('sleep_total')/60000};
   // Missing values are not invented and never prevent the ordinary report.
   if(!Number.isFinite(body.recovery)||!Number.isFinite(body.minutes))return;
   await db.transaction(async()=>{
    const c=await control(userId);if(!c||c.lifecycle_generation!==claim.lifecycleGeneration)fail();
    const scope=identity(userId,healthDate,claim,c);
    const live=await db.getClaim(userId,'daily',healthDate);
    if(live?.owner!==claim.owner||live.lifecycleGeneration!==claim.lifecycleGeneration||live.deliveryState!=='CLAIMED')fail();
    const existing=open(scope,await db.getState(key(scope)));
    if(existing){if(JSON.stringify(existing)!==JSON.stringify(body))fail();return;}
    await db.setState(key(scope),seal(scope,body));
   },workStepOptions('morning.snapshot',[userId,healthDate,claim.lifecycleGeneration,claim.owner],{discardResult:true}));
  },
  async read({userId,healthDate,claim,control:providedControl}){
   if(claim?.deliveryState!=='DELIVERED'||!claim.telegramSentAt||!claim.owner)return null;
   const c=providedControl??await control(userId);
   if(!c||c.lifecycle_generation!==claim.lifecycleGeneration)return null;
   const scope=identity(userId,healthDate,claim,c);return open(scope,await db.getState(key(scope)));
  },
 });
}
