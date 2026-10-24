// Pure lexical SQL results only. Never pass a guard, schema admission, tenant,
// arguments, database reads or authority predicate as the parser. Exact immutable
// SQL text and internal parser identity are the only keys; all callers retain
// every dynamic argument/context/policy check outside this bounded memo.
export const SQL_SYNTAX_MEMO_LIMITS=Object.freeze({entries:64,keyBytes:8192,bytes:128*1024});
const parsers=new WeakMap();
export function memoizedSqlSyntax(parse,sql){
 if(typeof sql!=='string')return parse(sql);
 const size=Buffer.byteLength(sql,'utf8');if(size>SQL_SYNTAX_MEMO_LIMITS.keyBytes)return parse(sql);
 let state=parsers.get(parse);if(state?.values.has(sql))return state.values.get(sql);
 const result=parse(sql);
 // Closed lexical parsers return booleans or enum0..3. Shared mutable
 // objects, arbitrary values and throws are never retained by this helper.
 if(typeof result!=='boolean'&&!(Number.isInteger(result)&&result>=0&&result<=3))return result;
 if(!state){state={values:new Map(),bytes:0};parsers.set(parse,state);}
 if(state.values.size>=SQL_SYNTAX_MEMO_LIMITS.entries||state.bytes+size>SQL_SYNTAX_MEMO_LIMITS.bytes){state.values.clear();state.bytes=0;}
 state.values.set(sql,result);state.bytes+=size;return result;
}
