import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,chmod,writeFile,readFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync,execFileSync} from 'node:child_process';
import {createCipheriv} from 'node:crypto';
import {createOwnedDb} from './stage5OwnedDb.js';
import {fixtureKeys} from './localDb.js';
import {validatePausedProviders,validateWriterInventory,readDatabaseControl,requireProductionControl,PRODUCTION_CONTROL,FROZEN_GITHUB_SCHEMA_BARRIER,PUBLIC_MAINTENANCE_PROBES} from '../scripts/stage8-production-control.mjs';
import {authenticateProductionDump,main} from '../scripts/stage8-production-migrate.mjs';
import {configurationProof} from '../src/phase4ExecutionStore.js';
import {publicBetaConfiguration} from '../src/publicBetaConfig.js';

const SHA='a'.repeat(40),SOURCE='b'.repeat(40),KEYS={PHASE4_LOOKUP_KEY:Buffer.alloc(32,71).toString('hex'),PHASE4_AUDIT_KEY:Buffer.alloc(32,83).toString('hex')};
const inventory={operator:'synthetic-operator',...Object.fromEntries(['directSql','localPolling','manualCli','privateNetwork','renderBackground'].map(key=>[key,'STOPPED_EXCLUSIVE_MIGRATION_OPERATOR']))};
test('maintenance probes cover every internal and Telegram/WHOOP write route with POST',()=>{
 assert.ok(Object.isFrozen(PUBLIC_MAINTENANCE_PROBES));
 for(const path of ['/internal/briefing/run','/internal/briefing/companion','/internal/briefing/continuation','/internal/briefing/readiness','/telegram/webhook','/whoop/webhook'])
  for(const method of ['GET','POST'])assert.equal(PUBLIC_MAINTENANCE_PROBES.filter(probe=>probe.path===path&&probe.method===method).length,1);
 assert.equal(PUBLIC_MAINTENANCE_PROBES.filter(probe=>probe.path==='/whoop/oauth/callback'&&probe.method==='GET').length,1);
 assert.ok(PUBLIC_MAINTENANCE_PROBES.every(Object.isFrozen));
});
function paused(){
 const env={...KEYS,PHASE4_RELEASE_SHA:SOURCE,TURSO_DATABASE_URL:'libsql://'+PRODUCTION_CONTROL.host},proof=configurationProof(fixtureKeys,publicBetaConfiguration(env),env,SOURCE);
 return {service:{id:PRODUCTION_CONTROL.render,repo:'https://github.com/'+PRODUCTION_CONTROL.repo,autoDeploy:'no',serviceDetails:{maintenanceMode:{enabled:true},envSpecificDetails:{startCommand:'npm run bot:webhook'},plan:'0.5c-512mb'}},
  deploys:[{deploy:{id:'dep-synthetic',status:'live',commit:{id:SOURCE}}}],variables:Object.entries(env).map(([key,value])=>({envVar:{key,value}})),
  settings:{success:true,result:{bindings:Object.entries({BRIEFING_RELEASE_SHA:SOURCE,BRIEFING_CONFIG_PROOF:proof,BRIEFING_ENDPOINT_URL:PRODUCTION_CONTROL.origin+'/internal/briefing/run',BRIEFING_EXECUTION_MODE:'OFF',BRIEFING_CONTINUATION_SCOPE:'sync',BRIEFING_CONTINUATION_DISCOVERY:'on',BRIEFING_COMPANION_ENABLED:'on'}).map(([name,text])=>({type:'plain_text',name,text}))}},
  schedules:{success:true,result:{schedules:[]}},workflow:{id:PRODUCTION_CONTROL.workflow,path:'.github/workflows/briefing.yml',state:'disabled_manually'},activeRuns:Array.from({length:5},()=>({total_count:0,workflow_runs:[]}))};
}
async function directory(t){const dir=await realpath(await mkdtemp(join(tmpdir(),'stage8-prod-control-')));await chmod(dir,0o700);t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}

