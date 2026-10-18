import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {Readable} from 'node:stream';
import {createDb} from './localDb.js';
import {log,operationalLogFields} from '../src/logger.js';
import {createPhase4Keys} from '../src/phase4Keys.js';
import {createWhoopRenderIngressBridge,admitWhoopBridgeCommonInbox,sealWhoopRenderIngressBinding,validateWhoopRenderIngressStartup,initializeWhoopRenderIngressBridge,WHOOP_BRIDGE_DATABASE_URL,WHOOP_BRIDGE_ORIGIN,WHOOP_BRIDGE_SOURCE_SHA,WHOOP_BRIDGE_PATH,WHOOP_BRIDGE_MAX_BYTES} from '../src/maintenanceWhoopIngress.js';

const AT=Date.parse('2026-10-18T05:00:00.000Z'),SECRET='SYNTHETIC-LOCAL-ONLY-WHOOP-SECRET',TENANTS=['70101','70102','70103'];
const CANDIDATE_SHA='1f665f3eb9b932a79b6a867c61700948e93cb28e';
const bridgeKeys=createPhase4Keys({lookupKey:Buffer.alloc(32,71),auditKey:Buffer.alloc(32,83)});
const unsignedPin=()=>({contract:'stage8-existing-render-whoop-ingress-v1',approvalId:'owner-SYNTHETIC-NOT-LIVE',sourceSha:WHOOP_BRIDGE_SOURCE_SHA,candidateSha:CANDIDATE_SHA,originalWindowId:'SYNTHETIC-ORIGINAL-WINDOW',originalWindowStartMs:AT-1000,originalWindowEndMs:AT+31*60_000,origin:WHOOP_BRIDGE_ORIGIN,acceptFromMs:AT-1000,acceptUntilMs:AT+31*60_000,resourceApiVersion:'v2',tenants:TENANTS.map((whoopUserId,i)=>({userId:'bridge-user-'+i,whoopUserId,lifecycleGeneration:1,authGeneration:1,sourceGeneration:0,purgeGeneration:0}))});
const pin=()=>sealWhoopRenderIngressBinding({keys:bridgeKeys,binding:unsignedPin()});
const raw=()=>'{ "user_id":70101, "id":"a1b2c3d4-0000-4000-8000-000000000001", "type":"sleep.updated", "trace_id":"d3709ee7-104e-4f70-a928-2932964b017b" }';
const signature=(body,timestamp=AT)=>createHmac('sha256',SECRET).update(String(timestamp)).update(body).digest('base64');
const request=(body=raw(),{path=WHOOP_BRIDGE_PATH,method='POST',origin=WHOOP_BRIDGE_ORIGIN,timestamp=AT,sig=signature(body,timestamp),query=''}={})=>new Request(origin+path+query,{method,headers:{'x-whoop-signature-timestamp':String(timestamp),'x-whoop-signature':sig},...(!['GET','HEAD'].includes(method)?{body}:{})});
const fixture=async(t,version=33)=>{
 const db=createDb({url:':memory:'});t.after(()=>db.close());await db.migrate({targetVersion:version});
 for(const tenant of unsignedPin().tenants){
  const stamp=new Date(AT).toISOString();await db.raw.execute({sql:'INSERT INTO users(id,display_name,timezone,status,lifecycle_generation,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',args:[tenant.userId,'Synthetic','Asia/Taipei','ACTIVE',1,stamp,stamp]});
  await db.raw.execute({sql:'INSERT INTO user_whoop_tokens(user_id,whoop_user_id,access_token,refresh_token,access_token_expires_at,scope,updated_at,auth_generation) VALUES(?,?,?,?,?,?,?,?)',args:[tenant.userId,tenant.whoopUserId,'SYNTHETIC-ACCESS','SYNTHETIC-REFRESH',stamp,'read:sleep read:recovery read:workout',stamp,1]});
  await db.raw.execute({sql:'INSERT INTO phase4_user_state(user_id,source_generation,purge_generation,pending_purge_count,created_at,updated_at) VALUES(?,0,0,0,?,?)',args:[tenant.userId,stamp,stamp]});
 }
 return db;
};
const bridge=(client,options={})=>createWhoopRenderIngressBridge({client,keys:bridgeKeys,clientSecret:SECRET,approvedBinding:pin(),releaseSha:CANDIDATE_SHA,mode:'ingress-only',now:()=>AT,...options});
const rows=async db=>(await db.raw.execute('SELECT * FROM whoop_webhook_events ORDER BY id')).rows;
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const statementSql=statement=>typeof statement==='string'?statement:statement.sql;
const instrument=client=>{const sql=[];return {sql,client:{execute:statement=>{sql.push(statementSql(statement));return client.execute(statement);}}};};

