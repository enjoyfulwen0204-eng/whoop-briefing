import {requireRecoveryScope} from './recoveryPolicy.js';
import http from 'node:http';
import {phase4AuthorityKeys} from './phase4EnvironmentKeys.js';
import {initializeWhoopRenderIngressBridge} from './maintenanceWhoopIngress.js';

export async function main(){
 requireRecoveryScope('maintenance');
 const environment=process.env,port=Number(environment.PORT??3000),encoded=environment.KHOS_MAINTENANCE_INGRESS_BINDING;
 if(!Number.isSafeInteger(port)||port<1||port>65535||typeof encoded!=='string'||Buffer.byteLength(encoded)>16*1024)
  throw Object.assign(Error('WHOOP_BRIDGE_STARTUP_CONFIG_REQUIRED'),{code:'WHOOP_BRIDGE_STARTUP_CONFIG_REQUIRED'});
 let binding;try{binding=JSON.parse(encoded);}catch{throw Object.assign(Error('WHOOP_BRIDGE_SIGNED_SOURCE_BINDING_REQUIRED'),{code:'WHOOP_BRIDGE_SIGNED_SOURCE_BINDING_REQUIRED'});}
 const runtime=await initializeWhoopRenderIngressBridge({
  databaseUrl:environment.TURSO_DATABASE_URL,authToken:environment.TURSO_AUTH_TOKEN,
  keys:phase4AuthorityKeys(environment),clientSecret:environment.WHOOP_CLIENT_SECRET,
  approvedBinding:binding,releaseSha:environment.PHASE4_RELEASE_SHA,mode:'ingress-only',
 });
 const server=http.createServer(runtime.nodeHandler);
 server.requestTimeout=15_000;server.headersTimeout=10_000;server.keepAliveTimeout=5_000;
 try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'0.0.0.0',()=>{server.removeListener('error',reject);resolve();});});}
 catch(error){runtime.close();throw error;}
 let closing;
 const shutdown=()=>{
  if(closing)return closing;
  closing=new Promise(resolve=>{
   const timer=setTimeout(()=>server.closeAllConnections(),15_000);timer.unref();
   server.close(()=>{clearTimeout(timer);try{runtime.close();}finally{process.removeListener('SIGTERM',shutdown);process.removeListener('SIGINT',shutdown);resolve();}});
  });return closing;
 };
 process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
 console.log(JSON.stringify({event:'whoop_maintenance_ingress_listening',businessAvailable:false,schema:runtime.admission.schema}));
 return {server,close:shutdown};
}
