import {syntheticPhase4Fixture} from './phase4Fixture.js';
import {bodyInput,seedBodyInput} from './bodyEnergyFixture.js';
import {createStage8Runtime} from '../src/stage8Runtime.js';
export async function stage8Fixture(t,{owner=false}={}){
 let at=new Date('2026-09-19T01:10:00Z');const now=()=>new Date(at),f=await syntheticPhase4Fixture(t,{targetVersion:34,now});
 for(const [uid,chat] of [['a','123'],['b','456']]){
  const input=bodyInput({days:2});input.userId=uid;
  for(const group of [...Object.values(input.sources),input.access,input.sync,input.capabilities])for(const row of group)row.user_id=uid;
  await seedBodyInput(f.db,input);await f.db.linkTelegram({userId:uid,chatId:chat,now:now()});await f.db.setLocale(uid,'en',{now:now()});
  await f.db.raw.execute({sql:"INSERT INTO user_onboarding(user_id,state,state_changed_at,created_at,updated_at) VALUES(?,'READY',?,?,?)",args:[uid,now().toISOString(),now().toISOString(),now().toISOString()]});
 }
 const environment={PHASE4_STAGE8_RUNTIME:'on',PHASE4_STAGE8_OWNER_MONITORING:owner?'on':'off',PHASE4_BETA_PILOT_USER_ID:'a',STAGE8_USER_IDS:'a'};
 const env={telegramBotToken:'SYNTHETIC_NOT_A_TOKEN'},app=await createStage8Runtime({...f,environment,env,now}),user=await f.db.getUser('a');
 return {...f,app,user,environment,env,now,input:{user,chatId:'123'},setTime:value=>{at=new Date(value);}};
}