test('default OFF and invalid source/time/three-tenant bindings never reach SQL',async()=>{
 let calls=0;const client={execute(){calls++;throw Error('FORBIDDEN_SQL');}};
 assert.equal((await createWhoopRenderIngressBridge().handle(request())).status,503);
 const bad=[{mode:'off'},{approvedBinding:null},{clientSecret:null},{approvedBinding:{...pin(),sourceSha:'a'.repeat(40)}},{approvedBinding:{...pin(),origin:'https://another.invalid'}},
  {approvedBinding:{...pin(),acceptUntilMs:AT+60*60_000+1}},{now:()=>pin().acceptUntilMs},{now:()=>AT-2000},
  {releaseSha:'b'.repeat(40)},{approvedBinding:{...pin(),seal:'0'.repeat(64)}},{keys:createPhase4Keys({lookupKey:Buffer.alloc(32,91),auditKey:Buffer.alloc(32,92)})},
  ...[[],['70101'],['70101','70102'],['70101','70102','70103','70104'],['70101',70101,'70103'],['070101','70102','70103'],['70101',,'70103']].map(tenantIds=>({approvedBinding:{...pin(),tenantIds}}))];
 for(const options of bad)assert.equal((await bridge(client,options).handle(request())).status,503);
 assert.equal(calls,0);
});

test('startup requires a sealed exact original window/candidate, fixed host and current own key continuity',async t=>{
 const db=await fixture(t),approvedBinding=pin();
 const options={client:db.raw,databaseUrl:WHOOP_BRIDGE_DATABASE_URL,keys:bridgeKeys,clientSecret:SECRET,approvedBinding,releaseSha:CANDIDATE_SHA,now:()=>AT};
 assert.equal((await validateWhoopRenderIngressStartup(options)).rosterVerified,true);
 for(const change of [{databaseUrl:'libsql://another.invalid'},{clientSecret:null},{approvedBinding:unsignedPin()},{releaseSha:'b'.repeat(40)},{approvedBinding:{...approvedBinding,originalWindowEndMs:AT+32*60_000}}])await assert.rejects(validateWhoopRenderIngressStartup({...options,...change}),/WHOOP_BRIDGE_/);
 for(const tenants of [[],unsignedPin().tenants.slice(0,2),[...unsignedPin().tenants,unsignedPin().tenants[0]],[unsignedPin().tenants[0],unsignedPin().tenants[0],unsignedPin().tenants[2]]])assert.throws(()=>sealWhoopRenderIngressBinding({keys:bridgeKeys,binding:{...unsignedPin(),tenants}}),/SOURCE_BINDING_REQUIRED/);
 assert.throws(()=>sealWhoopRenderIngressBinding({keys:bridgeKeys,binding:{...unsignedPin(),acceptUntilMs:unsignedPin().originalWindowEndMs+1}}),/SOURCE_BINDING_REQUIRED/);
 await db.raw.execute("UPDATE phase4_migration_checkpoints SET last_cursor='not authentic' WHERE target_version=22 AND step_key='lookup_key_check'");
 await assert.rejects(validateWhoopRenderIngressStartup(options),/KEY_CONTINUITY_REQUIRED/);
 let calls=0;t.mock.method(globalThis,'fetch',()=>{calls++;throw Error('NETWORK_FORBIDDEN');});
 await assert.rejects(initializeWhoopRenderIngressBridge({...options,databaseUrl:'libsql://another.invalid',authToken:'SYNTHETIC-NOT-LIVE'}),/FIXED_RUNTIME_TARGET_REQUIRED/);assert.equal(calls,0);
});

