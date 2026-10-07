// These imports MUST precede every application-module import. Retain genuine
// installed driver methods before runtimeAdmission intercepts their prototypes.
import {Sqlite3Client,createClient as sqliteClient} from '@libsql/client/sqlite3';
import {HttpClient,createClient as httpClient} from '@libsql/client/http';
const originals={file:{close:Sqlite3Client.prototype.close,reconnect:Sqlite3Client.prototype.reconnect},
 http:{close:HttpClient.prototype.close,reconnect:HttpClient.prototype.reconnect}};
const {default:test}=await import('node:test'),{default:assert}=await import('node:assert/strict');
const {mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
const {composeDb}=await import('../../src/db.js'),{fixtureKeys}=await import('../../test/localDb.js');
const {createOwnedDb}=await import('../../test/stage5OwnedDb.js'),{admitRuntime}=await import('../../src/runtimeAdmission.js');
const {hranaTransport}=await import('./hrana-transport.mjs');
for(const attack of ['file:reconnect','file:closed-flag','file:missing-trigger','file:nonunique-index','http:reconnect','http:missing-trigger'])
test(`R3 pre-import original native methods must permanently revoke: ${attack}`,async t=>{
 const [driver,change]=attack.split(':'),dir=await mkdtemp(join(tmpdir(),'p4-r3-preimport-')),url=`file:${join(dir,'db.sqlite')}`,seed=createOwnedDb({url});
 await seed.migrate({targetVersion:31});await seed.close();const transport=driver==='http'?hranaTransport(url):null;
 const base=driver==='file'?sqliteClient({url}):httpClient({url:'https://isolated.invalid',fetch:transport.fetch});
 const db=composeDb(base,{phase4Keys:fixtureKeys});t.after(async()=>{db.close();transport?.close();await rm(dir,{recursive:true,force:true});});
 const cap=await db.admitRuntime();assert.equal(db.requireRuntimeAdmission(cap),31);
 originals[driver].close.call(base);
 if(change==='missing-trigger'||change==='nonunique-index'){
  const writer=sqliteClient({url});try{
   if(change==='missing-trigger')await writer.execute('DROP TRIGGER p4_outbox_transition');
   else {await writer.execute('DROP INDEX uniq_report_sent');await writer.execute("CREATE INDEX uniq_report_sent ON report_runs(user_id,report_type,local_date) WHERE status='SENT'");}
  }finally{writer.close();}
 }
 if(change==='closed-flag')base.closed=false;else await originals[driver].reconnect.call(base);
 let oldAccepted=false,freshAccepted=false,freshError;
 try{oldAccepted=db.requireRuntimeAdmission(cap)===31;}catch{}
 try{await admitRuntime(db.raw,fixtureKeys);freshAccepted=true;}catch(e){freshError=e.code??e.message;}
 console.log(JSON.stringify({probe:attack,oldAccepted,freshAccepted,freshError:freshError??null}));
 assert.equal(oldAccepted,false,'old capability must never authorize the reconnected/closed lifetime');
 if(change==='missing-trigger'||change==='nonunique-index')assert.equal(freshAccepted,false);
});
