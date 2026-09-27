import { execFileSync } from 'node:child_process';
import { mkdtempSync,symlinkSync,rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { setup,hypothesis,family } from './stage5AssociationFixture.js';
import { call } from './stage5ClosureFixture.js';
import { T } from './stage5ReviewBFixture.js';

export const identity={subject:'journal:caffeine',outcome:'recovery_score',direction:'LOWER',exposureCategory:'caffeine',
  algorithmFamily:'journal-association',evidenceContractMajor:'1'};
export const retirement='2026-09-25T12:00:02.000Z';
export async function snapshot(f) {
  const rows={};for(const {name} of (await f.db.raw.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")).rows)
    rows[name]=(await f.db.raw.execute(`SELECT * FROM "${name.replaceAll('"','""')}"`)).rows;
  return rows;
}
export async function fixture(t,{retired=true}={}) {
  const f=await setup(t,{days:30}),h=hypothesis(f,Array.from({length:30},(_,i)=>i));
  const initialRequest=family('m007-original',h);let original,old,evidenceId;
  if(retired) {
    original=await call(f,'intelligence','analyzeAssociationFamily',initialRequest);
    old=original.items[0].insight.current;evidenceId=original.items[0].item.row.evidence_item_id;
    f.setNow('2026-09-25T12:00:10.000Z');
    await retire(f,old,evidenceId,retirement);
  } else {
    const result=await call(f,'intelligence','analyzeMetric',{metricKey:'hrv',currentSource:f.outcomeRefs[0],
      baselineSources:[],asOfUtc:T,windowFamily:'M007_ABSENCE_EVIDENCE'});
    evidenceId=result.item.row.evidence_item_id;
  }
  const direct=(at,key,extra={})=>({identity,claim:'Caffeine association candidate',evidenceContractVersion:'phase4-evidence-v1',
    supportingEvidenceIds:[evidenceId],expiresAt:'2026-09-26T12:00:00.000Z',creationKey:key,semanticAt:at,...extra});
  const request=(kind,at,key='m007-successor',extra={})=>kind==='direct'?direct(at,key,extra):family(key,h,at);
  const successor=(kind,at,key='m007-successor',extra={})=>call(f,kind==='direct'?'insights':'intelligence',
    kind==='direct'?'create':'analyzeAssociationFamily',request(kind,at,key,extra));
  return {f,old,evidenceId,original,initialRequest,direct,successor};
}
export const insight=(kind,result)=>kind==='direct'?result:result.items[0].insight.current;
export function retire(f,row,evidenceId,at) {
  return call(f,'insights','transition',{insightId:row.row.id,expectedRevision:row.row.current_revision,status:'RETIRED',
    disposition:'EXPIRED',claim:row.row.statement,supportingEvidenceIds:[evidenceId],reason:'EXPIRED',semanticAt:at});
}

// Genuine pre-M007 repository code can create two unlinked terminal rows.
// The unchanged core/driver is shared with this owned synthetic fixture; old
// serializers and HMAC contracts generate the authorities, never test re-signing.
export async function preM007Stores(t,f) {
  const repo=fileURLToPath(new URL('..',import.meta.url)),dir=mkdtempSync(path.join(os.tmpdir(),'stage5-m007-history-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const archive=execFileSync('git',['archive','11b51d64fc2dfb76311c3270955e6ccda8bbb451','src','package.json'],{cwd:repo,maxBuffer:40*1024*1024});
  execFileSync('tar',['-xf','-','-C',dir],{input:archive});symlinkSync(path.join(repo,'node_modules'),path.join(dir,'node_modules'),'dir');
  const {composePhase4Stores}=await import(pathToFileURL(path.join(dir,'src/phase4Repositories.js')));
  return composePhase4Stores(f.core);
}
