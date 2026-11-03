import test from 'node:test';import assert from 'node:assert/strict';
import {PREDICTION_QUALITY_POLICY,qualifyModel} from '../src/predictionPolicy.js';
import {evaluateEvening,predictionDue,recentAccuracy,renderEveningPrediction,notifyPrediction} from '../src/predictionNotification.js';
import {trainableRows,unpredictableRows} from './predictionFixtures.js';import {fakeDb} from './fakes.js';
import {withExecutionBudget} from '../src/executionBudget.js';
import {runPredictionCycle} from '../src/predictionPipeline.js';
import {handlePredictions} from '../src/bot/commands.js';
const good={ok:true,n_test:20,mae:4,baseline_mae:8,beats_baseline:true,r2:null,interval_coverage:null};
test('only explicit BEATS_BASELINE_ONLY skips null gates; baseline and test-size checks remain',()=>{
 assert.equal(PREDICTION_QUALITY_POLICY.QUALIFICATION_MODE,'BEATS_BASELINE_ONLY');assert.equal(qualifyModel(good).qualified,true);
 for(const mode of [undefined,'STRICT','TYPO'])assert.equal(qualifyModel(good,{policy:{...PREDICTION_QUALITY_POLICY,QUALIFICATION_MODE:mode}}).qualified,false);
 for(const e of [{...good,beats_baseline:false},{...good,mae:9},{...good,n_test:1},{...good,mae:null},{...good,baseline_mae:null}])assert.equal(qualifyModel(e).qualified,false);
});
function predictiveRows(){const rows=trainableRows(120,{start:[2026,6,7]});for(let i=1;i<rows.length;i++)rows[i].recovery=20+rows[i-1].hrv*.5-rows[i-1].rhr*.2+rows[i-1].sleep_total/3600000;return rows;}
test('same input deterministically retrains with original pipeline and coefficient contributions only',()=>{
 const rows=predictiveRows(),day=rows.at(-1).health_date,a=evaluateEvening(rows,day),b=evaluateEvening(rows,day);
 assert.deepEqual(a,b);assert.equal(a.verdict.qualified,true);assert.ok(a.run.mae<a.run.baseline_mae);
 for(const f of a.factors)assert.equal(f.contribution,a.run.model.fit.coefficients[f.key]*a.features[f.key]);
 for(const locale of ['zh-TW','en','vi']){assert.match(renderEveningPrediction(a,null,locale),/📈/);assert.ok(renderEveningPrediction({...a,factors:[]},null,locale).split('\n').length===2);}
 assert.match(renderEveningPrediction({...a,prediction:{...a.prediction,predicted_low:null,predicted_high:null}},null,'zh-TW'),/約/);
});
test('accuracy uses only actuals from last fourteen days and needs at least five',()=>{
 const rows=Array.from({length:5},(_,i)=>({target_date:`2026-11-0${i+1}`,predicted_value:60,actual_value:68}));
 assert.equal(recentAccuracy(rows.slice(0,4),'2026-11-05'),null);assert.deepEqual(recentAccuracy(rows,'2026-11-05'),{n:5,mae:8});
 assert.equal(recentAccuracy(rows,'2026-11-25'),null);
});
test('/predictions reports the current evaluation and baseline without requiring a stored model',async()=>{
 const rows=unpredictableRows(80),verdict=evaluateEvening(rows,rows.at(-1).health_date);
 assert.equal(verdict.verdict.qualified,false);
 const db={getPredictions:async()=>[],getLatestPredictionModel:async()=>assert.fail('no stored-model substitution')};
 for(const locale of ['zh-TW','vi','en']){
  const text=await handlePredictions({db,userId:'synthetic',rows,locale});
  assert.match(text,/MAE/);assert.ok(text.includes(verdict.run.mae.toFixed(2).replace('.',locale==='vi'?',':'.')));
 }
});
function fixture(){
 const rows=predictiveRows(),day=rows.at(-1).health_date,db=fakeDb(),sent=[],saved=[];
 let at=new Date(day+'T13:10:00Z'),paused=0,quiet=false,loads=0;
 const user={id:'a',timezone:'Asia/Taipei',lifecycleGeneration:1};
 db.coverage=async()=>({last_date:day});db.getCapabilities=async()=>({});db.getPredictions=async()=>[];db.savePrediction=async(id,p)=>{saved.push(p);};
 db.raw={execute:async({sql})=>({rows:sql.includes('notifications_paused')?[{notifications_paused:paused,quiet_start:quiet?'20:00':'22:00',quiet_end:'08:00'}]:[{status:'ACTIVE',lifecycle_generation:1,timezone:user.timezone,auth_generation:1,purge_generation:0,source_generation:1,pending_purge_count:0,onboarding:'READY',connected:1,telegram_chat_id:'synthetic-chat',access_count:2}]})};
 const input={db,user,locale:'zh-TW',now:()=>at,load:async()=>{loads++;return {complete:true,rows};},telegram:{send:async(text,{authorize})=>{await authorize();sent.push(text);return {sent:true,messageId:3};}}};
 return {input,sent,saved,rows,day,get loads(){return loads;},pause:()=>{paused=1;},quiet:()=>{quiet=true;},setTime:x=>{at=new Date(x);}};
}
test('21:10 prediction persists no parameters, sends once without optional quota, repeated tick does not train',async()=>{
 const f=fixture();assert.equal((await notifyPrediction(f.input)).status,'DELIVERED');assert.equal(f.saved.length,1);assert.equal(f.sent.length,1);
 assert.equal((await notifyPrediction(f.input)).status,'ALREADY_RESERVED');assert.equal(f.loads,1);assert.ok(!('model' in f.saved[0]));
});
test('non-slot, quiet, paused, insufficient budget and unqualified model send nothing',async()=>{
 assert.equal(predictionDue(new Date('2026-11-03T13:09:59Z')),false);assert.equal(predictionDue(new Date('2026-11-03T13:10Z')),true);
 for(const setup of [f=>f.pause(),f=>f.quiet(),f=>f.setTime(f.day+'T12:10:00Z')]){const f=fixture();setup(f);await notifyPrediction(f.input);assert.equal(f.sent.length,0);assert.equal(f.loads,0);}
 const f=fixture();f.input.load=async()=>({complete:true,rows:[]});assert.equal((await notifyPrediction(f.input)).status,'MODEL_UNQUALIFIED');assert.equal(f.saved.length,0);
 const g=fixture();await withExecutionBudget({remainingMs:()=>1000},async()=>assert.equal((await notifyPrediction(g.input)).status,'DEFERRED_BUDGET'));assert.equal(g.loads,0);
});
test('lost ACK retains original claim and prediction; next tick neither retrains nor sends',async()=>{
 const f=fixture();f.input.telegram.send=async()=>{throw Error('SYNTHETIC_TIMEOUT');};assert.equal((await notifyPrediction(f.input)).status,'AMBIGUOUS');
 assert.equal((await notifyPrediction(f.input)).status,'ALREADY_RESERVED');assert.equal(f.loads,1);assert.equal(f.saved.length,1);
});
test('read-only preparation timeout never reaches prediction persistence or delivery, even after it resolves',async()=>{
 const f=fixture();let checks=0;
 f.input.load=async()=>{await new Promise(r=>setTimeout(r,30));return {complete:true,rows:f.rows};};
 await withExecutionBudget({remainingMs:()=>++checks===1?15000:8002},async()=>assert.equal((await notifyPrediction(f.input)).status,'DEFERRED_BUDGET'));
 await new Promise(r=>setTimeout(r,40));assert.equal(f.saved.length,0);assert.equal(f.sent.length,0);
});
test('night training cannot overwrite a reserved, delivered or uncertain evening prediction; actuals still backfill',async()=>{
 const rows=predictiveRows(),anchorDate=rows.at(-1).health_date;
 for(const deliveryState of ['CLAIMED','DELIVERY_STARTED','DELIVERED','AMBIGUOUS']){
  let saved=0;const db={getClaim:async()=>({deliveryState}),savePredictionModel:async()=>{},savePrediction:async()=>{saved++;},
   getPredictions:async()=>[],recordPredictionActual:async()=>{}};
  const result=await runPredictionCycle({db,userId:'synthetic',rows,anchorDate});
  assert.equal(result.modelSaved,true);assert.equal(result.predictionSaved,false);assert.equal(saved,0);assert.ok(!result.reasons.includes('cycle_error'));
 }
});
