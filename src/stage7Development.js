import {createStage7Composition} from './stage7Composition.js';
import {fail} from './phase4Core.js';
/** Closed in-memory fixture composition; production uses its own admission. */
export async function createStage7Development(options){
 const {core}=options,files=(await core.client.execute('PRAGMA database_list')).rows;
 if(core.client.protocol!=='file'||!files.some(r=>r.name==='main')||files.some(r=>!['main','temp'].includes(r.name)||r.file!==''))fail('STAGE7_SYNTHETIC_MEMORY_REQUIRED');
 return createStage7Composition(options);
}
