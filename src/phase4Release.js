import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
const fail=code=>{throw Object.assign(new Error(code),{code});};
export const RELEASE_SHA_RE=/^[a-f0-9]{40}$/;
export function requireReleaseSha(value){if(!RELEASE_SHA_RE.test(value??''))fail('RELEASE_IDENTITY_INVALID');return value;}
/** Determine this loaded application's checkout, independent of cwd/request/env.
 * Provider/build pins are assertions against HEAD, never a replacement for it. */
export function runningReleaseSha(environment=process.env){
 const gitEnv={...process.env};for(const key of Object.keys(gitEnv))if(key.startsWith('GIT_'))delete gitEnv[key];
 let sha;try{sha=execFileSync('git',['rev-parse','--verify','HEAD^{commit}'],{cwd:root,env:gitEnv,encoding:'utf8',timeout:2000,stdio:['ignore','pipe','pipe']}).trim();}
 catch{fail('RELEASE_IDENTITY_UNAVAILABLE');}requireReleaseSha(sha);
 if(environment.GITHUB_ACTIONS==='true'&&!environment.PHASE4_RELEASE_SHA)fail('RELEASE_PIN_REQUIRED');
 for(const pin of [environment.PHASE4_RELEASE_SHA,environment.RENDER_GIT_COMMIT])if(pin!==undefined){requireReleaseSha(pin);if(pin!==sha)fail('RELEASE_CHECKOUT_MISMATCH');}
 return sha;
}
export const isGitHubContext=environment=>['GITHUB_ACTIONS','GITHUB_EVENT_NAME','GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT','GITHUB_WORKFLOW','GITHUB_SHA','GITHUB_JOB'].some(key=>environment[key]!==undefined);
export function cliTriggerSource(environment){
 if(environment.GITHUB_ACTIONS==='true'){
   if(environment.GITHUB_EVENT_NAME==='schedule')return 'github';
   if(environment.GITHUB_EVENT_NAME==='workflow_dispatch')return 'manual';
   fail('GITHUB_SOURCE_UNSUPPORTED');
 }
 if(isGitHubContext(environment))fail('GITHUB_SOURCE_UNSUPPORTED');
 return 'manual';
}
