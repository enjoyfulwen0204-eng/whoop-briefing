import test from 'node:test';import assert from 'node:assert/strict';
import {fixture,fixtureKeys} from './v32ReviewFixture.js';
import {betaPilotConfiguration,createBetaPilotPermit,PILOT_DURATION_MS} from '../src/betaPilotPermit.js';
import {OWNER_PILOT_APPROVAL_SHA256,reviewedPilotAllowance} from '../src/betaPilotAllowance.js';
const component='phase4_beta_pilot_permit_v1';
async function setup(t,{expiresInMs=null}={}){
 const {db,transport}=await fixture(t);await db.createUser({id:'a',displayName:'Synthetic',status:'ACTIVE',timezone:'Asia/Taipei'});
 await db.ensureOnboarding('a',{state:'READY'});await db.admitRuntime();
 const config=betaPilotConfiguration({PHASE4_BETA_PILOT_ID:'a'.repeat(64),PHASE4_BETA_PILOT_USER_ID:'a',
  PHASE4_BETA_PILOT_START_AT:new Date(expiresInMs===null?Date.now()-1000:Date.now()-PILOT_DURATION_MS+expiresInMs).toISOString(),PHASE4_BETA_PILOT_CONSENT_SHA256:'b'.repeat(64),
  PHASE4_BETA_PILOT_ALLOWANCE_ID:OWNER_PILOT_APPROVAL_SHA256});
 const grant=await createBetaPilotPermit({db,keys:fixtureKeys,config,reservation:reviewedPilotAllowance(config.allowanceId)}).reserve();
 const record=async()=>JSON.parse((await db.raw.execute({sql:"SELECT last_detail FROM system_heartbeats WHERE scope='global' AND component=?",args:[component]})).rows[0].last_detail);
 return {db,transport,config,grant,record};
}
const compound=statement=>statement?.sql?.includes('observed_at')&&statement.sql.includes('last_detail');

test('two actual fresh pilot reads may complete in reverse order without falsely closing the original allowance',async t=>{
 const {db,transport,config,grant,record}=await setup(t),execute=db.raw.execute.bind(db.raw);
 let releaseFirst,firstRead;const held=new Promise(resolve=>{releaseFirst=resolve;}),captured=new Promise(resolve=>{firstRead=resolve;});
 let reads=0;db.raw.execute=async statement=>{
  const result=await execute(statement);
  if(compound(statement)){
   assert.equal(result.rows[0].lifecycle_generation,1);assert.equal(typeof result.rows[0].last_detail,'string');
   const ordinal=++reads;result.rows[0].observed_at=config.startAt+(ordinal===1?5000:6000);
   if(ordinal===1){firstRead();await held;}
  }return result;
 };
 const before=transport.counts.byFamily.PILOT_CLOCK??0;
 try {
  const earlier=grant.assert();await captured;await grant.assert();releaseFirst();await earlier;
  assert.equal(reads,2);assert.equal((transport.counts.byFamily.PILOT_CLOCK??0)-before,2);
  const state=await record();assert.equal(state.closed,false);assert.equal(state.attempts,1);
  assert.equal(state.startAt,config.startAt);assert.equal(state.endAt,config.endAt);
 } finally {releaseFirst();db.raw.execute=execute;}
});

for(const attack of ['CLOSED','READY_REVOKED','EXPIRED'])test(`a newer ${attack} observation fences an earlier healthy read still in flight without permitting its business callback`,async t=>{
 const {db,config,grant,record}=await setup(t),execute=db.raw.execute.bind(db.raw);
 let releaseFirst,firstRead,reads=0,callback=false;
 const held=new Promise(resolve=>{releaseFirst=resolve;}),captured=new Promise(resolve=>{firstRead=resolve;});
 db.raw.execute=async statement=>{
  const result=await execute(statement);if(compound(statement)){
   const ordinal=++reads;result.rows[0].observed_at=config.startAt+(ordinal===1?5000:6000);
   if(ordinal===1){firstRead();await held;}else if(attack==='EXPIRED')result.rows[0].observed_at=config.endAt;
  }return result;
 };
 try {
  const earlier=db.withRuntimeFence(client=>grant.assert(client),()=>db.transaction(()=>{
   callback=true;return db.raw.execute({sql:'INSERT INTO telegram_state(key,value,updated_at) VALUES(?,?,?)',args:['late_'+attack,'synthetic','2026-10-11']});
  }));await captured;
  if(attack==='CLOSED'){
   const {signature,...state}=await record(),closed={...state,closed:true};
   await db.raw.execute({sql:"UPDATE system_heartbeats SET last_detail=? WHERE scope='global' AND component=?",
    args:[JSON.stringify({...closed,signature:fixtureKeys.lookup(['beta-pilot-state-v1',closed])}),component]});
  }else if(attack==='READY_REVOKED')await db.raw.execute("UPDATE user_onboarding SET state='ACTION_REQUIRED' WHERE user_id='a'");
  await assert.rejects(()=>grant.assert(),/BETA_PILOT_DENIED/);
  const rejected=assert.rejects(()=>earlier,/BETA_PILOT_DENIED/);releaseFirst();await rejected;
  assert.equal(callback,false);const state=await record();assert.equal(state.closed,true);assert.equal(state.attempts,1);
  assert.equal(state.startAt,config.startAt);assert.equal(state.endAt,config.endAt);
  assert.equal((await db.raw.execute({sql:'SELECT count(*) n FROM telegram_state WHERE key=?',args:['late_'+attack]})).rows[0].n,0);
 } finally {releaseFirst();db.raw.execute=execute;}
});

test('a real grant read that returns after its original monotonic expiry denies before the business callback and persists closure',async t=>{
 const {db,config,grant,record}=await setup(t,{expiresInMs:250}),execute=db.raw.execute.bind(db.raw);let callback=false;
 db.raw.execute=async statement=>{const result=await execute(statement);if(compound(statement))await new Promise(resolve=>setTimeout(resolve,300));return result;};
 try {
  await assert.rejects(()=>grant.assert().then(()=>{
   callback=true;return db.transaction(()=>db.raw.execute("INSERT INTO telegram_state(key,value,updated_at) VALUES('late_expiry','synthetic','2026-10-11')"));
  }),/BETA_PILOT_DENIED/);
  await grant.settleInvalidation();assert.equal(callback,false);
  const state=await record();assert.equal(state.closed,true);assert.equal(state.attempts,1);assert.equal(state.endAt,config.endAt);
  assert.equal((await db.raw.execute("SELECT count(*) n FROM telegram_state WHERE key='late_expiry'")).rows[0].n,0);
 } finally {db.raw.execute=execute;}
});

test('a later-started fresh read below an already proven database clock still closes durably without refund or restart',async t=>{
 const {db,config,grant,record}=await setup(t),execute=db.raw.execute.bind(db.raw);let observed=config.startAt+5000;
 db.raw.execute=async statement=>{const result=await execute(statement);if(compound(statement))result.rows[0].observed_at=observed;return result;};
 try {
  await grant.assert();observed=config.startAt+6000;await grant.assert();observed=config.startAt+5500;
  await assert.rejects(()=>grant.assert(),/BETA_PILOT_DENIED/);
  const state=await record();assert.equal(state.closed,true);assert.equal(state.attempts,1);
  assert.equal(state.lastObservedAt,config.startAt+6000);assert.equal(state.startAt,config.startAt);assert.equal(state.endAt,config.endAt);
  observed=config.startAt+7000;await assert.rejects(()=>grant.assert(),/BETA_PILOT_DENIED/);
 } finally {db.raw.execute=execute;}
});
