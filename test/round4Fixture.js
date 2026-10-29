import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createOwnedFileDb} from '../src/db.js';
import {fixtureKeys} from './localDb.js';
import {createSchemaTransitionRuntimeProfile,SCHEMA_TRANSITION_PROFILE} from '../src/schemaTransitionProfile.js';
export {fixtureKeys};
export const profileEnvironment=()=>({PHASE4_EXECUTION_PROFILE:SCHEMA_TRANSITION_PROFILE});
export async function recoveryFixture(t){
 const dir=await mkdtemp(join(tmpdir(),'round4-synthetic-v33-'));
 const environment=profileEnvironment(),profile=createSchemaTransitionRuntimeProfile({environment,keys:fixtureKeys});
 const db=createOwnedFileDb({url:'file:'+join(dir,'synthetic.db'),phase4Keys:fixtureKeys,runtimeProfile:profile});
 t.after(async()=>{await db.close();await rm(dir,{recursive:true,force:true});});
 await db.migrate({targetVersion:33});
 return {db,environment,dir};
}
