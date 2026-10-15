import{register}from'node:module';import{readFileSync,realpathSync}from'node:fs';import{fileURLToPath}from'node:url';import{execFileSync}from'node:child_process';import{verifyManifest,digest}from'./stage6SyntheticManifest.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),allowed=['stage6-synthetic-seed.mjs','stage6-synthetic-admission-http.mjs','stage6-synthetic-runner.mjs','stage6-synthetic-child.mjs'];
let name;try{name=allowed.find(n=>realpathSync(process.argv[1])===realpathSync(new URL(n,import.meta.url)));}catch{}
if(process.env.STAGE6_LOCAL_SYNTHETIC!=='explicit-local-test-v1'||!name||process.execArgv.some(x=>/^--(?:eval|print|input-type)(?:=|$)/.test(x)||/^-[ep]/.test(x)))throw Error('LOCAL_SYNTHETIC_TEST_ENTRY_REQUIRED');
const env={...process.env};for(const k of Object.keys(env))if(k.startsWith('GIT_'))delete env[k];const commit=execFileSync('git',['rev-parse','HEAD'],{cwd:root,env,encoding:'utf8'}).trim();
const envelope=JSON.parse(readFileSync('/qualification/manifest.json','utf8')),binding=verifyManifest(envelope,{root,commit,reservation:name!=='stage6-synthetic-seed.mjs'});
// The process has no external network namespace. This additionally refuses
// redirects/provider calls in the application-facing fetch transport.
const original=globalThis.fetch;globalThis.fetch=(input,init={})=>{const u=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||!['18080','18081','8081','8082'].includes(u.port)||u.username||u.password)throw Error('LOCAL_SYNTHETIC_NETWORK_DENIED');return original(input,{...init,redirect:'error'});};
register(new URL('./stage6SyntheticLoader.mjs',import.meta.url),{data:{...binding,reservationAllowed:name!=='stage6-synthetic-seed.mjs',envelopeDigest:digest(envelope),diagnostic:process.env.STAGE6_SYNTHETIC_DIAGNOSTIC==='1',root:new URL('../',import.meta.url).href,entry:new URL(name,import.meta.url).href}});
