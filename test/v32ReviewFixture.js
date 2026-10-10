import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createDb} from '../src/db.js';import {createOwnedDb} from './stage5OwnedDb.js';
import {fixtureKeys} from './localDb.js';import {hranaTransport} from './hranaTransport.js';
import {configurationProof,claimPhaseRequest} from '../src/phase4ExecutionStore.js';
import {runningReleaseSha} from '../src/phase4Release.js';
export {fixtureKeys};
export const environment={PHASE4_BETA_SHADOW_RUNTIME:'on',PHASE4_PUBLIC_BETA_MODE:'off'};
export const authority={assert(){}};
export const request=(extra={})=>({requestId:randomUUID(),releaseSha:runningReleaseSha(),phase:'SYNC',triggerSource:'manual',executionMode:'SHADOW',
 configProof:configurationProof(fixtureKeys,{runtime:'on',mode:'off'},environment),...extra});
export const claim=(db,r,options={})=>claimPhaseRequest(db,r,JSON.stringify(r),{keys:fixtureKeys,...options});
export async function fixture(t,version=32){
 const dir=await mkdtemp(join(tmpdir(),'v32-review-')),url=`file:${join(dir,'db.sqlite')}`,seed=createOwnedDb({url});
 await seed.migrate({targetVersion:version});
 // Concurrent HTTP authority tests use an explicitly WAL-backed isolated
 // server. DELETE-journal native readers can reject COMMIT; that definite
 // rejection is covered separately and never authorizes callback replay.
 const journal=await seed.raw.execute('PRAGMA journal_mode=WAL');
 if(journal.rows[0].journal_mode!=='wal')throw Error('HTTP_FIXTURE_WAL_REQUIRED');
 await seed.close();const transport=hranaTransport(url);
 const db=createDb({url:'https://isolated.invalid',fetch:transport.fetch,phase4Keys:fixtureKeys});
 t.after(async()=>{db.close();transport.close();await rm(dir,{recursive:true,force:true});});return {db,transport,url,dir};
}
