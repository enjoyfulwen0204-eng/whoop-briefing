import {types as nativeTypes} from 'node:util';
// PRIVATE UNQUALIFIED PROPOSAL. DATA effects only; never an admission, guard,
// receipt, reference, or successful business result. Not wired into a runtime.
export const RAW_SOURCE_TABLES=Object.freeze(['whoop_sleeps','whoop_recoveries','whoop_cycles','whoop_workouts']);
export const RAW_EFFECT_CATALOG_DIGEST='9ab16b472dd0c325338e54ad2d53dab9ad8c73463b1bdc9464800787e7407695';
export const RAW_EFFECT_CATALOG_LIMITS=Object.freeze({rows:2048,bytes:4*1024*1024});
const raw=new Set(RAW_SOURCE_TABLES);
// This is deliberately a smaller language than SQLite. Unsupported syntax
// closes the optional DATA lifetime; the original execution still decides the
// statement's outcome. No parser result authorizes SQL or suppresses a fence.
const functions=new Set(['ABS','AVG','CAST','COALESCE','COUNT','DATE','DATETIME','IFNULL','INSTR',
 'JSON_ARRAY','JSON_ARRAY_LENGTH','JSON_EACH','JSON_EXTRACT','JSON_TYPE','JSON_VALID','JULIANDAY','LENGTH',
 'LOWER','MAX','MIN','NULLIF','REPLACE','ROUND','STRFTIME','SUBSTR','SUM','TIME','TOTAL','TRIM',
 'TYPEOF','UNICODE','UNIXEPOCH','UPPER']);
const forbidden=new Set(['INSERT','UPDATE','DELETE','REPLACE','CREATE','ALTER','DROP','ATTACH',
 'DETACH','VACUUM','REINDEX','ANALYZE','SAVEPOINT','RELEASE','ROLLBACK','COMMIT','BEGIN',
 'PRAGMA','RETURNING','SELECT','WITH','LOAD_EXTENSION']);
