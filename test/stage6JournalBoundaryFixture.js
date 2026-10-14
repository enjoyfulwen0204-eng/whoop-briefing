// Isolated v32 residual-work boundary. Repository imports; no .env/provider.
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const base=new URL('../',import.meta.url);
export const mod=p=>import(new URL(p,base));
export const {fixtureKeys}=await mod('test/localDb.js');
const {createOwnedDb}=await mod('test/stage5OwnedDb.js');
const {createDb}=await mod('src/db.js');
const {hranaTransport}=await mod('test/hranaTransport.js');
const {bodyInput,seedBodyInput}=await mod('test/bodyEnergyFixture.js');
const {bodyHealthDate}=await mod('src/bodyEnergyInputs.js');
const {createPhase4Foundation}=await mod('src/phase4Foundation.js');
const {log}=await mod('src/logger.js');
for(const k of ['info','warn','error'])log[k]=()=>{};
export async function residualFixture(t,{http=false}={}){
 const dir=await mkdtemp(join(tmpdir(),'whoop-stage6-residual-')),url='file:'+join(dir,'fixture.sqlite');
 const seed=createOwnedDb({url});await seed.migrate({targetVersion:32});await seed.raw.execute('PRAGMA journal_mode=WAL');
 const transport=hranaTransport(url);let db=seed,latency=0,trace=false,origin=0;const timeline=[];
 const fetch=async r=>{
  let kinds=[];if(trace){const body=await r.clone().json();for(const entry of body.requests??[]){
   const sql=entry.stmt?.sql??'';
   const kind=/UPDATE phase4_jobs SET full_scan_cursor=/.test(sql)?'CURSOR_WRITE':/SELECT source_type,source_id,json_array/.test(sql)?'ENUMERATE':/^COMMIT/.test(sql)?'COMMIT':/^BEGIN/.test(sql)?'BEGIN':/whoop_cycles/.test(sql)?'CYCLE_READ':/whoop_resource_access/.test(sql)?'SOURCE_AUTH':null;
   if(kind)kinds.push(kind);
  }if(kinds.length)timeline.push({event:'request_start',kinds,atMs:performance.now()-origin});}
  if(latency)await new Promise(resolve=>setTimeout(resolve,latency));
  try{return await transport.fetch(r);}finally{if(kinds.length)timeline.push({event:'request_end',kinds,atMs:performance.now()-origin});}
 };
 if(http){await seed.close();db=createDb({url:'https://isolated.invalid',phase4Keys:fixtureKeys,fetch});}
 t.after(async()=>{await db.close();transport?.close();await rm(dir,{recursive:true,force:true});});
 const asOf=Date.now()-3600000,iso=x=>new Date(x).toISOString(),input=bodyInput({asOf,days:30});
 for(const s of input.sources.sleep){s.health_date=bodyHealthDate(Date.parse(s.end_at),input.timezone);input.sources.recovery.find(r=>r.sleep_id===s.id).health_date=s.health_date;}
 for(const r of input.sources.recovery.slice(1,4))r.user_calibrating=1;
 for(let i=0;i<5;i++)input.sources.sleep.push({...input.sources.sleep[10],id:'synthetic-nap-'+i,nap:1});
 input.sources.recovery.push({...input.sources.recovery.at(-1),sleep_id:'synthetic-old-recovery',health_date:bodyHealthDate(asOf-31*86400000,input.timezone),updated_at:iso(asOf-31*86400000)});
 for(let i=1;i<=35;i++)input.sources.cycle.push({...input.sources.cycle[0],id:'synthetic-cycle-'+String(i).padStart(2,'0'),start_at:iso(asOf-i*86400000),end_at:iso(asOf-(i-1)*86400000-1000),updated_at:iso(asOf-(i-1)*86400000-1000),strain:5+i/20});
 for(let i=1;i<=32;i++)input.sources.workout.push({user_id:'a',id:'synthetic-workout-'+String(i).padStart(2,'0'),health_date:bodyHealthDate(asOf-i*86400000,input.timezone),start_at:iso(asOf-i*86400000+3600000),end_at:iso(asOf-i*86400000+7200000),score_state:'SCORED',strain:5,synced_at:iso(asOf),updated_at:iso(asOf-i*86400000+7200000)});
 assert.equal(Object.values(input.sources).reduce((n,a)=>n+a.length,0),136);
 await db.createUser({id:'a',displayName:'Synthetic',timezone:'Asia/Taipei',status:'ACTIVE'});await db.setLocale('a','en');await db.ensureOnboarding('a',{state:'READY'});
 const admission=await db.admitRuntime(),stores=await createPhase4Foundation({db,keys:fixtureKeys,admission});await stores.initializeTenant('a','SHADOW');
 await db.transaction(()=>seedBodyInput(db,input));
 for(let i=0;i<7;i++){
  const eventAt=iso(asOf-i*60000),sourceText='caffeine at '+eventAt;
  const v=await stores.journal.create(await stores.captureControl('a'),{sourceEventKey:'synthetic-residual-'+i,sourceText,candidate:{category:'caffeine',eventAt,valueKind:'PRESENCE',exposureState:'EXPOSED',extractionConfidence:1,excerptStart:0,excerptEnd:sourceText.length}});
  assert.equal(v.status,'ACCEPT');
 }
 await stores.queue.sourceChanged(await stores.captureControl('a'));
 const jobs=async()=>[...(await db.raw.execute("SELECT job_kind,state,requested_generation,scope_revision,completed_generation,claimed_generation,full_scan_cursor,attempt,last_error_code,lease_owner FROM phase4_jobs WHERE user_id='a' ORDER BY job_kind")).rows];
 const counts=async()=>({body:Number((await db.raw.execute('SELECT count(*) n FROM body_energy_results')).rows[0].n),domain:Number((await db.raw.execute("SELECT count(*) n FROM phase4_operation_receipts WHERE operation_kind='analyzeMetric'")).rows[0].n),runs:Number((await db.raw.execute('SELECT count(*) n FROM evidence_runs')).rows[0].n),items:Number((await db.raw.execute('SELECT count(*) n FROM evidence_items')).rows[0].n)});
 const toHttp=async()=>{await db.close();http=true;db=createDb({url:'https://isolated.invalid',phase4Keys:fixtureKeys,fetch});return db;};
 const fresh=async()=>{await db.close();db=http?createDb({url:'https://isolated.invalid',phase4Keys:fixtureKeys,fetch}):createOwnedDb({url});return db;};
 return {get db(){return db;},asOf,transport,syntheticFetch:fetch,isolatedFileUrl:url,jobs,counts,fresh,toHttp,setLatency:v=>{latency=v;},startTrace:()=>{origin=performance.now();trace=true;timeline.length=0;},stopTrace:()=>{trace=false;return timeline.slice();},sourceCounts:{sleep:36,recovery:32,cycle:36,workout:32,journal:7,user:1},synthetic:true};
}
