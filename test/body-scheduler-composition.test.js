import test from 'node:test';import assert from 'node:assert/strict';
import {runBriefing} from '../src/index.js';import {runExecutionPhase} from '../src/phase4Execution.js';
import {configurationProof} from '../src/phase4ExecutionStore.js';import {publicBetaConfiguration} from '../src/publicBetaConfig.js';
import {fixture,fixtureKeys,request} from './v32ReviewFixture.js';
const environment={PHASE4_BETA_SHADOW_RUNTIME:'on',PHASE4_PUBLIC_BETA_MODE:'off',
 BODY_ENERGY_PUBLICATION:'on',BODY_ENERGY_ALERTS:'off',BODY_ENERGY_USER_IDS:'a',BODY_ENERGY_NOTIFICATION_USER_IDS:'',BODY_ENERGY_QUALIFICATION_ID:'unapproved'};
const env={timezone:'Asia/Taipei',dryRun:true,maxUserConcurrency:1,telegramBotToken:'synthetic-only',telegramChatId:'100001'};
function isolatedEnv(t){for(const [key,value] of Object.entries(environment)){const prior=process.env[key];process.env[key]=value;t.after(()=>{if(prior===undefined)delete process.env[key];else process.env[key]=prior;});}}
test('scheduler composes pending Body publication with the original admitted key object and rejects a same-bytes replacement',async t=>{
 isolatedEnv(t);const f=await fixture(t),admission=await f.db.admitRuntime();
 const good=await runBriefing({deps:{db:f.db,env,runtimeAdmission:admission,phase4AuthorityKeys:fixtureKeys,keepConnectionOpen:true}});
 assert.equal(good.errors.length,0);assert.equal(good.users,0);
 const wrong=await runBriefing({deps:{db:f.db,env,runtimeAdmission:admission,phase4AuthorityKeys:{...fixtureKeys},keepConnectionOpen:true}});
 assert.equal(wrong.errors.length,1);assert.equal(wrong.errors[0].stage,'bootstrap');
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM body_energy_results')).rows[0].n,0);
});
test('actual SYNC server composition forwards the exact admitted keys into the scheduler without granting numerical publication',async t=>{
 isolatedEnv(t);const f=await fixture(t);let passedKeys;
 const r=request({configProof:configurationProof(fixtureKeys,publicBetaConfiguration(environment),environment)});
 const result=await runExecutionPhase({db:f.db,keys:fixtureKeys,environment,env,request:r,deps:{runBriefing:async options=>{
  passedKeys=options.deps.phase4AuthorityKeys;return runBriefing(options);
 }}});
 assert.equal(passedKeys,fixtureKeys);assert.equal(result.body.ok,true,JSON.stringify(result));
 assert.equal(result.body.result.settlementState,'FINALIZED_SUCCESS');
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM body_energy_results')).rows[0].n,0);
});