test('fixed provider contract rejects active writers, wrong target/release, changed keys and incomplete identity',()=>{
 assert.equal(validatePausedProviders(paused(),SOURCE,fixtureKeys).sourceSha,SOURCE);
 const attacks=[p=>{p.service.autoDeploy='yes';},p=>{p.service.serviceDetails.maintenanceMode.enabled=false;},p=>{p.service.repo+='-other';},p=>{p.deploys[0].deploy.commit.id=SHA;},
  p=>{p.deploys.push({deploy:{status:'queued'}});},p=>{p.schedules.result.schedules.push({cron:'* * * * *'});},p=>{p.activeRuns[0].total_count=1;},p=>{p.workflow.state='active';},
  p=>{p.settings.result.bindings.find(r=>r.name==='BRIEFING_CONFIG_PROOF').text='f'.repeat(64);},p=>{p.variables.find(r=>r.envVar.key==='PHASE4_AUDIT_KEY').envVar.value='f'.repeat(64);},
  p=>{p.variables.push({envVar:{key:'STAGE8_POST_SYNC',value:'on'}});},p=>{p.variables.find(r=>r.envVar.key==='TURSO_DATABASE_URL').envVar.value='libsql://wrong.invalid';}];
 for(const attack of attacks){const value=paused();attack(value);assert.throws(()=>validatePausedProviders(value,SOURCE,fixtureKeys));}
 assert.deepEqual(validateWriterInventory(inventory),inventory);
 for(const value of [{...inventory,directSql:'unknown'},{...inventory,extra:true},{...inventory,operator:''}])assert.throws(()=>validateWriterInventory(value),/INVENTORY/);
});

test('caller JSON cannot qualify the exact queued orphan or claim GitHub finality',async()=>{
 const report=JSON.parse(await readFile(new URL('../docs/evidence/stage8-frozen-cli-schema-denial-20261016/proof-report.json',import.meta.url))),p=paused();
 p.activeRuns[0]={total_count:1,workflow_runs:[report.actualRun]};
 for(const orphanBarrier of [undefined,{},report,{...FROZEN_GITHUB_SCHEMA_BARRIER,providerFinality:false,F02:'OWNER_ACCEPTED_KNOWN_RISK_UNCHANGED'}])
  assert.throws(()=>validatePausedProviders({...p,orphanBarrier},SOURCE,fixtureKeys),/GITHUB_NOT_QUIESCED/);
});

test('actual source keys, schema and active leases are checked while expired work remains untouched',async t=>{
 const dir=await directory(t),db=createOwnedDb({url:'file:'+join(dir,'source.sqlite')});t.after(()=>db.close());await db.migrate({targetVersion:33});
 await db.createUser({id:'a',displayName:'Synthetic',timezone:'Asia/Taipei',status:'ACTIVE'});
 await db.raw.execute({sql:"INSERT INTO resource_locks(name,owner,acquired_at,expires_at) VALUES('synthetic','synthetic',?,?)",args:[new Date().toISOString(),new Date(Date.now()+60000).toISOString()]});
 await assert.rejects(readDatabaseControl(db.raw,fixtureKeys),/ACTIVE_WRITERS/);
 await db.raw.execute("UPDATE resource_locks SET expires_at='2000-01-01T00:00:00Z'");
 const before=await readDatabaseControl(db.raw,fixtureKeys),after=await readDatabaseControl(db.raw,fixtureKeys);
 assert.equal(before.schema,33);assert.equal(before.activeLeases,0);assert.equal(before.snapshot.resource_locks.count,1);assert.equal(before.digest,after.digest);
 await assert.rejects(requireProductionControl({database:before,signature:'operator-label'}),/AUTHORITY_REQUIRED/);
});

test('SQL backup authenticates its entire envelope before returning plaintext and rejects tampering, wrong release and stale backup',async t=>{
 const dir=await directory(t),backupPath=join(dir,'dump.enc'),keyPath=join(dir,'key');await writeFile(keyPath,Buffer.alloc(32,17),{mode:0o600});
 const metadata={contract:'stage8-production-sql-recovery-v1',host:PRODUCTION_CONTROL.host,releaseSha:SHA,sourceSha:SOURCE,sourceDigest:'synthetic-only',schema:33,createdAt:Date.now()},iv=Buffer.alloc(12,8);
 const header=Buffer.from(JSON.stringify({metadata,iv:iv.toString('base64')})),size=Buffer.alloc(4);size.writeUInt32BE(header.length);const aad=Buffer.concat([Buffer.from('KHOSSQL1'),size,header]),cipher=createCipheriv('aes-256-gcm',Buffer.alloc(32,17),iv);cipher.setAAD(aad);
 const sealed=Buffer.concat([aad,cipher.update('BEGIN TRANSACTION; CREATE TABLE synthetic(id); COMMIT;'),cipher.final(),cipher.getAuthTag()]);await writeFile(backupPath,sealed,{mode:0o600});
 const options={backupPath,keyPath,releaseSha:SHA,sourceSha:SOURCE,sourceDigest:'synthetic-only'};
 assert.match((await authenticateProductionDump(options)).sql.toString(),/CREATE TABLE synthetic/);
 await assert.rejects(authenticateProductionDump({...options,releaseSha:SOURCE}),/BINDING/);
 await assert.rejects(authenticateProductionDump({...options,now:metadata.createdAt+3600001}),/BINDING/);
 const tampered=Buffer.from(sealed);tampered[tampered.length-18]^=1;await writeFile(backupPath,tampered,{mode:0o600});await assert.rejects(authenticateProductionDump(options));
 assert.equal((await readFile(backupPath)).length,sealed.length,'authentication failure never writes a plaintext artifact');
});

