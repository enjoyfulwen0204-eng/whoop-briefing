// Bounded test observations only. No SQL, response or application deadline edits.
import {createHash,randomUUID} from 'node:crypto';
export const sqlLabel=sql=>({verb:/^\s*([a-z]+)/i.exec(sql)?.[1]?.toUpperCase(),table:/\b(?:FROM|INTO|UPDATE)\s+"?([a-z0-9_]+)/i.exec(sql)?.[1],template:createHash('sha256').update(sql.replace(/\s+/g,' ').trim()).digest('hex'),assertionLabel:/ELSE '([A-Z0-9_]+)'/.exec(sql)?.[1],...(sql.includes("ELSE 'SYNC_IMMUTABLE_AUTHORITY_CHANGED'")?{operation:'SYNC_COMMIT_WINDOW_AUTHORITY_ASSERTION'}:{})});
export function createTraceHistory({maxStatements=16384,maxTransactions=512,maxDurations=500000}={}){
 for(const n of [maxStatements,maxTransactions,maxDurations])if(!Number.isSafeInteger(n)||n<1)throw Error('TRACE_BOUNDS_REQUIRED');
 const runId=randomUUID(),transactions=[],times=new Map();let total=0,retainedStatements=0,truncated=false;
 const add=tx=>{
  if(total>=maxDurations)throw Error('SYNTHETIC_TRACE_DURATION_BOUND');
  total++;const values=times.get(tx.outcome)??[];values.push(tx.durationMs??tx.finishedAt-tx.startedAt);times.set(tx.outcome,values);
  const count=tx.statements.length,entry={...tx,sequence:total,statementCount:count};
  if(count>maxStatements){entry.statements=tx.statements.slice(-maxStatements);entry.statementsTruncated=true;truncated=true;}
  transactions.push(entry);retainedStatements+=entry.statements.length;
  while(transactions.length>maxTransactions||retainedStatements>maxStatements){retainedStatements-=transactions.shift().statements.length;truncated=true;}
 };
 const snapshot=()=>({traceRunId:runId,totalTransactions:total,traceHistoryComplete:!truncated,retainedStatementCount:retainedStatements,firstRetainedSequence:transactions[0]?.sequence??null,traceBounds:{maxStatements,maxTransactions,maxDurations},transactionStatistics:Object.fromEntries([...times].map(([kind,values])=>{const sorted=[...values].sort((a,b)=>a-b);return[kind,{count:values.length,p50Ms:sorted[Math.ceil(sorted.length*.5)-1],p95Ms:sorted[Math.ceil(sorted.length*.95)-1],maxMs:sorted.at(-1)}];})),transactions});
 return {add,snapshot};
}
