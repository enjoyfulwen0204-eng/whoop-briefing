import test from 'node:test';
import assert from 'node:assert/strict';
import {syntheticStage7V33Fixture} from './stage7-v33-fixture.js';
import {bodyInput,seedBodyInput} from './bodyEnergyFixture.js';
import {finalizedFixtureDrain} from './finalizedStage6Fixture.js';
import {confirmedLegacyBrief} from './confirmedLegacyBriefFixture.js';
import {bindProducingExecution} from '../src/phase4ExecutionContext.js';
import {workStepOptions} from '../src/phase4WorkStep.js';
import {createStage7Development} from '../src/stage7Development.js';
import {createCompanionInvitation} from '../src/companionInvitation.js';
import {COMPANION_DEFAULTS} from '../src/companionTimingPolicy.js';
import {readFileSync} from 'node:fs';

const at=new Date('2026-10-31T11:10:00Z'),day='2026-10-31';
async function fixture(t,decorate=stores=>stores,input=null){
 const f=await syntheticStage7V33Fixture(t,{now:()=>new Date(at)});
 if(input)await f.db.transaction(()=>seedBodyInput(f.db,input));
 else await f.db.saveTokens('a',{accessToken:'synthetic',refreshToken:'synthetic',expiresAt:new Date('2026-12-01'),scope:'offline',whoopUserId:'synthetic'},{now:at});
 await f.db.linkTelegram({userId:'a',chatId:'123',now:at});
 await f.db.ensureOnboarding('a',{state:'READY',now:at});
 const companion=await createStage7Development({...f,stores:decorate(f.stores,f)}),user=await f.db.getUser('a');
 const actor=await companion.interactions.authenticate({user,chatId:'123'});
 await f.core.transaction(async()=>{const p=await companion.preferences(actor);await companion.changePreferences(actor,p,{daily_enabled:1});});
 await f.db.raw.execute({sql:"INSERT INTO report_claims(user_id,report_type,local_date,owner,claimed_at,expires_at,lifecycle_generation,delivery_state,telegram_message_id) VALUES('a','daily',?,'synthetic',?,?,?,'DELIVERED',11)",args:[day,at.toISOString(),at.toISOString(),user.lifecycleGeneration]});
 await confirmedLegacyBrief({...f,companion,user},{day});
 const logs=[];t.mock.method(console,'log',line=>{if(typeof line==='string'&&line.includes('companion_optional_context_skipped'))logs.push(JSON.parse(line));});
 const invitations=createCompanionInvitation({...f,companion,coach:{issue:async()=>{throw Error('UNEXPECTED_COACH_ISSUE');}},configuration:COMPANION_DEFAULTS});
 return {...f,companion,user,actor,logs,invitations,input:{user,chatId:'123',healthDay:day}};
}

test('missing root behind real evidence is excluded; daily preparation and later steps continue',async t=>{
 const input=bodyInput({asOf:at.getTime(),days:30});
 for(let i=0;i<input.sources.recovery.length;i++)input.sources.recovery[i].recovery_score=i===0?0:[40,45,50,55,60][(i-1)%5];
 const f=await fixture(t,stores=>stores,input);
 await finalizedFixtureDrain(f.db,{drain:async()=>{
  await f.stores.withContext('a',{executionMode:'SHADOW'},context=>f.core.run(context,()=>bindProducingExecution(f.core.client,context),workStepOptions('stage7-test-producing-domain',[context.userId,context.inputGeneration],{discardResult:true})));
  await f.stores.withContext('a',{executionMode:'SHADOW'},async context=>{
   const refs=[];for(const row of input.sources.recovery)refs.push((await f.stores.root(context,'recovery',row.sleep_id)).ref);
   await f.stores.intelligence.analyzeMetric(context,{metricKey:'recovery_score',currentSource:refs[0],baselineSources:refs.slice(1,31),asOfUtc:f.core.timestamp(),windowFamily:'STAGE7_RUNTIME'});
  });
  return {outcome:'COMPLETE',processedItems:1,completedJobs:0,failedJobs:0,remainingJobs:0,completion:'COMPLETE'};
 }},{});
 await f.db.raw.execute("UPDATE phase4_computation_state SET last_completed_generation=input_generation WHERE user_id='a'");
 await f.db.raw.execute("UPDATE phase4_invalidations SET scope_kind='NONE' WHERE user_id='a'");
 const before=await f.stores.withContext('a',{executionMode:'SHADOW'},context=>f.stores.betaSummary.readCurrent(context,{asOfUtc:f.core.timestamp()}));
 assert.equal(before.episodes.length,1);
 await f.db.raw.execute({sql:"DELETE FROM whoop_recoveries WHERE user_id='a' AND sleep_id=?",args:[input.sources.recovery[0].sleep_id]});
 const result=await f.companion.prepareAfterBrief(f.input);
 assert.equal(result.status,'PROPOSED');
 assert.notEqual(result.selection.reason,'MISSING_CONTEXT');
 assert.equal((await f.db.raw.execute("SELECT count(*) n FROM phase4_source_links WHERE artifact_type='quick_action_interactions' AND source_type='evidence_items'")).rows[0].n,0);
 assert.equal((await f.companion.weekly.prepare(f.actor,{automatic:true})).status,'DISABLED');
 assert.equal((await f.invitations.prepare(f.input)).status,'DISABLED');
 assert.equal((await f.companion.prepareAfterBrief(f.input)).deliveryId,result.deliveryId);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM journal_prompt_deliveries')).rows[0].n,1);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM journal_delivery_attempts')).rows[0].n,0);
 assert.deepEqual(f.logs,[{event:'companion_optional_context_skipped',step:'daily_context',code:'PHASE4_SOURCE_NOT_FOUND',user:f.keys.lookup(['companion-diagnostic-user-v1','a'])}]);
});

