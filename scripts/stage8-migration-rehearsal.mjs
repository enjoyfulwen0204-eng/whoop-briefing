#!/usr/bin/env node
/** Offline protected recovery preparation. Production application remains
 * unavailable until provider writer quiescence and export are qualified. */
import {fileURLToPath} from 'node:url';
import {phase4AuthorityKeys} from '../src/publicBetaConfig.js';
import {assertCleanStage8Release,sealStage8RecoveryImage,rehearseStage8RecoveryImage,STAGE8_PRODUCTION_HOST} from './stage8-migration-safety.mjs';
const fail=code=>{throw Object.assign(Error(code),{code});};
export async function main(argv=process.argv.slice(2),environment=process.env){
 if(Number(process.versions.node.split('.')[0])!==22)fail('STAGE8_NODE22_REQUIRED');
 if(argv.includes('--apply'))fail('STAGE8_REMOTE_QUIESCENCE_AUTHORITY_UNAVAILABLE');
 const options={};
 for(let i=0;i<argv.length;i++){
  const name=argv[i];
  if(['--seal','--rehearse'].includes(name)){if(options.mode)fail('STAGE8_ARGUMENT_INVALID');options.mode=name.slice(2);}
  else if(['--source-file','--backup-file','--key-file','--expected-commit','--target-version'].includes(name)){
   if(options[name]!==undefined||!argv[i+1]||argv[i+1].startsWith('--'))fail('STAGE8_ARGUMENT_INVALID');options[name]=argv[++i];
  }else fail('STAGE8_ARGUMENT_INVALID');
 }
 if(!options.mode||!options['--backup-file']||!options['--key-file']||!options['--expected-commit'])fail('STAGE8_ARGUMENT_REQUIRED');
 const repository=fileURLToPath(new URL('../',import.meta.url));assertCleanStage8Release(options['--expected-commit'],repository);
 const common={backupPath:options['--backup-file'],keyPath:options['--key-file'],keys:phase4AuthorityKeys(environment),releaseSha:options['--expected-commit'],sourceTarget:STAGE8_PRODUCTION_HOST};
 if(options.mode==='seal'){
  if(!options['--source-file']||options['--target-version'])fail('STAGE8_ARGUMENT_INVALID');
  return {status:'LOCAL_EXPORT_SEALED',...await sealStage8RecoveryImage({...common,sourcePath:options['--source-file']}),remoteApply:'BLOCKED_NO_QUIESCENCE_AUTHORITY'};
 }
 if(options['--source-file']||!['34','35'].includes(options['--target-version']))fail('STAGE8_ARGUMENT_INVALID');
 return rehearseStage8RecoveryImage({...common,targetVersion:Number(options['--target-version'])});
}
if(import.meta.url===`file://${process.argv[1]}`)main().then(result=>console.log(JSON.stringify(result))).catch(error=>{
 const code=/^STAGE8_[A-Z_]+$/.test(error?.code??'')?error.code:'STAGE8_REHEARSAL_FAILED';
 console.error(JSON.stringify({code}));process.exitCode=1;
});
