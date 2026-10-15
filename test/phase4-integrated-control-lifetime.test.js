import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createOwnedDb} from './stage5OwnedDb.js';
import {fixtureKeys} from './localDb.js';
import {buildPhase4Core} from '../src/phase4Core.js';
test('ordinary admitted context with no durable execution or budget stays usable and rejects a changed input generation',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'integrated-control-')),db=createOwnedDb({url:'file:'+join(dir,'fixture.sqlite')});
 t.after(async()=>{await db.close();await rm(dir,{recursive:true,force:true});});
 await db.migrate({targetVersion:34});await db.createUser({id:'a',displayName:'Synthetic',timezone:'Asia/Taipei',status:'ACTIVE'});
 const core=await buildPhase4Core({keys:fixtureKeys,admission:await db.admitRuntime(),processing:{client:db.raw,transaction:db.transaction,active:db.processingTransactionActive,afterCommit:db.afterProcessingCommit,afterCompletion:db.afterProcessingCompletion},authorizeMode(mode,client){assert.equal(mode,'SHADOW');assert.equal(client,db.raw);}});
 await core.initializeTenant('a','SHADOW');const ctx=await core.capture('a',{executionMode:'SHADOW'});
 assert.equal(await core.run(ctx,()=>123),123);
 await db.raw.execute("UPDATE phase4_computation_state SET input_generation=input_generation+1 WHERE user_id='a' AND execution_mode='SHADOW'");
 let entered=false;await assert.rejects(core.run(ctx,()=>{entered=true;}),/PHASE4_INPUT_FENCED/);assert.equal(entered,false);
});
