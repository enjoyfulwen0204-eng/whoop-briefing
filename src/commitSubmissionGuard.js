/** Typed boundary: only this exact outer transaction and the exact
 * synchronous guard error can prove its inner commit function was never called.
 * There is no API to mark caller-supplied errors/transactions or JSON flags.
 * Kernel consumption is single-use and grants no callback/retry authority.
 */
const beforeSubmission=new WeakMap(),currentFailure=new WeakMap();
export function createOwnedCommitGuardedTransaction({transaction,guard,closed}={}){
 if(!transaction||typeof guard!=='function'||typeof closed!=='function')throw Error('OWNED_COMMIT_GUARD_REQUIRED');
 const outer=Object.freeze({
  get closed(){return closed();},
  execute(...args){guard();return transaction.execute(...args);},batch(...args){guard();return transaction.batch(...args);},executeMultiple(...args){guard();return transaction.executeMultiple(...args);},
  commit(){
   const previous=currentFailure.get(outer);if(previous){beforeSubmission.delete(previous);currentFailure.delete(outer);}
   try{guard();}catch(error){
    if(error&&typeof error==='object'){beforeSubmission.set(error,outer);currentFailure.set(outer,error);}
    throw error;
   }
   // Deliberately outside the catch: sync or async submission errors/unknown
   // acknowledgements can never acquire a guard-rejection marker.
   return transaction.commit();
  },
  rollback(...args){return transaction.rollback(...args);},close(){return transaction.close();},
 });return outer;
}
export function consumeOwnedCommitGuardFailure(transaction,error){
 if(!error||typeof error!=='object'||beforeSubmission.get(error)!==transaction||currentFailure.get(transaction)!==error)return false;
 beforeSubmission.delete(error);currentFailure.delete(transaction);return true;
}
