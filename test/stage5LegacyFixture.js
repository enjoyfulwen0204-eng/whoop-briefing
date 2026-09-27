import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, symlinkSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository=fileURLToPath(new URL('..',import.meta.url));
const versions={pre25:'5e42695',rc6:'8e377dc',rc7:'4e17fc13953ac7e21dbe1527851febd7648f7b08',v25:'769d323ffa20f0f744960a0c47c3da1cac827e3b'};

/** Generate cutover bytes with the real historical executable in an isolated
 * process. No current serializer, migration, or fixture re-signs old authority. */
export function legacyFixture(t,{version='rc6',shape='metric',rawAlias=false,sourceSpelling=null,standaloneExplanation=false}={}) {
  const sha=versions[version];if(!sha)throw Error('UNKNOWN_FIXTURE_VERSION');
  const dir=mkdtempSync(path.join(os.tmpdir(),'stage5-legacy-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const archive=execFileSync('git',['archive',sha,'src','test','package.json'],{cwd:repository,maxBuffer:40*1024*1024});
  execFileSync('tar',['-xf','-','-C',dir],{input:archive});
  symlinkSync(path.join(repository,'node_modules'),path.join(dir,'node_modules'),'dir');
  writeFileSync(path.join(dir,'test/stage5AssociationFixture.js'),
    readFileSync(new URL('./stage5AssociationFixture.js',import.meta.url)));
  if(version==='pre25')writeFileSync(path.join(dir,'test/stage5HistoryFixture.js'),
    readFileSync(new URL('./stage5HistoryFixture.js',import.meta.url)));
  const runner=`
import {writeFileSync} from 'node:fs';
import {setup,request,recoveryRefs} from './test/stage5HistoryFixture.js';
import {setup as association,hypothesis,family} from './test/stage5AssociationFixture.js';
const cleanups=[],t={after:fn=>cleanups.push(fn)},shape=${JSON.stringify(shape)},rawAlias=${JSON.stringify(rawAlias)},sourceSpelling=${JSON.stringify(sourceSpelling)};
const f=shape.startsWith('association')?await association(t,{days:30,createFacts:shape!=='association-null'}):await setup(t);
let requestShape,standaloneFact;
if(${JSON.stringify(standaloneExplanation)}) {
 const control=await f.stores.captureControl('a'),sourceText='caffeine at 2026-09-25T10:00:00.000Z';
 standaloneFact=await f.stores.journal.create(control,{sourceEventKey:'review-b-standalone',sourceText,candidate:{category:'caffeine',
  eventAt:'2026-09-25T10:00:00.000Z',valueKind:'PRESENCE',exposureState:'EXPOSED',extractionConfidence:1,excerptStart:0,excerptEnd:sourceText.length}});
}

if(shape.startsWith('association')) {
 const h=hypothesis(f,Array.from({length:30},(_,i)=>i));requestShape=family('legacy-family',h);
 async function bind(value,c) {
  if(!value||typeof value!=='object')return value;
  if(value.type&&value.id&&value.executionMode)return (await f.stores.root(c,value.type,value.id)).ref;
  if(Array.isArray(value)){const list=[];for(const item of value)list.push(await bind(item,c));return list;}
  const result={};for(const [key,item] of Object.entries(value))result[key]=await bind(item,c);return result;
 }
 for(const spelling of rawAlias?['2026-09-25T12:00:00Z','2026-09-25T20:00:00+08:00']:[null]) {
  if(spelling)for(const table of ['journal_events','journal_coverage_windows'])
   await f.db.raw.execute({sql:'UPDATE '+table+" SET created_at=?,updated_at=? WHERE user_id='a'",args:[spelling,spelling]});
  const c=await f.stores.capture('a',{executionMode:'SHADOW'});requestShape=await bind(requestShape,c);
  await f.stores.intelligence.analyzeAssociationFamily(c,requestShape);
 }
} else {
 for(const spelling of rawAlias?['2026-09-25T10:00:00Z','2026-09-25T18:00:00+08:00']:[sourceSpelling]) {
  if(spelling)await f.db.raw.execute({sql:"UPDATE whoop_recoveries SET updated_at=? WHERE user_id='a' AND sleep_id=?",args:[spelling,f.recoveryIds[0]]});
  const c=await f.stores.capture('a',{executionMode:'SHADOW'}),refs=await recoveryRefs(f.stores,c,f.recoveryIds);
  requestShape=request(refs[0],shape==='metric-null'?[]:refs.slice(1));
  await f.stores.intelligence.analyzeMetric(c,requestShape);
 }
}
if(${JSON.stringify(standaloneExplanation)}) {
 const context=await f.stores.capture('a',{executionMode:'SHADOW'});
 const journal=(await f.db.raw.execute({sql:'SELECT privacy_artifact_id FROM journal_events WHERE logical_fact_id=?',args:[standaloneFact.logicalFactId]})).rows[0];
 const episode=(await f.db.raw.execute('SELECT * FROM observation_episodes LIMIT 1')).rows[0];
 const j=await f.stores.root(context,'JOURNAL_FACT',journal.privacy_artifact_id);
 await f.stores.episodes.revise(context,{episodeId:episode.episode_id,expectedRevision:episode.revision,toState:'EXPLAINED',
  patch:{explained_status:1,explanation_evidence_item_id:episode.latest_evidence_item_id,
   explanation_json:{journal:'REVIEW_B_LEGACY_STANDALONE_SECRET'}},sourceRefs:[j.ref],reasonCode:'CURRENT_EXPLANATION',
  semanticAt:'2026-09-25T12:00:00.000Z'});
}
const tables={};
for(const {name} of (await f.db.raw.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'resource_locks'")).rows) {
 const rows=(await f.db.raw.execute('SELECT * FROM '+name)).rows;
 if(rows.length)tables[name]=rows.map(row=>({...row}));
}
writeFileSync('fixture.json',JSON.stringify({version:${JSON.stringify(sha)},tables,request:requestShape}));
for(const cleanup of cleanups.reverse())await cleanup();
await new Promise(resolve=>setImmediate(resolve));global.gc?.();
`;
  writeFileSync(path.join(dir,'generate.mjs'),runner);
  execFileSync(process.execPath,['--expose-gc','generate.mjs'],{cwd:dir,timeout:120000,maxBuffer:1024*1024});
  return JSON.parse(readFileSync(path.join(dir,'fixture.json'),'utf8'));
}

export async function loadLegacyFixture(db,fixture) {
  const triggers=(await db.raw.execute("SELECT name,sql FROM sqlite_master WHERE type='trigger'")).rows;
  for(const trigger of triggers)await db.raw.execute(`DROP TRIGGER ${trigger.name}`);
  await db.raw.execute('PRAGMA foreign_keys=OFF');
  try {
    for(const [table,rows] of Object.entries(fixture.tables)) {
      if(['schema_version','phase4_migration_checkpoints'].includes(table))continue;
      for(const row of rows) {
        const fields=Object.keys(row);
        await db.raw.execute({sql:`INSERT INTO ${table}(${fields.join(',')}) VALUES (${fields.map(()=>'?').join(',')})`,args:fields.map(field=>row[field])});
      }
    }
  }finally {
    await db.raw.execute('PRAGMA foreign_keys=ON');
    for(const trigger of triggers)await db.raw.execute(trigger.sql);
  }
}
