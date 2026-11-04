// Conservative, dependency-free graph: every literal JS path is an edge,
// including new URL child entry points and test/CLI references. Dynamic paths
// are deliberately not proof of dead code; retain uncertain modules.
import {execFileSync} from 'node:child_process';
import {readFileSync,existsSync} from 'node:fs';
import {dirname,normalize,join} from 'node:path';
import {createHash} from 'node:crypto';
const roots=['src/recoveryEntry.js','cloudflare/briefing-scheduler/worker.js'];
const baseline=process.argv[2]??'3cc6e1f2bf0a290d22e63714591fb3d3f50e6cfb';
if(!/^[a-f0-9]{40}$/.test(baseline))throw Error('EXACT_BASE_REQUIRED');
const original=execFileSync('git',['ls-tree','-r','--name-only',baseline],{encoding:'utf8'}).trim().split('\n');
const files=original.filter(f=>/\.(js|mjs|cjs)$/.test(f));
function graph(at){
 const text=new Map(),edges=new Map();
 for(const f of files){if(!at&&!existsSync(f))continue;text.set(f,at?execFileSync('git',['show',at+':'+f],{encoding:'utf8'}):readFileSync(f,'utf8'));}
 for(const [f,s] of text){const e=new Set();for(const [,p] of s.matchAll(/['"`]([^'"`\n]+\.(?:js|mjs|cjs))['"`]/g))for(const target of [normalize(join(dirname(f),p)),p])if(text.has(target))e.add(target);edges.set(f,e);}
 const reachable=new Set(),todo=[...roots];while(todo.length){const f=todo.pop();if(reachable.has(f))continue;reachable.add(f);todo.push(...edges.get(f)??[]);}
 return {text,reachable};
}
const before=graph(baseline),after=graph(null),hash=s=>createHash('sha256').update(s).digest('hex');
const lost=[...before.reachable].filter(f=>!after.reachable.has(f));
const changed=[...before.reachable].filter(f=>hash(before.text.get(f))!==hash(after.text.get(f)??''));
const removed=files.filter(f=>f.startsWith('src/')&&!after.text.has(f));
console.log(JSON.stringify({baseline,productionRoots:roots,reachableBefore:before.reachable.size,reachableAfter:after.reachable.size,lost,changed,removed},null,2));
if(lost.length||changed.length)process.exitCode=1;
