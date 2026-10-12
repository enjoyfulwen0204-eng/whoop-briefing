import test from 'node:test';import assert from 'node:assert/strict';
import {stage7Decision,questionUtility,counterfactualDecisionImpact,evaluateNonQuestion} from '../src/stage7DecisionPolicy.js';
const gates={tenant:true,lifecycle:true,authorization:true,paused:false,destination:true,current:true,quality:true,confidence:true,freshness:true,expectedMore:false};
const notify={material:true,novel:true,actionable:true,truthful:true,timely:true,unreserved:true,delayReducesAction:false};
const candidate={key:'registered',registered:true,current:true,known:false,open:false,sensitivity:0,components:{U:1,D:1,R:1,A:1,T:1,K:0,P:0,F:0}};
test('exact four actions, independent notification evaluation, no normal count cap or ASK downgrade',()=>{
 assert.equal(stage7Decision({metric:'hrv',gates,notification:notify,candidates:[candidate]}).action,'ASK_ONE_HIGHEST_VALUE_QUESTION');
 assert.equal(stage7Decision({metric:'hrv',gates,notification:{...notify,delayReducesAction:true},candidates:[candidate]}).action,'NOTIFY');
 assert.equal(stage7Decision({metric:'hrv',gates:{...gates,tenant:false},notification:notify}).action,'NO_NOTIFICATION');
 assert.equal(stage7Decision({metric:'hrv',gates:{...gates,quality:false,expectedMore:true},notification:notify}).action,'DEFER_OBSERVATION');
 for(let n=0;n<20;n++)assert.equal(stage7Decision({metric:'hrv',gates,notification:notify,previousCount:n}).action,'NOTIFY');
 assert.equal(stage7Decision({metric:'body_energy',gates,notification:notify}).action,'NO_NOTIFICATION');
 assert.equal(stage7Decision({metric:'hrv',gates,notification:{...notify,truthful:false},candidates:[{...candidate,known:true}]}).action,'NO_NOTIFICATION');
 assert.equal(questionUtility({...candidate.components,U:null}),null);
 const decision=stage7Decision({metric:'hrv',gates,notification:notify,candidates:[candidate]});assert.throws(()=>{decision.action='NOTIFY';});
});
test('counterfactual first-match D has all five outcomes and calls no evaluator recursively',()=>{
 const b={action:'NO_NOTIFICATION',evidence_eligibility:'CANDIDATE',episode_explained_status:'UNEXPLAINED'};
 for(const [YES,NO,UNKNOWN,D] of [[{...b,action:'NOTIFY'},b,b,1],[b,b,{...b,action:'NOTIFY'},.75],[b,{...b,episode_explained_status:'EXPLAINED'},b,.5],[b,b,{...b,evidence_eligibility:'INELIGIBLE'},.25],[b,b,b,0]])assert.equal(counterfactualDecisionImpact({YES,NO,UNKNOWN}),D);
 assert.throws(()=>counterfactualDecisionImpact({YES:{...b,action:'ASK_ONE_HIGHEST_VALUE_QUESTION'},NO:b,UNKNOWN:b}));
 const snapshot={valid:true,current:true,qualityReady:true,expectedMore:false,material:true,novel:true,actionable:true,truthful:true,timely:true};const copy=structuredClone(snapshot);evaluateNonQuestion(snapshot);assert.deepEqual(snapshot,copy);
});
