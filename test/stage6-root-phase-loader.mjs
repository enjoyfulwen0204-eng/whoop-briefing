// Test-only three-anchor observation of exact candidate root bootstrap.
import {createHash} from 'node:crypto';
export async function load(url,context,next){
 if(process.env.NODE_ENV!=='test')throw Error('ROOT_PHASE_TEST_ENV_REQUIRED');
 const result=await next(url,context);if(url!==new URL('../src/processingTransaction.js',import.meta.url).href)return result;
 let source=String(result.source);if(createHash('sha256').update(source).digest('hex')!=='ae9027134d859af4b47b2d3750771afa60abfd86fefc5e538a754c92003ad9a9')throw Error('ROOT_PHASE_EXACT_SOURCE_REQUIRED');
 const patch=(before,after)=>{if(source.split(before).length!==2)throw Error('ROOT_PHASE_EXACT_ANCHOR_REQUIRED');source=source.replace(before,after);};
 source='import {captureRootPhase,withRootPhase} from '+JSON.stringify(new URL('./stage6-native-slow-root.mjs',import.meta.url).href)+';\n'+source;
 patch('    const parent = scope.getStore();','    const parent = scope.getStore();\n    let diagnosticRoot=null;if(!parent)try{diagnosticRoot=captureRootPhase({readOnly,from:typeof workStepFrom===\'function\',fixed:typeof workStep===\'string\',stack:new Error().stack});}catch{}');
 patch('tx=await retryContention(async()=>{','tx=await retryContention(()=>withRootPhase(diagnosticRoot,async()=>{');
 patch('          return opened;\n        },{','          return opened;\n        }),{');
 return {...result,source};
}
