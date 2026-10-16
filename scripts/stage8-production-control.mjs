import {createClient} from '@libsql/client';
import {fileURLToPath} from 'node:url';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {phase4AuthorityKeys,publicBetaConfiguration} from '../src/publicBetaConfig.js';
import {pausedSourceConfigurationProof,CA4_SOURCE_PROOF} from './stage8-source-configuration-proof.mjs';
import {currentVersion} from '../src/migrations.js';
import {assertCleanStage8Release,stage8PreservationSnapshot,verifyStage8RecoveryClient,STAGE8_PRODUCTION_HOST} from './stage8-migration-safety.mjs';
import {withStage8MetadataReadCache} from './stage8-metadata-read-cache.mjs';

export const PRODUCTION_CONTROL=Object.freeze({
 host:STAGE8_PRODUCTION_HOST,render:'srv-dahs71qd0e5s738n94c0',renderOwner:'tea-d8ptktu8bjmc73c5f9sg',
 repo:'enjoyfulwen0204-eng/whoop-briefing',worker:'whoop-briefing-scheduler',
 cloudflare:'17558c0263c5c4076055ee0f860907dc',workflow:340955986,
 origin:'https://whoop-telegram-webhook.onrender.com',quietMs:31*60_000,maxObservationMs:2*60*60_000,
});
const audit=(keys,value)=>keys.digest(keys.lookup(['stage8-operator-audit-domain-v1']),JSON.stringify(value));
const serverDate=Symbol('authenticated-provider-date'),repository=fileURLToPath(new URL('../',import.meta.url));
const permits=new WeakMap(),fail=code=>{throw Object.assign(Error(code),{code});};
const frozenRunGrants=new WeakMap();
export const FROZEN_GITHUB_SCHEMA_BARRIER=Object.freeze({
 contract:'exact-frozen-github-cli-newer-schema-denial-v1',runId:37892556296,attempt:1,
 headSha:'2ef4a1162c64d67bd1add0e0259872329e80d46c',checkoutSha:'8fbc2d90ae2b3fe68ae29454a26d7603c98784f0',
 path:'.github/workflows/briefing.yml',blob:'9efda39f2e73cb56521949f60b32eaf199f22fbd',
 manifestSha256:'3373649ffdd00fcf9651bf108dd06de62d573d66a626d439aa43f54a1d0e14b6',
 qualificationSha256:'7dc59e4b5b7048c12aa93c1cb6f088574769ea4fd8fcb2f7156b5798b5ab869c',
 schemas:Object.freeze([33,34,35]),f02:'OWNER_ACCEPTED_KNOWN_RISK_UNCHANGED',
});
const serial=value=>JSON.stringify(value,(_,v)=>typeof v==='bigint'?{int64:v.toString()}:ArrayBuffer.isView(v)?{blob:Buffer.from(v.buffer,v.byteOffset,v.byteLength).toString('base64')}:v instanceof ArrayBuffer?{blob:Buffer.from(v).toString('base64')}:v);
const identifier=name=>{if(!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name))fail('STAGE8_SCHEMA_IDENTIFIER_INVALID');return '"'+name+'"';};
const sha=value=>{if(!/^[a-f0-9]{40}$/.test(value??''))fail('STAGE8_EXACT_RELEASE_REQUIRED');return value;};
const credentials=environment=>{
 for(const key of ['RENDER_API_KEY','CLOUDFLARE_API_TOKEN','GH_TOKEN','TURSO_AUTH_TOKEN'])if(typeof environment[key]!=='string'||!environment[key])fail('STAGE8_OPERATOR_AUTH_REQUIRED');
 if(![`libsql://${PRODUCTION_CONTROL.host}`,`libsql://${PRODUCTION_CONTROL.host}/`].includes(environment.TURSO_DATABASE_URL))fail('STAGE8_PRODUCTION_TARGET_MISMATCH');
};
async function response(url,token,options={}){
 const value=await fetch(url,{...options,redirect:'error',signal:AbortSignal.timeout(30_000),headers:{...(token?{Authorization:'Bearer '+token}:{}),accept:'application/json',...options.headers}});
 if(value.status!==200)fail('STAGE8_PROVIDER_READ_FAILED');
 const date=Date.parse(value.headers.get('date'));if(!Number.isFinite(date)||Math.abs(Date.now()-date)>120_000)fail('STAGE8_PROVIDER_CLOCK_UNPROVEN');
 if(Number(value.headers.get('content-length')??0)>1024*1024)fail('STAGE8_PROVIDER_RESPONSE_BOUNDS');
 const reader=value.body?.getReader();if(!reader)fail('STAGE8_PROVIDER_READ_FAILED');let bytes=0;const chunks=[];
 try{for(;;){const next=await reader.read();if(next.done)break;bytes+=next.value.length;if(bytes>1024*1024)fail('STAGE8_PROVIDER_RESPONSE_BOUNDS');chunks.push(next.value);}}
 finally{try{await reader.cancel();}catch{}reader.releaseLock();}
 try{const parsed=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!parsed||typeof parsed!=='object')throw Error();Object.defineProperty(parsed,serverDate,{value:date});return parsed;}catch{fail('STAGE8_PROVIDER_RESPONSE_INVALID');}
}
const renderPath=path=>'https://api.render.com/v1/'+path;
const cfPath=path=>`https://api.cloudflare.com/client/v4/accounts/${PRODUCTION_CONTROL.cloudflare}/workers/scripts/${PRODUCTION_CONTROL.worker}/`+path;
const ghPath=path=>`https://api.github.com/repos/${PRODUCTION_CONTROL.repo}/`+path;
async function renderList(path,token){
 const all=[],seen=new Set();let cursor='';
 for(let page=0;page<100;page++){
  const result=await response(renderPath(path+'?limit=100'+(cursor?'&cursor='+encodeURIComponent(cursor):'')),token);
  if(!Array.isArray(result))fail('STAGE8_PROVIDER_RESPONSE_INVALID');all.push(...result);if(result.length<100)return all;
  const next=result.at(-1)?.cursor;if(typeof next!=='string'||!next||seen.has(next))fail('STAGE8_PROVIDER_PAGINATION_UNPROVEN');seen.add(next);cursor=next;
 }
 fail('STAGE8_PROVIDER_PAGINATION_UNPROVEN');
}
function exactFrozenRun(run){
 const pin=FROZEN_GITHUB_SCHEMA_BARRIER;
 if(run?.id!==pin.runId||run.run_attempt!==pin.attempt||run.workflow_id!==PRODUCTION_CONTROL.workflow||run.path!==pin.path
  ||run.head_sha!==pin.headSha||run.event!=='workflow_dispatch'||run.status!=='queued'||run.conclusion!==null
  ||run.created_at!=='2026-10-09T06:15:03Z'||run.updated_at!=='2026-10-09T06:15:03Z')fail('STAGE8_GITHUB_NOT_QUIESCED');
 return {id:run.id,attempt:run.run_attempt,headSha:run.head_sha,path:run.path,status:run.status,conclusion:run.conclusion};
}
function githubInventory(activeRuns){
 if(!Array.isArray(activeRuns)||activeRuns.length!==5||activeRuns.some(r=>!Number.isSafeInteger(r?.total_count)||r.total_count<0||!Array.isArray(r.workflow_runs)||r.workflow_runs.length!==r.total_count))fail('STAGE8_GITHUB_NOT_QUIESCED');
 const total=activeRuns.reduce((n,r)=>n+r.total_count,0);
 if(total===0)return null;
 if(total!==1||activeRuns[0].total_count!==1)fail('STAGE8_GITHUB_NOT_QUIESCED');
 return exactFrozenRun(activeRuns[0].workflow_runs[0]);
}
function manifestBytes(blob){
 const pin=FROZEN_GITHUB_SCHEMA_BARRIER;
 if(blob?.sha!==pin.blob||blob.encoding!=='base64'||typeof blob.content!=='string')fail('STAGE8_FROZEN_GITHUB_MANIFEST_CHANGED');
 const text=blob.content.replace(/\r?\n/g,''),bytes=Buffer.from(text,'base64');
 if(!/^[A-Za-z0-9+/]+={0,2}$/.test(text)||bytes.toString('base64')!==text||blob.size!==bytes.length
  ||createHash('sha256').update(bytes).digest('hex')!==pin.manifestSha256
  ||createHash('sha1').update(Buffer.from('blob '+bytes.length+'\0')).update(bytes).digest('hex')!==pin.blob)fail('STAGE8_FROZEN_GITHUB_MANIFEST_CHANGED');
 return bytes;
}
/** This is a code-specific non-writer proof, never GitHub finality or token
 * containment. Fixed qualification bytes and actual provider reads are both
 * mandatory; no caller JSON/flag can mint the private grant. */