function tokens(sql){
 if(typeof sql!=='string'||Buffer.byteLength(sql,'utf8')>8192)return null;
 const result=[];
 for(let i=0;i<sql.length;){
  const c=sql[i];if(/\s/.test(c)){i++;continue;}
  if(c===';'||sql.startsWith('--',i)||sql.startsWith('/*',i)||['"','`','['].includes(c))return null;
  if(c==="'"){
   let closed=false;i++;
   while(i<sql.length){if(sql[i++]==="'"){if(sql[i]==="'"){i++;continue;}closed=true;break;}}
   if(!closed)return null;result.push({kind:'atom'});continue;
  }
  const word=/^[a-z_][a-z0-9_]*/i.exec(sql.slice(i));
  if(word){result.push({kind:'word',value:word[0].toUpperCase()});i+=word[0].length;continue;}
  const number=/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i.exec(sql.slice(i));
  if(number){result.push({kind:'atom'});i+=number[0].length;continue;}
  if('?,().=<>!+-*/%|&'.includes(c)){result.push({kind:c==='?'?'atom':'punct',value:c});i++;continue;}
  return null;
 }
 return result;
}
// Snapshot only inert, bounded, scalar statement arguments. Unsupported objects
// disable the optional DATA lifetime; they never acquire new SQL authority.
export function rawEffectSubmissionArguments(method,args){
 try{
  if(!Array.isArray(args)||args.length!==1)return null;
  const scalar=v=>v===null||['string','boolean','bigint'].includes(typeof v)||typeof v==='number'&&Number.isFinite(v);
  const array=(value,limit,copy)=>{
   if(!value||nativeTypes.isProxy(value)||!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype)return null;
   const ds=Object.getOwnPropertyDescriptors(value),length=ds.length?.value;
   if(!Number.isSafeInteger(length)||length>limit||Reflect.ownKeys(ds).length!==length+1)return null;
   const out=[];for(let n=0;n<length;n++){
    const d=ds[n];if(!d||!Object.hasOwn(d,'value'))return null;
    const v=copy(d.value);if(v===undefined)return null;out.push(v);
   }return Object.freeze(out);
  };
  let bytes=0;
  const statement=value=>{
   if(typeof value==='string'){bytes+=Buffer.byteLength(value);return bytes<=1048576&&Buffer.byteLength(value)<=8192?value:undefined;}
   if(!value||typeof value!=='object'||nativeTypes.isProxy(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))return undefined;
   const ds=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(ds);
   if(keys.some(k=>!['sql','args'].includes(k))||typeof ds.sql?.value!=='string'||!Object.hasOwn(ds.sql,'value')||Buffer.byteLength(ds.sql.value)>8192)return undefined;
   bytes+=Buffer.byteLength(ds.sql.value);
   const out={sql:ds.sql.value};
   if(ds.args){if(!Object.hasOwn(ds.args,'value'))return undefined;
    const values=array(ds.args.value,1024,v=>{if(!scalar(v))return undefined;bytes+=typeof v==='string'?Buffer.byteLength(v):16;return v;});
    if(!values)return undefined;out.args=values;
   }
   return bytes<=1048576?Object.freeze(out):undefined;
  };
  if(method==='execute'){const value=statement(args[0]);return value===undefined?null:Object.freeze([value]);}
  if(method==='batch'){const values=array(args[0],256,statement);return values?Object.freeze([values]):null;}
  return null;
 }catch{return null;}
}
// Deliberately small relation grammar. Every nested/compound SELECT is scanned.
// Bare unknown names may resolve to eponymous modules, so absence from the actual
// catalog is never evidence that invocation is harmless.
export function closedRawReadRelations(list,canonicalTables,{expected=false}={}){
 let depth=0;const from=new Set(),ends=new Set(['WHERE','GROUP','HAVING','ORDER','LIMIT','UNION','INTERSECT','EXCEPT','RETURNING']);
 for(let n=0;n<list.length;n++){
  const value=list[n].value;
  if(value==='('){depth++;continue;}
  if(value===')'){from.delete(depth);if(--depth<0)return false;continue;}
  if(value===';'){from.clear();continue;}
  if(ends.has(value))from.delete(depth);
  if(value===','&&from.has(depth))return false;
  if(value==='INDEXED'||value==='NOT'&&list[n+1]?.value==='INDEXED')return false;
  // SQLite also permits expr IN table_name as relation invocation. Only the
  // already parsed parenthesized expression/subquery form is supported.
  if(value==='IN'&&list[n+1]?.value!=='(')return false;
  if(value!=='FROM'&&value!=='JOIN')continue;
  from.add(depth);const next=list[n+1];
  if(next?.value==='('){if(list[n+2]?.value!=='SELECT')return false;continue;}
  if(next?.kind!=='word')return false;
  const name=next.value.toLowerCase(),call=list[n+2]?.value==='(';
  if(list[n+2]?.value==='.')return false;
  if(call){if(next.value!=='JSON_EACH')return false;}
  else if(!canonicalTables.has(name)&&!(expected&&name==='expected'))return false;
 }
 return depth===0;
}
function readExpression(list,canonicalTables,expected=false){
 if(!closedRawReadRelations(list,canonicalTables,{expected}))return false;
 for(let i=0;i<list.length;i++){
  const token=list[i];
  if(list[i+1]?.value==='('&&(token.kind==='atom'||token.value===')'))return false;
  if(token.kind!=='word')continue;
  if(forbidden.has(token.value)&&token.value!=='SELECT'&&!(token.value==='REPLACE'&&list[i+1]?.value==='('))return false;
  if(list[i+1]?.value==='('&&!functions.has(token.value)&&!['IN','EXISTS','AS','SELECT','WHEN','AND','OR','NOT','VALUES','WHERE','ON','HAVING','FROM','JOIN'].includes(token.value))return false;
 }
 return true;
}
// Pure classification accepts only the already canonical table-name set.
// Callers MUST separately prove the complete actual schema/trigger/FK effects
// inside the same acknowledged owned BEGIN; this function cannot prove that.
function parseRawDisjointSql(sql,canonicalTables){
 const t=tokens(sql);if(!t?.length||!(canonicalTables instanceof Set)||t.some((token,i)=>['LIKE','GLOB','REGEXP','MATCH','CURRENT_DATE','CURRENT_TIME','CURRENT_TIMESTAMP'].includes(token.value)||token.value==='COLLATE'&&(t[i+1]?.kind!=='word'||t[i+1]?.value!=='BINARY'||t[i+2]?.value==='(')||token.value==='-'&&t[i+1]?.value==='>'))return false;
 let i=0;
 const at=value=>t[i]?.value===value;
 const eat=value=>{if(!at(value))return false;i++;return true;};
 const identifier=()=>{if(t[i]?.kind!=='word')return null;return t[i++].value;};
 const target=()=>{const name=identifier()?.toLowerCase();return !!name&&canonicalTables.has(name)&&!raw.has(name);};
 const names=()=>{
  if(!eat('('))return false;
  if(!identifier())return false;
  while(eat(','))if(!identifier())return false;
  return eat(')');
 };
 const atom=()=>{
  // Only the original exactRealStatement binary64 rewrite. No arbitrary
  // arithmetic/function/subquery language is admitted into mutative VALUES.
  if(at('(')){
   i++;let terms=0;
   do{
    if(++terms>19||!eat('CAST')||!eat('(')||t[i]?.kind!=='atom')return false;
    i++;if(!eat('AS')||!eat('REAL')||!eat(')'))return false;
    if(!at('*')&&!at('/'))break;i++;
   }while(true);
   return eat(')');
  }
  if(t[i]?.kind==='atom'||at('NULL')){i++;return true;}
  if(at('-')||at('+')){i++;if(t[i]?.kind==='atom'){i++;return true;}return false;}
  return false;
 };
 const value=()=>{
  if(atom())return true;
  const name=identifier();if(!name||forbidden.has(name))return false;
  if(eat('.')&&!identifier())return false;
  if(at('+')||at('-')){i++;if(!atom())return false;}
  return true;
 };
 const assignments=()=>{
  if(!identifier()||!eat('=')||!value())return false;
  while(eat(','))if(!identifier()||!eat('=')||!value())return false;
  return true;
 };
 const where=()=>i===t.length||(eat('WHERE')&&i<t.length&&readExpression(t.slice(i),canonicalTables));
 if(eat('SELECT'))return readExpression(t.slice(i),canonicalTables);
 if(eat('WITH')){
  // One existing Stage8 reader's bounded receipt-key VALUES table only.
  // Unknown CTEs, expressions, recursive programs or mutative tails close DATA.
  if(!eat('EXPECTED')||!eat('(')||!eat('EXECUTION_ID')||!eat(',')||!eat('RECEIPT_KEY')
   ||!eat(')')||!eat('AS')||!eat('(')||!eat('VALUES'))return false;
  let pairs=0;
  do{if(++pairs>128||!eat('(')||!atom()||!eat(',')||!atom()||!eat(')'))return false;}while(eat(','));
  return eat(')')&&eat('SELECT')&&readExpression(t.slice(i),canonicalTables,true);
 }
 if(eat('PRAGMA')){
  const name=identifier();
  return ['FOREIGN_KEYS','IGNORE_CHECK_CONSTRAINTS','DATABASE_LIST'].includes(name)&&i===t.length
   ||['TABLE_INFO','TABLE_XINFO','INDEX_LIST','FOREIGN_KEY_LIST'].includes(name)
     &&eat('(')&&canonicalTables.has(identifier()?.toLowerCase())&&eat(')')&&i===t.length;
 }
 if(eat('INSERT')){
  if(eat('OR')&&!eat('IGNORE'))return false;
  if(!eat('INTO')||!target())return false;
  if(at('(')&&!names())return false;
  if(!eat('VALUES')||!eat('(')||!atom())return false;
  while(eat(','))if(!atom())return false;
  if(!eat(')'))return false;
  if(i===t.length)return true;
  if(!eat('ON')||!eat('CONFLICT'))return false;
  if(at('(')&&!names())return false;
  if(!eat('DO'))return false;
  if(eat('NOTHING'))return i===t.length;
  return eat('UPDATE')&&eat('SET')&&assignments()&&where();
 }
 if(eat('UPDATE'))return target()&&eat('SET')&&assignments()&&where();
 if(eat('DELETE'))return eat('FROM')&&target()&&where();
 return false;
}

