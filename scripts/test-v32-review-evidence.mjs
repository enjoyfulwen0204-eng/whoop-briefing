import {readFileSync,writeFileSync,readdirSync,existsSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';import {execFileSync} from 'node:child_process';
import {gzipSync} from 'node:zlib';
import path from 'node:path';
const hash=value=>createHash('sha256').update(value).digest('hex');
const files=JSON.parse(readFileSync('docs/phase4-v32-review-files.json','utf8'));
const attempts=[];
for(const dir of readdirSync('tmp').filter(name=>name.startsWith('v32-review-'))){
 const p=`tmp/${dir}/results.json`;if(!existsSync(p))continue;
 const entries=JSON.parse(readFileSync(p,'utf8'));if(!Array.isArray(entries))continue;
 for(const entry of entries){const log=readFileSync(entry.log,'utf8');attempts.push({...entry,evidenceDirectory:dir,logSha256:hash(log),
  cases:[...log.matchAll(/^# Subtest: (.+)$/gm)].map(match=>match[1])});}
}
const selected=files.map(file=>{
 const candidates=attempts.filter(entry=>entry.file===file&&/^v32-review-final-(?:broad-|corrections)/.test(entry.evidenceDirectory));
 const latest=candidates.sort((a,b)=>a.evidenceDirectory.localeCompare(b.evidenceDirectory)).at(-1);
 return latest??{file,classification:'NOT_RUN',tests:0,passed:0,failed:0};
});
const primary=attempts.filter(entry=>/^v32-review-final-broad-/.test(entry.evidenceDirectory));
const totals=entries=>({files:entries.length,tests:entries.reduce((n,e)=>n+(e.tests??0),0),passed:entries.reduce((n,e)=>n+(e.passed??0),0),
 failed:entries.reduce((n,e)=>n+(e.failed??0),0),skipped:entries.reduce((n,e)=>n+(e.skipped??0),0),cancelled:entries.reduce((n,e)=>n+(e.cancelled??0),0),
 classifications:entries.reduce((out,e)=>(out[e.classification]=(out[e.classification]??0)+1,out),{})});
const stability=JSON.parse(readFileSync('tmp/v32-review-final-stage5-stability/stage5-repetitions.json','utf8'));
const baseline=readFileSync('tmp/v32-review-baseline/findings.tap','utf8');
const measurements=attempts.filter(entry=>/performance/.test(entry.file)).flatMap(entry=>readFileSync(entry.log,'utf8').split('\n')
 .filter(line=>line.startsWith('# {"measurement"')).map(line=>({...JSON.parse(line.slice(2)),evidenceDirectory:entry.evidenceDirectory})));
const sourceFiles=execFileSync('rg',['--files','src','scripts','test','cloudflare','-g','*.js','-g','*.mjs'],{encoding:'utf8'}).trim().split('\n').sort();
const sourceHashes=Object.fromEntries(sourceFiles.map(file=>[file,hash(readFileSync(file))]));
const staticChecks=JSON.parse(readFileSync('tmp/v32-review-static/results.json','utf8'));
const archiveDirectory='docs/phase4-v32-review-evidence/logs';mkdirSync(archiveDirectory,{recursive:true});
const archiveSources=new Set(attempts.map(entry=>entry.log));
for(const dir of readdirSync('tmp',{withFileTypes:true}).filter(entry=>entry.isDirectory()&&entry.name.startsWith('v32-review-')).map(entry=>entry.name)){
 for(const file of readdirSync(`tmp/${dir}`))if(file.endsWith('.tap'))archiveSources.add(`tmp/${dir}/${file}`);
}
for(const entry of stability)archiveSources.add(path.relative(process.cwd(),entry.log));
const custody=[...archiveSources].sort().map(source=>{
 const raw=readFileSync(source),compressed=gzipSync(raw),destination=`${archiveDirectory}/${source.replaceAll('/','--')}.gz`;
 writeFileSync(destination,compressed);return {source,destination,sha256:hash(raw),gzipSha256:hash(compressed)};
});
writeFileSync('docs/phase4-v32-review-evidence/log-custody.json',JSON.stringify(custody,null,2)+'\n');
const result={schema:32,startHead:'0a8597b555b37a3945c7451d3bd7cca590809547',headAtCollection:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
 node:execFileSync('node',['--version'],{encoding:'utf8'}).trim(),npm:execFileSync('npm',['--version'],{encoding:'utf8'}).trim(),
 ready:selected.every(entry=>entry.classification==='PASS')&&stability.length===20&&stability.every(entry=>entry.code===0&&!entry.timedOut)
  &&staticChecks.javascriptFailures.length===0&&staticChecks.yaml.every(entry=>entry.code===0)&&staticChecks.shell.every(entry=>entry.code===0)&&staticChecks.diffCheck?.code===0,
 primaryBroad:totals(primary),accepted:totals(selected),selected,attempts,
 independentReproductions:{head:'0a8597b555b37a3945c7451d3bd7cca590809547',tests:9,passed:0,failed:9,logSha256:hash(baseline)},
 stage5:{repetitions:stability,cases:40,allPassed:stability.length===20&&stability.every(entry=>entry.code===0&&!entry.timedOut)},
 rc2Control:{head:'c364ea7a7586bcaafb3fccd66bc18a461643732c',tests:2,passed:2,logSha256:hash(readFileSync('tmp/v32-review-rc2-control.tap'))},
 historicalEvidence:['docs/phase4-v32-tests.json','docs/phase4-vietnam-stage2-tests.json','docs/phase4-vietnam-stage2-round2-tests.json','docs/phase4-v32-evidence/round3'],
 sourceHashes,sourceAggregateHash:hash(JSON.stringify(sourceHashes)),measurements,static:staticChecks,logCustody:'docs/phase4-v32-review-evidence/log-custody.json',
 toolingHistory:JSON.parse(readFileSync('tmp/v32-review-static/tooling-history.json','utf8')),
 production:'NOT_MEASURED; NO MUTATION',remote:'NOT_MEASURED'};
mkdirSync('docs/phase4-v32-review-evidence',{recursive:true});
writeFileSync('docs/phase4-v32-review-tests.json',JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({ready:result.ready,accepted:result.accepted,primaryBroad:result.primaryBroad,stage5:result.stage5.allPassed}));
