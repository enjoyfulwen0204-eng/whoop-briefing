import {createDb} from '../src/db.js';import {fixtureKeys} from './localDb.js';import {hranaTransport} from './hranaTransport.js';
import {runExecutionPhase} from '../src/phase4Execution.js';
const transport=hranaTransport(process.argv[2]);const db=createDb({url:'https://isolated.invalid',phase4Keys:fixtureKeys,fetch:transport.fetch});
const request=JSON.parse(process.argv[3]);
await runExecutionPhase({request,db,keys:fixtureKeys,environment:{PHASE4_BETA_SHADOW_RUNTIME:'off',PHASE4_PUBLIC_BETA_MODE:'off'},env:{dryRun:true},budgetMs:1500,overallBudgetMs:2500,
 deps:{runBriefing:async()=>{await db.updateUser('alice',{displayName:'Committed'});process.send({event:'committed'});await new Promise(()=>{});}}});
