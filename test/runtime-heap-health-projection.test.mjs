import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {dirname,join} from 'node:path';
import {readFileSync} from 'node:fs';
const W=dirname(dirname(fileURLToPath(import.meta.url))),URL=pathToFileURL(join(W,'src/runtimeHeapObservation.js')).href;
const testFlag=process.execArgv.indexOf('--test'),flags=process.execArgv.slice(0,testFlag<0?process.execArgv.length:testFlag);
function run(source,extra=[]){const r=spawnSync(process.execPath,[...flags,...extra,'--input-type=module','-e',source],{cwd:W,encoding:'utf8',timeout:10000});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);}
test('actual default and bounded V8 limit describes exactly the answering process',()=>{
 for(const extra of [[],['--max-old-space-size=96','--max-semi-space-size=2']]){
  const data=run(`import {getHeapStatistics} from 'node:v8';import {runtimeHeapLimitBytes} from ${JSON.stringify(URL)};console.log(JSON.stringify({actual:runtimeHeapLimitBytes(),expected:getHeapStatistics().heap_size_limit}));`,extra);
  assert.equal(data.actual,data.expected);assert.ok(Number.isSafeInteger(data.actual)&&data.actual>0);
 }
});
test('throwing/missing/invalid native projection returns null, never throws or invents a limit',()=>{
 for(const expression of ['(()=>{throw Error("SYNTHETIC_NATIVE_FAILURE")})()','null','{}','{heap_size_limit:0}','{heap_size_limit:-1}','{heap_size_limit:NaN}','{heap_size_limit:Infinity}','{heap_size_limit:9007199254740992}','{heap_size_limit:"1000"}']){
  const source=`import {registerHooks} from 'node:module';registerHooks({resolve(s,c,next){if(s==='node:v8'&&c.parentURL===${JSON.stringify(URL)})return {url:'data:text/javascript,'+encodeURIComponent('export function getHeapStatistics(){return '+${JSON.stringify(expression)}+'}'),shortCircuit:true};return next(s,c);}});const {runtimeHeapLimitBytes}=await import(${JSON.stringify(URL)});console.log(JSON.stringify({value:runtimeHeapLimitBytes()}));`;
  assert.deepEqual(run(source),{value:null});
 }
});
test('heap observation performs no network, stdout/stderr or environment read',()=>{
 const data=run(`const {runtimeHeapLimitBytes}=await import(${JSON.stringify(URL)});const output=process.stdout,errors=process.stderr,write=output.write,errorWrite=errors.write,environment=process.env;let value;try{process.env=new Proxy({},{get(){throw Error('ENV_FORBIDDEN')}});output.write=()=>{throw Error('STDOUT_FORBIDDEN')};errors.write=()=>{throw Error('STDERR_FORBIDDEN')};globalThis.fetch=()=>{throw Error('NETWORK_FORBIDDEN')};value=runtimeHeapLimitBytes();}finally{process.env=environment;output.write=write;errors.write=errorWrite;}console.log(JSON.stringify({positive:Number.isSafeInteger(value)&&value>0}));`);
 assert.deepEqual(data,{positive:true});
});
test('only supervisor exact GET health adds the number; HEAD and liveness/readiness/authority semantics remain original',()=>{
 const source=readFileSync(join(W,'src/productionSupervisorController.js'),'utf8');
 assert.ok(source.includes("path==='/health'&&req.url==='/health'&&['GET','HEAD'].includes(req.method)"));
 assert.ok(source.includes("runtimeHeapLimitBytes:req.method==='GET'?runtimeHeapLimitBytes():null"));
 assert.ok(source.includes("if(req.method==='HEAD'){res.writeHead(closed?503:200,{'content-type':'application/json','cache-control':'no-store'});return res.end();}"));
 assert.ok(source.includes("productionAuthority:'NONE'"));
 const entry=readFileSync(join(W,'src/bot/webhook-entry.js'),'utf8');assert.equal(entry.includes('runtimeHeap'),false);
});
