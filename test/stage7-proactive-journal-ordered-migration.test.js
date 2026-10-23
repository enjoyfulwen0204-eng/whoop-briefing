import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createOwnedFileDb} from '../src/db.js';
import {fixtureKeys} from './localDb.js';
import {buildPhase4Core} from '../src/phase4Core.js';
import {composePhase4Stores} from '../src/phase4Repositories.js';
import {createSchemaTransitionRuntimeProfile,SCHEMA_TRANSITION_PROFILE} from '../src/schemaTransitionProfile.js';
import {createStage7Composition} from '../src/stage7Composition.js';
import {createStage7ProactiveJournal} from '../src/stage7ProactiveJournal.js';
import {createStage7Dispatcher,createSyntheticJournalTelegram} from '../src/stage7Dispatcher.js';
import {JOURNAL_COPY} from '../src/stage7Registry.js';
import {originalStage8PreservationSnapshot} from './fixtures/stage8-preservation-v1.mjs';

test('new v33 proactive Journal answers and retained old questions survive ordered v34/v35 migration and resume trusted editing',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'journal-ordered-migration-')),url='file:'+join(directory,'fixture.db'),now=()=>new Date('2026-09-19T04:00:00Z');
 const runtimeProfile=createSchemaTransitionRuntimeProfile({keys:fixtureKeys,environment:{PHASE4_EXECUTION_PROFILE:SCHEMA_TRANSITION_PROFILE}});
 let db=createOwnedFileDb({url,phase4Keys:fixtureKeys,runtimeProfile});
 t.after(async()=>{global.gc?.();await new Promise(r=>setImmediate(r));db.close();await rm(directory,{recursive:true,force:true});});
 await db.migrate({targetVersion:33});
 async function composition(){
  const admission=await db.admitRuntime();
  const core=await buildPhase4Core({processing:{client:db.raw,transaction:db.transaction,active:db.processingTransactionActive,afterCommit:db.afterProcessingCommit,afterCompletion:db.afterProcessingCompletion},keys:fixtureKeys,admission,now,authorizeMode(mode){assert.equal(mode,'SHADOW');}});
  return {db,core,keys:fixtureKeys,stores:composePhase4Stores(core)};
 }
 let f=await composition();
 for(const id of ['a','b','c','d','e','f','g']){await db.createUser({id,displayName:'Synthetic',timezone:'Asia/Taipei',status:'ACTIVE'},{now:now()});if(['a','b','c'].includes(id)){await f.core.initializeTenant(id,'SHADOW');await db.ensureOnboarding(id,{state:'READY',now:now()});}}
 await db.linkTelegram({userId:'a',chatId:'123',now:now()});await db.linkTelegram({userId:'b',chatId:'456',now:now()});
 await db.saveTokens('a',{accessToken:'synthetic',refreshToken:'synthetic',expiresAt:new Date('2026-12-01'),scope:'offline',whoopUserId:'synthetic'},{now:now()});await db.setLocale('a','en');
 const user=await db.getUser('a'),c=JOURNAL_COPY.en;
 let companion=await createStage7Composition(f);
 const proactiveJournal=createStage7ProactiveJournal({...f,companion}),provider=createSyntheticJournalTelegram({}),dispatcher=createStage7Dispatcher({...f,companion,provider,proactiveJournal});
 const claim=await db.claimProactiveEvent('a',{healthDate:'2026-09-18',idempotencyKey:'synthetic-ordered-migration-original',decision:'ASK_CONTEXT',policyVersion:'synthetic',signals:[],reason:{question_category:'alcohol',question_target_date:'2026-09-17'}},{now:now(),expectedLifecycleGeneration:user.lifecycleGeneration});
 const proposed=await proactiveJournal.prepare({user,chatId:'123',eventId:claim.id});assert.equal(proposed.status,'PROPOSED');assert.equal((await dispatcher.dispatch({user,chatId:'123',deliveryId:proposed.deliveryId})).status,'DELIVERED');
 let sequence=0;
 const tap=async(reply,label)=>{const b=reply.replyMarkup.inline_keyboard.flat().find(b=>b.text.endsWith(' '+label));assert.ok(b,label);return companion.handle({user:await db.getUser('a'),chatId:'123',callback:{id:'synthetic-'+(++sequence),data:b.callback_data,from:{id:123},message:{message_id:701,chat:{id:123,type:'private'}}}});};
 let card=provider.calls[0];card=await tap(card,c.yes);card=await tap(card,c.confirm);card=await tap(card,c.edit);
 await db.openPendingQuestion('b',{chatId:'456',question:'Synthetic retained legacy question',intent:'proactive_context',contextJson:{question_target_date:'2026-09-16'},ttlMs:3600000},{now:now()});
 const oldPending=(await db.raw.execute('SELECT * FROM pending_questions')).rows;
 const original=await originalStage8PreservationSnapshot(db.raw,fixtureKeys);
 for(const [targetVersion,expected] of [[34,[34]],[35,[35]],[35,[]]]){const result=await db.migrate({targetVersion});assert.deepEqual(result.versionsApplied,expected);assert.deepEqual(await originalStage8PreservationSnapshot(db.raw,fixtureKeys,original),original);}
 assert.equal((await db.raw.execute('PRAGMA integrity_check')).rows[0].integrity_check,'ok');assert.deepEqual((await db.raw.execute('PRAGMA foreign_key_check')).rows,[]);
 global.gc?.();await new Promise(r=>setImmediate(r));db.close();db=createOwnedFileDb({url,phase4Keys:fixtureKeys});f=await composition();companion=await createStage7Composition(f);
 card=await tap(card,c.no);await tap(card,c.confirm);
 const active=(await db.raw.execute("SELECT * FROM journal_events WHERE fact_status='ACTIVE'")).rows;assert.equal(active.length,1);assert.equal(active[0].health_date,'2026-09-17');assert.equal(active[0].exposure_state,'CONFIRMED_UNEXPOSED');assert.equal(active[0].provenance_mode,'TRUSTED_REGISTRY');
 assert.deepEqual((await db.raw.execute('SELECT * FROM pending_questions')).rows,oldPending);assert.equal((await db.raw.execute('SELECT count(*) n FROM users')).rows[0].n,7);assert.equal(provider.calls.length,1);
 console.log('SYNTHETIC_JOURNAL_ORDERED_MIGRATION '+JSON.stringify({sourceSchema:33,targetSchema:35,steps:[34,35,35],users:7,initializedSyntheticTenants:3,exercisedJournalUsers:1,originalTablesPreserved:Object.keys(original).length,legacyPendingPreserved:true,trustedEditAfterReopen:true,outboundSyntheticCards:1,productionEvidence:false,productionPending37OrRelationships1296Verified:false}));
});
