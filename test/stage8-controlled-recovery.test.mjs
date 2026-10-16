import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,open,rm,writeFile,readFile,chmod,lstat,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createOwnedDb} from './stage5OwnedDb.js';
import {fixtureKeys} from './localDb.js';
import {bodyInput,seedBodyInput} from './bodyEnergyFixture.js';
import {request,claim} from './v32ReviewFixture.js';
import {buildV35} from '../src/phase4V35Schema.js';
import {currentVersion} from '../src/migrations.js';
import {executionProfile} from '../src/phase4Rollback.js';
import {createStage7Runtime} from '../src/stage7Runtime.js';
import {createStage8Runtime} from '../src/stage8Runtime.js';
import {runMorningReadiness} from '../src/morningReadiness.js';
import {configurationProof} from '../src/phase4ExecutionStore.js';
import {runningReleaseSha} from '../src/phase4Release.js';
import {applyStage8LocalMigrationStep,stage8PreservationSnapshot,sealStage8RecoveryImage,rehearseStage8RecoveryImage,assertCleanStage8Release} from '../scripts/stage8-migration-safety.mjs';
import {main} from '../scripts/stage8-migration-rehearsal.mjs';

const SHA='a'.repeat(40),TARGET='SYNTHETIC_LOCAL';
const fixtureGit=(args,cwd)=>{
 const env={...process.env};for(const key of Object.keys(env))if(key.startsWith('GIT_'))delete env[key];
 return execFileSync('git',args,{cwd,env,encoding:'utf8',stdio:['ignore','pipe','pipe']});
};
async function withGitSpoof(values,work){
 const prior=Object.fromEntries(Object.entries(process.env).filter(([key])=>key.startsWith('GIT_')));
 for(const key of Object.keys(process.env))if(key.startsWith('GIT_'))delete process.env[key];Object.assign(process.env,values);
 try{return await work();}finally{for(const key of Object.keys(process.env))if(key.startsWith('GIT_'))delete process.env[key];Object.assign(process.env,prior);}
}
async function fixture(t){
 const directory=await realpath(await mkdtemp(join(tmpdir(),'stage8-controlled-')));await chmod(directory,0o700);
 const path=join(directory,'source.sqlite'),db=createOwnedDb({url:'file:'+path});let closed=false;
 const close=async()=>{if(!closed){closed=true;await db.close();}};
 t.after(async()=>{await close();await rm(directory,{recursive:true,force:true});});
 await db.migrate({targetVersion:33});
 for(const id of ['a','b','c'])await db.createUser({id,displayName:'Synthetic',timezone:'Asia/Taipei',status:'ACTIVE'});
 await db.linkTelegram({userId:'a',chatId:'123'});
 await db.setLocale('a','en');await db.setLocale('b','vi');await db.setLocale('c','zh-TW');
 const input=bodyInput({asOf:Date.now()-1000,days:7});await db.transaction(()=>seedBodyInput(db,input));
 await db.raw.execute("INSERT INTO phase4_user_state(user_id,created_at,updated_at) VALUES('a','2026-10-16','2026-10-16') ON CONFLICT DO NOTHING");
 await db.raw.execute("INSERT INTO journal_events(user_id,event_at,health_date,category,source,created_at,updated_at) VALUES('a','2026-10-16T01:00:00.000Z','2026-10-16','caffeine','manual','2026-10-16','2026-10-16')");
 await db.raw.execute("INSERT INTO journal_tracking_preferences(user_id,daily_enabled,weekly_enabled,coach_enabled,lifecycle_generation,created_at,updated_at) VALUES('a',1,1,1,1,'2026-10-16','2026-10-16')");
 await db.raw.execute("INSERT INTO user_notification_preferences(user_id,notifications_paused,morning_brief_mode,morning_brief_local_time,created_at,updated_at) VALUES('a',1,'FIXED_LOCAL_TIME','09:15','2026-10-16','2026-10-16') ON CONFLICT(user_id) DO UPDATE SET notifications_paused=1,morning_brief_mode='FIXED_LOCAL_TIME',morning_brief_local_time='09:15'");
 const pending=request();await claim(db,pending,{leaseMs:1,deadlineAt:Date.now()+1});
 await new Promise(resolve=>setTimeout(resolve,10));
 return {db,directory,path,close,pending};
}

