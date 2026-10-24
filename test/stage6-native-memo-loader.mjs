import {createHash} from 'node:crypto';
import {load as loadWork} from './stage6-native-work-join-loader.mjs';
const memo=new URL('../src/processingReadSnapshot.js',import.meta.url).href;
export function transformMemo(url,source){
 if(url!==memo)return source;
 if(createHash('sha256').update(source).digest('hex')!=='c7b428688cda368f73ecc2ab7a5189a212400f423a9ec0f9fb2ddba849bfe418')throw Error('EXACT_MEMO_REQUIRED');
 const replace=(a,b,n=1)=>{if(source.split(a).length!==n+1)throw Error('EXACT_MEMO_ANCHOR_REQUIRED');source=source.replaceAll(a,b);};
 replace(' let contexts=new Map(),entries=0,bytes=0,epoch=0,closed=false;',` let contexts=new Map(),entries=0,bytes=0,epoch=0,closed=false;
 let __memoOrdinal=0;try{__memoOrdinal=globalThis.__stage6MemoProbe?.register()??0;}catch{}
 const __memoNote=(kind,a=0,b=0)=>{try{globalThis.__stage6MemoProbe?.note(__memoOrdinal,kind,epoch,entries,bytes,a,b);}catch{}};
 const __memoValue=(kind,value)=>{__memoNote(kind,typeof value==='boolean'?(value?1:0):value);return value;};`);
 replace('  put(context,key,result,observedEpoch){','  put(context,key,result,observedEpoch){\n   __memoNote(\'ROW_PUT\',closed?1:epoch!==observedEpoch?2:0);');
 replace('  putData(context,key,data,observedEpoch){','  putData(context,key,data,observedEpoch){\n   __memoNote(\'DATA_PUT\',closed?1:epoch!==observedEpoch?2:0);');
 replace('result.rows.length>READ_SNAPSHOT_LIMITS.rows',"__memoValue('ROW_ROWS',result.rows.length)>READ_SNAPSHOT_LIMITS.rows");
 replace('data.rows.length>READ_SNAPSHOT_LIMITS.rows',"__memoValue('DATA_ROWS',data.rows.length)>READ_SNAPSHOT_LIMITS.rows");
 const size='    if(size>READ_SNAPSHOT_LIMITS.resultBytes||bytes+size>READ_SNAPSHOT_LIMITS.bytes)return;';
 if(source.split(size).length!==3)throw Error('EXACT_MEMO_SIZE_REQUIRED');
 source=source.replace(size,"    __memoNote('ROW_SIZE',size);\n"+size);
 const index=source.indexOf('  putData(');source=source.slice(0,index)+source.slice(index).replace(size,"    __memoNote('DATA_SIZE',size);\n"+size);
 replace('if(rows.has(key))return;',"if(__memoValue('ROW_DUPLICATE',rows.has(key)))return;");
 replace('if(rows.has(dataKey))return;',"if(__memoValue('DATA_DUPLICATE',rows.has(dataKey)))return;");
 replace('entries++;bytes+=size;',"entries++;bytes+=size;__memoNote('ROW_ADMIT');",2);
 // The prior replacement must apply only to ROW; match DATA in its exact statement.
 replace("rows.set(dataKey,{prefixData:structuredClone(data)});contexts.set(context,rows);entries++;bytes+=size;__memoNote('ROW_ADMIT');", "rows.set(dataKey,{prefixData:structuredClone(data)});contexts.set(context,rows);entries++;bytes+=size;__memoNote('DATA_ADMIT');");
 replace('clear(){contexts.clear();',"clear(){__memoNote('CLEAR');contexts.clear();");
 replace('close(){this.clear();closed=true;}',"close(){this.clear();closed=true;__memoNote('CLOSE');}");
 return source;
}
export async function load(url,context,next){if(process.env.NODE_ENV!=='test')throw Error('TEST_ONLY');const r=await loadWork(url,context,next);return url===memo?{...r,source:transformMemo(url,String(r.source))}:r;}
