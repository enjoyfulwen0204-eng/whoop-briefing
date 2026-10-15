import {analysisTable} from './stage8LiveAllocation.js';
import {assertExecutionWorkOwner} from './phase4ExecutionContext.js';
import {createReceiptRouting} from './phase4ReceiptRouting.js';
import {createOperationReceipts} from './phase4OperationReceipts.js';
import {healthSourceVersion} from './phase4SourceVersion.js';
import {phase4Metric} from './phase4IntelligenceRegistry.js';
import {canonicalJson} from './phase4EntityStore.js';
import {canonicalMetricSourceValue} from './phase4IntelligenceStore.js';
const fail=code=>{throw Object.assign(Error(code),{code});};
/** The current analyzer captures a supported producer clock. No caller clock,
 * future ingestion, rewritten source snapshot or historical alias is admitted.
 * A committed operation's exact source versions reuse its original instant. */
export async function stage6CurrentCaptureTime(core,context,metricKey,artifact){
  await core.assertContext(context);const owner=await assertExecutionWorkOwner(core.client);
  if(context.executionMode!=='SHADOW'||owner?.phase!=='STAGE6_DRAIN')fail('STAGE6_CURRENT_CAPTURE_OWNER_REQUIRED');
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
    let same=true;for(const baseline of request.baselineSources??[]){
      const root=await core.root(context,baseline.source_type,baseline.source_id);
      if(baseline.source_mode!=='SHARED'||baseline.source_version!==healthSourceVersion(root.row)){same=false;break;}
    }
    if(!same)continue;
    const asOf=Date.parse(request.asOfUtc);if(!Number.isFinite(asOf)||asOf>clock)fail('STAGE6_CURRENT_CAPTURE_CLOCK_FENCED');times.add(request.asOfUtc);
  }
  if(times.size>1)fail('STAGE6_CURRENT_CAPTURE_AMBIGUOUS');
  await assertExecutionWorkOwner(core.client);await core.assertContext(context);
  return times.size?[...times][0]:new Date(clock).toISOString();
}
