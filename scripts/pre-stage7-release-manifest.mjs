#!/usr/bin/env node
// Local artifact preparation only. No dotenv, credentials, network or deployment.
import {execFileSync} from 'node:child_process';
import {mkdir,writeFile,readdir,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
const args=process.argv.slice(2),options={};
for(let i=0;i<args.length;i+=2){if(!['--core-sha','--settings-sha','--out','--budget-evidence'].includes(args[i])||!args[i+1]||options[args[i]])throw Error('MANIFEST_ARGUMENT_INVALID');options[args[i]]=args[i+1];}
const core=options['--core-sha'],settings=options['--settings-sha'],output=options['--out'];
if(!/^[a-f0-9]{40}$/.test(core??'')||(settings&&!/^[a-f0-9]{40}$/.test(settings))||!/^tmp\/[\w/-]+$/.test(output??''))throw Error('EXACT_LOCAL_IDENTITIES_REQUIRED');
const git=(...a)=>execFileSync('git',a,{encoding:'utf8'}).trim();
const tree=sha=>{if(git('rev-parse',sha+'^{commit}')!==sha)throw Error('COMMIT_IDENTITY_MISMATCH');return git('rev-parse',sha+'^{tree}');};
let executionBudget='EXECUTION_BUDGET_UNRESOLVED',budgetEvidence=null;
const coreTree=tree(core),settingsTree=settings?tree(settings):null;
if(git('ls-tree','--name-only',core,'src/bot/settings.js'))throw Error('CORE_MUST_EXCLUDE_SETTINGS');
if(settings){execFileSync('git',['merge-base','--is-ancestor',core,settings]);if(!git('ls-tree','--name-only',settings,'src/bot/settings.js'))throw Error('SETTINGS_SCOPE_MISSING');}
if(git('status','--porcelain','--untracked-files=no'))throw Error('CLEAN_TRACKED_WORKTREE_REQUIRED');
await mkdir(output,{recursive:true});if((await readdir(output)).length)throw Error('FRESH_ARTIFACT_DIRECTORY_REQUIRED');
if(options['--budget-evidence']){
 const source=options['--budget-evidence'];if(!/^tmp\/[\w/-]+\/timings\.json$/.test(source))throw Error('LOCAL_TIMING_EVIDENCE_REQUIRED');
 const bytes=await readFile(source),rows=JSON.parse(bytes),inventory=JSON.parse(await readFile(path.join(path.dirname(source),'inventory.json'),'utf8'));
 if(inventory.head!==core||inventory.diffSha256!==createHash('sha256').update('').digest('hex')||inventory.node!=='v22.23.2')throw Error('FROZEN_TIMING_IDENTITY_REQUIRED');
 for(const name of ['F_SLOW_HTTP','I_HTTP_JITTER']){
  const row=rows.find(x=>x.name===name);
  if(!row||row.providerClient!=='REAL_CREATE_WHOOP_CLIENT_SYNTHETIC_FETCH'||row.users!==3||row.workerDriver!==true||row.workerResult?.ok!==true||row.resumed?.status!==200
    ||row.progress?.settlementState!=='FINALIZED_SUCCESS'||row.lateProviderRequests!==0||row.additionalFinalizedReplaySends!==0||row.replayMatched!==true
    ||row.finalClaims?.length!==3||!row.finalClaims.every(x=>x.delivery_state==='DELIVERED'&&x.delivery_attempts===1)
    ||row.workerInvocations?.some(x=>x.elapsedMs>562000)||row.workerElapsedMs>=900000)throw Error('CONVERGENT_BOUNDED_TIMING_REQUIRED');
 }
 executionBudget='SAFE_BOUNDED_ASYNC_RECONCILIATION_CANDIDATE';budgetEvidence={path:source,sha256:createHash('sha256').update(bytes).digest('hex'),testedCommit:inventory.head};
}
const show=p=>execFileSync('git',['show',core+':'+p],{encoding:'utf8'});
const hash=s=>createHash('sha256').update(s).digest('hex');
const files={
 'github-reviewed-workflow.yml':show('docs/phase4-main-workflow.yml').replaceAll('REVIEWED_RELEASE_SHA',core),
 'cloudflare-worker.js':show('cloudflare/briefing-scheduler/worker.js'),
 'cloudflare-wrangler.toml':show('cloudflare/briefing-scheduler/wrangler.toml').replaceAll('REVIEWED_RELEASE_SHA',core).replace('BRIEFING_CONTINUATION_DISCOVERY = "off"',executionBudget==='SAFE_BOUNDED_ASYNC_RECONCILIATION_CANDIDATE'?'BRIEFING_CONTINUATION_DISCOVERY = "on"':'BRIEFING_CONTINUATION_DISCOVERY = "off"').replace('crons = [] # Enable morning cron only after coordinated RC3 validation.','crons = ["*/10 0-3 * * *"] # Proposed retained live window; deployment requires approval.'),
 'render-off.env.example':`PHASE4_RELEASE_SHA=${core}\nPHASE4_EXECUTION_PROFILE=PHASE4\nPHASE4_BETA_SHADOW_RUNTIME=off\nPHASE4_PUBLIC_BETA_MODE=off\nPHASE4_PUBLIC_BETA_USER_IDS=\n`,
 'rollback-off.env.example':`PHASE4_RELEASE_SHA=${core}\nPHASE4_EXECUTION_PROFILE=RC2_V32_ROLLBACK\nPHASE4_BETA_SHADOW_RUNTIME=off\nPHASE4_PUBLIC_BETA_MODE=off\nPHASE4_PUBLIC_BETA_USER_IDS=\n`,
};
if(!files['github-reviewed-workflow.yml'].includes('environment: whoop-production-'+core)||!files['cloudflare-wrangler.toml'].includes('REVIEWED_CONFIG_PROOF'))throw Error('ARTIFACT_AUTHORITY_INVALID');
for(const [name,content] of Object.entries(files))await writeFile(path.join(output,name),content);
const manifest={version:2,preparedAt:new Date().toISOString(),node:process.version,core:{commit:core,tree:coreTree},settings:settings?{commit:settings,tree:settingsTree}:null,
 schema:32,migration:'NONE_REQUIRED',transport:'REMOTE_HTTP_HRANA',productionMutation:'NONE',publication:'NOT_AUTHORIZED',
 executionBudget,budgetEvidence,continuation:{protocol:'p4c1_',contextMaxAgeMs:900000,workerWindowMs:561000,productionActivation:'REQUIRES_ARCHITECTURE_REVIEW_AND_AUTHORIZATION'},staleRuns:'STALE_GITHUB_RUNS_PROVIDER_ACTION_REQUIRED',
 gates:Object.fromEntries(['G1_CORE_REVIEW','G2_STALE_RUN_CONTAINMENT','G3_CONTROLLED_DEPLOYMENT','G4_MORNING_BRIEF','G5_PRODUCTION_SHADOW','G6_THREE_LANGUAGE_SMOKE','G7_PUBLIC_BETA_STABILIZATION'].map(g=>[g,'PENDING_EXTERNAL_VERIFICATION'])),
 files:Object.fromEntries(Object.entries(files).map(([name,s])=>[name,{sha256:hash(s),bytes:Buffer.byteLength(s)}])),
 prerequisites:['Formal independent review','Independent architecture approval of bounded continuation and its frozen timing/currentness evidence; verified legacy residual reconciliation','Verified obsolete-run external finality/denial','Private Render/service and deployed identity readback','Original keys and credential continuity','Operator-derived exact config proof; placeholder is intentionally non-runnable','Authorized remaining English user language choice','Separate authorization for every provider mutation or real send']};
await writeFile(path.join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({output,core:manifest.core,settings:manifest.settings,files:Object.keys(files),productionMutation:'NONE'}));
