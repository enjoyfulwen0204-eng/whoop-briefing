// External synthetic database provider, deliberately outside the app cgroup.
import {createServer} from 'node:http';import {createOwnedDb} from './stage5OwnedDb.js';import {hranaTransport} from './hranaTransport.js';
import {writeFile,readFile} from 'node:fs/promises';
const url='file:/fixtures/checkpoint.sqlite',seed=createOwnedDb({url});
const users=(await seed.raw.execute('SELECT id,display_name FROM users')).rows;
const shared=process.env.LINUX_SHARED_DATABASE==='1';
if(users.length!==1||users[0].id!=='a'||users[0].display_name!=='Synthetic')throw Error('SYNTHETIC_FIXTURE_ONLY');await seed.close();
if(shared){const {seedMorningProvider}=await import('./stage6LinuxMorningFixture.mjs');await seedMorningProvider(url);}
const transport=hranaTransport(url,{transactionMaxMs:5000,traceTransactions:process.env.LINUX_TRANSACTION_TRACE==='1'});
if(process.env.LINUX_CRASH_AFTER==='1')transport.arm({matchSql:/UPDATE phase4_jobs SET full_scan_cursor=/,after:async()=>{
 await writeFile('/fixtures/commit-marker.json',JSON.stringify({synthetic:true,originalCommitDurable:true,at:Date.now()}));
 // The external controller kills the entire app container while its original
 // publication ACK is unavailable. No deadline, lease or queue state is edited.
 await new Promise(r=>setTimeout(r,60000));
}});
let morning,probeActive=false,probePromise,probes=[];
if(process.env.LINUX_SERVICE==='1'){
 if(shared)morning=transport;
 else{
 if(process.env.LINUX_RETAINED_SERVICE==='1'){
  const retained=createOwnedDb({url:'file:/fixtures/morning.sqlite'});
  try{const rows=(await retained.raw.execute('SELECT id,display_name FROM users ORDER BY id')).rows;
   if(JSON.stringify(rows.map(r=>[r.id,r.display_name]))!==JSON.stringify([['alice','Synthetic'],['bob','Synthetic'],['lan','Synthetic']]))throw Error('RETAINED_SYNTHETIC_FIXTURE_REQUIRED');
  }finally{await retained.close();}
 }else{const {seedMorningProvider}=await import('./stage6LinuxMorningFixture.mjs');await seedMorningProvider('file:/fixtures/morning.sqlite');}
 morning=hranaTransport('file:/fixtures/morning.sqlite',{transactionMaxMs:5000,traceTransactions:process.env.LINUX_TRANSACTION_TRACE==='1'});
 }
}
const server=createServer(async(req,res)=>{try{
 if(req.method==='GET'&&req.url==='/qualification/resume'&&process.env.LINUX_RETAINED_SERVICE==='1'){res.setHeader('content-type','application/json');res.end(await readFile('/fixtures/resume.json','utf8'));return;}
 if(req.method==='GET'&&req.url==='/counts'){res.setHeader('content-type','application/json');res.end(JSON.stringify({transactionTraceEnabled:process.env.LINUX_TRANSACTION_TRACE==='1',counts:transport.counts,evidence:transport.evidence,probes,morningCounts:morning?.counts,morningEvidence:morning?.evidence,transactions:transport.transactions,morningTransactions:morning?.transactions}));return;}
 if(req.method==='POST'&&req.url==='/probe/start'&&!probeActive){probeActive=true;probes=[];probePromise=(async()=>{while(probeActive){const at=performance.now();try{const r=await fetch('http://app:8081/health',{signal:AbortSignal.timeout(35000)});probes.push({elapsedMs:performance.now()-at,status:r.status});}catch(e){probes.push({elapsedMs:performance.now()-at,error:e.name});}await new Promise(r=>setTimeout(r,250));}})();res.end('{}');return;}
 if(req.method==='POST'&&req.url==='/probe/stop'){probeActive=false;await probePromise;res.end('{}');return;}
 if(req.method!=='POST'||!['/v2/pipeline','/morning/v2/pipeline'].includes(req.url)||req.url.startsWith('/morning')&&!morning){res.writeHead(404).end();return;}
 const chunks=[];for await(const part of req)chunks.push(part);await new Promise(r=>setTimeout(r,115));
 const response=await (req.url.startsWith('/morning')?morning:transport).fetch(new Request('https://isolated.invalid/v2/pipeline',{method:'POST',body:Buffer.concat(chunks)}));
 res.writeHead(response.status,{'content-type':'application/json'});res.end(await response.text());
 }catch(e){res.writeHead(500).end(JSON.stringify({error:e.code??e.message}));}});
server.listen(8080,'0.0.0.0');console.log('SYNTHETIC_HRANA_READY');
process.on('SIGTERM',()=>{probeActive=false;server.close(async()=>{await writeFile('/fixtures/provider-summary.json',JSON.stringify({counts:transport.counts,evidence:transport.evidence,transactions:transport.transactions,probes}));transport.close();if(morning!==transport)morning?.close();process.exit(0);});});
