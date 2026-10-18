/** Local routing kernel. It grants no DB, migration or production
 * authority. The fixed application controller must supply genuinely owned
 * native intake and freshly authenticated business runtimes. One external HTTP
 * listener calls handler throughout; local drain is not remote SQL cancellation.
 */
import {WHOOP_WEBHOOK} from './config.js';
const fail=code=>{throw Object.assign(Error(code),{code});};
const reject=res=>{
 if(!res.headersSent)res.writeHead(503,{'content-type':'application/json','cache-control':'no-store'});
 if(!res.writableEnded)res.end('{"ok":false}');
};
function requireBusiness(value){
 if(!value||['handler','closeAdmission','waitForDrained','dispose','status','startBackground'].some(k=>typeof value[k]!=='function'))fail('STABLE_ROUTER_OWNED_BUSINESS_REQUIRED');
 if(value.status().admission!=='OPEN')fail('STABLE_ROUTER_FRESH_OPEN_BUSINESS_REQUIRED');
 return value;
}
function requireIngress(value){
 if(!value||['handler','closeAdmission','waitForDrained','dispose'].some(k=>typeof value[k]!=='function'))fail('STABLE_ROUTER_OWNED_INGRESS_REQUIRED');
 return value;
}
export function createStableWebhookRouter({business}={}){return makeRouter({business:requireBusiness(business)});}
export function createColdStableWebhookRouter({nativeIngress,originalWindowId}={}){
 if(typeof originalWindowId!=='string'||!/^[A-Za-z0-9_-]{16,128}$/.test(originalWindowId))fail('STABLE_ROUTER_ORIGINAL_WINDOW_REQUIRED');
 return makeRouter({business:null,nativeIngress:requireIngress(nativeIngress),originalWindowId});
}
function makeRouter({business,nativeIngress=null,originalWindowId=null}){
 const coldStart=business===null;
 let current=business,retiring=null,ingress=nativeIngress,windowId=originalWindowId;
 let mode=coldStart?'DRAINED':'BUSINESS',retiredDisposed=false,ingressDisposed=false,backgroundSubmitted=false;
 let draining=null,finishing=null;
 const seen=new WeakSet(business?[business]:[]);
 async function handler(req,res){
  // Capture a route synchronously. No await separates selection from admission
  // to the chosen owned handler. A previously admitted handler retains its own
  // lifetime until joined; switching routes never closes an active SQL handle.
  const path=typeof req.url==='string'?req.url.split('?')[0]:null;
  const route=path===WHOOP_WEBHOOK.PATH&&ingress&&mode!=='RECOVERING'&&mode!=='BUSINESS'
   ?ingress.handler:mode==='BUSINESS'||mode==='INGRESS_PREPARED'||path===WHOOP_WEBHOOK.PATH&&mode==='RECOVERING'
    ?current.handler:null;
  if(!route)return reject(res);
  try{return await route(req,res);}catch(error){reject(res);throw error;}
 }
 function stageMaintenanceIngress({nativeIngress,originalWindowId}={}){
  if(mode!=='BUSINESS'||windowId!==null)fail('STABLE_ROUTER_ORIGINAL_WINDOW_ALREADY_BOUND');
  if(typeof originalWindowId!=='string'||!/^[A-Za-z0-9_-]{16,128}$/.test(originalWindowId))fail('STABLE_ROUTER_ORIGINAL_WINDOW_REQUIRED');
  const prepared=requireIngress(nativeIngress);
  // The dedicated durable route is visible BEFORE business admission closes.
  ingress=prepared;windowId=originalWindowId;mode='INGRESS_PREPARED';
  return status();
 }
 function closeBusinessAdmission(){
  if(mode!=='INGRESS_PREPARED')fail('STABLE_ROUTER_PREPARED_INGRESS_REQUIRED');
  retiring=current;mode='CLOSING';
  // Any partial failure leaves non-WHOOP traffic fenced. Never silently reopen
  // an old runtime whose native writes may already be queued remotely.
  retiring.closeAdmission(windowId);return status();
 }
 async function drainAndDisposeBusiness({signal}={}){
  if(coldStart||!['CLOSING','DRAINED'].includes(mode))fail('STABLE_ROUTER_CLOSED_BUSINESS_REQUIRED');
  if(!signal||typeof signal.throwIfAborted!=='function')fail('STABLE_ROUTER_ABORT_SIGNAL_REQUIRED');
  if(draining)return draining;
  draining=(async()=>{
   signal.throwIfAborted();await retiring.waitForDrained({signal});
   signal.throwIfAborted();await retiring.dispose({signal});
   retiredDisposed=true;mode='DRAINED';return status();
  })().finally(()=>{draining=null;});
  return draining;
 }
 function stageFreshBusiness({freshBusiness}={}){
  if(mode!=='DRAINED'||!retiredDisposed&&!coldStart)fail('STABLE_ROUTER_DISPOSED_OLD_BUSINESS_REQUIRED');
  const prepared=requireBusiness(freshBusiness);
  if(seen.has(prepared))fail('STABLE_ROUTER_OLD_BUSINESS_REUSE_FORBIDDEN');
  seen.add(prepared);current=prepared;
  // New WHOOP requests now use the verified fresh C/D runtime. Existing native
  // ingress promises remain owned and are drained before background processing
  // or Telegram callbacks are admitted. No positive ACK is synthesized here.
  mode='RECOVERING';return status();
 }
 async function finishReopen({signal}={}){
  if(mode!=='RECOVERING')fail('STABLE_ROUTER_FRESH_BUSINESS_REQUIRED');
  if(!signal||typeof signal.throwIfAborted!=='function')fail('STABLE_ROUTER_ABORT_SIGNAL_REQUIRED');
  if(finishing)return finishing;
  finishing=(async()=>{
   signal.throwIfAborted();
   if(!ingressDisposed){
    ingress.closeAdmission(windowId);await ingress.waitForDrained({signal});
    signal.throwIfAborted();await ingress.dispose({signal});ingressDisposed=true;
   }
   signal.throwIfAborted();
   if(backgroundSubmitted)fail('STABLE_ROUTER_BACKGROUND_START_OUTCOME_UNCERTAIN');
   backgroundSubmitted=true;
   // A throw remains RECOVERING and is never blindly retried. Controller must
   // stop/drain/reconcile that fresh runtime before further lifecycle changes.
   await current.startBackground();signal.throwIfAborted();mode='BUSINESS';return status();
  })().finally(()=>{finishing=null;});
  return finishing;
 }
 function status(){return Object.freeze({productionAuthority:'NONE',routingMode:mode,originalWindowId:windowId,
  dedicatedWhoopIngressMounted:ingress!==null&&!ingressDisposed,retiredBusinessDisposed:retiredDisposed,
  noBusinessConstructedAtStartup:coldStart,priorProcessDatabaseDisposition:coldStart?'UNKNOWN_NOT_OBSERVED':'NOT_APPLICABLE',
  ingressDisposed,backgroundStartSubmitted:backgroundSubmitted,remoteSqlCancelled:false,
  maintenanceRequired:mode!=='BUSINESS',databaseOutcomeVerified:false});}
 return Object.freeze({handler,stageMaintenanceIngress,closeBusinessAdmission,drainAndDisposeBusiness,
  stageFreshBusiness,finishReopen,status});
}
