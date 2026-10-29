#!/usr/bin/env node
import {pathToFileURL} from 'node:url';
import {startRecoveryBusiness} from './recoveryPolicy.js';
export async function main({environment=process.env,argv=process.argv.slice(2),listen=true}={}){
 if(argv.length)throw Object.assign(Error('RECOVERY_ENTRY_ARGUMENTS_FORBIDDEN'),{code:'RECOVERY_ENTRY_ARGUMENTS_FORBIDDEN'});
 return startRecoveryBusiness(environment,{listen});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 main().catch(()=>{console.error(JSON.stringify({event:'recovery_entry_refused',code:'RECOVERY_START_FAILED'}));process.exitCode=1;});
}
