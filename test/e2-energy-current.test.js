import test from 'node:test';
import assert from 'node:assert/strict';
import {energySlot,renderTimedEnergy,extrasReports} from '../src/timedEnergy.js';
import {bodyInput,seedBodyInput} from './bodyEnergyFixture.js';
import {syntheticStage7V33Fixture} from './stage7-v33-fixture.js';
import {createOnDemandBodyEnergy} from '../src/onDemandBodyEnergy.js';
import {followFixture} from './morningFollowupsFixture.js';
const step=(_name,fn)=>fn(),predict=async()=>({status:'MODEL_UNQUALIFIED'});
function fixture(hour=15,opts={}){
 const f=followFixture({at:'2026-11-03T'+String(hour-8).padStart(2,'0')+':10:00Z',gap:opts.gap??0});
 const input={...f.input,tick:f.input.now(),enrollment:{eligible:async()=>true,read:async()=>({timedEnergy:opts.enabled!==false})},
 getBody:async()=>({identityCurrent:async()=>true,inspect:async({requestedAt,healthDate})=>{
   if(hour===18&&requestedAt.getUTCHours()===7&&opts.missingPast)throw Object.assign(Error('fixture'),{code:'NOT_REPRODUCIBLE_FROM_RETAINED_INPUTS'});
   return {calculation:{quality_state:opts.quality??'AVAILABLE',value:50,drivers:{initial_charge:70}},identity:[1],wakeAt:'fixture',healthDate};
 }})};
 return {...f,input,run:(p=predict)=>extrasReports(input,{step,predict:p})};
}
test('only natural local :10 slots; an old tick never catches up in the next hour',()=>{
 for(const [tz,offset] of [['Asia/Taipei',8],['Asia/Ho_Chi_Minh',7]])for(const hour of [15,18,21]){
  const tick=new Date(Date.UTC(2026,10,3,hour-offset,10));assert.equal(energySlot(tick,new Date(+tick+39000),tz).hour,hour);
  assert.equal(energySlot(tick,new Date(+tick+50*60000),tz),null);assert.equal(energySlot(new Date(+tick+60000),new Date(+tick+61000),tz),null);
 }assert.equal(energySlot(null,new Date(),'Asia/Taipei'),null);
});
for(const [s,opts,action,code] of [['off',{enabled:false},null,'DISABLED_OR_INELIGIBLE'],['main sleep missing',{gap:1},null,'MAIN_SLEEP_MISSING'],['insufficient',{quality:'DEGRADED'},null,'BODY_DEGRADED'],['custom quiet',{},'setQuiet','QUIET_OR_PAUSED'],['paused',{},'setPaused','QUIET_OR_PAUSED']]){
 test('no scheduled send: '+s,async()=>{const f=fixture(15,opts);if(action)f[action](1);assert.equal((await f.run()).timed_energy,code);assert.equal(f.sent.length,0);});
}
test('fixed reports use report claims only: same slot twice sends once; unavailable historic comparison omits only that line',async()=>{
 const f=fixture(18,{missingPast:true});assert.equal((await f.run()).timed_energy,'DELIVERED');assert.deepEqual(f.sent,['🔋 18:00 電量 50']);
 assert.equal((await f.run()).timed_energy,'ALREADY_RESERVED');assert.equal(f.sent.length,1);
 assert.equal(f.state.size,0);assert.ok(f.db.claims.has('synthetic|timed_energy_18|2026-11-03'));
});
test('coincident qualified prediction and energy have one durable claim, one send and one prediction write',async()=>{
 const f=fixture(21);let saved=0;
 const p=async({deliver,...input})=>{if(await input.db.getClaim(input.user.id,'prediction',f.day))return {status:'ALREADY_RESERVED'};
  return deliver({...input,kind:'prediction',day:f.day,identity:await (await import('../src/scheduledReport.js')).reportIdentity(input.db,input.user),
    text:'📈 fixture prediction',beforeDelivery:async()=>{saved++;},verify:async()=>true});};
 assert.deepEqual(await f.run(p),{prediction:'DELIVERED',timed_energy:'DELIVERED'});await f.run(p);
 assert.equal(f.sent.length,1);assert.match(f.sent[0],/^🔋 .*\n.*\n\n📈 /u);assert.equal(saved,1);
 assert.equal(f.db.claims.has('synthetic|prediction|'+f.day),true);
});
test('18:00 delivery logs only the comparison result, exactly once per accepted report',async t=>{
 const logs=[];
 t.mock.method(console,'log',line=>logs.push(JSON.parse(line)));
 for(const [missingPast,code] of [[false,'COMPARISON_INCLUDED'],[true,'NOT_REPRODUCIBLE_FROM_RETAINED_INPUTS']]){
  const f=fixture(18,{missingPast});
  await f.run();await f.run();
  const comparison=logs.filter(l=>l.event==='timed_energy_comparison');
  assert.deepEqual(comparison,[{event:'timed_energy_comparison',code}]);
  assert.equal(f.sent[0].split('\n').length,missingPast?1:2);logs.length=0;
 }
});
test('a later successful sync alone prevents exact replay of the earlier Vietnam slot',async t=>{
 const at=new Date('2026-11-10T08:00:00Z'),now=()=>new Date('2026-11-10T11:10:00Z');
 const f=await syntheticStage7V33Fixture(t,{now});
 const timezone='Asia/Ho_Chi_Minh';
 await f.db.updateUser('a',{timezone});
 await f.db.setLocale('a','vi');await f.db.ensureOnboarding('a',{state:'READY',now:now()});
 await seedBodyInput(f.db,bodyInput({asOf:+at,timezone}));
 const body=createOnDemandBodyEnergy({...f,now,environment:{BODY_ENERGY_ON_DEMAND:'on'}});
 const inspect=requestedAt=>body.inspect({userId:'a',healthDate:'2026-11-10',requestedAt});
 assert.ok(['AVAILABLE','LIMITED'].includes((await inspect(at)).calculation.quality_state));
 await f.db.raw.execute({sql:'UPDATE whoop_sync_state SET last_success_at=?,updated_at=? WHERE user_id=?',args:[now().toISOString(),now().toISOString(),'a']});
 await assert.rejects(inspect(at),{code:'NOT_REPRODUCIBLE_FROM_RETAINED_INPUTS'});
 assert.ok(['AVAILABLE','LIMITED'].includes((await inspect(now())).calculation.quality_state));
});
test('18:00 signed differences and 21:00 wake comparison in all three languages',()=>{
 for(const [locale,lower,higher,equal] of [
  ['zh-TW','比 15:00 少了 3','比 15:00 多了 3','跟 15:00 一樣'],
  ['vi','Giảm 3 so với 15:00','Tăng 3 so với 15:00','Không đổi so với 15:00'],
  ['en','Down 3 since 15:00','Up 3 since 15:00','Unchanged since 15:00']
 ]){
  for(const [current,expected] of [[47,lower],[53,higher],[50,equal]]){
   assert.equal(renderTimedEnergy(locale,18,current,70,50).split('\n')[1],expected);
  }
  assert.equal(renderTimedEnergy(locale,21,50,40,null).split('\n').length,1);
  assert.equal(renderTimedEnergy(locale,21,50,50,null).split('\n').length,2);
  assert.equal(renderTimedEnergy(locale,21,33,30,null).split('\n').length,2,'rest advice survives');
 }
});
test('energy switch does not suspend a qualified prediction',async()=>{
 const f=fixture(21,{enabled:false});let sent=0;
 const p=async({deliver,...input})=>deliver({...input,kind:'prediction',day:f.day,identity:await (await import('../src/scheduledReport.js')).reportIdentity(input.db,input.user),text:'📈 fixture',verify:async()=>true,beforeDelivery:()=>{sent++;}});
 assert.deepEqual(await f.run(p),{prediction:'DELIVERED',timed_energy:'DISABLED_OR_INELIGIBLE'});assert.deepEqual(f.sent,['📈 fixture']);assert.equal(sent,1);
});
test('localized lines use measured differences only; rest line inclusive at 33',()=>{
 for(const [locale,phrase,fall,rest] of [['zh-TW','起床','少了','早點休息'],['en','wake-up','Down','rest early'],['vi','thức dậy','Giảm','Nghỉ ngơi']]){
  assert.ok(renderTimedEnergy(locale,15,40,60,null).includes(phrase));assert.ok(renderTimedEnergy(locale,18,40,60,50).includes(fall));
  assert.ok(renderTimedEnergy(locale,21,33,60,null).includes(rest));assert.ok(!renderTimedEnergy(locale,21,34,60,null).includes(rest));
  assert.equal(renderTimedEnergy(locale,15,40,null,null).split('\n').length,1);assert.equal(renderTimedEnergy(locale,18,40,60,null).split('\n').length,1);
 }
});
