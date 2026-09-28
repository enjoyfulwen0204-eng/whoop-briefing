import { execFileSync } from 'node:child_process';
import { mkdtempSync,symlinkSync,rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';

// Genuine starting-version serializers generate historical authority. Tests
// never manufacture a receipt or recompute its HMAC after mutating content.
export async function preBlindStores(t,f) {
  const repo=fileURLToPath(new URL('..',import.meta.url)),dir=mkdtempSync(path.join(os.tmpdir(),'stage5-blind-history-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const archive=execFileSync('git',['archive','532cc5858cf9ed27762a2150d04bb49458abd7e6','src','package.json'],{cwd:repo,maxBuffer:40*1024*1024});
  execFileSync('tar',['-xf','-','-C',dir],{input:archive});symlinkSync(path.join(repo,'node_modules'),path.join(dir,'node_modules'),'dir');
  const {composePhase4Stores}=await import(pathToFileURL(path.join(dir,'src/phase4Repositories.js')));
  return composePhase4Stores(f.core);
}