async function frozenGithubBarrier(environment,schema){
 const pin=FROZEN_GITHUB_SCHEMA_BARRIER;
 if(!pin.schemas.includes(schema))fail('STAGE8_FROZEN_GITHUB_SCHEMA_UNQUALIFIED');
 const bytes=await readFile(new URL('../docs/evidence/stage8-frozen-cli-schema-denial-20261016/proof-report.json',import.meta.url));
 if(createHash('sha256').update(bytes).digest('hex')!==pin.qualificationSha256)fail('STAGE8_FROZEN_GITHUB_QUALIFICATION_UNPROVEN');
 const qualification=JSON.parse(bytes);
 if(qualification.contract!==pin.contract||qualification.status!=='EXACT_FROZEN_CLI_DENIED_BEFORE_MUTABLE_SQL_FOR_V33_V34_V35'
  ||qualification.results.length!==9)fail('STAGE8_FROZEN_GITHUB_QUALIFICATION_UNPROVEN');
 const [run,jobs,definition,blob]=await Promise.all([
  response(ghPath('actions/runs/'+pin.runId),environment.GH_TOKEN),
  response(ghPath('actions/runs/'+pin.runId+'/jobs?filter=all&per_page=100'),environment.GH_TOKEN),
  response(ghPath('contents/'+pin.path+'?ref='+pin.headSha),environment.GH_TOKEN),
  response(ghPath('git/blobs/'+pin.blob),environment.GH_TOKEN),
 ]);
 const identity=exactFrozenRun(run);
 if(jobs?.total_count!==0||!Array.isArray(jobs.jobs)||jobs.jobs.length)fail('STAGE8_FROZEN_GITHUB_JOBS_PRESENT');
 if(definition?.path!==pin.path||definition.type!=='file')fail('STAGE8_FROZEN_GITHUB_MANIFEST_CHANGED');
 manifestBytes(definition);manifestBytes(blob);
 const grant=Object.freeze({});frozenRunGrants.set(grant,Object.freeze({
  nonterminalRunCount:1,queuedRunCount:1,run:identity,allAttemptJobs:0,providerFinality:false,F02:pin.f02,
  codeBarrier:{contract:pin.contract,checkoutSha:pin.checkoutSha,manifestBlob:pin.blob,manifestSha256:pin.manifestSha256,
   qualificationSha256:pin.qualificationSha256,qualifiedSchemas:[...pin.schemas],denial:'BEFORE_MUTABLE_SQL_AND_PROVIDERS'},
 }));return grant;
}

