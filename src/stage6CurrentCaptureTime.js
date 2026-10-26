import {createReceiptRouting} from './phase4ReceiptRouting.js';
import {createOperationReceipts} from './phase4OperationReceipts.js';
import {healthSourceVersion} from './phase4SourceVersion.js';
import {phase4Metric} from './phase4IntelligenceRegistry.js';
import {canonicalJson} from './phase4EntityStore.js';
import {canonicalMetricSourceValue} from './phase4IntelligenceStore.js';
import {observeContextAndWorkOwner} from './phase4ReadControls.js';
const fail=code=>{throw Object.assign(Error(code),{code});};
/** The current analyzer captures a supported producer clock. No caller clock,
 * future ingestion, rewritten source snapshot or historical alias is admitted.
 * A committed operation's exact source versions reuse its original instant. */
export async function stage6CurrentCaptureTime(core,context,metricKey,artifact,{preparePending=null,verifyPending=null}={}){
  core.assertAnalysisWrite(context);const owner=await observeContextAndWorkOwner(core,context);
  if(!core.analysisModeAllowed(context)||owner?.phase!=='STAGE6_DRAIN')fail('STAGE6_CURRENT_CAPTURE_OWNER_REQUIRED');
  const supportedClock=core.now().getTime(),actualClock=Date.now();
  if(supportedClock>actualClock)fail('STAGE6_CURRENT_CAPTURE_CLOCK_FENCED');
  const clock=Math.min(supportedClock,actualClock);
  if(!Number.isSafeInteger(clock)||clock<owner.created_at||clock>owner.deadline_at)fail('STAGE6_CURRENT_CAPTURE_CLOCK_FENCED');
  const [source]=await core.revalidateSources(context,[artifact.ref]);
  if(source.type!==phase4Metric(metricKey).sourceType||canonicalJson(source.row)!==canonicalJson(artifact.row))fail('STAGE6_CURRENT_CAPTURE_SOURCE_REQUIRED');
  canonicalMetricSourceValue(metricKey,{type:source.type,id:source.id,row:source.row},context,new Date(clock).toISOString());
  const routing=createReceiptRouting(core.client,core.keys,{live:core.liveAllocation}),contract=phase4Metric(metricKey),
    token=routing.token(context.userId,context.executionMode,'EPISODE',[metricKey,contract.domain]);
  const inventory=await routing.inventory(context,'EPISODE',token,true);
  if(inventory.unknown)fail('PHASE4_RECEIPT_ROUTE_LEGACY_UNKNOWN');
  const receipts=createOperationReceipts(core),times=new Set();
  for(const row of inventory.receipts){
    if(row.operation_kind!=='analyzeMetric'||row.input_generation!==context.inputGeneration
      ||row.lifecycle_generation!==context.lifecycleGeneration||row.auth_generation!==context.authGeneration||row.purge_generation!==context.purgeGeneration)continue;
    const request=receipts.authenticate(context,row).request_json.request,current=request.currentSource;
    if(request.metricKey!==metricKey||current?.source_type!==source.type||current.source_id!==source.id
      ||current.source_version!==healthSourceVersion(source.row))continue;
    let same=true;const mismatch=Symbol('source-version-mismatch');
    try{await core.readRoots(context,(request.baselineSources??[]).map(baseline=>({type:baseline.source_type,id:baseline.source_id,baseline})),
      {verify:(source,root)=>{if(source.baseline.source_mode!=='SHARED'||source.baseline.source_version!==healthSourceVersion(root.row))throw mismatch;}});
    }catch(error){if(error!==mismatch)throw error;same=false;}
    if(!same)continue;
    const asOf=Date.parse(request.asOfUtc);if(!Number.isFinite(asOf)||asOf>clock)fail('STAGE6_CURRENT_CAPTURE_CLOCK_FENCED');times.add(request.asOfUtc);
  }
  if(times.size>1)fail('STAGE6_CURRENT_CAPTURE_AMBIGUOUS');
  if(!times.size&&preparePending&&verifyPending){
    const pending=(await core.client.execute({sql:`SELECT * FROM evidence_runs WHERE user_id=? AND execution_mode=?
      AND subject_key=? AND input_generation=? AND lifecycle_generation=? AND auth_generation=? AND purge_generation=?
      AND invalidated_at IS NULL AND state IN ('STARTED','COMPLETED') ORDER BY as_of_utc LIMIT 129`,
      args:[context.userId,context.executionMode,metricKey,context.inputGeneration,context.lifecycleGeneration,context.authGeneration,context.purgeGeneration]})).rows;
    if(pending.length>128)fail('PHASE4_OPERATION_RESULT_BOUNDS_UNAVAILABLE');
    for(const row of pending){
      const time=Date.parse(row.as_of_utc);if(!Number.isFinite(time)||time>clock)fail('STAGE6_CURRENT_CAPTURE_CLOCK_FENCED');
      const request={...await preparePending(row.as_of_utc),refresh:true};
      if(await verifyPending(request,row))times.add(row.as_of_utc);
    }
    if(times.size>1)fail('STAGE6_CURRENT_CAPTURE_AMBIGUOUS');
  }
  await observeContextAndWorkOwner(core,context,{ownerFirst:true});
  return times.size?[...times][0]:new Date(clock).toISOString();
}