test('ordered local v33→34→35, interrupted allocation and no-op recovery preserve all existing columns, users and pending work',async t=>{
 const f=await fixture(t),before=await stage8PreservationSnapshot(f.db.raw,fixtureKeys);
 assert.ok(before.users.count===3&&before.journal_events.count>0&&before.phase4_executions.count>0);
 await assert.rejects(applyStage8LocalMigrationStep(f.db.raw,{keys:fixtureKeys,fromVersion:33,targetVersion:35}),/ORDERED_SINGLE_STEP/);
 assert.deepEqual((await applyStage8LocalMigrationStep(f.db.raw,{keys:fixtureKeys,fromVersion:33,targetVersion:34})).versionsApplied,[34]);
 await f.db.raw.execute(buildV35().ddl[0]);
 assert.deepEqual((await applyStage8LocalMigrationStep(f.db.raw,{keys:fixtureKeys,fromVersion:34,targetVersion:35})).versionsApplied,[35]);
 assert.deepEqual((await applyStage8LocalMigrationStep(f.db.raw,{keys:fixtureKeys,fromVersion:35,targetVersion:35})).versionsApplied,[]);
 assert.deepEqual(await stage8PreservationSnapshot(f.db.raw,fixtureKeys,before),before);
 const retained=(await f.db.raw.execute({sql:'SELECT state,result_json FROM phase4_executions WHERE execution_id=?',args:[f.pending.requestId]})).rows[0];
 assert.equal(retained.state,'ESTABLISHED');assert.equal(retained.result_json,null);
});

test('protected encrypted original image rehearses ordered recovery, authenticates backup, rejects tampering/freshness and never changes source',async t=>{
 const f=await fixture(t);await f.close();await chmod(f.path,0o600);
 const keyPath=join(f.directory,'backup.key'),backupPath=join(f.directory,'backup.enc');await writeFile(keyPath,Buffer.alloc(32,37),{mode:0o600});
 const original=await readFile(f.path),createdAt=Date.now(),options={sourcePath:f.path,backupPath,keyPath,keys:fixtureKeys,releaseSha:SHA,sourceTarget:TARGET,now:createdAt};
 const sealed=await sealStage8RecoveryImage(options);assert.equal((await lstat(backupPath)).mode&0o077,0);
 const originalEncrypted=await readFile(backupPath);assert.ok(!originalEncrypted.includes(Buffer.from('SQLite format 3')));
 const result=await rehearseStage8RecoveryImage({...options,targetVersion:35});
 assert.equal(result.status,'LOCAL_RECOVERY_REHEARSAL_PASS');assert.deepEqual(result.steps.map(step=>step.to),[34,35,35]);assert.equal(result.encryptedDigest,sealed.encryptedDigest);
 assert.deepEqual(await readFile(f.path),original);
 await assert.rejects(sealStage8RecoveryImage(options),/EEXIST/);
 assert.deepEqual(await readFile(backupPath),originalEncrypted,'exclusive publication cannot overwrite or clean up an existing backup');
 await assert.rejects(rehearseStage8RecoveryImage({...options,targetVersion:35,releaseSha:'b'.repeat(40)}),/RECOVERY_BINDING/);
 await assert.rejects(rehearseStage8RecoveryImage({...options,targetVersion:35,now:createdAt+3600001}),/RECOVERY_BINDING/);
 const bytes=await readFile(backupPath);bytes[bytes.length-20]^=1;await writeFile(backupPath,bytes,{mode:0o600});
 await assert.rejects(rehearseStage8RecoveryImage({...options,targetVersion:35}));
});

