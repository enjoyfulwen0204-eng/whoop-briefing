import test from 'node:test';import assert from 'node:assert/strict';
import {stage7Configuration} from '../src/stage7Runtime.js';
import {isApprovedStage7Three} from '../src/stage7Cohort.js';
test('explicit approved three cannot be replaced by arbitrary IDs, duplicates, blanks, or a mutable ready population',()=>{
 for(const ids of [[],['a'],['a','b'],['a','b','c'],['a','a','b'],['a','b','c','d'],[' a','b','c'],['','b','c']]){
  assert.equal(isApprovedStage7Three(ids),false);
  assert.throws(()=>stage7Configuration({STAGE7_COMPANION:'on',STAGE7_COMPANION_USER_IDS:ids.join(',')}),error=>error.code==='STAGE7_OWNER_ROLLOUT_REQUIRED'||error.name==='MissingUserIdError');
 }
 assert.equal(stage7Configuration({}).mode,'off');
 assert.deepEqual(stage7Configuration({STAGE7_COMPANION:'on',STAGE7_COMPANION_USER_IDS:'a',PHASE4_BETA_PILOT_USER_ID:'a'}).userIds,['a']);
});
