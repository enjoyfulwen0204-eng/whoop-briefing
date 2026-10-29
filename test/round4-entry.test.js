import test from 'node:test';
import assert from 'node:assert/strict';
import {assertRecoveryConfiguration,RECOVERY_PRODUCTION_HOST} from '../src/recoveryPolicy.js';
import {runningReleaseSha} from '../src/phase4Release.js';
import {loadDotEnvIfPresent} from '../src/config.js';
import {createDb} from '../src/db.js';
import {runMigrations} from '../src/migrations.js';
import {main as recovery} from '../src/recoveryEntry.js';
import {main as legacy} from '../src/bot/webhook-entry.js';
import {main as supervisor} from '../src/productionSupervisorStartup.js';
import {main as maintenance} from '../src/maintenanceWhoopIngressStartup.js';
import {main as polling} from '../src/bot/index.js';
import {main as business} from '../src/bot/webhook.js';
import {runBriefing} from '../src/index.js';
const environment=()=>({PHASE4_RELEASE_SHA:runningReleaseSha({}),RENDER_GIT_COMMIT:runningReleaseSha({}),
 PHASE4_EXECUTION_PROFILE:'STAGE8_SCHEMA_TRANSITION',PHASE4_LOOKUP_KEY:'47'.repeat(32),PHASE4_AUDIT_KEY:'53'.repeat(32),
 TURSO_DATABASE_URL:'libsql://'+RECOVERY_PRODUCTION_HOST,TURSO_AUTH_TOKEN:'SYNTHETIC-NOT-LIVE',BRIEFING_CONTINUATION_SCOPE:'sync'});

test('only fixed v33 business policy accepts complete pins/identity/OFF policy',()=>{
 const env=environment();assert.equal(assertRecoveryConfiguration(env),true);
 for(const patch of [{PHASE4_RELEASE_SHA:undefined},{RENDER_GIT_COMMIT:'a'.repeat(40)},
  {PHASE4_EXECUTION_PROFILE:'PHASE4'},{PHASE4_LOOKUP_KEY:undefined},{STAGE8_LIVE_ANALYSIS:'on'},
  {TURSO_DATABASE_URL:'libsql://synthetic-other.invalid'},{BRIEFING_CONTINUATION_SCOPE:'all'},
  {KHOS_RUNTIME_SUPERVISOR:'on'},{KHOS_MAINTENANCE_INGRESS_MODE:'whoop-only'},{PHASE4_EXECUTION_PHASE:'STAGE6_DRAIN'}])
  assert.throws(()=>assertRecoveryConfiguration({...env,...patch}));
});
test('wrong startup roles reject before environment loading, SQL, listener or transport',async t=>{
 let envLoads=0,network=0;t.mock.method(process,'loadEnvFile',()=>{envLoads++;throw Error('ENV_FORBIDDEN');});
 t.mock.method(globalThis,'fetch',async()=>{network++;throw Error('NETWORK_FORBIDDEN');});
 for(const fn of [legacy,supervisor,maintenance,polling,business,runBriefing])await assert.rejects(fn(),/RECOVERY_EXPLICIT_ENTRY_REQUIRED/);
 await assert.rejects(recovery({environment:{},argv:[]}),/RECOVERY_RELEASE_PINS_REQUIRED/);
 await assert.rejects(recovery({environment:environment(),argv:['--maintenance']}),/ARGUMENTS_FORBIDDEN/);
 assert.throws(loadDotEnvIfPresent,/RECOVERY_EXPLICIT_ENTRY_REQUIRED/);
 assert.throws(()=>createDb({url:'libsql://synthetic.invalid',authToken:'SYNTHETIC'}),/RECOVERY_EXPLICIT_ENTRY_REQUIRED/);
 assert.equal(envLoads,0);assert.equal(network,0);
});
test('remote migration refuses before any SQL, independently of flags or current schema',async()=>{
 let sql=0;const remote={protocol:'http',execute(){sql++;throw Error('SQL_FORBIDDEN');}};
 await assert.rejects(runMigrations(remote,{targetVersion:33}),/RECOVERY_OPERATOR_MIGRATION_ONLY/);
 assert.equal(sql,0);
});
