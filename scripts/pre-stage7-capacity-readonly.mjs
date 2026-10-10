#!/usr/bin/env node
// Explicit read-only provider entry. No admission or mutation claim. No secrets
// or health payloads are emitted. Platform quota must be supplied/read separately.
import {createClient} from '@libsql/client/http';import {mkdir,writeFile} from 'node:fs/promises';import path from 'node:path';
const [flag,output]=process.argv.slice(2);
if(flag!=='--remote-readonly'||!/^tmp\/[\w/-]+\.json$/.test(output??''))throw Error('EXPLICIT_READ_ONLY_OUTPUT_REQUIRED');
await mkdir(path.dirname(output),{recursive:true});
const result={observedAt:new Date().toISOString(),productionMutation:'NONE',scope:'Read-only aggregate storage and v32 metadata; no tenant payload',providerCapacity:'UNVERIFIED_PLATFORM_CAPACITY_REQUIRED'};let client;
try {process.loadEnvFile('.env');const url=process.env.TURSO_DATABASE_URL,authToken=process.env.TURSO_AUTH_TOKEN;
 if(!/^(https:|libsql:)/.test(url??'')||!authToken)throw Error('unavailable');
 client=createClient({url,authToken,fetch:request=>fetch(new Request(request,{signal:AbortSignal.timeout(10000)}))});
 for(const [key,sql] of [['schema','SELECT MAX(version) version FROM schema_version'],['check','SELECT ignore_check_constraints FROM pragma_ignore_check_constraints()'],
  ['pageCount','PRAGMA page_count'],['pageSize','PRAGMA page_size'],['freePages','PRAGMA freelist_count'],
  ['executionRows','SELECT count(*) n FROM phase4_executions'],['receiptRows','SELECT count(*) n FROM phase4_execution_work_receipts'],['producerRows','SELECT count(*) n FROM phase4_execution_producers']]) {
  try {result[key]=(await client.execute(sql)).rows.map(row=>({...row}));}catch{result[key]='READ_UNAVAILABLE';}
 }
 result.status=result.schema?.[0]?.version===32?'REMOTE_V32_METADATA_READ':'UNVERIFIED';
 // Never infer a plan limit from SQLite max_page_count or a public pricing tier.
}catch{result.status='REMOTE_READ_UNAVAILABLE';}finally{client?.close();}
await writeFile(output,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
