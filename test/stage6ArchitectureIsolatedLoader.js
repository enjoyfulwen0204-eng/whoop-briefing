// Evaluation only: loaded by the explicit isolated test preloader, never runtime.
import {readFileSync} from 'node:fs';
let root,wallMs,leaseMs,patches;
export function initialize(data){
 root=data.root;wallMs=data.wallMs;leaseMs=data.leaseMs;
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
  client.transaction=async(mode='write')=>{await client.execute(mode==='write'?'BEGIN IMMEDIATE':'BEGIN');return new Sqlite3Transaction(anchor,'number');};
  privateClients.add(client);
  try{await seed(client);return composeDb(client,{phase4Keys});}catch(error){client.close();throw error;}
 }
 `;

 for(const hunk of patches?.get(file)??[]){const before=hunk.before.join('\n')+'\n',after=hunk.after.join('\n')+'\n';if(source.indexOf(before)<0||source.indexOf(before)!==source.lastIndexOf(before))throw Error('ISOLATED_PROTOTYPE_SOURCE_MISMATCH');source=source.replace(before,after);}
 const replace=(before,after)=>{if(!source.includes(before))throw Error('ISOLATED_PROFILE_SOURCE_MISMATCH');source=source.replace(before,after);};
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
 if(url===root+'betaPilotPermit.js')replace('if(used>=issuedWorkProfiles.get(grant).prefixReadSets)fail();',"if(used>=issuedWorkProfiles.get(grant).prefixReadSets){console.log('ISOLATED_PREFIX_EXHAUSTED '+JSON.stringify({used,limit:issuedWorkProfiles.get(grant).prefixReadSets,profile:issuedWorkProfiles.get(grant).version}));fail();}");
 if(url===root+'betaPilotPermit.js')replace('prefixReadReservations.set(grant,used+1);return true;',"prefixReadReservations.set(grant,used+1);if(globalThis.__stage6PrefixStats)globalThis.__stage6PrefixStats.reservations++;return true;");
 return {...result,source};
}