test('dirty release cannot observe or apply before any provider or database request',async t=>{
 // Make the precondition real even in a clean checkout. Remove only this
 // test's exclusively created directory; never rely on unrelated user edits.
 const dirty=await mkdtemp(new URL('./.stage8-dirty-release-',import.meta.url));
 t.after(()=>rm(dirty,{recursive:true,force:true}));
 await writeFile(join(dirty,'owned-probe'),'synthetic dirty release\n',{mode:0o600,flag:'wx'});
 let calls=0;t.mock.method(globalThis,'fetch',()=>{calls++;throw Error('NETWORK_FORBIDDEN');});
 const env={...process.env};for(const name of Object.keys(env))if(name.startsWith('GIT_'))delete env[name];
 const head=execFileSync('git',['rev-parse','HEAD'],{cwd:new URL('../',import.meta.url),env,encoding:'utf8'}).trim();
 await assert.rejects(main(['--observe','--expected-commit',head,'--source-commit',SOURCE,'--inventory-file','unused','--observation-file','unused'],{}),/CLEAN_RELEASE/);assert.equal(calls,0);
});

test('separate operator backup/restore/ordered core preserves populated synthetic33 data through35; provider authority is explicitly mocked',()=>{
 const result=spawnSync(process.execPath,['--experimental-test-module-mocks','--input-type=module','-e',`
  import {mock,test} from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,writeFile,chmod,rm,realpath} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {execFileSync} from 'node:child_process';
  const safety=await import('./scripts/stage8-migration-safety.mjs'),control=await import('./scripts/stage8-production-control.mjs');
  const {fixtureKeys}=await import('./test/localDb.js'),{createOwnedDb}=await import('./test/stage5OwnedDb.js');
  const dir=await realpath(await mkdtemp(join(tmpdir(),'synthetic-operator-')));await chmod(dir,0o700);const SHA='a'.repeat(40),SOURCE='b'.repeat(40);
  let db,saved,sourceUrl,download=0,controls=0,injectAt=0;
  mock.module('./scripts/stage8-migration-safety.mjs',{namedExports:{...safety,assertCleanStage8Release:()=>SHA}});
  mock.module('./scripts/stage8-production-control.mjs',{namedExports:{...control,productionControl:()=>({authorize:async()=>({}),close(){}}),requireProductionControl:async()=>{
   controls++;if(controls===injectAt)await db.raw.execute("INSERT INTO journal_events(user_id,event_at,health_date,category,source,created_at,updated_at) VALUES('a','2026-10-16T02:00:00Z','2026-10-16','caffeine','manual','2026-10-16','2026-10-16')");
   return {client:db.raw,keys:fixtureKeys,releaseSha:SHA,sourceSha:SOURCE,environment:{TURSO_AUTH_TOKEN:'synthetic-only',TURSO_DATABASE_URL:sourceUrl},database:saved,current:await control.readDatabaseControl(db.raw,fixtureKeys)};
  }}});
  const {main}=await import('./scripts/stage8-production-migrate.mjs');
  test('owned isolated DB only; writes before or after the atomic batch cannot replace recovery baseline',async()=>{try{for(const injection of [0,4,5]){
   injectAt=injection;controls=0;download=0;const path=join(dir,'source-'+injection+'.sqlite');sourceUrl='file:'+path;db=createOwnedDb({url:sourceUrl});try{
   await db.migrate({targetVersion:33});await db.createUser({id:'a',displayName:'Synthetic',timezone:'Asia/Taipei',status:'ACTIVE'});
   await db.raw.execute("INSERT INTO journal_events(user_id,event_at,health_date,category,source,created_at,updated_at) VALUES('a','2026-10-16T01:00:00Z','2026-10-16','caffeine','manual','2026-10-16','2026-10-16')");
   saved=await control.readDatabaseControl(db.raw,fixtureKeys);
   const sql=execFileSync('python3',['-c','import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); print(chr(10).join(c.iterdump()))',path]);
   globalThis.fetch=async(url,options)=>{assert.equal(url,'https://'+control.PRODUCTION_CONTROL.host+'/dump');assert.equal(options.redirect,'error');download++;return new Response(sql,{status:200});};
   const inventory=join(dir,'inventory-'+injection+'.json'),observation=join(dir,'observation-'+injection+'.json'),key=join(dir,'key-'+injection);for(const [p,v] of [[inventory,'{}'],[observation,'{}'],[key,Buffer.alloc(32,19)]])await writeFile(p,v,{mode:0o600});
   const run=()=>main(['--apply','--expected-commit',SHA,'--source-commit',SOURCE,'--inventory-file',inventory,'--observation-file',observation,'--backup-file',join(dir,'source-'+injection+'.enc'),'--key-file',key,'--from-version','33','--target-version','35','--confirm-production','whoop-briefing'],{});
   if(injection){
    await assert.rejects(run,/STAGE8_DATABASE_CHANGED_(AFTER_BACKUP|DURING_MIGRATION)/);
    assert.equal((await db.raw.execute('SELECT MAX(version) v FROM schema_version')).rows[0].v,injection===4?33:35,'detected external work prevents mutation or final success;34 is never separately committed');
    assert.equal((await db.raw.execute('SELECT count(*) n FROM journal_events')).rows[0].n,2,'external row remains intact rather than being deleted');
   }else{
    const result=await run();assert.equal(result.schema,35);assert.equal(result.trafficReopened,false);assert.deepEqual(result.steps.map(s=>s.to),[34,35,35]);
    assert.deepEqual(await safety.stage8PreservationSnapshot(db.raw,fixtureKeys,saved.snapshot),saved.snapshot);assert.equal((await db.raw.execute('SELECT count(*) n FROM journal_events')).rows[0].n,1);
   }
   assert.equal(download,1);
   }finally{await db.close();}
  }}finally{await rm(dir,{recursive:true,force:true});}});
 `],{cwd:new URL('../',import.meta.url),encoding:'utf8',env:Object.fromEntries(Object.entries(process.env).filter(([key])=>key!=='NODE_TEST_CONTEXT')),timeout:90000});
 assert.equal(result.status,0,result.stdout+result.stderr);
});