// Cache a bounded pure SQL-shape plan, never a catalog/guard/row/result or
// an accepted table membership. Each hit rechecks its required table names
// against the current original plain Set. Nonstandard Sets use the original
// parser so custom membership behavior is not memoized or reordered.
export const RAW_DISJOINT_PLAN_LIMITS=Object.freeze({entries:64,keyBytes:8192,bytes:128*1024});
const plainSetHas=Set.prototype.has,rawPlans=new Map();let rawPlanBytes=0;
export function supportedRawDisjointSql(sql,canonicalTables){
 if(typeof sql!=='string'||Buffer.byteLength(sql)>RAW_DISJOINT_PLAN_LIMITS.keyBytes
  ||!(canonicalTables instanceof Set)||nativeTypes.isProxy(canonicalTables)
  ||Object.getPrototypeOf(canonicalTables)!==Set.prototype
  ||Object.hasOwn(canonicalTables,'has')||Set.prototype.has!==plainSetHas)
  return parseRawDisjointSql(sql,canonicalTables);
 let plan=rawPlans.get(sql);
 if(plan===undefined){
  const required=new Set();
  class ShapeTables extends Set{has(name){required.add(name);return true;}}
  const supported=parseRawDisjointSql(sql,new ShapeTables());
  // The original grammar admits exactly one WITH form: its fixed EXPECTED
  // VALUES alias shadows a same-named catalog table. It is a local relation,
  // not a required canonical catalog member. Every other name remains fresh.
  if(supported&&/^\s*WITH\b/i.test(sql))required.delete('expected');
  if([...required].some(name=>typeof name!=='string'))return parseRawDisjointSql(sql,canonicalTables);
  const names=Object.freeze(supported?[...required]:[]);
  plan=Object.freeze({supported,names});
  const size=Buffer.byteLength(sql)+names.reduce((n,name)=>n+Buffer.byteLength(name)+8,0);
  if(size<=RAW_DISJOINT_PLAN_LIMITS.bytes){
   if(rawPlans.size>=RAW_DISJOINT_PLAN_LIMITS.entries||rawPlanBytes+size>RAW_DISJOINT_PLAN_LIMITS.bytes){rawPlans.clear();rawPlanBytes=0;}
   rawPlans.set(sql,plan);rawPlanBytes+=size;
  }
 }
 return plan.supported&&plan.names.every(name=>plainSetHas.call(canonicalTables,name));
}

