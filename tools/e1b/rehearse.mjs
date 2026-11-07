import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {exportSelectSnapshot} from './selectSnapshot.mjs';
import {localAdapter} from './localAdapter.mjs';
import {denyRehearsalNetwork} from './networkFence.mjs';
import {phase4AuthorityKeys} from '../../src/phase4EnvironmentKeys.js';
import {createSchemaTransitionRuntimeProfile} from '../../src/schemaTransitionProfile.js';
import {bindConnectionLifetime,admitRuntime} from '../../src/runtimeAdmission.js';
import {rehearseLocal} from './rehearsalChecks.mjs';
import {RECOVERY_PRODUCTION_HOST} from '../../src/recoveryPolicy.js';
import {assertJobStartWindow} from './jobChecks.mjs';

const fail=code=>{throw Object.assign(Error(code),{code});};
// Do not forward application diagnostics: this process may inspect private
// rows in its isolated copy. Only the explicit count/status sink is allowed.
for(const method of ['log','info','warn','error','debug','trace'])console[method]=()=>{};
const emit=value=>process.stdout.write(JSON.stringify(value)+'\n');
const started=Date.now();let directory,db;
try{
 if(process.env.E1B_ONE_OFF_JOB!=='1'||process.env.RENDER_SERVICE_ID!=='srv-dahs71qd0e5s738n94c0')fail('REHEARSAL_JOB_REQUIRED');
 const expected=process.env.E1B_CANDIDATE_SHA,base=process.env.E1B_EXPECTED_BASE_SHA;
 if(!/^[a-f0-9]{40}$/.test(expected??'')||!/^[a-f0-9]{40}$/.test(base??''))fail('REHEARSAL_SHA_REQUIRED');
 const gitEnv={PATH:process.env.PATH};
 const head=execFileSync('git',['rev-parse','--verify','HEAD^{commit}'],{cwd:new URL('../..',import.meta.url),env:gitEnv,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
 if(head!==expected||process.env.RENDER_GIT_COMMIT!==base||process.env.PHASE4_RELEASE_SHA!==base)fail('REHEARSAL_BUILD_MISMATCH');
 const sourceUrl=new URL(process.env.TURSO_DATABASE_URL);
 if(!['libsql:','https:'].includes(sourceUrl.protocol)||sourceUrl.hostname!==RECOVERY_PRODUCTION_HOST||sourceUrl.username||sourceUrl.password||sourceUrl.port||!['','/'].includes(sourceUrl.pathname)||sourceUrl.search||sourceUrl.hash)fail('REHEARSAL_DATABASE_IDENTITY_MISMATCH');
 const minute=new Date().getUTCMinutes(); // Taipei is a whole-hour offset.
 assertJobStartWindow();
 if(minute<14||minute>=55)fail('REHEARSAL_AFTER_CRON_REQUIRED');
 const keys=phase4AuthorityKeys(process.env),environment={...process.env,RENDER_GIT_COMMIT:head,PHASE4_RELEASE_SHA:head};
 const profile=createSchemaTransitionRuntimeProfile({environment,keys});
 directory=await mkdtemp(join(tmpdir(),'e1b-one-off-'));const path=join(directory,'snapshot.sqlite');
 const copied=await exportSelectSnapshot({url:process.env.TURSO_DATABASE_URL,token:process.env.TURSO_AUTH_TOKEN,path});
 emit({phase:'EXPORT',pass:true,...copied,duration_ms:Date.now()-started});
 // The remote stream/client is closed by exportSelectSnapshot's finally.
 // Neither the local adapter nor the erasure engine accepts credentials.
 for(const target of [process.env,environment])for(const name of Object.keys(target))if(/TURSO|TOKEN|SECRET|(?:^|_)KEY(?:$|_)/.test(name))delete target[name];
 denyRehearsalNetwork();
 db=localAdapter(path);bindConnectionLifetime(db.raw,db.raw,db.transaction,{runtimeProfile:profile,keys});
 const admit=()=>admitRuntime(db.raw,keys);await admit();
 await rehearseLocal({db,keys,environment,at:new Date(),admit,emit});
 emit({phase:'COMPLETE',pass:true,duration_ms:Date.now()-started});
}catch{
 // Never print an Error object, stack, SQL, identifier or provider payload.
 emit({phase:'COMPLETE',pass:false,duration_ms:Date.now()-started});process.exitCode=1;
}finally{
 db?.raw.close();if(directory)await rm(directory,{recursive:true,force:true});
}
