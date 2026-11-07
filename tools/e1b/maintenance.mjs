import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createUserErasure} from '../../src/userErasure.js';
import {resolveErasureKvReadOnly} from '../../src/erasureKvOwnership.js';
import {assertErasureTables} from '../../src/erasureCatalog.js';
import {identifier} from './selectSnapshot.mjs';
import {assertJobStartWindow,countSubjectReceipts} from './jobChecks.mjs';

const fail=code=>{throw Object.assign(Error(code),{code});};
const list=s=>String(s??'').split(',').map(x=>x.trim()).filter(Boolean);
const q=(sql,args=[])=>({sql,args});

/** Explicit maintenance operation, never called by application startup.
 * All eligibility and expected-count checks precede the first mutation.
 * Secrets, names, identifiers and hashes stay in memory. */
export async function eraseDisabledCohort({db,keys,environment,expected,now=()=>new Date()}){
 if(expected!==5)fail('MAINTENANCE_EXPECTED_COUNT_REQUIRED');
 const owners=list(environment.OWNER_USER_IDS),family=list(environment.FAMILY_GROUP_USER_IDS);
 if(!owners.length||family.length!==3)fail('MAINTENANCE_COHORT_CONFIGURATION_REQUIRED');
 const users=(await db.raw.execute('SELECT id,display_name,status,lifecycle_generation FROM users LIMIT 101')).rows;
 if(users.length>100)fail('MAINTENANCE_USER_BOUND');
 const targets=users.filter(u=>u.status==='DISABLED'&&!owners.includes(u.id)&&!family.includes(u.id));
 if(targets.length!==expected)fail('MAINTENANCE_EXPECTED_COUNT_MISMATCH');
 const tables=(await db.raw.execute("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")).rows;
 assertErasureTables(tables.map(t=>t.name));
 const kv=await resolveErasureKvReadOnly({client:db.raw,keys,users,familyIds:family});
 const targetKeys=[...kv.owners].filter(([,ids])=>targets.some(t=>ids.has(t.id))).map(([key])=>key),needles=[];
 for(const t of targets){
  needles.push(t.id,t.display_name);
  const tokens=(await db.raw.execute(q('SELECT access_token,refresh_token,whoop_user_id FROM user_whoop_tokens WHERE user_id=?',[t.id]))).rows;
  // This authorized cohort was never connected. A different state is a new
  // scope, not permission to make a provider call or silently clear tokens.
  if(tokens.some(r=>r.access_token||r.refresh_token))fail('MAINTENANCE_DISABLED_TOKEN_PRESENT');
  for(const r of tokens)if(r.whoop_user_id)needles.push(String(r.whoop_user_id));
  for(const r of (await db.raw.execute(q('SELECT telegram_chat_id FROM user_telegram WHERE user_id=?',[t.id]))).rows)needles.push(String(r.telegram_chat_id));
 }
 const engine=createUserErasure({db,keys,environment,now}),deleted={USER:0,SHARED_OPERATIONAL:0,SYSTEM:0};
 for(const t of targets){
  await engine.fence(t.id,{maintenance:true,expectedLife:t.lifecycle_generation});
  const result=await engine.eraseDisabled(t.id,{maintenance:true});
  if(result.status!=='ERASED'||result.pending)fail('MAINTENANCE_ERASURE_PENDING');
  for(const kind of Object.keys(deleted))deleted[kind]+=result.deletedByClass[kind];
 }
 let remaining=0;
 for(const table of tables){
  const cols=(await db.raw.execute('PRAGMA table_info('+identifier(table.name)+')')).rows.filter(c=>/TEXT/i.test(c.type));
  const args=[],conditions=cols.flatMap(c=>[...new Set(needles.filter(Boolean))].map(value=>{args.push(value);return `instr(${identifier(c.name)},?)>0`;}));
  if(conditions.length)remaining+=Number((await db.raw.execute(q(`SELECT COUNT(*) n FROM ${identifier(table.name)} WHERE ${conditions.join(' OR ')}`,args))).rows[0].n);
 }
 for(const key of targetKeys)remaining+=Number((await db.raw.execute(q('SELECT COUNT(*) n FROM telegram_state WHERE key=?',[key]))).rows[0].n);
 remaining+=await countSubjectReceipts(db.raw,keys,targets);
 if(remaining)fail('MAINTENANCE_SCAN_FAILED');
 return {pass:true,subjects:expected,deleted,remaining};
}

async function main(){
 for(const method of ['log','info','warn','error','debug','trace'])console[method]=()=>{};
 const started=Date.now();let db;
 try{
  if(process.env.E1B_ONE_OFF_JOB!=='1'||process.env.RENDER_SERVICE_ID!=='srv-dahs71qd0e5s738n94c0'||process.argv.slice(2).join(' ')!=='--expected 5')fail('MAINTENANCE_JOB_REQUIRED');
  assertJobStartWindow();
  const expected=process.env.E1B_CANDIDATE_SHA;
  const head=execFileSync('git',['rev-parse','--verify','HEAD^{commit}'],{encoding:'utf8',env:{PATH:process.env.PATH},stdio:['ignore','pipe','ignore']}).trim();
  if(!/^[a-f0-9]{40}$/.test(expected??'')||head!==expected||process.env.RENDER_GIT_COMMIT!==expected||process.env.PHASE4_RELEASE_SHA!==expected)fail('MAINTENANCE_BUILD_MISMATCH');
  const {assertRecoveryConfiguration}=await import('../../src/recoveryPolicy.js');assertRecoveryConfiguration(process.env);
  const {phase4AuthorityKeys}=await import('../../src/phase4EnvironmentKeys.js');
  const {createSchemaTransitionRuntimeProfile}=await import('../../src/schemaTransitionProfile.js');
  const {createClient}=await import('@libsql/client');const {composeDb}=await import('../../src/db.js');
  const keys=phase4AuthorityKeys(process.env),runtimeProfile=createSchemaTransitionRuntimeProfile({environment:process.env,keys});
  const url=new URL(process.env.TURSO_DATABASE_URL.replace(/^libsql:/,'https:')),fetchImpl=globalThis.fetch;
  const fetch=async(input,init)=>{const request=new Request(input,init);if(new URL(request.url).origin!==url.origin)fail('MAINTENANCE_NETWORK_DENIED');return fetchImpl(request,{redirect:'error',signal:AbortSignal.timeout(30000)});};
  db=composeDb(createClient({url:url.href,authToken:process.env.TURSO_AUTH_TOKEN,fetch}),{phase4Keys:keys,runtimeProfile});
  await db.admitRuntime({source:'cloudflare',fresh:true});
  const result=await eraseDisabledCohort({db,keys,environment:process.env,expected:5});
  await db.admitRuntime({source:'cloudflare',fresh:true});
  process.stdout.write(JSON.stringify({...result,duration_ms:Date.now()-started})+'\n');
 }catch{process.stdout.write(JSON.stringify({pass:false,duration_ms:Date.now()-started})+'\n');process.exitCode=1;}
 finally{db?.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