test('nonrecoverable optional read keeps failing with no proposal or skip log',async t=>{
 let reads=0;const failure=Object.assign(Error('PRIVATE_SENTINEL'),{code:'PHASE4_OPERATION_RECEIPT_INTEGRITY'});
 const f=await fixture(t,(stores,f)=>({...stores,betaSummary:{readCurrent:context=>f.core.run(context,()=>{reads++;throw failure;})}}));
 await assert.rejects(f.companion.prepareAfterBrief(f.input),error=>error===failure);
 assert.equal(reads,1);assert.deepEqual(f.logs,[]);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM journal_prompt_deliveries')).rows[0].n,0);
});

test('necessary Journal read with the same code is not treated as optional',async t=>{
 const failure=Object.assign(Error('PRIVATE_SENTINEL'),{code:'PHASE4_SOURCE_NOT_FOUND'});
 const f=await fixture(t,stores=>({...stores,journal:{...stores.journal,list:async()=>{throw failure;}}}));
 await assert.rejects(f.companion.prepareAfterBrief(f.input),error=>error===failure);
 assert.deepEqual(f.logs,[]);
});

test('necessary Coach wake source remains fail-closed with original receipt unchanged',async t=>{
 const f=await fixture(t);
 await f.core.transaction(async()=>{const p=await f.companion.preferences(f.actor);await f.companion.changePreferences(f.actor,p,{coach_enabled:1});});
 await f.db.raw.execute("UPDATE report_runs SET sleep_id='synthetic-missing-sleep' WHERE user_id='a'");
 const before=(await f.db.raw.execute("SELECT * FROM report_runs WHERE user_id='a'")).rows;
 await assert.rejects(f.invitations.prepare(f.input),{code:'PHASE4_SOURCE_NOT_FOUND'});
 assert.deepEqual((await f.db.raw.execute("SELECT * FROM report_runs WHERE user_id='a'")).rows,before);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM journal_prompt_deliveries')).rows[0].n,0);
 assert.deepEqual(f.logs,[]);
});

const missingContext=stores=>({...stores,betaSummary:{readCurrent:context=>stores.readArtifact(context,'evidence_items',{evidence_item_id:'synthetic-missing-evidence'})}});
test('nested caller transaction cannot be reused after an optional context failure',async t=>{
 const f=await fixture(t,missingContext);
 // A missing derived artifact is PARENT_NOT_FOUND; its missing raw root is
 // SOURCE_NOT_FOUND (covered by the real-evidence fixture above).
 await assert.rejects(f.core.transaction(()=>f.companion.prepareAfterBrief(f.input)),{code:'PHASE4_PARENT_NOT_FOUND'});
 assert.deepEqual(f.logs,[]);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM journal_prompt_deliveries')).rows[0].n,0);
});

test('fresh attempt rereads necessary authority; a second failure is never retried',async t=>{
 let reads=0;const failure=Object.assign(Error('PRIVATE_SENTINEL'),{code:'PHASE4_OPERATION_RECEIPT_INTEGRITY'});
 const f=await fixture(t,stores=>({...missingContext(stores),journal:{...stores.journal,list:async(...args)=>{
  if(++reads===2)throw failure;return stores.journal.list(...args);
 }}}));
 await assert.rejects(f.companion.prepareAfterBrief(f.input),error=>error===failure);
 assert.equal(reads,2);assert.equal(f.logs.length,1);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM journal_prompt_deliveries')).rows[0].n,0);
 assert.doesNotMatch(JSON.stringify(f.logs),/PRIVATE_SENTINEL|synthetic-missing-evidence/);
});

test('diagnostic sink failure does not change optional fallback or grant a send',async t=>{
 const f=await fixture(t,missingContext);
 t.mock.method(console,'log',()=>{throw Error('LOG_UNAVAILABLE');});
 assert.equal((await f.companion.prepareAfterBrief(f.input)).status,'PROPOSED');
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM journal_delivery_attempts')).rows[0].n,0);
});

test('optional source error allowlist exactly matches the existing morning contract',()=>{
 const source=name=>readFileSync(new URL('../src/'+name,import.meta.url),'utf8');
 const codes=(file,name)=>source(file).match(new RegExp('const '+name+'=new Set\\(\\[([^\\]]+)\\]\\)'))[1].match(/PHASE4_[A-Z_]+|CONTENT_REDACTED/g).sort();
 assert.deepEqual(codes('stage7Companion.js','optionalContextCodes'),codes('stage8MorningIntelligence.js','recoverable'));
});