test('invalid timeout cannot initialize, reach SQL or owned fetch, or make health green',async t=>{
 let calls=0,fetches=0;const client={execute(){calls++;throw Error('SQL_FORBIDDEN');}};
 t.mock.method(globalThis,'fetch',()=>{fetches++;throw Error('NETWORK_FORBIDDEN');});
 for(const operationTimeoutMs of [0,-1,1.5,15001,'100',null]){
  const runtime=bridge(client,{operationTimeoutMs});await assert.rejects(runtime.initialize(),/FIXED_RUNTIME_TARGET_REQUIRED/);
  assert.equal((await runtime.handle(new Request(WHOOP_BRIDGE_ORIGIN+'/health'))).status,503);
  assert.equal((await runtime.handle(request())).status,503);
  await assert.rejects(initializeWhoopRenderIngressBridge({databaseUrl:WHOOP_BRIDGE_DATABASE_URL,authToken:'SYNTHETIC-NOT-LIVE',keys:bridgeKeys,clientSecret:SECRET,approvedBinding:pin(),releaseSha:CANDIDATE_SHA,mode:'ingress-only',now:()=>AT,operationTimeoutMs}),/FIXED_RUNTIME_TARGET_REQUIRED/);
 }
 assert.equal(calls,0);assert.equal(fetches,0);
});

test('current roster, lifecycle/auth/privacy generations and purge state are rechecked before every INSERT',async t=>{
 const db=await fixture(t),runtime=bridge(db.raw);await runtime.initialize();
 for(const [table,column,value,original] of [['users','status','DISABLED','ACTIVE'],['users','lifecycle_generation',2,1],['user_whoop_tokens','auth_generation',2,1],['phase4_user_state','source_generation',1,0],['phase4_user_state','purge_generation',1,0],['phase4_user_state','pending_purge_count',1,0],['user_whoop_tokens','whoop_user_id','70104','70101']]){
  const key=table==='users'?'id':'user_id';await db.raw.execute({sql:`UPDATE ${table} SET ${column}=? WHERE ${key}=?`,args:[value,'bridge-user-0']});
  assert.equal((await runtime.handle(request())).status,503);assert.equal((await rows(db)).length,0);assert.equal((await runtime.handle(new Request(WHOOP_BRIDGE_ORIGIN+'/health'))).status,503);
  await db.raw.execute({sql:`UPDATE ${table} SET ${column}=? WHERE ${key}=?`,args:[original,'bridge-user-0']});await runtime.initialize();
 }
 assert.equal((await runtime.handle(request())).status,200);
});

for(const version of [33,35])test(`read-only common admission accepts actual migrated schema${version} without business runtime`,async t=>{
 const db=await fixture(t,version),seen=instrument(db.raw),result=await admitWhoopBridgeCommonInbox(seen.client);
 assert.equal(result.schema,version);assert.match(result.metadataDigest,/^[a-f0-9]{64}$/);
 assert.equal(seen.sql.length,3);assert.ok(seen.sql.every(sql=>/^SELECT\b/.test(sql)));
 assert.ok(!seen.sql.some(sql=>/FROM (users|journal_events|user_whoop_tokens|phase4_migration_checkpoints)\b/.test(sql)));
});

