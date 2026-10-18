#!/usr/bin/env node
import {pathToFileURL} from 'node:url';

export function webhookEntryMode(environment=process.env){
 const mode=environment.KHOS_MAINTENANCE_INGRESS_MODE===undefined?'off':environment.KHOS_MAINTENANCE_INGRESS_MODE;
 const supervisor=environment.KHOS_RUNTIME_SUPERVISOR===undefined?'off':environment.KHOS_RUNTIME_SUPERVISOR;
 if(!['off','on'].includes(supervisor))throw Object.assign(Error('SUPERVISOR_ENTRY_MODE_INVALID'),{code:'SUPERVISOR_ENTRY_MODE_INVALID'});
 if(supervisor==='on'){
  if(mode!=='off')throw Object.assign(Error('SUPERVISOR_ENTRY_MODE_CONFLICT'),{code:'SUPERVISOR_ENTRY_MODE_CONFLICT'});
  return 'supervisor';
 }
 if(mode==='off')return 'business';
 if(mode==='whoop-only')return 'whoop-only';
 throw Object.assign(Error('WHOOP_BRIDGE_ENTRY_MODE_INVALID'),{code:'WHOOP_BRIDGE_ENTRY_MODE_INVALID'});
}
/** Import exactly one startup path. Maintenance never imports or constructs
 * Coach, Journal, Stage5/6/8, notification or WHOOP processing workers. */
/** Only bounded enum codes are emitted. Raw messages/stacks/causes stay private. */
export function webhookEntryFatalCode(error){
 let code;try{code=error?.code;}catch{return 'WEBHOOK_ENTRY_START_FAILED';}
 const nativeCodes=['SQLITE_BUSY','SQLITE_LOCKED','SQLITE_CONSTRAINT','SQLITE_CONSTRAINT_NOTNULL','SQLITE_CONSTRAINT_CHECK','SQLITE_CONSTRAINT_PRIMARYKEY','SQLITE_CONSTRAINT_UNIQUE','SQLITE_ERROR','SERVER_ERROR','TRANSACTION_TIMEOUT','TRANSACTION_CLOSED'];
 return typeof code==='string'&&(/^(?:WHOOP_BRIDGE_|PHASE4_PRIVACY_|SUPERVISOR_|PRODUCTION_|SCHEMA_TRANSITION_|STAGE8_|EPOCH_|RELEASE_)[A-Z0-9_]{1,120}$/.test(code)||nativeCodes.includes(code))?code:'WEBHOOK_ENTRY_START_FAILED';
}
export async function main(){
 const mode=webhookEntryMode();
 if(mode==='supervisor')return (await import('../productionSupervisorStartup.js')).main();
 if(mode==='whoop-only')return (await import('../maintenanceWhoopIngressStartup.js')).main();
 return (await import('./webhook.js')).main();
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 main().catch(error=>{
  const code=webhookEntryFatalCode(error);
  console.error(JSON.stringify({event:'webhook_entry_fatal',code}));process.exit(1);
 });
}
