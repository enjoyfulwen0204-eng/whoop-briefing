import test from 'node:test';
import assert from 'node:assert/strict';
import {buildFragmentCatalogue,renderFragments,validatePlan} from '../src/narrativePlan.js';
import {renderDaily,renderWhatChanged} from '../src/format.js';
import {t} from '../src/localization.js';
const metric=(key,value,baseline,severity='green')=>({key,value,baseline,severity,available:true,display:String(value),baselineDisplay:String(baseline),emoji:'🔹'});
for(const locale of ['zh-TW','en','vi']){
 test(`${locale}: daily intensity is Recovery-only; low sleep gets separate required advice`,()=>{
  for(const [value,color] of [[95,'Green'],[67,'Green'],[66,'Yellow'],[34,'Yellow'],[33,'Red'],[0,'Red']]){
   const b={stage:'full',metrics:[metric('recovery_score',value,65),metric('slow_wave',65,95,'red'),metric('rem',63,90,'yellow')]};
   const c=buildFragmentCatalogue(b,{locale});
   assert.equal(c.fragments.find(f=>f.id==='f_advice').text,t(locale,'narrative.recovery'+color));
   const sleep=c.fragments.find(f=>f.id==='f_sleep_advice');assert.ok(sleep.required);assert.ok(sleep.text.includes(t(locale,'metric.slow_wave')));assert.ok(sleep.text.includes('REM'));
   assert.equal(validatePlan(c,c.defaultOrder).ok,true);assert.equal(validatePlan(c,c.defaultOrder.filter(id=>id!=='f_sleep_advice')).ok,false);
  }
  const b={stage:'full',metrics:[metric('recovery_score',95,65),metric('slow_wave',100,90)]};
  assert.equal(buildFragmentCatalogue(b,{locale}).fragments.some(f=>f.id==='f_sleep_advice'),false);
  const weekly=buildFragmentCatalogue({...b,metrics:[...b.metrics,metric('rem',50,90,'red')]},{locale,period:'weekly'});
  assert.equal(weekly.fragments.find(f=>f.id==='f_advice').text,t(locale,'narrative.ease',{when:t(locale,'narrative.thisWeek')}));
 });
 test(`${locale}: concerning/favorable directions separated, each capped at two, no statistical notation`,()=>{
  const changes=[['hrv',73,62,2.8],['rhr',48,-20,-2.4],['recovery',95,30,2.3],['deep_sleep',3900000,-34,-1.9],['rem_sleep',3780000,-30,-1.6]].map(([metric,current,vs_30d_pct,z_score])=>({metric,current,vs_30d_pct,z_score}));
  const lines=renderWhatChanged(changes,locale);const boundary=lines.indexOf(t(locale,'daily.brightHead'));
  assert.equal(boundary,3);assert.equal(lines.length,6);
  assert.ok(lines[1].includes('😴'));assert.ok(lines[2].includes('🧠'));assert.ok(lines[4].includes('❤️'));assert.ok(lines[5].includes('💓'));assert.doesNotMatch(lines.join('\n'),/z=|2\.8/);
  assert.equal(renderWhatChanged(changes.slice(3),locale).includes(t(locale,'daily.brightHead')),false);
  assert.equal(renderWhatChanged(changes.slice(0,3),locale).includes(t(locale,'daily.changeHead')),false);
  const b={stage:'full',sampleCount:30,healthDate:'2026-11-04',metrics:[metric('recovery_score',95,65)],trends:{alerts:[]}};
  const before=renderDaily(b,null,{locale});const after=renderDaily({...b,whatChanged:changes},null,{locale});
  assert.equal(after.split(t(locale,'daily.changeHead'))[0].trim(),before.split('—')[0].trim());
 });
}
test('calibrating/missing Recovery never borrows sleep severity to assert activity intensity',()=>{
 const c=buildFragmentCatalogue({stage:'full',metrics:[{...metric('recovery_score',95,65),calibrating:true},metric('slow_wave',50,90,'red')]});
 assert.equal(c.fragments.find(f=>f.id==='f_advice').text,t('zh-TW','narrative.maintain'));
 const cold=buildFragmentCatalogue({stage:'cold',metrics:[metric('recovery_score',95,65)]});assert.ok(renderFragments(cold,cold.defaultOrder).includes(t('zh-TW','narrative.recoveryGreen')));
});
