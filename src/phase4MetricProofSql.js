import {liveTable} from './stage8LiveAllocation.js';
// SQL text only. Consumers still authenticate every producer, owner, named
// receipt and clock. Keep the original page/seek contract and statement bytes.
export const metricProducerPageSql=live=>`SELECT p.*,e.state,e.phase,e.generation final_generation,
 e.execution_seq final_seq,e.identity_digest,e.scope_key,e.created_at,e.deadline_at,e.finalized_at,
 e.result_json,e.result_digest,e.release_sha,e.trigger_source,e.config_proof FROM ${live?liveTable('phase4_execution_producers'):'phase4_execution_producers'} p
 JOIN ${live?liveTable('phase4_executions'):'phase4_executions'} e ON e.execution_id=p.producing_execution_id
 WHERE p.user_id=? AND p.execution_mode=? AND p.input_generation=?
 AND p.producing_execution_id>? COLLATE BINARY
 ORDER BY p.producing_execution_id COLLATE BINARY LIMIT 65`;
