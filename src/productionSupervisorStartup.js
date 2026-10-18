/** Explicit entry for the fixed stable listener. Enabling this entry does not
 * authorize maintenance; each command still needs the original signed scope. */
import {createProductionSupervisorRuntime} from './productionSupervisorController.js';

export async function main(){
 const environment=Object.freeze({...process.env});
 if(environment.KHOS_RUNTIME_SUPERVISOR!=='on'||!['off',undefined].includes(environment.KHOS_MAINTENANCE_INGRESS_MODE))
  throw Object.assign(Error('SUPERVISOR_EXPLICIT_ENTRY_REQUIRED'),{code:'SUPERVISOR_EXPLICIT_ENTRY_REQUIRED'});
 return createProductionSupervisorRuntime({environment});
}
