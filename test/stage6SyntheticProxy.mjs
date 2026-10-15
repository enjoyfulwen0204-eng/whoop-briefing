// Test-only 115ms transport in front of an unmodified, pinned upstream sqld.
// No retries, lock handling, SQL rewriting, or timeout extensions occur here.
import {createServer} from 'node:http';
import {createHash,randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
const streams=new Map(),transactions=[],evidence=[],probes=[],probeRuns=[];
const counts={httpRequests:0,submittedSqlStatements:0,observedExecutedSqlStatements:0},configuration={backend:'upstream-sqld-v0.24.33',latencyMs:115,qualificationTransactionThresholdMs:5000,actualSelfHostedTransactionLimitMs:null,productionTransactionLimit:'UNKNOWN',retries:0};
let probeActive=false,probePromise,probeRun,probeStopping;
const label=sql=>({verb:/^\s*([a-z]+)/i.exec(sql)?.[1]?.toUpperCase(),table:/\b(?:FROM|INTO|UPDATE)\s+"?([a-z0-9_]+)/i.exec(sql)?.[1],template:createHash('sha256').update(sql.replace(/\s+/g,' ').trim()).digest('hex'),assertionLabel:/ELSE '([A-Z0-9_]+)'/.exec(sql)?.[1],...(sql.includes("ELSE 'SYNC_IMMUTABLE_AUTHORITY_CHANGED'")?{operation:'SYNC_COMMIT_WINDOW_AUTHORITY_ASSERTION'}:{})});
const safe=()=>({providerConfiguration:configuration,transactionTraceEnabled:true,counts,evidence,probes,probeRuns,transactions,morningTransactions:transactions});
const server=createServer(async(req,res)=>{try{
 if(req.method==='GET'&&req.url==='/counts'){res.setHeader('content-type','application/json');res.end(JSON.stringify(safe()));return;}
 if(req.url==='/probe/start'){if(probeActive||probeStopping){res.writeHead(409).end(JSON.stringify({error:'PROBE_ALREADY_ACTIVE'}));return;}const run=probeRun={id:randomUUID(),startedAt:Date.now(),finishedAt:null};probeRuns.push(run);probeActive=true;probePromise=(async()=>{while(probeActive){const at=performance.now(),startedAt=Date.now();try{const r=await fetch('http://127.0.0.1:8081/health',{signal:AbortSignal.timeout(5000)});await r.arrayBuffer();probes.push({runId:run.id,startedAt,finishedAt:Date.now(),status:r.status,elapsedMs:performance.now()-at});}catch(e){probes.push({runId:run.id,startedAt,finishedAt:Date.now(),error:e.name,elapsedMs:performance.now()-at});}await new Promise(r=>setTimeout(r,250));}})();res.end(JSON.stringify({runId:run.id}));return;}
 if(req.url==='/probe/stop'){if(!probeStopping){const run=probeRun,loop=probePromise;probeActive=false;probeStopping=(async()=>{await loop;if(run)run.finishedAt=Date.now();})().finally(()=>{probeStopping=null;});}await probeStopping;res.end('{}');return;}
 if(req.method!=='POST'||!['/v2/pipeline','/morning/v2/pipeline'].includes(req.url)){res.writeHead(404).end();return;}
 const chunks=[];for await(const part of req)chunks.push(part);const body=JSON.parse(Buffer.concat(chunks)),httpId=++counts.httpRequests;
 const stream=streams.get(body.baton)??{id:randomUUID(),role:req.headers['x-synthetic-role']??'UNSCOPED',sql:new Map()};
 const labels=[];for(const item of body.requests){if(item.type==='store_sql')stream.sql.set(item.sql_id,item.sql);const statements=item.type==='execute'?[item.stmt]:item.type==='batch'?item.batch.steps.map(s=>s.stmt):[];labels.push(statements.map(s=>label(s.sql??stream.sql.get(s.sql_id)??'')));counts.submittedSqlStatements+=statements.length;}
 await new Promise(r=>setTimeout(r,115));const submittedAt=Date.now();
 const response=await fetch('http://127.0.0.1:18080/v2/pipeline',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 const result=await response.json(),finishedAt=Date.now();
 for(let i=0;i<body.requests.length;i++){
  const request=body.requests[i],r=result.results?.[i],statements=labels[i]??[];
  const errors=r?.type==='error'?[r.error]:r?.response?.result?.step_errors??[];
  for(const [step,error] of errors.entries()){if(!error)continue;const reason=/malformed json/i.test(error.message??'')?'JSON_ASSERTION_REJECTED':/locked|busy/i.test(error.message??'')?'LOCK':/too many|limit/i.test(error.message??'')?'ENGINE_LIMIT':/syntax|no such/i.test(error.message??'')?'SQL_CONTRACT':'OTHER';evidence.push({event:'sql_error',code:error.code,connectionId:stream.id,role:stream.role,at:finishedAt,batchStep:step,statement:statements[step],reason,messageDigest:createHash('sha256').update(error.message??'').digest('hex'),holders:[...new Set(streams.values())].filter(s=>s!==stream&&s.tx).map(s=>({connectionId:s.id,role:s.role,transactionId:s.tx.id,ageMs:submittedAt-s.tx.startedAt,last:s.tx.statements.at(-1)}))});}
  for(let j=0;j<statements.length;j++){
   const s=statements[j],successful=r?.type==='ok'&&(request.type==='execute'||r.response?.result?.step_results?.[j]!=null);
   if(s.verb==='BEGIN'&&successful)stream.tx={id:randomUUID(),connectionId:stream.id,role:stream.role,startedAt:submittedAt,beginAcknowledgedAt:finishedAt,sqlOperations:0,http:new Set(),statements:[]};
   if(successful)counts.observedExecutedSqlStatements++;const tx=stream.tx;if(tx){tx.http.add(httpId);tx.sqlOperations++;tx.statements.push({...s,submittedAt,finishedAt});tx.lastStatementAt=finishedAt;}
   if(tx&&['COMMIT','ROLLBACK'].includes(s.verb)&&successful){const {http,...plain}=tx;transactions.push({...plain,httpOperations:http.size,finishedAt,outcome:s.verb==='COMMIT'?'COMMITTED':'ROLLED_BACK',durationMs:finishedAt-tx.startedAt});stream.tx=null;}
  }
  if(request.type==='close'&&r?.type==='ok'&&stream.tx){const {http,...plain}=stream.tx;transactions.push({...plain,httpOperations:http.size,finishedAt,outcome:'STREAM_CLOSED_ROLLBACK'});stream.tx=null;}
 }
 if(body.baton)streams.delete(body.baton);if(result.baton)streams.set(result.baton,stream);
 res.writeHead(response.status,{'content-type':'application/json'});res.end(JSON.stringify(result));
 }catch(e){evidence.push({event:'proxy_error',code:e.code??e.name});res.writeHead(500).end(JSON.stringify({error:e.code??e.name}));}});
server.listen(18081,'127.0.0.1');console.log('SYNTHETIC_HRANA_READY');
process.on('SIGTERM',()=>{probeActive=false;server.close(async()=>{await writeFile('/qualification/provider-summary.json',JSON.stringify(safe()));process.exit(0);});});