for(const version of [32,34])test(`unsupported committed schema${version} is denied without writing`,async t=>{
 const db=await fixture(t,version),seen=instrument(db.raw);
 await assert.rejects(admitWhoopBridgeCommonInbox(seen.client),/COMMITTED_SCHEMA_REQUIRED/);
 assert.ok(seen.sql.every(sql=>/^SELECT\b/.test(sql)));
 assert.equal((await bridge(db.raw).handle(request())).status,503);assert.equal((await rows(db)).length,0);
});

test('missing index, unexpected index/trigger, altered default and marker drift each deny',async t=>{
 const cases=[
  ['missing index',async db=>db.raw.execute('DROP INDEX uniq_whoop_webhook_event')],
  ['unexpected index',async db=>db.raw.execute('CREATE INDEX synthetic_extra_inbox_index ON whoop_webhook_events(provider)')],
  ['inbox trigger',async db=>db.raw.execute("CREATE TRIGGER synthetic_inbox_trigger AFTER INSERT ON whoop_webhook_events BEGIN UPDATE users SET updated_at='BAD'; END")],
  ['indirect trigger',async db=>db.raw.execute('CREATE TRIGGER synthetic_other_trigger AFTER INSERT ON users BEGIN DELETE FROM whoop_webhook_events; END')],
  ['marker',async db=>db.raw.execute("UPDATE schema_version SET note='not canonical' WHERE version=33")],
 ];
 for(const [name,mutate] of cases)await t.test(name,async sub=>{const db=await fixture(sub);await mutate(db);const seen=instrument(db.raw);assert.equal((await bridge(seen.client).handle(request())).status,503);assert.ok(!seen.sql.some(sql=>/^INSERT/.test(sql)));});
 await t.test('changed privacy default',async sub=>{
  const db=await fixture(sub),client={execute:async statement=>{const result=await db.raw.execute(statement);if(typeof statement==='string'&&statement.includes('FROM sqlite_master'))return {...result,rows:result.rows.map(row=>row.name==='whoop_webhook_events'?{...row,sql:row.sql.replace("DEFAULT 'LEGACY_UNLINKED'","DEFAULT 'PRESENT'")}:row)};return result;}};
  assert.equal((await bridge(client).handle(request())).status,503);assert.equal((await rows(db)).length,0);
 });
});

test('health is200 only after valid startup; every Telegram/business/OAuth route503 before body/auth/SQL',async t=>{
 const db=await fixture(t);let calls=0,bodyReads=0;const runtime=bridge({execute(statement){calls++;return db.raw.execute(statement);}});
 assert.equal((await runtime.handle(new Request(WHOOP_BRIDGE_ORIGIN+'/health'))).status,503);await runtime.initialize();calls=0;
 const body={getReader(){bodyReads++;throw Error('FORBIDDEN_BODY');}};
 for(const path of ['/telegram/webhook','/internal/briefing/run','/internal/briefing/companion','/internal/briefing/continuation','/internal/briefing/readiness','/whoop/oauth/callback','/unknown']){
  for(const method of ['GET','POST'])assert.equal((await runtime.handle({url:WHOOP_BRIDGE_ORIGIN+path,method,body})).status,503);
 }
 const health=await runtime.handle({url:WHOOP_BRIDGE_ORIGIN+'/health',method:'GET',body});
 assert.equal(health.status,200);assert.deepEqual(await health.json(),{ok:true,mode:'WHOOP_INGRESS_ONLY',businessAvailable:false});
 assert.equal(calls,0);assert.equal(bodyReads,0);
});

