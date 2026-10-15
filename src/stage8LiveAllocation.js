/** Static physical allocation; no request-controlled identifiers or SQL rewriting. */
export const LIVE_SCHEMA_VERSION=35;
export const LIVE_TABLES=Object.freeze(Object.fromEntries([
 'phase4_executions','phase4_execution_work_receipts','phase4_execution_producers',
 'phase4_evidence_result_authorities','phase4_operation_receipts',
 'phase4_receipt_routes','phase4_receipt_route_entries','phase4_receipt_route_manifests',
 'phase4_family_directory_entries','phase4_family_directory_manifests','phase4_family_work_tips',
].map(name=>[name,name.replace('phase4_','stage8_live_')])));
export const liveTable=name=>LIVE_TABLES[name]??name;
export const analysisTable=(core,name)=>core.liveAllocation?liveTable(name):name;
export const allocationForMode=(mode,name)=>mode==='LIVE'?liveTable(name):name;
export const LIVE_HEALTH_FIELDS=Object.freeze({
 [liveTable('phase4_evidence_result_authorities')]:['original_result_json','required_roots_json','input_manifest_hash','item_hash','authority_hmac'],
 [liveTable('phase4_operation_receipts')]:['semantic_at','request_json','result_json','related_results_json','required_roots_json','schema_contract_json','receipt_hmac'],
});
