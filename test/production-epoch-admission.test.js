import test from 'node:test';
import assert from 'node:assert/strict';
import * as adapter from '../src/epochPermitClient.js';
import {createSupervisorRuntimeEpochScope} from '../src/runtimeEpochScope.js';
import {phase4AuthorityKeys} from '../src/phase4EnvironmentKeys.js';

test('public epoch adapter exposes production capture only; JSON cannot become admission',()=>{
 assert.deepEqual(Object.keys(adapter).sort(),['assertSupervisorEpochAdmission','bindFixedEpochPermitClientFromAdmission','captureProductionSupervisorEpochAdmission','requireSupervisorEpochAdmissionCatalog'].sort());
 const keys=phase4AuthorityKeys({PHASE4_LOOKUP_KEY:'47'.repeat(32),PHASE4_AUDIT_KEY:'53'.repeat(32)});
 for(const observation of [{},Object.freeze({productionAuthority:'NONE',phase:'C_BUSINESS35',schema:35})])
  assert.throws(()=>adapter.captureProductionSupervisorEpochAdmission({observation,keys}),/ORIGINAL_ACTUAL_OBSERVATION_REQUIRED/);
 assert.throws(()=>createSupervisorRuntimeEpochScope({epochAdmission:{productionAuthority:'NONE'},keys}),/ORIGINAL_OPAQUE_ADMISSION_REQUIRED/);
 assert.throws(()=>adapter.captureProductionSupervisorEpochAdmission({observation:{},keys,client:{}}),/ORIGINAL_PRODUCTION_OBSERVATION_REQUIRED/);
});