/** No operator label grants this declaration authority by itself. The explicit
 * inventory supplements the independently read providers, DB and log window. */
export function validateWriterInventory(value){
 if(!value||Object.keys(value).sort().join(',')!=='directSql,localPolling,manualCli,operator,privateNetwork,renderBackground'
  ||typeof value.operator!=='string'||!/^[a-zA-Z0-9_.@-]{1,80}$/.test(value.operator)
  ||['directSql','localPolling','manualCli','privateNetwork','renderBackground'].some(key=>value[key]!=='STOPPED_EXCLUSIVE_MIGRATION_OPERATOR'))fail('STAGE8_WRITER_INVENTORY_REQUIRED');
 return structuredClone(value);
}
export function validatePausedProviders({service,deploys,variables,settings,schedules,workflow,activeRuns,orphanBarrier},sourceSha,keys,schema){
 if(service?.id!==PRODUCTION_CONTROL.render||service.repo!==`https://github.com/${PRODUCTION_CONTROL.repo}`||service.autoDeploy!=='no'
  ||service.serviceDetails?.maintenanceMode?.enabled!==true||(service.serviceDetails?.envSpecificDetails?.startCommand??service.serviceDetails?.startCommand)!=='npm run bot:webhook')fail('STAGE8_RENDER_NOT_QUIESCED');
 if(!Array.isArray(deploys)||!deploys.length)fail('STAGE8_DEPLOYMENT_UNPROVEN');
 const entries=deploys.map(row=>row.deploy??row),live=entries.filter(row=>row.status==='live');
 if(entries.some(row=>!['live','deactivated','canceled','build_failed','update_failed','pre_deploy_failed'].includes(row.status))||live.length!==1||live[0].commit?.id!==sourceSha)fail('STAGE8_DEPLOYMENT_UNPROVEN');
 if(!Array.isArray(variables)||variables.length===0)fail('STAGE8_RENDER_BINDINGS_UNPROVEN');
 const env=Object.fromEntries(variables.map(row=>row.envVar??row).map(row=>[row.key,row.value]));
 if(env.PHASE4_RELEASE_SHA!==sourceSha||!['off',undefined].includes(env.STAGE8_POST_SYNC))fail('STAGE8_RENDER_BINDINGS_UNPROVEN');
 if(env.TURSO_DATABASE_URL!==`libsql://${PRODUCTION_CONTROL.host}`&&env.TURSO_DATABASE_URL!==`libsql://${PRODUCTION_CONTROL.host}/`)fail('STAGE8_PRODUCTION_TARGET_MISMATCH');
 // Actual deployed key verifiers must be the same authority supplied locally.
 const remoteKeys=phase4AuthorityKeys(env);
 if(remoteKeys.lookup(['stage8-operator-key-continuity-v1'])!==keys.lookup(['stage8-operator-key-continuity-v1'])||audit(remoteKeys,['stage8-operator-key-continuity-v1'])!==audit(keys,['stage8-operator-key-continuity-v1']))fail('STAGE8_KEY_CONTINUITY_REQUIRED');
 if(settings?.success!==true||!Array.isArray(settings.result?.bindings)||schedules?.success!==true||!Array.isArray(schedules.result?.schedules)||schedules.result.schedules.length)fail('STAGE8_CLOUDFLARE_NOT_QUIESCED');
 const bindings=Object.fromEntries(settings.result.bindings.filter(row=>row.type==='plain_text').map(row=>[row.name,row.text]));
 const proof=pausedSourceConfigurationProof(keys,publicBetaConfiguration(env),env,sourceSha,schema);
 if(bindings.BRIEFING_RELEASE_SHA!==sourceSha||bindings.BRIEFING_CONFIG_PROOF!==proof||bindings.BRIEFING_ENDPOINT_URL!==PRODUCTION_CONTROL.origin+'/internal/briefing/run'
  ||bindings.BRIEFING_EXECUTION_MODE!=='OFF'||bindings.BRIEFING_CONTINUATION_SCOPE!=='sync'||bindings.BRIEFING_CONTINUATION_DISCOVERY!=='on'
  ||!['off','on'].includes(bindings.BRIEFING_COMPANION_ENABLED))fail('STAGE8_CLOUDFLARE_BINDINGS_UNPROVEN');
 if(workflow?.id!==PRODUCTION_CONTROL.workflow||workflow.path!=='.github/workflows/briefing.yml'||workflow.state!=='disabled_manually')fail('STAGE8_GITHUB_NOT_QUIESCED');
 const orphan=githubInventory(activeRuns),barrier=frozenRunGrants.get(orphanBarrier);
 if(orphan&&(!barrier||serial(orphan)!==serial(barrier.run))||!orphan&&orphanBarrier)fail('STAGE8_GITHUB_NOT_QUIESCED');
 return {renderId:service.id,sourceSha,sourceProofContract:sourceSha===CA4_SOURCE_PROOF.sourceSha?CA4_SOURCE_PROOF.canonicalFunctionSha256:'CURRENT_CANDIDATE_FORMULA',deployId:live[0].id,deploymentHistory:keys.lookup(['stage8-render-deployments-v1',entries.map(row=>[row.id,row.status,row.commit?.id,row.createdAt,row.finishedAt])]),maintenance:true,autoDeploy:'no',proof,
  plan:service.serviceDetails.plan,worker:PRODUCTION_CONTROL.worker,workflow:workflow.id,
  bindings:keys.lookup(['stage8-provider-bindings-v1',bindings]),postSync:'off',github:orphan?barrier:{nonterminalRunCount:0,queuedRunCount:0}};
}
async function pausedProviders(environment,sourceSha,keys,schema){
 const activeStatuses=['queued','in_progress','waiting','requested','pending'];
 const results=await Promise.all([
  response(renderPath('services/'+PRODUCTION_CONTROL.render),environment.RENDER_API_KEY),
  renderList(`services/${PRODUCTION_CONTROL.render}/deploys`,environment.RENDER_API_KEY),
  renderList(`services/${PRODUCTION_CONTROL.render}/env-vars`,environment.RENDER_API_KEY),
  response(cfPath('settings'),environment.CLOUDFLARE_API_TOKEN),response(cfPath('schedules'),environment.CLOUDFLARE_API_TOKEN),
  response(ghPath('actions/workflows/'+PRODUCTION_CONTROL.workflow),environment.GH_TOKEN),
  ...activeStatuses.map(status=>response(ghPath('actions/runs?status='+status+'&per_page=100'),environment.GH_TOKEN)),
 ]);
 const [service,deploys,variables,settings,schedules,workflow,...activeRuns]=results;
 const orphanBarrier=githubInventory(activeRuns)?await frozenGithubBarrier(environment,schema):null;
 const state=validatePausedProviders({service,deploys,variables,settings,schedules,workflow,activeRuns,orphanBarrier},sourceSha,keys,schema);
 // Check the actual POST ingress as well as GET. An edge rule that blocks only
 // GET must never qualify as writer quiescence. Unsigned empty requests cannot
 // authorize work if maintenance was unexpectedly removed during a probe.
 for(const {path,method} of PUBLIC_MAINTENANCE_PROBES){
  const result=await fetch(PRODUCTION_CONTROL.origin+path,{method,redirect:'error',signal:AbortSignal.timeout(15_000),...(method==='POST'?{headers:{'content-type':'application/json'},body:'{}'}:{})});
  try{if(result.status!==503)fail('STAGE8_PUBLIC_INGRESS_NOT_BLOCKED');}finally{await result.body?.cancel();}
 }
 Object.defineProperty(state,'observedAtServer',{value:service[serverDate]});return state;
}
export const PUBLIC_MAINTENANCE_PROBES=Object.freeze([
 ...['/health','/internal/briefing/run','/internal/briefing/companion','/internal/briefing/continuation','/internal/briefing/readiness','/telegram/webhook','/whoop/webhook','/whoop/oauth/callback'].map(path=>Object.freeze({path,method:'GET'})),
 ...['/internal/briefing/run','/internal/briefing/companion','/internal/briefing/continuation','/internal/briefing/readiness','/telegram/webhook','/whoop/webhook'].map(path=>Object.freeze({path,method:'POST'})),
]);
export async function readDatabaseControl(client,keys){
 return withStage8MetadataReadCache(client,keys,readDatabaseControlUncached);
}
async function readDatabaseControlUncached(client,keys){
 const schema=await verifyStage8RecoveryClient(client,keys);
 const tables=(await client.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")).rows.map(row=>row.name);
 let active=0;
 for(const table of tables){
  const columns=(await client.execute(`PRAGMA table_info(${identifier(table)})`)).rows.map(row=>row.name),predicates=[];
  if(columns.includes('lease_until'))predicates.push('lease_until>CAST((julianday(\'now\')-2440587.5)*86400000 AS INTEGER)'+(columns.includes('finalized_at')?' AND finalized_at IS NULL':''));
  if(columns.includes('lease_expires_at'))predicates.push("julianday(lease_expires_at)>julianday('now')");
  if(table==='resource_locks')predicates.push("julianday(expires_at)>julianday('now')");
  if(table==='report_claims')predicates.push("delivery_state IN ('CLAIMED','DELIVERY_STARTED') AND julianday(expires_at)>julianday('now')");
  if(predicates.length)active+=Number((await client.execute(`SELECT count(*) n FROM ${identifier(table)} WHERE ${predicates.map(p=>'('+p+')').join(' OR ')}`)).rows[0].n);
 }
 if(active!==0)fail('STAGE8_ACTIVE_WRITERS_PRESENT');
 const snapshot=await stage8PreservationSnapshot(client,keys),history=keys.lookup(['stage8-schema-history-v1',
  (await client.execute('SELECT * FROM schema_version ORDER BY version')).rows,
  (await client.execute('SELECT * FROM phase4_migration_checkpoints ORDER BY target_version,step_key')).rows]);
 return {schema,activeLeases:0,snapshot,digest:keys.lookup(['stage8-production-all-rows-v1',snapshot,history]),history};
}
async function replicationIndex(environment){
 const body=await response(`https://${PRODUCTION_CONTROL.host}/v2/pipeline`,environment.TURSO_AUTH_TOKEN,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({requests:[{type:'execute',stmt:{sql:'SELECT 1',want_rows:true}},{type:'close'}]})});
 const result=body.results?.[0];if(result?.type!=='ok'||result.response?.type!=='execute')fail('STAGE8_REPLICATION_OBSERVATION_FAILED');
 const index=result.response.result?.replication_index;
 if(index===null)return null;
 if(typeof index!=='string'||!/^(0|[1-9][0-9]*)$/.test(index))fail('STAGE8_REPLICATION_OBSERVATION_FAILED');
 return index;
}
/** Complete authenticated app-log window. Any app activity forces a new quiet
 * window; raw messages never leave this module or appear in operator receipts. */
