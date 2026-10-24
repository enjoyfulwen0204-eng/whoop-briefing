import {registerHooks}from'node:module';import{readFileSync}from'node:fs';import{createHash}from'node:crypto';import assert from'node:assert/strict';
// The one append-only export below exists only in this isolated test process.
const candidate=new URL('../src/runtimeAdmission.js',import.meta.url),url=candidate.href,source=readFileSync(candidate,'utf8');
assert.equal(createHash('sha256').update(source).digest('hex'),'5c5acb2270f7b58273f19505a95707c1604561bf91c2b79d4dbb9724432460f1');
registerHooks({load(u,context,next){if(u!==url)return next(u,context);return{format:'module',shortCircuit:true,source:source+'\nexport const __rawCompileTestOnly={tableMatches,rawEffectTableMatches,contracts,elements,withoutComments,columnName,rawEffectExpectedObjectSql,normalizeSql};\n'};}});
const {__rawCompileTestOnly:m}=await import(url);let cases=0,tables=0,variants=0;
for(const [version,contract]of m.contracts)for(const expected of contract.objects.values())if(expected.type==='table'){
 tables++;const ddl=expected.ddl,start=ddl.indexOf('('),end=ddl.lastIndexOf(')'),parts=m.elements(ddl),prefix=ddl.slice(0,start+1),suffix=ddl.slice(end);
 const values=[ddl,m.withoutComments(ddl),ddl.replace(/IF NOT EXISTS\s+/i,''),prefix+[...parts].reverse().join(',')+suffix,ddl.replace(/\bTEXT\b/,'BLOB'),prefix+parts.join(',')+', unexpected_extra TEXT'+suffix,prefix+parts.slice(1).join(',')+suffix,ddl+' WITHOUT ROWID',ddl.replace(/CREATE TABLE/i,'CREATE VIRTUAL TABLE'),ddl.replace(/\s+/g,' '),prefix+parts.map(p=>'/* lexical fixture */ '+p).join(',')+suffix];
 for(const v of expected.variants){const index=parts.findIndex(p=>m.columnName(p)===v.column);if(index<0)continue;const changed=[...parts];changed[index]=v.column+' '+v.definition;values.push(prefix+changed.join(',')+suffix);variants++;}
 for(const actual of values){assert.equal(m.rawEffectTableMatches(actual,expected),m.tableMatches(actual,expected));cases++;}
 // Second pass uses the same expected preprocessing, still compares fresh actual SQL.
 for(const actual of [ddl,prefix+parts.join(',')+', second_extra INTEGER'+suffix,ddl]){assert.equal(m.rawEffectTableMatches(actual,expected),m.tableMatches(actual,expected));cases++;}
}
let fixedObjectCases=0;for(const [,contract]of m.contracts)for(const expected of contract.objects.values())if(expected.type!=='table')for(const actual of [expected.ddl,expected.ddl+' ',expected.ddl+' INVALID',expected.ddl.replace(/IF NOT EXISTS\s+/i,''),expected.ddl]){assert.equal(m.normalizeSql(actual)===m.rawEffectExpectedObjectSql(expected),m.normalizeSql(actual)===m.normalizeSql(expected.ddl));fixedObjectCases++;}
const out={fixedObjectCases,status:'PURE_EXPECTED_PREPROCESSING_EQUIVALENCE_PASS',cases,tables,retainedVariantCases:variants,versions:[33,34,35],currentMetadataReadOrAdmissionClaimed:false,appWorktreeChanges:0,providerCalls:0,productionWrites:0};console.log(JSON.stringify(out));
