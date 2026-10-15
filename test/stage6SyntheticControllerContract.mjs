import {canonicalPhaseRequest} from '../src/phase4ExecutionStore.js';

export const parentRequestBody = request => canonicalPhaseRequest(request);
export function phaseHttpBody(response) {
  if (!Number.isInteger(response?.status) || response.status < 100 || response.status > 599
      || !response.body || typeof response.body !== 'object') throw Error('SYNTHETIC_PHASE_RESPONSE_INVALID');
  return JSON.stringify(response.body);
}
