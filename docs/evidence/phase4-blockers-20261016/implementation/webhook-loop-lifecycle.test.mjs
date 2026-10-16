import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'file:///Users/kelvin/Desktop/whoop-briefing/node_modules/libsql/index.js';
import {createDb} from 'file:///Users/kelvin/.codex/worktrees/phase4-final-integration/whoop-briefing/src/db.js';
import {phase4AuthorityKeys} from 'file:///Users/kelvin/.codex/worktrees/phase4-final-integration/whoop-briefing/src/publicBetaConfig.js';
import {bodyInput,seedBodyInput} from 'file:///Users/kelvin/.codex/worktrees/phase4-final-integration/whoop-briefing/test/bodyEnergyFixture.js';
import {main} from 'file:///Users/kelvin/.codex/worktrees/phase4-final-integration/whoop-briefing/src/bot/webhook.js';
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
test('actual webhook main starts the configured loop and SIGTERM joins its metadata before closing DB exactly once',async()=>{
 const previous={...process.env},realFetch=globalThis.fetch,signals=Object.fromEntries(['SIGTERM','SIGINT'].map(k=>[k,new Set(process.listeners(k))]));
 for(const key of Object.keys(process.env))if(/^(PHASE4_|STAGE[78]_|BODY_ENERGY_|WHOOP_|BRIEFING_)/.test(key))delete process.env[key];
 Object.assign(process.env,{TELEGRAM_BOT_TOKEN:'123456:synthetic-test-only',TELEGRAM_WEBHOOK_SECRET:'synthetic-webhook-secret-32-bytes-long',
  TURSO_DATABASE_URL:'file::memory:?cache=shared',TURSO_AUTH_TOKEN:'synthetic-not-a-token',OPENROUTER_API_KEY:'synthetic-not-a-key',
  PHASE4_LOOKUP_KEY:Buffer.alloc(32,71).toString('hex'),PHASE4_AUDIT_KEY:Buffer.alloc(32,83).toString('hex'),PHASE4_EXECUTION_PROFILE:'PHASE4',
  PHASE4_BETA_SHADOW_RUNTIME:'off',PHASE4_PUBLIC_BETA_MODE:'off',PHASE4_PUBLIC_BETA_USER_IDS:'',PHASE4_BETA_PILOT_STOP:'on',PHASE4_BETA_PILOT_USER_ID:'a',
  WHOOP_CLIENT_ID:'',WHOOP_CLIENT_SECRET:'',WHOOP_REDIRECT_URI:'',BRIEFING_TRIGGER_SECRET:'',BODY_ENERGY_PUBLICATION:'off',BODY_ENERGY_ALERTS:'off',
  PHASE4_STAGE8_RUNTIME:'on',STAGE8_USER_IDS:'a',STAGE8_LIVE_ANALYSIS:'on',STAGE8_POST_SYNC:'on',PHASE4_STAGE8_OWNER_MONITORING:'off'});
 let network=0;globalThis.fetch=async()=>{network++;throw Error('SYNTHETIC_NO_PROVIDER_NETWORK');};
 const anchor=new Database(process.env.TURSO_DATABASE_URL),keys=phase4AuthorityKeys(process.env),seeded=createDb({url:process.env.TURSO_DATABASE_URL,phase4Keys:keys});
 const entered=deferred(),release=deferred(),closed=deferred();let started,closeCalls=0,gated=false,ackSettled=false;
 try{
  await seeded.migrate({targetVersion:35});await seeded.transaction(()=>seedBodyInput(seeded,bodyInput({asOf:Date.now()-1000,days:0})));await seeded.ensureOnboarding('a',{state:'READY'});
  started=await main({listen:true,port:0});assert.equal(started.server.listening,true);
  const execute=started.db.raw.execute,close=started.db.close;
  started.db.raw.execute=async function(statement){const result=await execute.call(this,statement);const sql=typeof statement==='string'?statement:statement.sql;
   if(!gated&&sql.includes('SELECT execution_id,identity_digest,generation,result_digest,created_at FROM phase4_executions')){gated=true;entered.resolve();await release.promise;ackSettled=true;}return result;};
  started.db.close=function(){closeCalls++;assert.equal(ackSettled,true);const result=close.call(this);closed.resolve();return result;};
  await entered.promise;process.kill(process.pid,'SIGTERM');await new Promise(r=>setTimeout(r,150));assert.equal(closeCalls,0);
  release.resolve();await closed.promise;assert.equal(closeCalls,1);assert.equal(started.server.listening,false);assert.equal(network,0);
  process.kill(process.pid,'SIGTERM');await new Promise(r=>setTimeout(r,30));assert.equal(closeCalls,1);
 }finally{
  release.resolve();for(const sig of ['SIGTERM','SIGINT'])for(const fn of process.listeners(sig))if(!signals[sig].has(fn))process.removeListener(sig,fn);
  if(started?.server.listening)await new Promise(r=>started.server.close(r));if(started&&!closeCalls)started.db.close();seeded.close();anchor.close();globalThis.fetch=realFetch;
  for(const key of Object.keys(process.env))if(!(key in previous))delete process.env[key];Object.assign(process.env,previous);
 }
});
