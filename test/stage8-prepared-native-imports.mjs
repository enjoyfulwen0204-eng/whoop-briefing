// Static import/re-export graph only. Source is compiled, never evaluated;
// neither a client nor an application factory is instantiated by preflight.
import {SourceTextModule} from 'node:vm';
import {readFileSync,existsSync} from 'node:fs';
import {resolve,dirname,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
export function nativeImportGraph(root,entry){
 const seen=new Set();
 const visit=path=>{
  assert.ok(!relative(root,path).startsWith('..'),'IMPORT_ESCAPES_SOURCE_ROOT');if(seen.has(path))return;seen.add(path);
  assert.ok(existsSync(path),'MISSING_STATIC_DEPENDENCY:'+relative(root,path));
  const module=new SourceTextModule(readFileSync(path,'utf8'),{identifier:path});
  for(const specifier of module.dependencySpecifiers)if(specifier.startsWith('.'))visit(resolve(dirname(path),specifier));
 };
 visit(resolve(root,entry));return [...seen].map(p=>relative(root,p)).sort();
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 assert.equal(process.argv.length,4);const files=nativeImportGraph(resolve(process.argv[2]),process.argv[3]);
 console.log(JSON.stringify({status:'STATIC_IMPORT_GRAPH_COMPLETE_NOT_EVALUATED',modules:files.length}));
}
