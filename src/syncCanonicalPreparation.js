// Pure provider JSON preparation. No DB, generation or authorization result.
const serialized=new WeakMap();
export function prepareSyncCanonicalPayload(value){
 const seen=new WeakSet();
 const inspect=v=>{if(v===null||typeof v!=='object'){if(['function','symbol'].includes(typeof v))throw Error('SYNC_PROVIDER_JSON_REQUIRED');return;}
  if(seen.has(v))throw Error('SYNC_PROVIDER_JSON_REQUIRED');seen.add(v);
  if(!Array.isArray(v)&&Object.getPrototypeOf(v)!==Object.prototype&&Object.getPrototypeOf(v)!==null)throw Error('SYNC_PROVIDER_JSON_REQUIRED');
  const descriptors=Object.getOwnPropertyDescriptors(v);
  for(const key of Reflect.ownKeys(descriptors)){const d=descriptors[key];
   if(typeof key==='symbol'||!Object.hasOwn(d,'value')||!d.enumerable&&!(Array.isArray(v)&&key==='length'))throw Error('SYNC_PROVIDER_JSON_REQUIRED');
   inspect(d.value);
  }seen.delete(v);
 };
 inspect(value);const copied=structuredClone(value);
 const freeze=v=>{if(v&&typeof v==='object'){for(const child of Object.values(v))freeze(child);Object.freeze(v);}};freeze(copied);
 for(const row of Array.isArray(copied)?copied:[copied])if(row&&typeof row==='object')serialized.set(row,JSON.stringify(row));
 return copied;
}
export const canonicalRawJSON=value=>serialized.get(value)??JSON.stringify(value);