test('GIT environment cannot substitute a clean donor or hide a backup directory inside the actual repository',async t=>{
 const f=await fixture(t);await f.close();await chmod(f.path,0o600);
 const candidate=join(f.directory,'candidate'),donor=join(f.directory,'donor');
 for(const repository of [candidate,donor])fixtureGit(['init','--quiet',repository]);
 await writeFile(join(candidate,'tracked'),'original');fixtureGit(['add','tracked'],candidate);
 fixtureGit(['-c','user.name=Synthetic','-c','user.email=synthetic@example.invalid','commit','--quiet','-m','candidate'],candidate);
 fixtureGit(['-c','user.name=Synthetic','-c','user.email=synthetic@example.invalid','commit','--allow-empty','--quiet','-m','donor'],donor);
 const actualSha=fixtureGit(['rev-parse','HEAD'],candidate).trim(),donorSha=fixtureGit(['rev-parse','HEAD'],donor).trim();assert.notEqual(actualSha,donorSha);
 const inside=join(candidate,'protected');await mkdir(inside,{mode:0o700});
 const keyPath=join(f.directory,'key');await writeFile(keyPath,Buffer.alloc(32,37),{mode:0o600});
 const backupPath=join(inside,'must-not-exist.enc');
 await withGitSpoof({GIT_DIR:join(donor,'.git'),GIT_COMMON_DIR:join(donor,'.git'),GIT_WORK_TREE:donor,GIT_INDEX_FILE:join(donor,'.git','index'),GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'core.bare',GIT_CONFIG_VALUE_0:'false',GIT_CEILING_DIRECTORIES:inside},async()=>{
  assert.equal(assertCleanStage8Release(actualSha,candidate),actualSha,'release identity comes from the actual checkout even with all donor selectors set');
  await writeFile(join(candidate,'tracked'),'dirty');
  assert.throws(()=>assertCleanStage8Release(donorSha,candidate),/CLEAN_RELEASE/,'a clean donor cannot authorize a dirty candidate');
  await assert.rejects(sealStage8RecoveryImage({sourcePath:f.path,backupPath,keyPath,keys:fixtureKeys,releaseSha:SHA,sourceTarget:TARGET}),/OUTSIDE_GIT_REQUIRED/);
 });
 await assert.rejects(lstat(backupPath),{code:'ENOENT'});
});

test('sealed backup success follows file and parent fsync; sync failures remove only the new artifact and preserve existing images',async t=>{
 const f=await fixture(t);await f.close();await chmod(f.path,0o600);
 const keyPath=join(f.directory,'key');await writeFile(keyPath,Buffer.alloc(32,37),{mode:0o600});
 const probe=await open(join(f.directory,'probe'),'wx',0o600),prototype=Object.getPrototypeOf(probe),originalSync=prototype.sync;await probe.close();
 const originalSource=await readFile(f.path),options={sourcePath:f.path,keyPath,keys:fixtureKeys,releaseSha:SHA,sourceTarget:TARGET};
 const successful=join(f.directory,'successful.enc');let retained;
 for(const failure of [null,'file','directory']){
  const events=[];let faulted=false;
  t.mock.method(prototype,'sync',async function(){
   const kind=(await this.stat()).isDirectory()?'directory':'file';events.push(kind);
   if(failure===kind&&!faulted){faulted=true;throw Object.assign(Error('SYNTHETIC_FSYNC_FAILURE'),{code:'EIO'});}
   return originalSync.call(this);
  });
  const backupPath=failure?join(f.directory,failure+'-failure.enc'):successful;
  try{
   if(failure){
    await assert.rejects(sealStage8RecoveryImage({...options,backupPath}),{code:'EIO'});
    await assert.rejects(lstat(backupPath),{code:'ENOENT'});
    assert.deepEqual(events,failure==='file'?['file','directory']:['file','directory','directory'],'failure cleanup also fsyncs the parent before returning');
    assert.deepEqual(await readFile(successful),retained,'a failed publication cannot remove an existing successful image');
   }else{
    const receipt=await sealStage8RecoveryImage({...options,backupPath});assert.ok(receipt.encryptedDigest);
    assert.deepEqual(events,['file','directory'],'no success receipt precedes either durability barrier');retained=await readFile(successful);
   }
  }finally{t.mock.restoreAll();}
 }
 assert.deepEqual(await readFile(f.path),originalSource);
});

test('remote application remains closed, unsafe backup protection and dirty release are rejected',async t=>{
 await assert.rejects(applyStage8LocalMigrationStep({protocol:'http'},{keys:fixtureKeys,fromVersion:33,targetVersion:34}),/REMOTE_QUIESCENCE_AUTHORITY/);
 await assert.rejects(main(['--apply']),/REMOTE_QUIESCENCE_AUTHORITY/);
 const f=await fixture(t);await f.close();await chmod(f.path,0o644);
 const keyPath=join(f.directory,'key');await writeFile(keyPath,Buffer.alloc(32,37),{mode:0o600});
 await assert.rejects(sealStage8RecoveryImage({sourcePath:f.path,backupPath:join(f.directory,'backup'),keyPath,keys:fixtureKeys,releaseSha:SHA,sourceTarget:TARGET}),/PROTECTED_FILE/);
 const repo=join(f.directory,'repo');fixtureGit(['init','--quiet',repo]);
 fixtureGit(['-c','user.name=Synthetic','-c','user.email=synthetic@example.invalid','commit','--allow-empty','--quiet','-m','synthetic'],repo);
 const sha=fixtureGit(['rev-parse','HEAD'],repo).trim();assert.equal(assertCleanStage8Release(sha,repo),sha);
 await writeFile(join(repo,'untracked'),'synthetic');assert.throws(()=>assertCleanStage8Release(sha,repo),/CLEAN_RELEASE/);
});

