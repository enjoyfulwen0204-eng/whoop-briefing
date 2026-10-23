import {createHash} from 'node:crypto';
const cache=new URL('../src/phase4Cache.js',import.meta.url).href;
const queue=new URL('../src/phase4ReanalysisQueue.js',import.meta.url).href;
export function transformCpuDiagnostic(url,source){
 if(url===cache){
  if(createHash('sha256').update(source).digest('hex')!=='e17e8d64f3c34f7396be801498675c296b62ba53d7924c34f1c213232d950cc8')throw Error('EXACT_CACHE_REQUIRED');
  const anchor='export function projectContextLeaseData(row,at){';if(source.split(anchor).length!==2)throw Error('EXACT_PROJECT_ANCHOR_REQUIRED');
  return source.replace(anchor,'function projectContextLeaseDataOriginal(row,at){')+`\nexport function projectContextLeaseData(row,at){const r=projectContextLeaseDataOriginal(row,at);globalThis.__stage6CPUStats?.project(r.supported===true);return r;}\n`;
 }
 if(url===queue){
  if(createHash('sha256').update(source).digest('hex')!=='4afe5b616d8567c255a3a267a0040440016fa3ef2846dfa4e3d3aa284bd1e7f8')throw Error('EXACT_QUEUE_REQUIRED');
  const a='  const owned=(context,lease,fn,{assertBudget=()=>{},workKind,workFacts}={})=>withOwnership',b='  async function checkpoint(context,lease,cursor) {';
  if(source.split(a).length!==2||source.split(b).length!==2)throw Error('EXACT_OWNED_ANCHORS_REQUIRED');
  return source.replace(a,a.replace('const owned=','const ownedOriginal=')).replace(b,`  const owned=(...args)=>{const call=()=>ownedOriginal(...args);return globalThis.__stage6CPUStats?globalThis.__stage6CPUStats.measure(args[3]?.workKind,args[3]?.workFacts?.[0],call):call();};\n`+b);
 }
 return source;
}
export async function load(url,context,next){
 if(process.env.NODE_ENV!=='test')throw Error('TEST_ONLY');
 const result=await next(url,context);if(url!==cache&&url!==queue)return result;
 return {...result,source:transformCpuDiagnostic(url,String(result.source))};
}
