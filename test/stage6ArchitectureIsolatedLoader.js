// Evaluation only: loaded by the explicit isolated test preloader, never runtime.
import {readFileSync} from 'node:fs';
let root,wallMs,leaseMs,patches,lateProfile,retainRamScopes,runtimeIntegrated;
export function initialize(data){
 runtimeIntegrated=data.runtimeIntegrated;retainRamScopes=data.retainRamScopes;lateProfile=data.lateProfile;root=data.root;wallMs=data.wallMs;leaseMs=data.leaseMs;
 if(data.prototype){
  const allowed=new Set(['betaPilotBoundedReads.js','betaPilotPermit.js','phase4Core.js','phase4OperationReceipts.js','phase4ReanalysisQueue.js','processingReadSnapshot.js','processingTransaction.js']);
  patches=new Map();let file,hunk;
  for(const line of readFileSync(new URL('./stage6ArchitecturePrototype.patch',import.meta.url),'utf8').split('\n')){
   if(line.startsWith('diff --git ')){const match=/^diff --git a\/src\/([^ ]+) b\/src\/([^ ]+)$/.exec(line);if(!match||match[1]!==match[2]||!allowed.has(match[1])||patches.has(match[1]))throw Error('ISOLATED_PROTOTYPE_PATCH_REJECTED');file=match[1];patches.set(file,[]);hunk=undefined;}
   else if(line.startsWith('@@ ')){if(!file)throw Error('ISOLATED_PROTOTYPE_PATCH_REJECTED');hunk={before:[],after:[]};patches.get(file).push(hunk);}
   else if(hunk&&line.startsWith(' ')){hunk.before.push(line.slice(1));hunk.after.push(line.slice(1));}
   else if(hunk&&line.startsWith('-'))hunk.before.push(line.slice(1));
   else if(hunk&&line.startsWith('+'))hunk.after.push(line.slice(1));
  }
  if(patches.size!==allowed.size)throw Error('ISOLATED_PROTOTYPE_PATCH_REJECTED');
 }
}
export async function load(url,context,nextLoad){
 const result=await nextLoad(url,context);
 if(!root||!url.startsWith(root)||result.format!=='module')return result;
 let source=String(result.source);
 const file=url.slice(root.length);
 if(patches&&file==='db.js')source+=`
 // Explicit isolated prototype loader only: privately owned RAM receiver.
 export async function createIsolatedOwnedMemoryDb(seed,phase4Keys){
  const anchor=new Database(':memory:'),client=new Sqlite3Client(':memory:',{},anchor,'number');
  const observe=(target,method,count=()=>1)=>{const original=target[method].bind(target);target[method]=async(...args)=>{const at=performance.now();try{return await original(...args);}finally{const n=count(...args);for(let k=0;k<n;k++)globalThis.__stage6LateProfile?.mark('PHYSICAL_RAM_SQL',(performance.now()-at)/n);}};};
  client.transaction=async(mode='write')=>{await client.execute(mode==='write'?'BEGIN IMMEDIATE':'BEGIN');const tx=new Sqlite3Transaction(anchor,'number');if(globalThis.__stage6LateProfile){observe(tx,'execute');observe(tx,'batch',stmts=>stmts.length);observe(tx,'commit');observe(tx,'rollback');}return tx;};
  privateClients.add(client);_ramScopes.ownRamScopes(client);
  if(globalThis.__stage6LateProfile)observe(client,'execute');
  try{await seed(client);const db=composeDb(client,{phase4Keys});return {...db,close(){db.close();_ramScopes.closeRamScopes(client,{retainForDiagnostic:${Boolean(retainRamScopes)}});}};}catch(error){client.close();_ramScopes.closeRamScopes(client,{retainForDiagnostic:${Boolean(retainRamScopes)}});throw error;}
 }
 `;

 for(const hunk of runtimeIntegrated?[]:patches?.get(file)??[]){const before=hunk.before.join('\n')+'\n',after=hunk.after.join('\n')+'\n';if(source.includes(after))continue;if(source.indexOf(before)<0||source.indexOf(before)!==source.lastIndexOf(before))throw Error('ISOLATED_PROTOTYPE_SOURCE_MISMATCH');source=source.replace(before,after);}
 const replace=(before,after)=>{if(!source.includes(before))throw Error('ISOLATED_PROFILE_SOURCE_MISMATCH');source=source.replace(before,after);};
 if(patches&&['db.js','processingTransaction.js','phase4Core.js','phase4OperationReceipts.js','legacyHealthAdapter.js'].includes(file)){
  source=`import * as _ramScopes from '${new URL('./stage6RamScopeLifetime.mjs',import.meta.url).href}';\n`+source;
  if(file==='processingTransaction.js'){
   replace('  const fences = () =>', '  _ramScopes.registerRamScopes(base,scope,readScope,readOnlyWork,fenceScope,checking);\n  const fences = () =>');
   replace('  return { client, transaction,readOnlyTransaction,', '  _ramScopes.shareRamScopes(base,client);\n  return { client, transaction,readOnlyTransaction,');
  }
  if(file==='phase4Core.js')replace('  const {client,transaction}=processing;', '  const {client,transaction}=processing;_ramScopes.registerRamScopes(client,jobScope);');
  if(file==='phase4OperationReceipts.js')replace('  const producerScope=new AsyncLocalStorage();', '  const producerScope=new AsyncLocalStorage();_ramScopes.registerRamScopes(client,producerScope);');
  if(file==='legacyHealthAdapter.js')replace('  const calls=new AsyncLocalStorage(),shapes=new Map();', '  const calls=new AsyncLocalStorage(),shapes=new Map();_ramScopes.registerRamScopes(client,calls);');
 }
 if(lateProfile){
  const bind=(names,needle)=>replace(needle,names.map(([name,label])=>`${name}=globalThis.__stage6LateProfile?.wrap('${label}',${name})??${name};`).join('\n')+'\n'+needle);
  if(file==='phase4Core.js')bind([['validateStoredGraph','GRAPH_TRAVERSAL'],['revalidateSources','SOURCE_REVALIDATION'],['artifact','ARTIFACT'],['readRoots','GRAPH_ROOTS']], '  const core=Object.freeze({client,processing');
  if(file==='phase4ResultAuthority.js')bind([['captureRoots','AUTHORITY_CAPTURE'],['validateRoots','AUTHORITY_VALIDATE'],['descriptorsForRun','RUN_ENUMERATION'],['read','AUTHORITY_READ']], '  return Object.freeze({read,readOwnedMetricDomainEvidence');
  if(file==='phase4IntelligenceStore.js')bind([['performMetricPreparationUnit','RAW_UNIT']], '  return Object.freeze({analyzeMetric,analyzeAssociationFamily');
  if(file==='phase4AuthorityClosure.js')bind([['inventory','AUTHORITY_CLOSURE']], '  return {inventory,retained};');
  if(file==='phase4OperationReceipts.js')bind([['encode','RECEIPT_SERIALIZATION'],['read','RECEIPT_READ'],['forArtifact','RECEIPT_ARTIFACT']], '  const api=Object.freeze({execute,read,prepare');
  if(file==='phase4EntityStore.js'){
   source=source.replace('export function canonicalJson(value) {','function canonicalJsonOriginal(value) {').replaceAll('value.map(canonicalJson)','value.map(canonicalJsonOriginal)').replaceAll('canonicalJson(value[k])','canonicalJsonOriginal(value[k])');
   source+="\nexport function canonicalJson(value){return globalThis.__stage6LateProfile?.sync('MANIFEST_CANONICAL_JSON',()=>canonicalJsonOriginal(value))??canonicalJsonOriginal(value);}";
  }
  if(file==='phase4Keys.js')replace("const hmac = (key, value) => createHmac('sha256', key).update(JSON.stringify(value)).digest('hex');", "const hmac=(key,value)=>{const p=globalThis.__stage6LateProfile,s=p?p.sync('HMAC_JSON',()=>JSON.stringify(value)):JSON.stringify(value);return p?p.sync('HMAC',()=>createHmac('sha256',key).update(s).digest('hex')):createHmac('sha256',key).update(s).digest('hex');};");
 }
 if(wallMs!==undefined&&url===root+'phase4DrainPolicy.js'){
  replace('github:Object.freeze({maxWallMs:90000,safetyMarginMs:15000,maxJobs:16,maxItems:128,maxItemsPerTenant:8,leaseMs:120000})',`github:Object.freeze({maxWallMs:${wallMs},safetyMarginMs:15000,maxJobs:16,maxItems:128,maxItemsPerTenant:8,leaseMs:${leaseMs}})`);
  replace('budget.maxWallMs>90000',`budget.maxWallMs>${wallMs}`);replace('budget.leaseMs>120000',`budget.leaseMs>${leaseMs}`);
 }
 if(wallMs!==undefined&&url===root+'phase4Execution.js')replace("github:90_000,manual:45_000,event:25_000",`github:${wallMs},manual:45_000,event:25_000`);
 if(wallMs!==undefined&&url===root+'phase4ReanalysisQueue.js')replace('leaseMs>120000',`leaseMs>${leaseMs}`);
 if(url===root+'executionBudget.js'&&wallMs>180000)replace('budgetMs > 225_000',`budgetMs > ${wallMs+45000}`);
 if(url===root+'phase4Reanalysis.js')replace("export const stage6ErrorCode=error=>errorCodes.get(error?.code)??'CALCULATION_FAILED';", "export const stage6ErrorCode=error=>{console.log('ISOLATED_STAGE6_ERROR '+JSON.stringify({name:error?.name,code:error?.code,message:error?.message,stack:error?.stack}));return errorCodes.get(error?.code)??'CALCULATION_FAILED';};");
 if(url===root+'processingTransaction.js'&&source.includes('state.readMemo.getData(context,scopedKey)')){
  replace('if(data!==undefined){',"if(data!==undefined){if(globalThis.__stage6PrefixStats)globalThis.__stage6PrefixStats.hits++;");
  replace('const value=await readOnlyWork.run(true,read);',"if(globalThis.__stage6PrefixStats)globalThis.__stage6PrefixStats.misses++;const value=await readOnlyWork.run(true,read);");
 }
 if(url===root+'betaPilotBoundedReads.js')replace("||result.invalid_types!==0||result.candidate_count>PILOT_PREFIX_MAX_ROWS||result.serialized_bytes>maxBytes)denied();","||result.invalid_types!==0||result.candidate_count>PILOT_PREFIX_MAX_ROWS||result.serialized_bytes>maxBytes){console.log('ISOLATED_PREFIX_BOUNDS '+JSON.stringify({table:spec.table,index:spec.index,prefix:spec.prefix,count:result.candidate_count,bytes:result.serialized_bytes,invalidTypes:result.invalid_types,maxBytes}));denied();}");
 if(!runtimeIntegrated&&url===root+'betaPilotPermit.js')replace('if(used>=issuedWorkProfiles.get(grant).prefixReadSets)fail();',"if(used>=issuedWorkProfiles.get(grant).prefixReadSets){console.log('ISOLATED_PREFIX_EXHAUSTED '+JSON.stringify({used,limit:issuedWorkProfiles.get(grant).prefixReadSets,profile:issuedWorkProfiles.get(grant).version}));fail();}");
 if(url===root+'betaPilotPermit.js')replace('prefixReadReservations.set(grant,used+1);return true;',"prefixReadReservations.set(grant,used+1);if(globalThis.__stage6PrefixStats)globalThis.__stage6PrefixStats.reservations++;return true;");
 return {...result,source};
}
