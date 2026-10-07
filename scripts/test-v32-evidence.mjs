/** Local synthetic test evidence only. Never loads application configuration. */
import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const hash=value=>createHash('sha256').update(value).digest('hex');
const readJson=file=>JSON.parse(fs.readFileSync(file,'utf8'));
function logEvidence(log){
 if(!log||!fs.existsSync(log))return {logAvailable:false};
 const text=fs.readFileSync(log,'utf8'),measurements=[];
 for(const line of text.split('\n')){try{const value=JSON.parse(line.replace(/^# /,''));if(value.measurement)measurements.push(value);}catch{}}
 return {logAvailable:true,logSha256:hash(text),caseNames:[...text.matchAll(/^\s*# Subtest: (.+)$/gm)].map(m=>m[1]),measurements,
  nativeSigsegv:/SIGSEGV/.test(text),eperm:/\bEPERM\b/.test(text)};
}
const attempts=[];
for(const directory of fs.readdirSync('tmp').filter(name=>name.startsWith('v32-')).sort()){
 for(const name of ['results.json','outcome.json','stage5-repetitions.json']){
  const file=path.join('tmp',directory,name);if(!fs.existsSync(file))continue;
  const data=readJson(file);
  for(const row of Array.isArray(data)?data:[data]){
   const detail=logEvidence(row.log);
   attempts.push({run:directory,...row,...detail,
    classification:row.classification??(row.timedOut?'TIMEOUT':row.code===0?'PASS':detail.nativeSigsegv?'NATIVE_SIGSEGV':'FAIL')});
  }
 }
}
const manifest=readJson('docs/phase4-v32-evidence/relevant-files.json');
const candidates=attempts.filter(row=>row.file&&(row.run.startsWith('v32-final-')||['v32-serial-recheck','v32-broad-0','v32-broad-1','v32-broad-2'].includes(row.run)));
const priority=run=>run==='v32-final-authority-recheck'?6:run==='v32-final-deadline-recheck'?5:run==='v32-final-fixture-corrections'?4:run==='v32-final-focused'?3:run==='v32-serial-recheck'?2:1;
const selected=manifest.map(file=>candidates.filter(row=>row.file===file).sort((a,b)=>priority(b.run)-priority(a.run))[0]??{file,classification:'NOT_RUN'});
const total=rows=>({files:rows.length,tests:rows.reduce((n,r)=>n+(r.tests??0),0),pass:rows.reduce((n,r)=>n+(r.passed??0),0),
 fail:rows.reduce((n,r)=>n+(r.failed??0),0),skip:rows.reduce((n,r)=>n+(r.skipped??0),0),cancel:rows.reduce((n,r)=>n+(r.cancelled??0),0),
 classifications:rows.reduce((counts,row)=>(counts[row.classification]=(counts[row.classification]??0)+1,counts),{})});
const repetitions=attempts.filter(row=>row.run==='v32-stage5-release-stability');
execFileSync('git',['diff','--check']);
const result={node:process.version,npm:execFileSync('npm',['--version'],{encoding:'utf8'}).trim(),startingHead:'6eabd67ef3c99604db975014b3f65e13053f0fee',schema:32,
 staticChecks:{javascript:readJson('tmp/v32-static-js.json'),yamlShell:readJson('tmp/v32-static-yaml.json'),diffCheck:'PASS'},
 retainedHistoricalLedgers:['docs/phase4-vietnam-stage2-tests.json','docs/phase4-vietnam-stage2-round2-tests.json','docs/phase4-v32-evidence/round3/round3-evidence.json'],
 initialBroad:total(attempts.filter(row=>/^v32-broad-[012]$/.test(row.run))),
 selected:total(selected),selectedFiles:selected,stage5FinalRepetitions:{count:repetitions.length,pass:repetitions.filter(r=>r.classification==='PASS').length,
  complete:repetitions.length===20&&repetitions.every(r=>r.classification==='PASS')},
 historicalNonpass:attempts.filter(row=>row.classification!=='PASS'),attempts};
fs.writeFileSync('docs/phase4-v32-tests.json',JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({selected:result.selected,stage5FinalRepetitions:result.stage5FinalRepetitions,initialBroad:result.initialBroad}));
