// Real process interruption; only explicitly named local synthetic receiver file.
import {readFileSync,writeFileSync,realpathSync} from 'node:fs';import {hranaTransport} from './hranaTransport.js';
import {fixtureKeys} from './localDb.js';import {withDurableExecution} from '../src/phase4ExecutionContext.js';
import {createExecutionBudget,withExecutionBudget} from '../src/executionBudget.js';
import {isolatedPublicationClient,prepareIsolatedUnit,publishIsolatedUnit} from './stage6ShortTransactionPrototype.mjs';
import {tmpdir} from 'node:os';import {basename,dirname,sep} from 'node:path';import {fileURLToPath} from 'node:url';
const input=JSON.parse(readFileSync(process.argv[2],'utf8'));
const path=realpathSync(fileURLToPath(input.url));
if(!path.startsWith(realpathSync(tmpdir())+sep)||!basename(dirname(path)).startsWith('whoop-stage6-residual-')||basename(path)!=='fixture.sqlite'||input.synthetic!==true)throw Error('SYNTHETIC_CRASH_ONLY');
const transport=hranaTransport(input.url,{transactionMaxMs:5000}),client=isolatedPublicationClient(async r=>{await new Promise(resolve=>setTimeout(resolve,115));return transport.fetch(r);}),budget=createExecutionBudget({budgetMs:30000}),context={claim:input.owner,keys:fixtureKeys,pending:new Set(),authority:{assert:()=>budget.assert()}};
try{await withDurableExecution(context,()=>withExecutionBudget(budget,()=>budget.run(async()=>{
 const plan=await prepareIsolatedUnit({client});
 if(input.point==='before-publication'){writeFileSync(input.marker,JSON.stringify({synthetic:true,point:input.point,result:plan.result}));process.kill(process.pid,'SIGKILL');}
 transport.arm({matchSql:/INSERT INTO phase4_operation_receipts/,after:async()=>{writeFileSync(input.marker,JSON.stringify({synthetic:true,point:'after-durable-commit',result:plan.result}));process.kill(process.pid,'SIGKILL');}});
 await publishIsolatedUnit(client,plan);throw Error('CRASH_BOUNDARY_NOT_REACHED');
})));}finally{budget.close();client.close();transport.close();}