async function assertDrainedLogs(environment,start,end,keys){
 let from=new Date(start).toISOString(),until=new Date(end).toISOString(),count=0,hash=audit(keys,['stage8-drain-logs-v1',from,until]);
 for(let page=0;page<100;page++){
  const query=new URLSearchParams({ownerId:PRODUCTION_CONTROL.renderOwner,resource:PRODUCTION_CONTROL.render,type:'app',startTime:from,endTime:until,direction:'forward',limit:'100'});
  const result=await response(renderPath('logs?'+query),environment.RENDER_API_KEY);
  if(!Array.isArray(result.logs)||typeof result.hasMore!=='boolean')fail('STAGE8_LOG_WINDOW_UNPROVEN');
  for(const row of result.logs){
   const time=Date.parse(row.timestamp);if(!Number.isFinite(time)||time<start||time>end||!Array.isArray(row.labels)||!row.labels.some(v=>v.name==='resource'&&v.value===PRODUCTION_CONTROL.render)||!row.labels.some(v=>v.name==='type'&&v.value==='app'))fail('STAGE8_LOG_WINDOW_UNPROVEN');
   count++;hash=audit(keys,['stage8-drain-log-v1',hash,row.id,row.timestamp,row.message]);
  }
  if(!result.hasMore){if(count)fail('STAGE8_APPLICATION_NOT_DRAINED');return {count:0,digest:hash,from:start,through:end};}
  if(typeof result.nextStartTime!=='string'||typeof result.nextEndTime!=='string'||Date.parse(result.nextStartTime)<=Date.parse(from)||Date.parse(result.nextEndTime)>end||Date.parse(result.nextEndTime)<Date.parse(result.nextStartTime))fail('STAGE8_LOG_WINDOW_UNPROVEN');
  from=result.nextStartTime;until=result.nextEndTime;
 }
 fail('STAGE8_LOG_WINDOW_UNPROVEN');
}
const seal=(keys,value)=>({...value,signature:audit(keys,['stage8-production-observation-v1',value])});
function verifyObservation(keys,receipt,{releaseSha,sourceSha,inventory},now){
 const {signature,...value}=receipt??{};
 if(signature!==audit(keys,['stage8-production-observation-v1',value])||value.contract!=='stage8-production-observation-v1'||value.releaseSha!==releaseSha||value.sourceSha!==sourceSha
  ||value.inventory!==audit(keys,['stage8-writer-inventory-v1',inventory])||!Number.isSafeInteger(value.observedAt)||now<value.observedAt||now-value.observedAt>PRODUCTION_CONTROL.maxObservationMs)fail('STAGE8_QUIESCENCE_OBSERVATION_INVALID');
 return value;
}
export function productionControl({environment,releaseSha,sourceSha,inventory}){
 if(Number(process.versions.node.split('.')[0])!==22)fail('STAGE8_NODE22_REQUIRED');assertCleanStage8Release(releaseSha,repository);environment=Object.freeze({...environment});
 credentials(environment);sha(releaseSha);sha(sourceSha);inventory=validateWriterInventory(inventory);
 const keys=phase4AuthorityKeys(environment),client=createClient({url:environment.TURSO_DATABASE_URL,authToken:environment.TURSO_AUTH_TOKEN,intMode:'number'});
 async function observe(){
  assertCleanStage8Release(releaseSha,repository);
  const schema=await currentVersion(client),provider=await pausedProviders(environment,sourceSha,keys,schema),before=await replicationIndex(environment),database=await readDatabaseControl(client,keys),after=await replicationIndex(environment);
  if(database.schema!==schema)fail('STAGE8_DATABASE_CHANGED_DURING_OBSERVATION');
  if(before!==after)fail('STAGE8_DATABASE_CHANGED_DURING_OBSERVATION');
  return seal(keys,{contract:'stage8-production-observation-v1',releaseSha,sourceSha,inventory:audit(keys,['stage8-writer-inventory-v1',inventory]),provider,replicationIndex:after,database,observedAt:provider.observedAtServer});
 }
 async function authorize(receipt){
  const initial=verifyObservation(keys,receipt,{releaseSha,sourceSha,inventory},Date.now());
  if(Date.now()-initial.observedAt<PRODUCTION_CONTROL.quietMs)fail('STAGE8_FULL_QUIET_WINDOW_REQUIRED');
  const current=await observe();
  if(current.observedAt-initial.observedAt<PRODUCTION_CONTROL.quietMs)fail('STAGE8_FULL_QUIET_WINDOW_REQUIRED');
  if(serial(current.provider)!==serial(initial.provider)||current.replicationIndex!==initial.replicationIndex||current.database.digest!==initial.database.digest)fail('STAGE8_QUIET_WINDOW_CHANGED');
  const logs=await assertDrainedLogs(environment,initial.observedAt,current.observedAt,keys),permit=Object.freeze({});
  permits.set(permit,{client,keys,environment,releaseSha,sourceSha,provider:current.provider,database:current.database,issuedAt:Date.now(),logs,initialAt:initial.observedAt});return permit;
 }
 return Object.freeze({observe,authorize,close:()=>client.close()});
}
export async function requireProductionControl(permit){
 const state=permits.get(permit);if(!state||Date.now()<state.issuedAt||Date.now()-state.issuedAt>3600_000)fail('STAGE8_PRODUCTION_AUTHORITY_REQUIRED');
 assertCleanStage8Release(state.releaseSha,repository);const schema=await currentVersion(state.client),provider=await pausedProviders(state.environment,state.sourceSha,state.keys,schema);
 if(serial(provider)!==serial(state.provider))fail('STAGE8_QUIET_WINDOW_CHANGED');
 await assertDrainedLogs(state.environment,state.initialAt,provider.observedAtServer,state.keys);
 const current=await readDatabaseControl(state.client,state.keys);
 if(current.schema!==schema)fail('STAGE8_DATABASE_CHANGED_DURING_OBSERVATION');
 return {...state,current};
}
