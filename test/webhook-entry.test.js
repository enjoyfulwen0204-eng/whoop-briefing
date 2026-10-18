import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {webhookEntryMode} from '../src/bot/webhook-entry.js';
import {phase4AuthorityKeys} from '../src/phase4EnvironmentKeys.js';
import {phase4AuthorityKeys as existingKeys,publicBetaKeys} from '../src/publicBetaConfig.js';
test('ordinary webhook startup remains the default; unknown modes fail closed',()=>{
 assert.equal(webhookEntryMode({}),'business');assert.equal(webhookEntryMode({KHOS_MAINTENANCE_INGRESS_MODE:'off'}),'business');
 assert.equal(webhookEntryMode({KHOS_MAINTENANCE_INGRESS_MODE:'whoop-only'}),'whoop-only');
 assert.equal(webhookEntryMode({KHOS_RUNTIME_SUPERVISOR:'off'}),'business');
 assert.equal(webhookEntryMode({KHOS_RUNTIME_SUPERVISOR:'on'}),'supervisor');
 assert.throws(()=>webhookEntryMode({KHOS_RUNTIME_SUPERVISOR:'on',KHOS_MAINTENANCE_INGRESS_MODE:'whoop-only'}),/SUPERVISOR_ENTRY_MODE_CONFLICT/);
 for(const value of ['',true,null,'yes'])assert.throws(()=>webhookEntryMode({KHOS_RUNTIME_SUPERVISOR:value}),/SUPERVISOR_ENTRY_MODE_INVALID/);
 for(const value of ['on','',true,null])assert.throws(()=>webhookEntryMode({KHOS_MAINTENANCE_INGRESS_MODE:value}),/ENTRY_MODE_INVALID/);
});
test('explicit supervisor entry selects only its fixed startup; default and maintenance select their original paths',()=>{
 for(const [environment,wanted] of [[{},'business'],[{KHOS_MAINTENANCE_INGRESS_MODE:'whoop-only'},'whoop-only'],[{KHOS_RUNTIME_SUPERVISOR:'on'},'supervisor']]){
  const source=`import {registerHooks} from 'node:module';
   const selected=new Map([['/src/bot/webhook.js','business'],['/src/maintenanceWhoopIngressStartup.js','whoop-only'],['/src/productionSupervisorStartup.js','supervisor']]);
   registerHooks({resolve(specifier,context,next){let u;try{u=new URL(specifier,context.parentURL);}catch{}const mode=[...selected].find(([path])=>u?.pathname.endsWith(path))?.[1];if(mode)return {url:'data:text/javascript,'+encodeURIComponent('export async function main(){return '+JSON.stringify(mode)+'}'),shortCircuit:true};return next(specifier,context);}});
   const {main}=await import('./src/bot/webhook-entry.js');console.log(await main());`;
  const result=spawnSync(process.execPath,['--input-type=module','-e',source],{cwd:new URL('../',import.meta.url),env:{PATH:process.env.PATH,...environment},encoding:'utf8',timeout:3000});
  assert.equal(result.status,0,result.stderr);assert.equal(result.stdout.trim(),wanted);
 }
});
test('shared environment key decoder preserves the existing authority identity',()=>{
 assert.equal(existingKeys,phase4AuthorityKeys);assert.equal(publicBetaKeys,phase4AuthorityKeys);
 const env={PHASE4_LOOKUP_KEY:'11'.repeat(32),PHASE4_AUDIT_KEY:'22'.repeat(32)};
 assert.equal(existingKeys(env).lookupCheckpoint(),phase4AuthorityKeys(env).lookupCheckpoint());
 assert.throws(()=>phase4AuthorityKeys({...env,PHASE4_LOOKUP_KEY:'invalid'}),/PRIVACY_KEYS_REQUIRED/);
});
test('maintenance entry refuses an unsigned/missing binding before any server is started',()=>{
 const result=spawnSync(process.execPath,['src/bot/webhook-entry.js'],{cwd:new URL('../',import.meta.url),env:{PATH:process.env.PATH,KHOS_MAINTENANCE_INGRESS_MODE:'whoop-only'},encoding:'utf8',timeout:3000});
 assert.equal(result.status,1);assert.match(result.stderr,/WHOOP_BRIDGE_STARTUP_CONFIG_REQUIRED/);assert.equal(result.stdout,'');
});
test('maintenance startup dependency graph contains no business runtime or processor',async()=>{
 const files=['../src/bot/webhook-entry.js','../src/maintenanceWhoopIngressStartup.js','../src/phase4EnvironmentKeys.js'];
 for(const file of files){const source=await readFile(new URL(file,import.meta.url),'utf8');assert.doesNotMatch(source,/from ['"][^'"]*(?:publicBetaConfig|db\.js|stage[5678]Runtime|whoopWebhookProcessor|coach\.js)['"]/);}
});
