import {consumeReadOnlyRollback} from './processingTransaction.js';

// Call sites supply fixed original readonly siblings. All results settle before
// rollback, with the first original call retaining failure priority.
export async function settledReadPreparation(reads){
 const results=await Promise.allSettled(reads.map(read=>Promise.resolve().then(read)));
 const failure=results.find(result=>result.status==='rejected');if(failure)throw failure.reason;
 return results.map(result=>result.value);
}
export async function prepareReadOnly(db,composed,independent){
 if(typeof db.readOnlyTransaction!=='function')return independent();
 try{return await db.readOnlyTransaction(composed);}
 catch(error){if(!consumeReadOnlyRollback(error))throw error;return independent();}
}