test('actual control protocol requires signed server-timed31min stability and complete logs when index is null',()=>{
 const result=spawnSync(process.execPath,['--experimental-test-module-mocks','--input-type=module','-e',`
  import {mock,test} from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,chmod,rm,realpath} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
  const safety=await import('./scripts/stage8-migration-safety.mjs'),libsql=await import('@libsql/client');
  const {createOwnedDb}=await import('./test/stage5OwnedDb.js');
  const p=${JSON.stringify(paused())},SOURCE='${SOURCE}',SHA='${SHA}',dir=await realpath(await mkdtemp(join(tmpdir(),'synthetic-quiescence-')));await chmod(dir,0o700);
  const db=createOwnedDb({url:'file:'+join(dir,'source.sqlite')});
  mock.module('./scripts/stage8-migration-safety.mjs',{namedExports:{...safety,assertCleanStage8Release:()=>SHA}});
  mock.module('@libsql/client',{namedExports:{...libsql,createClient:options=>{assert.equal(options.url,'libsql://whoop-briefing-enjoyfulwen0204-eng.aws-ap-northeast-1.turso.io');return db.raw;}}});
  const {productionControl,requireProductionControl,PRODUCTION_CONTROL}=await import('./scripts/stage8-production-control.mjs');
  const base=Date.now();let at=base,index=null,appActivity=false,requests=0,postBypass=false;const publicProbes=[];mock.method(Date,'now',()=>at);
  globalThis.fetch=async(input,options)=>{
   requests++;const url=new URL(input);let value;
   if(url.host==='whoop-telegram-webhook.onrender.com'){
    publicProbes.push([url.pathname,options.method]);
    if(options.method==='POST'){assert.equal(options.body,'{}');assert.equal(options.headers['content-type'],'application/json');assert.equal(options.headers.Authorization,undefined);}
    return new Response('maintenance',{status:postBypass&&options.method==='POST'&&url.pathname==='/internal/briefing/continuation'?200:503});
   }
   if(url.pathname.endsWith('/v2/pipeline'))value={results:[{type:'ok',response:{type:'execute',result:{replication_index:index}}}]};
   else if(url.pathname.endsWith('/deploys'))value=p.deploys;else if(url.pathname.endsWith('/env-vars'))value=p.variables;
   else if(url.pathname.endsWith('/settings'))value=p.settings;else if(url.pathname.endsWith('/schedules'))value=p.schedules;
   else if(url.pathname.includes('/actions/workflows/'))value=p.workflow;else if(url.pathname.endsWith('/actions/runs'))value={total_count:0,workflow_runs:[]};
   else if(url.pathname.endsWith('/logs'))value={logs:appActivity?[{id:'synthetic',timestamp:new Date(base+1000).toISOString(),labels:[{name:'resource',value:PRODUCTION_CONTROL.render},{name:'type',value:'app'}],message:'SYNTHETIC_APP_ACTIVITY'}]:[],hasMore:false};
   else if(url.pathname==='/v1/services/'+PRODUCTION_CONTROL.render)value=p.service;else throw Error('UNEXPECTED_SYNTHETIC_URL');
   return new Response(JSON.stringify(value),{status:200,headers:{date:new Date(at).toUTCString()}});
  };
  test('external providers and clock are mocked; SQL and controller checks are real',async()=>{try{
   await db.migrate({targetVersion:33});await db.createUser({id:'a',displayName:'Synthetic',timezone:'Asia/Taipei',status:'ACTIVE'});
   const environment={...Object.fromEntries(p.variables.map(row=>[row.envVar.key,row.envVar.value])),RENDER_API_KEY:'synthetic',CLOUDFLARE_API_TOKEN:'synthetic',GH_TOKEN:'synthetic',TURSO_AUTH_TOKEN:'synthetic'};
   const inventory=${JSON.stringify(inventory)},controller=productionControl({environment,releaseSha:SHA,sourceSha:SOURCE,inventory});
   const initial=JSON.parse(JSON.stringify(await controller.observe()));assert.equal(initial.replicationIndex,null);
   for(const path of ['/internal/briefing/run','/internal/briefing/companion','/internal/briefing/continuation','/internal/briefing/readiness','/telegram/webhook','/whoop/webhook'])assert.ok(publicProbes.some(p=>p[0]===path&&p[1]==='POST'));
   let n=requests;await assert.rejects(controller.authorize({...initial,observedAt:initial.observedAt-PRODUCTION_CONTROL.quietMs}),/OBSERVATION_INVALID/);assert.equal(requests,n,'forged JSON fails before provider requests');
   await assert.rejects(controller.authorize(initial),/FULL_QUIET_WINDOW/);assert.equal(requests,n);
   at=base+PRODUCTION_CONTROL.quietMs+2000;const permit=await controller.authorize(initial),state=await requireProductionControl(permit);
   assert.equal(state.current.digest,initial.database.digest);await assert.rejects(requireProductionControl(JSON.parse(JSON.stringify(permit))),/AUTHORITY_REQUIRED/);
   postBypass=true;await assert.rejects(requireProductionControl(permit),/PUBLIC_INGRESS_NOT_BLOCKED/);postBypass=false;
   index='1';await assert.rejects(controller.authorize(initial),/QUIET_WINDOW_CHANGED/);index=null;
   p.schedules.result.schedules.push({cron:'* * * * *'});await assert.rejects(requireProductionControl(permit),/CLOUDFLARE_NOT_QUIESCED/);p.schedules.result.schedules=[];
   appActivity=true;await assert.rejects(requireProductionControl(permit),/APPLICATION_NOT_DRAINED/);
  }finally{await db.close();await rm(dir,{recursive:true,force:true});}});
 `],{cwd:new URL('../',import.meta.url),encoding:'utf8',env:Object.fromEntries(Object.entries(process.env).filter(([key])=>key!=='NODE_TEST_CONTEXT')),timeout:90000});
 assert.equal(result.status,0,result.stdout+result.stderr);
});

