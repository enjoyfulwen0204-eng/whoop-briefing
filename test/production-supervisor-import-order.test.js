import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

const orders={
 'migrations first':['./src/migrations.js','./src/db.js','./src/productionEpochBootstrap.js','./src/productionSupervisorController.js'],
 'database first':['./src/db.js','./src/migrations.js','./src/productionEpochBootstrap.js','./src/productionSupervisorController.js'],
 'controller first':['./src/productionSupervisorController.js','./src/migrations.js','./src/db.js'],
 'managed business first':['./src/bot/webhook.js','./src/productionEpochBootstrap.js','./src/migrations.js'],
 'actual entry import':['./src/bot/webhook-entry.js','./src/productionSupervisorStartup.js','./src/migrations.js','./scripts/stage8-production-control.mjs','./scripts/stage8-atomic-migration.mjs'],
};
for(const [name,modules] of Object.entries(orders))test(`fresh process imports ${name} without startup or provider access`,()=>{
 const source=`import assert from 'node:assert/strict';import http from 'node:http';import https from 'node:https';
  let network=0,listeners=0;globalThis.fetch=()=>{network++;throw Error('NETWORK_FORBIDDEN');};
  for(const client of [http,https])for(const method of ['request','get'])client[method]=()=>{network++;throw Error('NETWORK_FORBIDDEN');};
  http.createServer=()=>{listeners++;throw Error('LISTENER_FORBIDDEN');};
  for(const path of ${JSON.stringify(modules)})await import(path);
  const entry=await import('./src/bot/webhook-entry.js');assert.equal(entry.webhookEntryMode({}),'business');
  assert.equal(network,0);assert.equal(listeners,0);console.log('IMPORT_ORDER_OK');`;
 const result=spawnSync(process.execPath,['--input-type=module','-e',source],{cwd:new URL('../',import.meta.url),env:{PATH:process.env.PATH},encoding:'utf8',timeout:10000});
 assert.equal(result.status,0,result.stderr);assert.equal(result.stdout.trim(),'IMPORT_ORDER_OK');assert.equal(result.stderr,'');
});
