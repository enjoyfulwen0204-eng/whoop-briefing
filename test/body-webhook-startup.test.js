import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'libsql';
import {createDb} from '../src/db.js';
import {phase4AuthorityKeys} from '../src/publicBetaConfig.js';
import {createBodyEnergyRuntime} from '../src/bodyEnergyRuntime.js';
import {main} from '../src/bot/webhook.js';

test('webhook initializes gated Body runtime with the original admitted key identity',async()=>{
 const previous={...process.env},fetch=globalThis.fetch;
 const environment={TELEGRAM_BOT_TOKEN:'123456:synthetic-test-only',TELEGRAM_WEBHOOK_SECRET:'synthetic-webhook-secret-32-bytes-long',
  TURSO_DATABASE_URL:'file::memory:?cache=shared',TURSO_AUTH_TOKEN:'synthetic-not-a-token',OPENROUTER_API_KEY:'synthetic-not-a-key',
  PHASE4_LOOKUP_KEY:'11'.repeat(32),PHASE4_AUDIT_KEY:'22'.repeat(32),PHASE4_EXECUTION_PROFILE:'PHASE4',
  PHASE4_BETA_SHADOW_RUNTIME:'off',PHASE4_PUBLIC_BETA_MODE:'off',PHASE4_PUBLIC_BETA_USER_IDS:'',
  WHOOP_CLIENT_ID:'',WHOOP_CLIENT_SECRET:'',WHOOP_REDIRECT_URI:'',BRIEFING_TRIGGER_SECRET:'',
  BODY_ENERGY_PUBLICATION:'off',BODY_ENERGY_ALERTS:'off',BODY_ENERGY_USER_IDS:'',BODY_ENERGY_NOTIFICATION_USER_IDS:'',
  BODY_ENERGY_QUALIFICATION_ID:'',PHASE4_BETA_PILOT_ID:'',PHASE4_BETA_PILOT_USER_ID:'',PHASE4_BETA_PILOT_START_AT:'',
  PHASE4_BETA_PILOT_CONSENT_SHA256:'',PHASE4_BETA_PILOT_COST_BOUND_ID:'',PHASE4_BETA_PILOT_ALLOWANCE_ID:'',PHASE4_BETA_PILOT_STOP:'on'};
 Object.assign(process.env,environment);
 let network=0;globalThis.fetch=async()=>{network++;throw Error('OFFLINE_STARTUP_ONLY');};
 const anchor=new Database('file::memory:?cache=shared'),keys=phase4AuthorityKeys(process.env);
 const seeded=createDb({url:environment.TURSO_DATABASE_URL,phase4Keys:keys});let started;
 try{
  await seeded.migrate();await seeded.admitRuntime({source:'event'});
  await assert.rejects(()=>createBodyEnergyRuntime({db:seeded,keys:phase4AuthorityKeys(process.env),environment}),/PHASE4_RUNTIME_ADMISSION_REQUIRED/);
  started=await main({listen:false,port:0});
  assert.ok(started.server);assert.ok(started.db);
  assert.equal(started.server.listening,false);
  assert.equal(network,0);
 }finally{
  await started?.close();seeded.close();anchor.close();
  globalThis.fetch=fetch;
  for(const k of Object.keys(process.env))if(!(k in previous))delete process.env[k];
  Object.assign(process.env,previous);
 }
});