test('same-schema v35 recovery keeps manual Coach/Journal callbacks and legacy morning readiness before cutover while all new producers stay off',async t=>{
 const f=await fixture(t);await applyStage8LocalMigrationStep(f.db.raw,{keys:fixtureKeys,fromVersion:33,targetVersion:34});await applyStage8LocalMigrationStep(f.db.raw,{keys:fixtureKeys,fromVersion:34,targetVersion:35});
 const environment={PHASE4_EXECUTION_PROFILE:'STAGE8_V35_RECOVERY',PHASE4_BETA_SHADOW_RUNTIME:'off',PHASE4_PUBLIC_BETA_MODE:'off',STAGE7_COMPANION:'on',STAGE7_COMPANION_USER_IDS:'a',PHASE4_BETA_PILOT_USER_ID:'a',BODY_ENERGY_PUBLICATION:'off',BODY_ENERGY_ALERTS:'off'};
 assert.equal(executionProfile(environment),'STAGE8_V35_RECOVERY');
 assert.notEqual(configurationProof(fixtureKeys,{runtime:'off',mode:'off'},environment),configurationProof(fixtureKeys,{runtime:'off',mode:'off'},{...environment,PHASE4_EXECUTION_PROFILE:'PHASE4'}));
 const stage7=await createStage7Runtime({db:f.db,keys:fixtureKeys,environment,env:{}}),user=await f.db.getUser('a');
 for(const text of ['/coach','/journal']){
  const handled=await stage7.stage7Inbound({user,chatId:'123',text,updateId:123});assert.equal(handled.handled,true);
  const reply=await stage7.stage7Reply({user,chatId:'123',reply:handled.reply});assert.ok(reply.stage7ReplyGuard);
  const actor=await stage7.companion.interactions.authenticate({user,chatId:'123'});await stage7.companion.interactions.bind(actor,reply.stage7InteractionId,42);
  const button=reply.replyMarkup.inline_keyboard.flat().find(button=>button.callback_data?.startsWith('j7:'));assert.ok(button);
  const callback={id:text,from:{id:123},data:button.callback_data,message:{message_id:42,chat:{id:123,type:'private'}}};
  assert.equal((await stage7.stage7Inbound({user,chatId:'123',callback,updateId:124})).handled,true);
 }
 assert.equal(await createStage8Runtime({db:f.db,keys:fixtureKeys,environment,env:{}}),null);
 assert.equal((await f.db.raw.execute("SELECT count(*) n FROM tenant_delivery_modes WHERE message_family='MORNING_BRIEF_V1' AND execution_mode='LIVE' AND mode='PHASE4'")).rows[0].n,0,'this readiness witness is explicitly before PHASE4 Morning cutover');
 const request={kind:'MORNING_READINESS_V1',requestId:'v35-recovery-morning-001',releaseSha:runningReleaseSha(),executionMode:'OFF',triggerSource:'cloudflare',configProof:configurationProof(fixtureKeys,{runtime:'off',mode:'off'},environment)};
 const morning=await runMorningReadiness({request,db:f.db,keys:fixtureKeys,env:{maxUserConcurrency:1},environment,deps:{runUser:()=>assert.fail('no enrolled synthetic users')}});assert.equal(morning.status,200);assert.equal(morning.body.result.users,0);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM stage8_live_executions')).rows[0].n,0);
 for(const flag of ['STAGE8_LIVE_ANALYSIS','STAGE8_POST_SYNC','PHASE4_STAGE8_RUNTIME','STAGE8_MORNING_BRIEF','PHASE4_STAGE8_OWNER_MONITORING','PHASE4_DELIVERY_CUTOVER','BODY_ENERGY_PUBLICATION','STAGE7_AUTOMATIC'])assert.throws(()=>executionProfile({...environment,[flag]:'on'}),/RECOVERY_.*FEATURES_OFF_REQUIRED/);
 assert.equal(await currentVersion(f.db.raw),35);
});
