import test from 'node:test';import assert from 'node:assert/strict';
import {importantFixture} from './stage8LiveFunctionalFixture.js';
import {createStage8LiveProducer} from '../src/stage8LiveProducer.js';
for(const fault of ['PRE_SEND_REVOCATION','PRE_SEND_PROACTIVE_DISABLED','PROCESS_LOST_AFTER_SEND'])test(`source integration ${fault} retains provider truth and never manufactures an approved alert`,async t=>{
 const f=await importantFixture(t,'DELIVERED'),execute=f.db.raw.execute.bind(f.db.raw);let injected=false;
 f.db.raw.execute=async statement=>{
  const sql=typeof statement==='string'?statement:statement.sql;
  if(fault==='PROCESS_LOST_AFTER_SEND'&&!injected&&sql.startsWith('UPDATE outbound_delivery_attempts SET state=')){
   injected=true;throw Error('SYNTHETIC_PROCESS_LOST_AFTER_SEND');
  }
  const result=await execute(statement);
  if(fault.startsWith('PRE_SEND_')&&!injected&&sql.startsWith('INSERT INTO outbound_delivery_attempts')){
   injected=true;if(fault==='PRE_SEND_REVOCATION')await execute("UPDATE user_notification_preferences SET notifications_paused=1,preference_version=preference_version+1 WHERE user_id='a'");else await execute("INSERT INTO proactive_agent_state(user_id,enabled,updated_at) VALUES('a',0,'2026-10-15') ON CONFLICT(user_id) DO UPDATE SET enabled=0");
  }
  return result;
 };
 let result,error;for(let leg=0;leg<40;leg++){
  try{result=await f.producer.run({userId:'a',requestId:`${fault}-${leg}`});}catch(e){error=e;break;}
  if(result.publication.status==='CURRENT')break;
 }
 f.db.raw.execute=execute;assert.equal(injected,true);
 const message=(await execute("SELECT * FROM outbound_messages WHERE user_id='a' AND message_class='EPISODE_NOTIFICATION'")).rows[0];
 if(fault.startsWith('PRE_SEND_')){
  assert.equal(error,undefined);assert.equal(result.publication.status,'CURRENT');assert.equal(f.provider.calls.length,0);assert.equal(message.state,'FAILED_DEFINITE');
  assert.equal((await execute("SELECT count(*) n FROM outbound_messages WHERE state IN ('DELIVERED','AMBIGUOUS')")).rows[0].n,0);
 }else{
  assert.match(error?.message??'',/SYNTHETIC_PROCESS_LOST/);assert.equal(message.state,'DELIVERY_STARTED');assert.equal(f.provider.calls.length,1);
  assert.equal((await execute('SELECT count(*) n FROM stage8_live_publications')).rows[0].n,0);
  const source=(await execute("SELECT e.* FROM stage8_live_executions e JOIN stage8_live_execution_producers p ON p.producing_execution_id=e.execution_id WHERE p.user_id='a' AND e.state='ESTABLISHED'")).rows;assert.equal(source.length,1,'source registered before the committed start');
  // Real original time expires. No edited timestamp, receipt or source generation.
  const wait=Math.max(0,source[0].created_at+45020-Date.now());console.log('SYNTHETIC_SOURCE_CRASH_WAIT_MS',wait);await new Promise(resolve=>setTimeout(resolve,wait));
  const restart=await createStage8LiveProducer({...f,userIds:['a'],enabled:()=>true,eligible:id=>id==='a',subjectAlertProvider:f.provider});
  for(let leg=0;leg<40;leg++){result=await restart.run({userId:'a',requestId:`source-restart-${leg}`});if(result.publication.status==='CURRENT')break;}
  assert.equal(result.publication.status,'CURRENT');assert.equal(f.provider.calls.length,1,'durable started attempt is recovered without another provider call');
  assert.equal((await execute({sql:'SELECT state FROM outbound_messages WHERE message_id=?',args:[message.message_id]})).rows[0].state,'AMBIGUOUS');
  assert.equal((await execute({sql:'SELECT state FROM outbound_delivery_attempts WHERE message_id=?',args:[message.message_id]})).rows[0].state,'AMBIGUOUS');
 }
});
