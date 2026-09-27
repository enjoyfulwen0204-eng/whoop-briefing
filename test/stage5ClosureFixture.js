/** Requests in this suite deliberately own one context per public operation.
 * Rebind fixture source identities after the preceding scope has been closed.
 * Production code has no such privilege to manufacture source capabilities. */
export async function call(f,group,method,request,...options) {
  if(f.context)await f.stores.release(f.context);
  const context=await f.stores.capture('a',{executionMode:'SHADOW'});
  async function bind(value) {
    if(value===null||typeof value!=='object')return value;
    if(Object.keys(value).sort().join(',')==='executionMode,id,type') {
      if(value.executionMode==='SHARED')return (await f.stores.root(context,value.type,value.id)).ref;
      const columns=(await f.db.raw.execute(`PRAGMA table_info(${value.type})`)).rows;
      const row=(await f.db.raw.execute({sql:`SELECT * FROM ${value.type} WHERE user_id=? AND execution_mode=? AND privacy_artifact_id=?`,
        args:['a',value.executionMode,value.id]})).rows[0];
      const key=Object.fromEntries(columns.filter(column=>column.pk&&!['user_id','execution_mode'].includes(column.name)).map(column=>[column.name,row[column.name]]));
      return (await f.stores.readArtifact(context,value.type,key)).ref;
    }
    if(Array.isArray(value)){const values=[];for(const entry of value)values.push(await bind(entry));return values;}
    const object={};for(const [key,entry] of Object.entries(value))object[key]=await bind(entry);return object;
  }
  try{return await f.stores[group][method](context,await bind(request),...options);}
  finally {await f.stores.release(context);}
}

export async function read(f,table,key) {
  return f.stores.withContext('a',{executionMode:'SHADOW'},context=>f.stores.readArtifact(context,table,key));
}
