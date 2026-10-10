import {createClient} from '@libsql/client/sqlite3';
import {randomUUID} from 'node:crypto';

// Installed HTTP/Hrana driver speaks its real v2 JSON protocol. Every SQL
// statement is executed by the installed normal SQLite/libsql driver against
// one isolated file. Only transport timing/acknowledgement is controlled.
// No socket, DNS, production credential or provider request is used.
const decode=v=>v.type==='null'?null:v.type==='integer'?BigInt(v.value):v.type==='blob'?Buffer.from(v.base64,'base64'):v.value;
const encode=v=>v===null?{type:'null'}:typeof v==='bigint'?{type:'integer',value:String(v)}:
 typeof v==='number'?{type:'float',value:v}:typeof v==='string'?{type:'text',value:v}:{type:'blob',base64:Buffer.from(v).toString('base64')};
export function hranaTransport(url) {
 const streams=new Map();let armed=null,commits=0;
 const evidence=[];
 const open=()=>{const client=createClient({url,intMode:'bigint'}),id=randomUUID(),stream={client,sql:new Map(),inTransaction:false};
  streams.set(id,stream);return [id,stream];};
 const statement=async(stream,stmt)=>{
  const sql=stmt.sql??stream.sql.get(stmt.sql_id),args=stmt.named_args?.length?
   Object.fromEntries(stmt.named_args.map(x=>[x.name,decode(x.value)])):(stmt.args??[]).map(decode);
  if(/^\s*BEGIN\b/i.test(sql)){stream.workResult=false;stream.matched=false;}
  if(sql.includes("SET state='WORK_COMMITTED'"))stream.workResult=true;
  if(armed?.matchSql?.test(sql))stream.matched=true;
  if(/^\s*COMMIT\s*$/i.test(sql)){
   commits++;if(armed&&(!armed.onlyWorkResult||stream.workResult)&&(!armed.matchSql||stream.matched)){
    if(armed.skipMatches){armed.skipMatches--;return stream.client.execute({sql,args}).then(result=>{stream.inTransaction=false;return result;});}
    const attack=armed;armed=null;
    evidence.push({event:'commit_pending',at:Date.now(),commit:commits});await attack.before?.(stream.client);
    const result=await stream.client.execute({sql,args});stream.inTransaction=false;
    evidence.push({event:'commit_durable',at:Date.now(),commit:commits});await attack.after?.();
    if(attack.loseAcknowledgement)throw Error('SYNTHETIC_COMMIT_ACK_LOST');
    return result;
   }
  }
  const result=await stream.client.execute({sql,args});
  if(/^\s*BEGIN\b/i.test(sql))stream.inTransaction=true;
  if(/^\s*(COMMIT|ROLLBACK)\b/i.test(sql))stream.inTransaction=false;
  return result;
 };
 const serialized=r=>({cols:r.columns.map((name,i)=>({name,decltype:r.columnTypes[i]??null})),
  rows:r.rows.map(row=>r.columns.map((_,i)=>encode(row[i]))),affected_row_count:r.rowsAffected,
  last_insert_rowid:r.lastInsertRowid===undefined?null:String(r.lastInsertRowid)});
 const error=e=>({message:e.message,code:e.code??'SYNTHETIC_TRANSPORT_ERROR'});
 const condition=(c,results,errors,stream)=>!c?true:c.type==='ok'?results[c.step]!==null:c.type==='error'?errors[c.step]!==null:
  c.type==='not'?!condition(c.cond,results,errors,stream):c.type==='and'?c.conds.every(v=>condition(v,results,errors,stream)):
  c.type==='or'?c.conds.some(v=>condition(v,results,errors,stream)):c.type==='is_autocommit'?!stream.inTransaction:false;
 const fetch=async request=>{
  const body=await request.json();let [id,stream]=body.baton?[body.baton,streams.get(body.baton)]:open();
  if(!stream)throw Error('UNKNOWN_SYNTHETIC_BATON');
  const results=[];
  for(const item of body.requests){
   let response;
   try{
    if(item.type==='execute')response={type:'execute',result:serialized(await statement(stream,item.stmt))};
    else if(item.type==='batch'){
     const step_results=[],step_errors=[];
     for(const step of item.batch.steps){
      if(!condition(step.condition,step_results,step_errors,stream)){step_results.push(null);step_errors.push(null);continue;}
      try{step_results.push(serialized(await statement(stream,step.stmt)));step_errors.push(null);}
      catch(e){if(e.message==='SYNTHETIC_COMMIT_ACK_LOST')throw e;step_results.push(null);step_errors.push(error(e));}
     }response={type:'batch',result:{step_results,step_errors}};
    }else if(item.type==='store_sql'){stream.sql.set(item.sql_id,item.sql);response={type:'store_sql'};}
    else if(item.type==='close_sql'){stream.sql.delete(item.sql_id);response={type:'close_sql'};}
    else if(item.type==='close'){
     // A real Hrana stream close rolls back its open SQLite transaction. The
     // native test driver's deferred finalizer cannot stand in for that server
     // lifecycle; perform the protocol's rollback before closing the receiver.
     if(stream.inTransaction){await stream.client.execute('ROLLBACK');stream.inTransaction=false;}
     stream.client.close();streams.delete(id);id=null;response={type:'close'};
    }
    else if(item.type==='get_autocommit')response={type:'get_autocommit',is_autocommit:!stream.inTransaction};
    else throw Error(`UNIMPLEMENTED_HRANA_REQUEST:${item.type}`);
    results.push({type:'ok',response});
   }catch(e){if(e.message==='SYNTHETIC_COMMIT_ACK_LOST')throw e;results.push({type:'error',error:error(e)});}
  }
  return new Response(JSON.stringify({baton:id,base_url:null,results}),{headers:{'content-type':'application/json'}});
 };
 return {fetch,evidence,arm:attack=>{armed=attack;},close:()=>{for(const stream of streams.values())stream.client.close();streams.clear();}};
}
