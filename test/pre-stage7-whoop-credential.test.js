import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {deliveryFixture,fixtureKeys} from './deliveryDefaultFixture.js';import {claimPhaseRequest,canonicalPhaseRequest} from '../src/phase4ExecutionStore.js';import {runningReleaseSha} from '../src/phase4Release.js';
import {withDurableExecution} from '../src/phase4ExecutionContext.js';import {createExecutionBudget,withExecutionBudget} from '../src/executionBudget.js';import {createWhoopClient} from '../src/whoop.js';import {createSync} from '../src/sync.js';
async function fixture(t){
 const {db}=await deliveryFixture(t),uid='alice';await db.createUser({id:uid,displayName:'Alice',status:'ACTIVE',timezone:'Asia/Taipei'});await db.getCapabilities(uid);
 const tokens={accessToken:'synthetic-epoch-one',refreshToken:'synthetic-refresh-one',expiresAt:new Date(Date.now()+3600000),whoopUserId:'12345'};await db.saveTokens(uid,tokens);
 const bump=()=>db.saveTokens(uid,{...tokens,accessToken:'synthetic-epoch-two',refreshToken:'synthetic-refresh-two'},{bumpAuthGeneration:true,expectedLifecycleGeneration:1});
 const r={requestId:randomUUID(),releaseSha:runningReleaseSha(),phase:'SYNC',triggerSource:'cloudflare',executionMode:'OFF',configProof:'a'.repeat(64)},claim=await claimPhaseRequest(db,r,canonicalPhaseRequest(r));
 const authority=createExecutionBudget({budgetMs:10000});t.after(()=>authority.close());
 const run=fn=>withDurableExecution({claim,keys:fixtureKeys,pending:new Set(),authority},()=>withExecutionBudget(authority,fn));
 const make=options=>createWhoopClient({db,userId:uid,clientId:'synthetic',clientSecret:'synthetic',expectedLifecycleGeneration:1,sleepImpl:async()=>{},...options});
 return {db,uid,tokens,bump,run,make};
}
test('reauthorization before input capture rejects a prewarmed real-client credential and persists zero health',async t=>{
 const {db,uid,bump,run,make}=await fixture(t);let requests=0;
 const whoop=make({fetchImpl:async()=>{requests++;return new Response(JSON.stringify({height_meter:1.7,weight_kilogram:70}));}});
 await whoop.getAccessToken();await bump();
 const result=await run(()=>createSync({db,whoop,userId:uid,timezone:'Asia/Taipei',expectedLifecycleGeneration:1}).syncAll({force:true,resources:['body_measurement']}));
 assert.equal(result.outcome,'AUTH_FAILED');assert.equal(requests,0);assert.equal((await db.raw.execute('SELECT count(*) n FROM whoop_body_measurements')).rows[0].n,0);
});
for(const kind of ['retry','pagination','late-body'])test(`real-client ${kind} cannot accept or resend an obsolete credential`,async t=>{
 const {bump,run,make}=await fixture(t);let requests=0;
 const whoop=make({fetchImpl:async()=>{requests++;await bump();return kind==='retry'?new Response('{}',{status:500}):new Response(JSON.stringify(kind==='pagination'?{records:[],next_token:'next'}:{height_meter:1.7,weight_kilogram:70}));}});
 await whoop.getAccessToken();
 await assert.rejects(()=>run(()=>kind==='pagination'?whoop.sleeps(new Date(Date.now()-86400000),new Date()):whoop.bodyMeasurement()),e=>e.code==='STALE_AUTHORIZATION');
 assert.equal(requests,1);
});
for(const kind of ['before-refresh','during-refresh','peer-adoption'])test(`real-client ${kind} retains the current authorization and issues no later WHOOP observation`,async t=>{
 const {db,uid,tokens,bump,run,make}=await fixture(t);let refresh=0,observations=0;
 await db.saveTokens(uid,{...tokens,expiresAt:new Date(Date.now()-1)});const authorization=await db.getTokens(uid);
 const whoop=make({authorization,fetchImpl:async url=>{if(url.includes('/oauth')){refresh++;await bump();return new Response(JSON.stringify({access_token:'synthetic-returned-old-epoch',refresh_token:'synthetic-returned-refresh',expires_in:3600}));}observations++;return new Response('{}');},sleepImpl:async()=>{if(kind==='peer-adoption')await bump();}});
 if(kind==='before-refresh')await bump();
 if(kind==='peer-adoption')db.acquireLock=async()=>null;
 await assert.rejects(()=>run(()=>whoop.bodyMeasurement()),e=>e.code==='STALE_AUTHORIZATION');
 assert.equal(observations,0);assert.equal(refresh,kind==='during-refresh'?1:0);
 const current=await db.getTokens(uid);assert.equal(current.authGeneration,2);assert.equal(current.accessToken,'synthetic-epoch-two');
});
test('valid cached authorization still performs and persists a real-client observation',async t=>{
 const {db,uid,run,make}=await fixture(t);let requests=0;
 const whoop=make({fetchImpl:async(_url,init)=>{requests++;assert.equal(init.headers.Authorization,'Bearer synthetic-epoch-one');return new Response(JSON.stringify({height_meter:1.7,weight_kilogram:70}));}});
 await whoop.getAccessToken();
 const result=await run(()=>createSync({db,whoop,userId:uid,timezone:'Asia/Taipei',expectedLifecycleGeneration:1}).syncAll({force:true,resources:['body_measurement']}));
 assert.equal(result.resources[0].status,'ok');assert.equal(requests,1);assert.equal((await db.raw.execute('SELECT count(*) n FROM whoop_body_measurements')).rows[0].n,1);
});