test('strict route, four literal metadata keys, tenant canonicalization and HMAC precede all SQL',async()=>{
 let calls=0;const runtime=bridge({execute(){calls++;throw Error('FORBIDDEN_SQL');}}),value=JSON.parse(raw());
 const invalid=[JSON.stringify({...value,recovery_score:99}),JSON.stringify({...value,journal:'SYNTHETIC_PRIVATE_TEXT'}),JSON.stringify({...value,user_id:{id:70101}}),
  JSON.stringify({...value,id:'SYNTHETIC_PRIVATE_HEALTH_TEXT'}),JSON.stringify({...value,type:'cycle.updated'}),JSON.stringify({...value,user_id:'070101'}),
  raw().replace('"user_id":70101','"user_id":70101.0'),raw().replace('"user_id":70101','"user_id":7.0101e4'),
  raw().replace('"user_id":70101','"user_id":70101,"user_id":70101'),raw().replace('"user_id":70101','"\\u0075ser_id":70101'),
  JSON.stringify({...value,user_id:9007199254740992}),'{bad',raw()+' trailing'];
 for(const body of invalid)assert.equal((await runtime.handle(request(body))).status,400);
 assert.equal((await runtime.handle(request(JSON.stringify({...value,user_id:'70104'})))).status,403);
 assert.equal((await runtime.handle(request(raw(),{sig:'wrong'}))).status,401);
 assert.equal((await runtime.handle(request(raw(),{timestamp:AT-300001}))).status,401);
 assert.equal((await runtime.handle(request(raw(),{timestamp:AT+300001}))).status,401);
 assert.equal((await runtime.handle(request('x'.repeat(WHOOP_BRIDGE_MAX_BYTES+1)))).status,413);
 assert.equal((await runtime.handle(request(raw(),{method:'GET'}))).status,405);
 assert.equal((await runtime.handle(request(raw(),{query:'?any=1'}))).status,400);
 assert.equal((await runtime.handle(request(raw(),{origin:'https://another.invalid'}))).status,400);
 assert.equal(calls,0);
});

