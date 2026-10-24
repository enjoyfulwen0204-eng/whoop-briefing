import {createHash} from 'node:crypto';
const queue=new URL('../src/phase4ReanalysisQueue.js',import.meta.url).href;
export function transformWorkJoin(url,source){
 if(url!==queue)return source;
 if(createHash('sha256').update(source).digest('hex')!=='211d2d0c3936e272f4ba67fca8570a86dfb52bcb48fd58923e9deaa719695494')throw Error('EXACT_QUEUE_REQUIRED');
 const a='  const owned=(context,lease,fn,{assertBudget=()=>{},workKind,workFacts}={})=>withOwnership',b='  async function checkpoint(context,lease,cursor) {';
 if(source.split(a).length!==2||source.split(b).length!==2)throw Error('EXACT_OWNED_ANCHORS_REQUIRED');
 return source.replace(a,a.replace('const owned=','const ownedOriginal=')).replace(b,`  const owned=(...args)=>{const call=()=>ownedOriginal(...args);return globalThis.__stage6WorkJoin?globalThis.__stage6WorkJoin.owned(args[3],call):call();};\n`+b);
}
export async function load(url,context,next){if(process.env.NODE_ENV!=='test')throw Error('TEST_ONLY');const r=await next(url,context);return url===queue?{...r,source:transformWorkJoin(url,String(r.source))}:r;}
