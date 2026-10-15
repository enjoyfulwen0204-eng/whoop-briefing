let data;export function initialize(d){data=d;}
export async function resolve(specifier,context,next){
 if(specifier==='stage6-synthetic:manifest')return{url:specifier,shortCircuit:true};
 const r=await next(specifier,context);if(r.url.startsWith(data.root+'src/')||r.url.startsWith(data.root+'test/')){
  const u=new URL(r.url),p=context.parentURL?new URL(context.parentURL):null;
  if(u.searchParams.has('productionControl')||p?.searchParams.has('productionControl')){u.search='?productionControl=1';return{...r,url:u.href};}
  if(r.url.split('?')[0]===data.entry||p?.searchParams.has('localSynthetic')){u.search='?localSynthetic='+data.manifestDigest;return{...r,url:u.href};}
 }return r;
}
export async function load(url,context,next){
 if(url==='stage6-synthetic:manifest')return{format:'module',shortCircuit:true,source:'const freeze=x=>{if(x&&typeof x===\'object\'){for(const v of Object.values(x))freeze(v);Object.freeze(x);}return x;};export default freeze('+JSON.stringify(data)+');'};
 const r=await next(url,context);if(!new URL(url).searchParams.has('localSynthetic')||r.format!=='module')return r;
 let s=String(r.source);const file=url.split('?')[0].slice(data.root.length),helper=new URL('test/stage6SyntheticAdmission.mjs?localSynthetic='+data.manifestDigest,data.root).href;
 const replace=(a,b)=>{if(s.split(a).length!==2)throw Error('SYNTHETIC_SOURCE_ANCHOR_MISMATCH:'+file);s=s.replace(a,b);};
 if(file==='src/phase4Keys.js')replace("if ([lookup,audit].some(key=>key.subarray(0,16).equals(Buffer.from('S6_SYNTHETIC_V1:')))) throw new Error('PHASE4_SYNTHETIC_KEYS_REJECTED');","if (![lookup,audit].every(key=>key.subarray(0,16).equals(Buffer.from('S6_SYNTHETIC_V1:')))) throw new Error('LOCAL_SYNTHETIC_KEYS_REQUIRED');");
 if(file==='test/localDb.js')replace('lookupKey: Buffer.alloc(32, 71), auditKey: Buffer.alloc(32, 83)','lookupKey: Buffer.from(\'S6_SYNTHETIC_V1:lookup-test-only!\'), auditKey: Buffer.from(\'S6_SYNTHETIC_V1:audit--test-only!\')');
 if(file==='src/betaPilotAllowance.js'){
  s=`import{syntheticAllowance}from'${helper}';\n`+s;
  replace('id===allowance.id?allowance:', 'id===syntheticAllowance.id?syntheticAllowance:id===allowance.id?allowance:');
  replace('value===allowance||value===secondAllowance','value===syntheticAllowance||value===allowance||value===secondAllowance');
 }
 if(file==='src/betaPilotPermit.js'){
  s=`import{syntheticConfiguration,syntheticAdmission,syntheticPermit,syntheticComponent,syntheticAssertTime,syntheticObservationSql,syntheticAssertObservation,syntheticPublication,syntheticSettle,syntheticClosing}from'${helper}';\n`+s;
  replace('export const closingBetaPilotPermit=db=>Boolean(db?.raw)&&closureScope.getStore()===db.raw;', 'export const closingBetaPilotPermit=db=>Boolean(db?.raw)&&(closureScope.getStore()===db.raw||syntheticClosing(db));');
  replace('export function betaPilotConfiguration(environment={}) {','export function betaPilotConfiguration(environment={}) {return syntheticConfiguration(environment);}\nfunction originalBetaPilotConfiguration(environment={}) {');
  replace('return config?.allowanceId?reviewedPilotAllowance(config.allowanceId):reviewedPilotReservation(config?.costBoundId);','return syntheticAdmission(config);');
  replace('export function createBetaPilotPermit({db,keys,config,reservation}={}) {','export function createBetaPilotPermit(args){return syntheticPermit(args,originalCreateBetaPilotPermit);}\nfunction originalCreateBetaPilotPermit({db,keys,config,reservation}={}) {');
  replace("const component=second?'phase4_beta_pilot_permit_owner_20261012_v2':COMPONENT;", "const component=syntheticComponent(config,db,keys);");
  replace("if(!grant||!issuedGrants.has(grant)","if(!grant||!issuedGrants.has(grant)"); // Explicit anchor count; no authority bypass.
  replace("const assertTime=()=>{if(closingBetaPilotPermit(db))return;if(locallyClosed", "const assertTime=()=>{if(closingBetaPilotPermit(db))return;syntheticAssertTime(grant);if(locallyClosed");
  replace('settleInvalidation:()=>locallyClosed?persistClosure():undefined,','settleInvalidation:()=>Promise.all([locallyClosed?persistClosure():undefined,syntheticSettle(grant)]),');
  replace('const current=(await (client??db.raw).execute({sql:`SELECT ${databaseNowMs} observed_at,','const current=(await (client??db.raw).execute({sql:`SELECT ${databaseNowMs} observed_at,${syntheticObservationSql(config)}');
  replace('if(!current||current.last_detail===null)fail();const state=decode(current);','syntheticAssertObservation(config,db,keys,current);if(!current||current.last_detail===null)fail();const state=decode(current);');
  replace('export function pilotPublicationFence(grant,client){','export function pilotPublicationFence(grant,client){return syntheticPublication(grant,client,originalPilotPublicationFence(grant,client));}\nfunction originalPilotPublicationFence(grant,client){');
  replace("if(allowance)log[result.attempt>=reservation.warningAttempt?'warn':'info']", "if(false)log[result.attempt>=reservation.warningAttempt?'warn':'info']");
 }
 return{...r,source:s};
}