for(const version of [33,35])test(`canonical six event types insert only pending metadata and preserve business state on schema${version}`,async t=>{
 const db=await fixture(t,version),seen=instrument(db.raw),runtime=bridge(seen.client),original=JSON.parse(raw());
 const before=(await db.raw.execute("SELECT name,seq FROM sqlite_sequence WHERE name<>'whoop_webhook_events' ORDER BY name")).rows;
 for(const type of ['sleep.updated','sleep.deleted','recovery.updated','recovery.deleted','workout.updated','workout.deleted']){
  const result=await runtime.handle(request(JSON.stringify({...original,type})));assert.equal(result.status,200);assert.deepEqual(await result.json(),{ok:true,outcome:'recorded'});
 }
 const events=await rows(db);assert.equal(events.length,6);
 for(const event of events){assert.equal(event.state,'RECEIVED');assert.equal(event.attempt_count,0);assert.equal(event.user_id,null);assert.equal(event.content_state,'LEGACY_UNLINKED');assert.equal(event.privacy_artifact_id,null);}
 assert.deepEqual((await db.raw.execute("SELECT name,seq FROM sqlite_sequence WHERE name<>'whoop_webhook_events' ORDER BY name")).rows,before);
 assert.equal((await db.raw.execute('SELECT count(*) n FROM users')).rows[0].n,3);
 assert.equal((await db.raw.execute('SELECT count(*) n FROM journal_events')).rows[0].n,0);
 assert.ok(seen.sql.filter(sql=>/^\s*(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\b/.test(sql)).every(sql=>/^\s*INSERT INTO whoop_webhook_events\b/.test(sql)));
});

test('existing durable duplicate is verified and ACKed without changing the old row',async t=>{
 const db=await fixture(t),runtime=bridge(db.raw);assert.equal((await runtime.handle(request())).status,200);
 const before=await rows(db);const result=await runtime.handle(request());assert.equal(result.status,200);assert.equal((await result.json()).outcome,'duplicate');assert.deepEqual(await rows(db),before);
});

test('escaped UUID lexemes preserve original HMAC bytes while canonical identifiers reach storage',async t=>{
 const db=await fixture(t),body=raw().replace('a1b2c3d4','\\u00611b2c3d4'),runtime=bridge(db.raw);
 assert.equal((await runtime.handle(request(body))).status,200);
 assert.equal((await rows(db))[0].resource_id,JSON.parse(raw()).id);
 assert.equal((await runtime.handle(request(body,{sig:signature(JSON.stringify(JSON.parse(body)))}))).status,401);
 const off=await createWhoopRenderIngressBridge().handle(new Request(WHOOP_BRIDGE_ORIGIN+'/health'));
 assert.equal(off.status,503);assert.equal((await off.json()).mode,'UNAVAILABLE');
});

test('official opaque trace strings need no UUID and retain original-parser canonical trim',async t=>{
 const db=await fixture(t),runtime=bridge(db.raw),value=JSON.parse(raw());
 for(const trace of ['opaque-provider-trace-v2:123',' trace with internal spaces ','x'.repeat(128)])assert.equal((await runtime.handle(request(JSON.stringify({...value,trace_id:trace})))).status,200);
 assert.deepEqual((await rows(db)).map(row=>row.trace_id),['opaque-provider-trace-v2:123','trace with internal spaces','x'.repeat(128)]);
 for(const trace of ['', '   ', 'x'.repeat(129), 'bad\u0000trace', 'bad\u007ftrace', 123])assert.equal((await runtime.handle(request(JSON.stringify({...value,trace_id:trace})))).status,400);
});

test('200 waits for canonical SQL settlement and independent durable-row confirmation',async t=>{
 const db=await fixture(t),entered=deferred(),finish=deferred();let settled=false;
 const client={execute:async statement=>{if(/^\s*INSERT INTO whoop_webhook_events/.test(statementSql(statement))){entered.resolve();await finish.promise;}return db.raw.execute(statement);}};
 const pending=bridge(client).handle(request()).then(result=>{settled=true;return result;});await entered.promise;assert.equal(settled,false);assert.equal((await rows(db)).length,0);
 finish.resolve();assert.equal((await pending).status,200);assert.equal((await rows(db)).length,1);
});

test('SQLITE_BUSY, uncertain insert, missing durable duplicate and tampered receipt never200',async t=>{
 for(const code of ['SQLITE_BUSY','SYNTHETIC_UNCERTAIN_INSERT'])await t.test(code,async sub=>{
  const db=await fixture(sub),client={execute:statement=>{if(/^\s*INSERT INTO whoop_webhook_events/.test(statementSql(statement)))throw Object.assign(Error(SECRET),{code});return db.raw.execute(statement);}};
  assert.equal((await bridge(client).handle(request())).status,503);assert.equal((await rows(db)).length,0);
 });
 await t.test('unique failure without actual durable row',async sub=>{
  const db=await fixture(sub),client={execute:statement=>{if(/^\s*INSERT INTO whoop_webhook_events/.test(statementSql(statement)))throw Error('UNIQUE constraint failed: synthetic');return db.raw.execute(statement);}};
  assert.equal((await bridge(client).handle(request())).status,503);assert.equal((await rows(db)).length,0);
 });
 await t.test('false positive insert ID',async sub=>{
  const db=await fixture(sub),client={execute:statement=>/^\s*INSERT INTO whoop_webhook_events/.test(statementSql(statement))?Promise.resolve({lastInsertRowid:100,rows:[]}):db.raw.execute(statement)};
  assert.equal((await bridge(client).handle(request())).status,503);assert.equal((await rows(db)).length,0);
 });
});

test('timeout during metadata or body cannot later initiate SQL mutation',async t=>{
 const db=await fixture(t),entered=deferred(),finish=deferred();let writes=0;
 const client={execute:async statement=>{const sql=statementSql(statement);if(sql.includes('FROM sqlite_master')){entered.resolve();await finish.promise;}if(/^\s*INSERT/.test(sql))writes++;return db.raw.execute(statement);}};
 const pending=bridge(client,{operationTimeoutMs:25}).handle(request());await entered.promise;assert.equal((await pending).status,503);finish.resolve();await new Promise(resolve=>setTimeout(resolve,20));assert.equal(writes,0);assert.equal((await rows(db)).length,0);
 let cancelled=false;const stream=new ReadableStream({pull(){return new Promise(()=>{});},cancel(){cancelled=true;}});
 const slow=new Request(WHOOP_BRIDGE_ORIGIN+WHOOP_BRIDGE_PATH,{method:'POST',body:stream,duplex:'half'});
 assert.equal((await bridge(db.raw,{operationTimeoutMs:25}).handle(slow)).status,503);assert.equal(cancelled,true);
});

test('a dispatched insert that settles after timeout never turns a503 into200 and dedup handles retry',async t=>{
 const db=await fixture(t),entered=deferred(),finish=deferred();
 const client={execute:async statement=>{if(/^\s*INSERT/.test(statementSql(statement))){entered.resolve();await finish.promise;}return db.raw.execute(statement);}};
 const pending=bridge(client,{operationTimeoutMs:25}).handle(request());await entered.promise;assert.equal((await pending).status,503);finish.resolve();await new Promise(resolve=>setTimeout(resolve,25));
 assert.equal((await rows(db)).length,1);const retry=await bridge(db.raw).handle(request());assert.equal(retry.status,200);assert.equal((await retry.json()).outcome,'duplicate');assert.equal((await rows(db)).length,1);
});

test('binding input mutation cannot widen cohort and schema33-to35 transition needs no full runtime',async t=>{
 const db=await fixture(t),approved=structuredClone(pin()),runtime=bridge(db.raw,{approvedBinding:approved});approved.tenants[0].whoopUserId='70104';approved.acceptUntilMs=AT+99*60_000;
 assert.equal((await runtime.handle(request())).status,200);
 assert.equal((await runtime.handle(request(JSON.stringify({...JSON.parse(raw()),user_id:'70104'})))).status,403);
 const before=await rows(db);await db.migrate({targetVersion:35});assert.deepEqual(await rows(db),before);
 const result=await runtime.handle(request(JSON.stringify({...JSON.parse(raw()),user_id:'70102'})));assert.equal(result.status,200);assert.equal((await rows(db)).length,2);
});

test('original logger retains neither secret, WHOOP ID, original signature nor raw payload',async t=>{
 const db=await fixture(t),logs=[];
 for(const level of ['info','warn','error'])t.mock.method(log,level,(event,fields)=>logs.push({event,...operationalLogFields(fields)}));
 assert.equal((await bridge(db.raw).handle(request())).status,200);
 const client={execute:statement=>{if(/^\s*INSERT/.test(statementSql(statement)))throw Error(SECRET+' '+raw());return db.raw.execute(statement);}};
 const next=JSON.stringify({...JSON.parse(raw()),user_id:'70102'});assert.equal((await bridge(client).handle(request(next))).status,503);
 const serialized=JSON.stringify(logs);for(const privateValue of [SECRET,TENANTS[0],signature(raw()),raw()])assert.ok(!serialized.includes(privateValue));
});

test('portable Node handler uses the existing WHOOP path, and Telegram gets503 without a durable ACK',async t=>{
 const db=await fixture(t),runtime=bridge(db.raw);
 const invoke=async(path,body=raw())=>{
  const req=Readable.from([Buffer.from(body)]);Object.assign(req,{url:path,method:'POST',headers:{'x-whoop-signature-timestamp':String(AT),'x-whoop-signature':signature(body)}});
  const result={};const res={headersSent:false,writeHead(status,headers){this.headersSent=true;result.status=status;result.headers=headers;},end(value){result.body=String(value);}};
  await runtime.nodeHandler(req,res);return result;
 };
 assert.equal((await invoke(WHOOP_BRIDGE_PATH)).status,200);assert.equal((await invoke('/telegram/webhook','{"update_id":999,"message":{"text":"SYNTHETIC_PRIVATE_TEXT"}}')).status,503);
 assert.equal((await rows(db)).length,1);assert.equal((await db.raw.execute('SELECT count(*) n FROM telegram_processed_updates')).rows[0].n,0);
});
