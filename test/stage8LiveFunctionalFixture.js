import {syntheticPhase4Fixture} from './phase4Fixture.js';
import {bodyInput,seedBodyInput} from './bodyEnergyFixture.js';
import {createStage8LiveProducer} from '../src/stage8LiveProducer.js';
import {createSyntheticStage8SubjectAlertProvider} from '../src/stage8SubjectAlerts.js';
export async function importantFixture(t,outcome){
 const f=await syntheticPhase4Fixture(t,{targetVersion:35,now:()=>new Date()}),input=bodyInput({asOf:Date.now()-1000,days:30});
 for(let i=0;i<input.sources.recovery.length;i++)input.sources.recovery[i].recovery_score=i===0?10:60+i%5;
 await f.db.transaction(()=>seedBodyInput(f.db,input));await f.db.ensureOnboarding('a',{state:'READY'});await f.db.linkTelegram({userId:'a',chatId:'10001'});
 // Explicit synthetic pre-existing subject-family cutover; runtime never creates it.
 await f.db.raw.execute("INSERT INTO tenant_delivery_modes(user_id,execution_mode,message_family,mode,lifecycle_generation,auth_generation,changed_at,reason_code,cutover_boundary,timezone) VALUES('a','LIVE','EPISODE_NOTIFICATION','PHASE4',1,1,'2026-10-01','CUTOVER_COMMITTED','2026-10-01','Asia/Taipei')");
 const control=await f.stores.captureControl('a'),p=await f.stores.preferences.read(control);await f.stores.preferences.update(control,p.preference_version,{notifications_paused:0});
 const admission=await f.db.admitRuntime(),provider=createSyntheticStage8SubjectAlertProvider({db:f.db,outcomes:[outcome]});
 const producer=await createStage8LiveProducer({...f,admission,userIds:['a'],enabled:()=>true,eligible:id=>id==='a',subjectAlertProvider:provider});
 return {...f,admission,provider,producer};
}