test('exact frozen orphan is schema-bound through actual mocked provider reads; every changed job, attempt, pin or proof fails closed',async()=>{
 const report=JSON.parse(await readFile(new URL('../docs/evidence/stage8-frozen-cli-schema-denial-20261016/proof-report.json',import.meta.url)));
 const manifest=await readFile(new URL('../docs/evidence/stage8-frozen-cli-schema-denial-20261016/frozen-briefing.yml',import.meta.url));
 const result=spawnSync(process.execPath,['--experimental-test-module-mocks','--input-type=module','-e',`
  import {mock,test} from 'node:test';import assert from 'node:assert/strict';import * as fs from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
  const safety=await import('./scripts/stage8-migration-safety.mjs'),libsql=await import('@libsql/client'),{createOwnedDb}=await import('./test/stage5OwnedDb.js');
  const p=${JSON.stringify(paused())},run=${JSON.stringify(report.actualRun)},manifest=Buffer.from('${manifest.toString('base64')}','base64');
  const SOURCE='${SOURCE}',SHA='${SHA}',dir=await fs.realpath(await fs.mkdtemp(join(tmpdir(),'synthetic-orphan-barrier-')));await fs.chmod(dir,0o700);
  let db=createOwnedDb({url:'file:'+join(dir,'source.sqlite')}),attack='',at=Date.now(),reads={};
  mock.module('./scripts/stage8-migration-safety.mjs',{namedExports:{...safety,assertCleanStage8Release:()=>SHA}});
  mock.module('@libsql/client',{namedExports:{...libsql,createClient:()=>db.raw}});
  mock.module('node:fs/promises',{namedExports:{...fs,readFile:(path,...args)=>attack==='qualification'&&String(path).endsWith('/proof-report.json')?Promise.resolve(Buffer.from('{}')):fs.readFile(path,...args)}});
  const {productionControl,requireProductionControl,PRODUCTION_CONTROL,FROZEN_GITHUB_SCHEMA_BARRIER:pin}=await import('./scripts/stage8-production-control.mjs');
  mock.method(Date,'now',()=>at);
  globalThis.fetch=async(input,options)=>{
   const url=new URL(input);assert.equal(options.redirect,'error');let value;const key=url.pathname+url.search;reads[key]=(reads[key]??0)+1;
   if(url.host==='whoop-telegram-webhook.onrender.com')return new Response('maintenance',{status:503});
   if(url.pathname.endsWith('/v2/pipeline'))value={results:[{type:'ok',response:{type:'execute',result:{replication_index:null}}}]};
   else if(url.pathname.endsWith('/deploys'))value=p.deploys;else if(url.pathname.endsWith('/env-vars'))value=p.variables;
   else if(url.pathname.endsWith('/settings'))value=p.settings;else if(url.pathname.endsWith('/schedules'))value=p.schedules;
   else if(url.pathname.includes('/actions/workflows/'))value=p.workflow;
   else if(url.pathname.endsWith('/actions/runs')){
    const status=url.searchParams.get('status'),candidate={...run,...(attack==='attempt'?{run_attempt:2}:{}),...(attack==='head'?{head_sha:'f'.repeat(40)}:{}),...(attack==='other-run'?{id:run.id+1}:{}),...(attack==='updated'?{updated_at:'2026-10-10T06:15:03Z'}:{})};
    value=status==='queued'?{total_count:attack==='extra-run'?2:1,workflow_runs:attack==='extra-run'?[candidate,{...candidate,id:run.id+1}]:[candidate]}:attack==='running'&&status==='in_progress'?{total_count:1,workflow_runs:[{...run,status:'in_progress'}]}:{total_count:0,workflow_runs:[]};
   }else if(url.pathname.endsWith('/actions/runs/'+pin.runId+'/jobs')){
    assert.equal(url.searchParams.get('filter'),'all');assert.equal(url.searchParams.get('per_page'),'100');
    if(attack==='job-api')return new Response('{}',{status:403});
    value=attack==='job'?{total_count:1,jobs:[{id:7,status:'queued'}]}:{total_count:0,jobs:[]};
   }else if(url.pathname.endsWith('/actions/runs/'+pin.runId))value={...run,...(attack==='detail-attempt'?{run_attempt:2}:{})};
   else if(url.pathname.includes('/contents/')){
    assert.equal(url.searchParams.get('ref'),pin.headSha);
    value={type:'file',path:pin.path,sha:attack==='definition'?'e'.repeat(40):pin.blob,size:manifest.length,encoding:'base64',content:manifest.toString('base64')};
   }else if(url.pathname.endsWith('/git/blobs/'+pin.blob))value={sha:pin.blob,size:manifest.length,encoding:'base64',content:attack==='blob'?Buffer.from('changed immutable workflow').toString('base64'):manifest.toString('base64')};
   else if(url.pathname.endsWith('/logs'))value={logs:[],hasMore:false};
   else if(url.pathname==='/v1/services/'+PRODUCTION_CONTROL.render)value=p.service;else throw Error('UNEXPECTED_SYNTHETIC_URL');
   return new Response(JSON.stringify(value),{status:200,headers:{date:new Date(at).toUTCString()}});
  };
  test('actual schema and provider contract; no real network or provider mutation',async()=>{let db32;try{
   await db.migrate({targetVersion:33});await db.createUser({id:'a',displayName:'Synthetic',timezone:'Asia/Taipei',status:'ACTIVE'});
   const environment={...Object.fromEntries(p.variables.map(row=>[row.envVar.key,row.envVar.value])),RENDER_API_KEY:'synthetic',CLOUDFLARE_API_TOKEN:'synthetic',GH_TOKEN:'synthetic',TURSO_AUTH_TOKEN:'synthetic'};
   const inventory=${JSON.stringify(inventory)},controller=productionControl({environment,releaseSha:SHA,sourceSha:SOURCE,inventory});
   const initial=JSON.parse(JSON.stringify(await controller.observe())),g=initial.provider.github;
   assert.equal(g.queuedRunCount,1);assert.equal(g.nonterminalRunCount,1);assert.equal(g.run.status,'queued');assert.equal(g.run.attempt,1);assert.equal(g.allAttemptJobs,0);
   assert.equal(g.providerFinality,false);assert.equal(g.F02,'OWNER_ACCEPTED_KNOWN_RISK_UNCHANGED');assert.equal(g.codeBarrier.qualificationSha256,pin.qualificationSha256);assert.equal(initial.database.schema,33);
   const n=Object.values(reads).reduce((a,b)=>a+b,0);await assert.rejects(controller.authorize({...initial,provider:{...initial.provider,github:{...g,queuedRunCount:0,providerFinality:true}}}),/OBSERVATION_INVALID/);assert.equal(Object.values(reads).reduce((a,b)=>a+b,0),n);
   await assert.rejects(controller.authorize(initial),/FULL_QUIET_WINDOW/);at+=PRODUCTION_CONTROL.quietMs+2000;
   const permit=await controller.authorize(initial);assert.equal((await requireProductionControl(permit)).current.schema,33);
   for(const value of ['job','job-api','attempt','detail-attempt','head','updated','other-run','extra-run','running','definition','blob','qualification']){
    attack=value;await assert.rejects(requireProductionControl(permit),/STAGE8_(?:FROZEN_GITHUB|GITHUB_NOT_QUIESCED|PROVIDER_READ_FAILED)/,value);
   }
   attack='';
   for(const version of [34,35]){await db.migrate({targetVersion:version});const state=await requireProductionControl(permit);assert.equal(state.current.schema,version);assert.equal(state.provider.github.providerFinality,false);}
   const paths=['/actions/runs/'+pin.runId,'/actions/runs/'+pin.runId+'/jobs?filter=all&per_page=100','/contents/'+pin.path+'?ref='+pin.headSha,'/git/blobs/'+pin.blob];
   for(const path of paths){const key='/repos/'+PRODUCTION_CONTROL.repo+path;assert.ok(reads[key]>=5,'fresh immutable identity/job/code reads repeat at every successful provider check');}
   db32=createOwnedDb({url:'file:'+join(dir,'schema32.sqlite')});await db32.migrate({targetVersion:32});const saved=db;db=db32;
   const oldController=productionControl({environment,releaseSha:SHA,sourceSha:SOURCE,inventory});await assert.rejects(oldController.observe(),/FROZEN_GITHUB_SCHEMA_UNQUALIFIED/);db=saved;
  }finally{await db32?.close();await db.close();await fs.rm(dir,{recursive:true,force:true});}});
 `],{cwd:new URL('../',import.meta.url),encoding:'utf8',env:Object.fromEntries(Object.entries(process.env).filter(([key])=>key!=='NODE_TEST_CONTEXT')),timeout:90000});
 assert.equal(result.status,0,result.stdout+result.stderr);
});
