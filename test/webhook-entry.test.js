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
 for(const value of ['on','',true,null])assert.throws(()=>webhookEntryMode({KHOS_MAINTENANCE_INGRESS_MODE:value}),/ENTRY_MODE_INVALID/);
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
