import test from 'node:test';import assert from 'node:assert/strict';
import {createBodyEnergyLivePresentation} from '../src/bodyEnergyLivePresentation.js';
import {BODY_ENERGY_RELEASE_CRITERIA as CRITERIA} from '../src/bodyEnergyReleaseCriteria.js';

// Isolated scope dependency fixture tests the bridge's clock linkage, never a
// producer, persistence, publication receipt or Production availability claim.
function fixture({duringOpen=false}={}){
 let at=new Date('2026-10-16T23:59:59.900Z'),reads=0;const scope={permitted:true,userId:'a',toDate:'2026-10-16',timezone:'UTC',locale:'en'};
 const view={status:'AVAILABLE',presentationPolicy:null,healthDate:scope.toDate,asOfUtc:at.toISOString(),timezone:'UTC',wakeAtUtc:at.toISOString(),value:50,quality:'AVAILABLE',confidence:1,algorithm:CRITERIA.algorithm,constantsHash:CRITERIA.constantsHash,drivers:{initialCharge:50,timeDepletion:0,loadDepletion:0,napRecharge:0},provenance:{included:{mainSleepId:'s',recoverySleepId:'s',hrvBaselineCount:30,rhrBaselineCount:30,loadKind:'CYCLE',loadIds:[],napIds:[]},sources:[],excluded:[],reasons:[]}};
 const scopes={open:async()=>{if(duringOpen)at=new Date('2026-10-17T00:00:00.100Z');return scope;},derived:async()=>{reads++;return {status:'CURRENT',items:[{presentation:view}]};},assert:async()=>{},sealReply:async(_scope,reply)=>reply,verifyReply:async()=>true};
 const app=createBodyEnergyLivePresentation({scopes,db:{getUser:async()=>({timezone:'UTC'}),getOnboarding:async()=>({state:'READY'})},bodyEnergy:{assertReadPolicy:async()=>({presentationPolicy:null})},now:()=>new Date(at)});
 return {app,actor:{user:{id:'a'},chatId:'123',text:'/energy'},reads:()=>reads,midnight:()=>{at=new Date('2026-10-17T00:00:00.100Z');}};
}
test('midnight during scope opening rejects the old health day before any numeric derived read',async()=>{
 const f=fixture({duringOpen:true});await assert.rejects(f.app.query(f.actor),/BODY_ENERGY_LIVE_DATE_CHANGED/);assert.equal(f.reads(),0);
});
test('a reply sealed just before midnight cannot be sent in the next health day',async()=>{
 const f=fixture(),reply=await f.app.query(f.actor);assert.match(reply.text,/50\/100/);assert.equal(await f.app.verifyReply({userId:'a',reply}),true);
 f.midnight();assert.equal(await f.app.verifyReply({userId:'a',reply}),false);
});
