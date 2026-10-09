import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
const root=new URL('../',import.meta.url).href;
const {createDb}=await import(root+'src/db.js');
const {createOwnedDb}=await import(root+'test/stage5OwnedDb.js');
const {fixtureKeys}=await import(root+'test/localDb.js');
const {hranaTransport}=await import(root+'test/hranaTransport.js');
const {withExecutionBudget,createExecutionBudget}=await import(root+'src/executionBudget.js');
const {admitRuntime}=await import(root+'src/runtimeAdmission.js');
const {loadDailyMetricsDetailed}=await import(root+'src/dailyMetrics.js');
const {createSync,isSyncDue}=await import(root+'src/sync.js');
const {runExecutionPhase}=await import(root+'src/phase4Execution.js');
const {runningReleaseSha}=await import(root+'src/phase4Release.js');
const {configurationProof,claimPhaseRequest,readPhaseProgress}=await import(root+'src/phase4ExecutionStore.js');
const {publicBetaConfiguration}=await import(root+'src/publicBetaConfig.js');
const {createBriefingEndpoint}=await import(root+'src/briefingEndpoint.js');
const {invoke}=await import(root+'cloudflare/briefing-scheduler/worker.js');
const {signTriggerRequest}=await import(root+'src/briefingTriggerAuth.js');
const {randomUUID}=await import('node:crypto');
const constraint='SELECT ignore_check_constraints FROM pragma_ignore_check_constraints';
async function fixture(t,{shadow=false}={}){
 const dir=await mkdtemp('/private/tmp/rc4-adversarial-'),url=`file:${join(dir,'db.sqlite')}`,seed=createOwnedDb({url});
 await seed.migrate({targetVersion:32});
 if(shadow){await seed.raw.execute('CREATE TABLE pragma_ignore_check_constraints(ignore_check_constraints INTEGER)');await seed.raw.execute('INSERT INTO pragma_ignore_check_constraints VALUES(0)');}
 await seed.createUser({id:'alice',displayName:'Synthetic',status:'ACTIVE',timezone:'Asia/Taipei'});await seed.close();
 const transport=hranaTransport(url);let attack=null,disabled=false;
 const db=createDb({url:'https://isolated.invalid',phase4Keys:fixtureKeys,fetch:async request=>{
  let body=await request.clone().json();const contains=(v,p)=>v&&typeof v==='object'&&(typeof v.sql==='string'&&p.test(v.sql)||Object.values(v).some(x=>x&&typeof x==='object'&&contains(x,p)));
  if(attack&&contains(body,attack.match))return attack.run(request,body,transport);
  if(disabled){body.requests.unshift({type:'execute',stmt:{sql:'PRAGMA ignore_check_constraints=ON',args:[],named_args:[],want_rows:true}});const res=await transport.fetch(new Request(request,{body:JSON.stringify(body)}));const json=await res.json();json.results.shift();return new Response(JSON.stringify(json),{headers:{'content-type':'application/json'}});}
  return transport.fetch(request);
 }});
 t.after(async()=>{db.close();transport.close();await rm(dir,{recursive:true,force:true});});return {db,transport,setAttack:x=>attack=x,setDisabled:x=>disabled=x};
}
test('CHECK collision rejects actual HTTP admission even when bare source lies',async t=>{
 const f=await fixture(t,{shadow:true});f.setDisabled(true);
 assert.equal((await f.db.raw.execute('PRAGMA ignore_check_constraints')).rows[0].ignore_check_constraints,1);
 assert.equal((await f.db.raw.execute(constraint)).rows[0].ignore_check_constraints,0);
 await assert.rejects(()=>f.db.admitRuntime({fresh:true}));
 await assert.rejects(()=>f.db.raw.execute('SELECT ignore_check_constraints FROM pragma_ignore_check_constraints()'));
 console.log('REVIEW_FINDING '+JSON.stringify({kind:'CHECK_METADATA_SHADOW',actualIgnore:1,metadataIgnore:0,admission:'REJECTED',transport:'HTTP/Hrana'}));
});
for(const mode of ['transport','missingRows','malformedRows','timeout'])test('admission fails closed on '+mode,async t=>{
 const f=await fixture(t);f.setAttack({match:/FROM pragma_ignore_check_constraints/,run:async()=>{
  if(mode==='timeout')await new Promise(r=>setTimeout(r,120));
  throw Object.assign(Error('synthetic '+mode),{code:mode==='transport'?'ECONNRESET':'SQL_PARSE_ERROR'});
 }});
 if(mode==='timeout'){const budget=createExecutionBudget({budgetMs:100});try{await assert.rejects(()=>budget.run(()=>f.db.admitRuntime({fresh:true})),/SYNC_TIMEOUT/);}finally{budget.close();}}
 else await assert.rejects(()=>f.db.admitRuntime({fresh:true}));
});
test('Healthspan metadata failure rolls back metric data and every privacy link',async t=>{
 const f=await fixture(t);await f.db.admitRuntime();
 f.setAttack({match:/INSERT.*phase4_source_links/s,run:async(request,body,transport)=>{
  const visit=v=>{if(!v||typeof v!=='object')return;if(typeof v.sql==='string'&&/INSERT.*phase4_source_links/s.test(v.sql))v.sql='INSERT INTO deliberately_absent_table VALUES (1)';for(const x of Object.values(v))if(x&&typeof x==='object')visit(x);};visit(body);return transport.fetch(new Request(request,{body:JSON.stringify(body)}));
 }});
 await assert.rejects(()=>f.db.saveHealthspanMetrics('alice',[{metricKey:'one',value:1,availability:'AVAILABLE'},{metricKey:'two',value:2,availability:'AVAILABLE'}]));
 f.setAttack(null);assert.equal((await f.db.raw.execute('SELECT count(*) n FROM healthspan_metrics')).rows[0].n,0);
 assert.equal((await f.db.raw.execute("SELECT count(*) n FROM phase4_source_links WHERE artifact_type='healthspan_metrics'")).rows[0].n,0);
});
test('Healthspan lost COMMIT acknowledgement never proves success; fresh retry converges',async t=>{
 const f=await fixture(t);await f.db.admitRuntime();f.transport.arm({matchSql:/INSERT\s+INTO\s+healthspan_metrics/,loseAcknowledgement:true});
 const metrics=[{metricKey:'one',value:1,availability:'AVAILABLE'},{metricKey:'two',value:2,availability:'AVAILABLE'}],now=new Date('2026-10-09T00:00:00Z');
 await assert.rejects(()=>f.db.saveHealthspanMetrics('alice',metrics,{now}),/COMMIT_INDETERMINATE/);
 assert.equal(await f.db.saveHealthspanMetrics('alice',metrics,{now}),2);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM healthspan_metrics')).rows[0].n,2);
 assert.equal((await f.db.raw.execute("SELECT count(*) n FROM phase4_source_links WHERE artifact_type='healthspan_metrics'")).rows[0].n,2);
});
test('grouped sync-state order is independent and missing/partial/duplicate state cannot prove throttling',async()=>{
 const now=new Date(),resources=['sleep','recovery','cycle','workout','body_measurement'];
 const full=resources.map(resource=>({user_id:'alice',resource,backfill_complete:1,last_success_at:now.toISOString()}));
 for(const rows of [full,[...full].reverse(),[full[2],full[4],full[0],full[3],full[1]]])assert.equal(await isSyncDue({db:{getAllSyncState:async()=>rows},userId:'alice',now}),false);
 for(const rows of [[],full.slice(0,2),[...full,full[0]],full.map(r=>({...r,user_id:'bob'}))])assert.equal(await isSyncDue({db:{getAllSyncState:async()=>rows},userId:'alice',now}),true);
});
test('a caller timeout leaves server work running, same signed identity replays success without heavy work twice',async t=>{
 const f=await fixture(t),environment={PHASE4_BETA_SHADOW_RUNTIME:'off',PHASE4_PUBLIC_BETA_MODE:'off'},releaseSha=runningReleaseSha();
 const secret='synthetic-review-secret-only-'.repeat(2),proof=configurationProof(fixtureKeys,publicBetaConfiguration(environment),environment),phases=[],pending=[];let heavy=0;
 const endpoint=createBriefingEndpoint({secret,environment,runPhase:o=>{const p=runExecutionPhase({...o,db:f.db,keys:fixtureKeys,environment,env:{timezone:'Asia/Taipei',dryRun:true},budgetMs:10000,deps:{runBriefing:async()=>{heavy++;await new Promise(r=>setTimeout(r,2700));return {syncComplete:true,syncOutcome:'NO_NEW_DATA_SUCCESS',users:1,failed:0};}}});pending.push(p);return p;}});
 const fetchImpl=async(url,init)=>{const headers=Object.fromEntries(new Headers(init.headers));phases.push({headers,body:init.body});const result=await endpoint({url:'/internal/briefing/run',method:'POST',headers},init.body);return new Response(JSON.stringify(result.body),{status:result.status});};
 const workerEnv={BRIEFING_ENDPOINT_URL:'https://isolated.invalid/internal/briefing/run',BRIEFING_TRIGGER_SECRET:secret,BRIEFING_EXECUTION_MODE:'OFF',BRIEFING_RELEASE_SHA:releaseSha,BRIEFING_CONFIG_PROOF:proof};
 const started=performance.now();await assert.rejects(()=>invoke(workerEnv,{fetchImpl,timeoutMs:900,drainTimeoutMs:900,sleep:async()=>{}}),e=>e.category==='timeout');
 const callerMs=performance.now()-started;const final=await pending[0];assert.equal(final.status,200);assert.equal(heavy,1);assert.equal(phases.length,2);assert.equal(phases[0].body,phases[1].body);
 const same=phases[0];assert.deepEqual(await endpoint({url:'/internal/briefing/run',method:'POST',headers:same.headers},same.body),final);assert.equal(heavy,1);
 const progress=await readPhaseProgress(f.db,'SYNC','cloudflare');assert.equal(progress.settlementState,'FINALIZED_SUCCESS');
 console.log('REVIEW_TIMING '+JSON.stringify({name:'CALLER_DISCONNECT',callerMs,serverMs:performance.now()-started,workerOutcome:'TIMEOUT',serverOutcome:final.body.result.outcome,heavy,attempts:phases.length,replayMatched:true}));
});
