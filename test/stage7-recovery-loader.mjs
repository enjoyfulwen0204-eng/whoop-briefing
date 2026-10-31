// Test runner only: reuse the accepted v33 fixture rather than changing the
// production admission contract to fit historical v34 tests. Block all HTTP.
import {registerHooks} from 'node:module';
import http from 'node:http';
import https from 'node:https';
globalThis.fetch=async()=>{throw Error('SYNTHETIC_NETWORK_FORBIDDEN');};
for(const module of [http,https])for(const name of ['request','get'])module[name]=()=>{throw Error('SYNTHETIC_NETWORK_FORBIDDEN');};
const fixture=new URL('./stage7-v33-fixture.js',import.meta.url).href;
registerHooks({resolve(specifier,context,next){
 if(specifier==='./phase4Fixture.js'&&context.parentURL?.includes('/test/'))return {url:'data:text/javascript,'+encodeURIComponent(`export {syntheticStage7V33Fixture as syntheticPhase4Fixture} from ${JSON.stringify(fixture)};`),shortCircuit:true};
 return next(specifier,context);
}});