// Still unqualified and unwired. Every query below is fixed read-only metadata
// on the caller's ORIGINAL acknowledged owned write transaction. No earlier
// connection admission or parser decision substitutes for these observations.
const catalogSummary=`SELECT count(*) n,COALESCE(sum(length(CAST(type AS BLOB))+length(CAST(name AS BLOB))+
 length(CAST(tbl_name AS BLOB))+COALESCE(length(CAST(sql AS BLOB)),0)),0) bytes,
 (SELECT MAX(version) FROM schema_version) version FROM sqlite_master`;
export async function captureRawSourceEffectCatalog({client,transaction,assertCurrent,revision}){
 assertCurrent();const observedRevision=revision();
 // Fixed lazy import avoids changing the existing cyclic startup graph.
 const {ownedRawSourceEffectVerifier}=await import('./runtimeAdmission.js');
 assertCurrent();
 const verifier=ownedRawSourceEffectVerifier(client);if(!verifier)return null;
 verifier.assert();
 const results=await transaction.batch([catalogSummary,'PRAGMA database_list',
  'SELECT count(*) n FROM sqlite_temp_master',
  'SELECT name,builtin,narg FROM pragma_function_list() LIMIT 1025',
  'SELECT seq,name FROM pragma_collation_list() LIMIT 33']);
 assertCurrent();verifier.assert();
 if(revision()!==observedRevision||!Array.isArray(results)||results.length!==5)return null;
 const summary=results[0]?.rows,databases=results[1]?.rows,temp=results[2]?.rows,
  catalogFunctions=results[3]?.rows,collations=results[4]?.rows;
 if(!Array.isArray(summary)||summary.length!==1||summary[0].version!==35
  ||!Number.isSafeInteger(summary[0].n)||summary[0].n<1||summary[0].n>RAW_EFFECT_CATALOG_LIMITS.rows
  ||!Number.isSafeInteger(summary[0].bytes)||summary[0].bytes<1||summary[0].bytes>RAW_EFFECT_CATALOG_LIMITS.bytes)return null;
 if(!Array.isArray(databases)||databases.length<1||databases.length>2
  ||databases.some(r=>!['main','temp'].includes(r.name)||!Number.isSafeInteger(r.seq))
  ||new Set(databases.map(r=>r.name)).size!==databases.length||!databases.some(r=>r.name==='main'))return null;
 if(!Array.isArray(temp)||temp.length!==1||temp[0].n!==0)return null;
 const effectBuiltins=new Set([...functions,'CHAR','RAISE','GLOB','JSON_ARRAY']);
 if(!Array.isArray(catalogFunctions)||catalogFunctions.length<1||catalogFunctions.length>=1025
  ||catalogFunctions.some(r=>typeof r.name!=='string'||![0,1].includes(r.builtin)||!Number.isSafeInteger(r.narg)
    ||r.builtin===0&&effectBuiltins.has(r.name.toUpperCase())))return null;
 // No classified statement or pinned canonical/epoch definition selects a
 // named collation. Additional, unused provider collations cannot be invoked
 // by bound values. Never infer implementation identity from catalog names.
 if(!Array.isArray(collations)||collations.length<3||collations.length>=33
  ||collations.some(r=>typeof r.name!=='string'||!Number.isSafeInteger(r.seq))
  ||new Set(collations.map(r=>r.name.toUpperCase())).size!==collations.length
  ||!['BINARY','NOCASE','RTRIM'].every(name=>collations.some(r=>r.name.toUpperCase()===name)))return null;
 const rows=(await transaction.execute('SELECT type,name,tbl_name,sql FROM sqlite_master LIMIT 2049')).rows;
 assertCurrent();verifier.assert();
 if(revision()!==observedRevision||!Array.isArray(rows)||rows.length!==summary[0].n||!verifier.matches(rows))return null;
 return Object.freeze({tables:verifier.tables,assert:()=>{assertCurrent();verifier.assert();}});
}
