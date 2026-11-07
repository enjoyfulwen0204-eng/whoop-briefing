import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ERASURE_TABLES} from '../../src/erasureCatalog.js';
import {exportSelectSnapshot, assertSelect} from './selectSnapshot.mjs';
import {remoteError, failureFields, atTable} from './rehearsalDiagnostics.mjs';

const privateText='SECRET_FIXTURE_MUST_NOT_LEAK';
const allowedTime=Date.parse('2026-11-08T04:14:00Z');
const origin='https://fixture.invalid/';
const typed=value=>{
  if (value===null) return {type:'null'};
  if (typeof value==='bigint') return {type:'integer',value:String(value)};
  if (value instanceof Uint8Array) return {type:'blob',base64:Buffer.from(value).toString('base64')};
  return {type:typeof value==='number'?'float':'text',value};
};

// A real SQLite WAL source and the locked Hrana parser. Only the network is
// synthetic. The second connection can commit while the snapshot is open.
async function fixture(t, inject=()=>{}) {
  const dir=await mkdtemp(join(tmpdir(),'e1b-table-test-'));
  const db=new DatabaseSync(join(dir,'source')),writer=new DatabaseSync(join(dir,'source'));
  t.after(async()=>{db.close();writer.close();await rm(dir,{recursive:true,force:true});});
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON');
  for(const n of Object.keys(ERASURE_TABLES)){
    if(n==='sqlite_sequence')continue;
    let body='(id INTEGER PRIMARY KEY)';
    if(n==='users')body='(id INTEGER PRIMARY KEY AUTOINCREMENT, n, r, s, b, z)';
    if(n==='whoop_cycles')body='(id INTEGER PRIMARY KEY REFERENCES users(id))';
    if(n==='schema_version')body='(version INTEGER PRIMARY KEY)';
    db.exec('CREATE TABLE "'+n+'" '+body);
  }
  db.prepare('INSERT INTO users VALUES(1,?,?,?,?,?)').run(9007199254740993n,2.5,'sample',Buffer.from([0,255]),null);
  db.exec('INSERT INTO whoop_cycles VALUES(1); INSERT INTO schema_version VALUES(33); CREATE INDEX fixture_idx ON users(s); CREATE TRIGGER fixture_no_delete BEFORE DELETE ON users BEGIN SELECT RAISE(ABORT,"blocked"); END');
  const events=[],logs=[];let connection=0,baton=null,serial=0;
  const path=join(dir,'copy.sqlite');
  let clock=allowedTime;
  const data={db,writer,path,dir,events,logs,clockTo:v=>{clock=v;}};
  const fetchImpl=async(req,init)=>{
    assert.equal(init.redirect,'error');assert.equal(new URL(req.url).origin,new URL(origin).origin);
    if(req.method==='GET'){connection++;baton=null;return new Response('Hrana 3');}
    const wire=await req.json();
    assert.equal(wire.baton??null,baton);baton='synthetic-stream-'+ ++serial;
    const cursor=!!wire.batch, stmt=cursor?wire.batch.steps[0].stmt:wire.requests[0].stmt;
    const action=cursor?'cursor':wire.requests[0].type;
    if(cursor)assert.equal(wire.batch.steps.length,1);
    const sql=stmt?.sql;
    const table=sql?.match(/FROM "([a-z_0-9]+)"$/)?.[1];
    const event={connection,action,sql,table,tx:db.isTransaction};
    events.push(event);
    const injected=inject(event,data);
    if(injected instanceof Response)return injected;
    let result;
    if(action==='get_autocommit')result={type:action,is_autocommit:!db.isTransaction};
    else if(action==='close')result={type:'close'};
    else {
      if(['BEGIN','ROLLBACK','COMMIT'].includes(sql)) {
        assert.equal(action,'execute');db.exec(sql);
        result={type:'execute',result:{cols:[],rows:[],affected_row_count:0}};
      } else {
        assertSelect(sql);
        const statement=db.prepare(sql);
        statement.setReadBigInts(true);statement.setReturnArrays(true);
        const cols=statement.columns().map(c=>({name:c.name}));
        const rows=(injected?.rows??statement.all()).map(row=>row.map(typed));
        if(cursor){
          assert.match(sql,/^SELECT \* FROM "[a-z_0-9]+"$/);
          const frames=[{baton},{type:'step_begin',step:0,cols},
            ...rows.map(row=>({type:'row',row})),injected?.entry??{type:'step_end',affected_row_count:0}];
          return new Response(frames.map(f=>JSON.stringify(f)+'\n').join(''));
        }
        result={type:'execute',result:{cols,rows,affected_row_count:0}};
      }
    }
    return Response.json({baton,results:[{type:'ok',response:result}]});
  };
  data.copy=()=>exportSelectSnapshot({url:origin,token:'fixture',path,now:()=>clock,fetchImpl,report:r=>logs.push(r)});
  return data;
}

const expires=()=>new Response(JSON.stringify({code:'STREAM_EXPIRED',message:privateText}),
  {status:410,headers:{'content-type':'application/json; charset=utf-8'}});
function expireFirst(e,f){
  if(e.connection===1 && e.table==='users' && e.action==='cursor'){
    f.db.exec('ROLLBACK');return expires();
  }
}

test('one read transaction, typed SELECT * cursor per table, stable snapshot across concurrent commit',async t=>{
  const f=await fixture(t,(e,{writer})=>{
    if(e.table==='users' && e.action==='cursor')writer.exec("UPDATE users SET s='later' WHERE id=1");
  });
  const result=await f.copy();assert.equal(result.tables,Object.keys(ERASURE_TABLES).length);
  const cursors=f.events.filter(e=>e.action==='cursor');
  assert.equal(cursors.length,result.tables);assert.ok(cursors.every(e=>e.connection===1&&e.tx));
  assert.equal(f.events.filter(e=>e.sql?.startsWith('SELECT COUNT(')).length,2*result.tables);
  assert.equal(f.events.at(-1).sql,'COMMIT');assert.equal(f.logs.length,0);
  const db=new DatabaseSync(f.path,{readOnly:true});t.after(()=>db.close());
  const stmt=db.prepare('SELECT n,r,s,b,z FROM users');stmt.setReadBigInts(true);
  assert.deepEqual({...stmt.get()},{n:9007199254740993n,r:2.5,s:'sample',b:Uint8Array.from([0,255]),z:null});
  assert.equal(f.db.prepare('SELECT s FROM users').get().s,'later');
  assert.deepEqual(db.prepare('SELECT * FROM sqlite_sequence').all(),f.db.prepare('SELECT * FROM sqlite_sequence').all());
  assert.deepEqual(db.prepare('SELECT type,name,sql FROM sqlite_schema ORDER BY type,name').all(),f.db.prepare('SELECT type,name,sql FROM sqlite_schema ORDER BY type,name').all());
});

test('expiry discards first copy; changing table count rolls back and retries only that table',async t=>{
  let reads=0;
  const f=await fixture(t,(e,f)=>{
    const expiry=expireFirst(e,f);if(expiry)return expiry;
    if(e.connection===2&&e.table==='users'&&e.action==='cursor'&&++reads===1)
      f.writer.exec("INSERT INTO users(id,s) VALUES(2,'added')");
  });
  await f.copy();assert.equal(reads,2);
  assert.equal(f.events.filter(e=>e.connection===2&&e.sql==='BEGIN').length,0);
  assert.equal(f.events.filter(e=>e.connection===2&&e.action==='cursor'&&e.table==='ai_usage').length,1);
  assert.deepEqual(f.logs.map(r=>[r.code,r.table]),[['STREAM_EXPIRED','users'],['SNAPSHOT_COUNT_MISMATCH','users']]);
  const db=new DatabaseSync(f.path);t.after(()=>db.close());assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n,2);
});
test('fallback count disagreement exhausts two retries and publishes nothing',async t=>{
  const f=await fixture(t,(e,f)=>expireFirst(e,f)??(e.connection===2&&e.table==='users'&&e.action==='cursor'?{rows:[]}:undefined));
  await assert.rejects(f.copy(),e=>failureFields(e).code==='SNAPSHOT_COUNT_MISMATCH'&&failureFields(e).table==='users');
  assert.equal(f.logs.filter(r=>r.phase==='EXPORT_TABLE_RETRY').length,2);
  assert.ok(!(await readdir(f.dir)).includes('copy.sqlite'));
});
for(const recover of [true,false])test('foreign-key violation retries a fresh entire copy; recover='+recover,async t=>{
  const f=await fixture(t,(e,f)=>expireFirst(e,f)??(e.connection>=2 && (!recover||e.connection===2) && e.table==='whoop_cycles' && e.action==='cursor'?{rows:[[99n]]}:undefined));
  if(recover)await f.copy();
  else await assert.rejects(f.copy(),e=>failureFields(e).code==='SNAPSHOT_FOREIGN_KEY_FAILED'&&failureFields(e).table==='whoop_cycles');
  assert.equal(f.logs.filter(r=>r.phase==='EXPORT_COPY_RETRY').length,recover?1:2);
  assert.equal((await readdir(f.dir)).includes('copy.sqlite'),recover);
  assert.ok(!(await readdir(f.dir)).some(n=>n.startsWith('.e1b-copy-')));
});
test('expiry close to cutoff cannot start or continue fallback outside the allowed minute',async t=>{
  const f=await fixture(t,(e,f)=>{
    if(e.connection===2&&e.table==='app_state'&&e.action==='cursor')f.clockTo(Date.parse('2026-11-08T04:55:00Z'));
    return expireFirst(e,f);
  });
  await assert.rejects(f.copy(),{code:'SNAPSHOT_FALLBACK_WINDOW_CLOSED'});
  assert.ok(!f.events.some(e=>e.connection===2&&e.table==='users'));
  assert.ok(!(await readdir(f.dir)).includes('copy.sqlite'));
});
for(const [raw,expected] of [['SQLITE_TOOBIG','SQLITE_TOOBIG'],[privateText,'UNCLASSIFIED'],['SQLITE_'+privateText,'UNCLASSIFIED'],['SQLITE_TOOBIG\nSELECT','UNCLASSIFIED']]){
  test('cursor code redaction '+expected,async t=>{
    const f=await fixture(t,e=>e.table==='users'&&e.action==='cursor'?{entry:{type:'step_error',step:0,error:{code:raw,message:privateText}}}:undefined);
    await assert.rejects(f.copy(),error=>{
      assert.deepEqual(failureFields(error),{code:expected,http_status:200,table:'users'});
      assert.doesNotMatch(JSON.stringify(failureFields(error)),/SECRET|SELECT/);return true;
    });
    assert.equal(f.logs.length,0);
  });
}
test('HTTP authentication failure is never evidence of transaction expiry',async t=>{
  const f=await fixture(t,e=>e.table==='users'&&e.action==='cursor'?Response.json({code:'STREAM_EXPIRED',message:privateText},{status:401}):undefined);
  await assert.rejects(f.copy(),e=>failureFields(e).http_status===401&&failureFields(e).table==='users');
  assert.deepEqual(f.logs,[]);assert.ok(f.events.every(e=>e.connection===1));
});
test('untrusted table names, HTTP status and arbitrary exceptions cannot become report fields',()=>{
  const e=atTable(remoteError(privateText,700),privateText);
  assert.deepEqual(failureFields(e),{code:'UNCLASSIFIED',http_status:null});
});

test('a count mismatch in an intact transaction fails closed without switching modes',async t=>{
  const f=await fixture(t,e=>e.table==='users'&&e.action==='cursor'?{rows:[]}:undefined);
  await assert.rejects(f.copy(),e=>failureFields(e).code==='SNAPSHOT_COUNT_MISMATCH'&&failureFields(e).table==='users');
  assert.ok(f.events.every(e=>e.connection===1));assert.deepEqual(f.logs,[]);
  assert.ok(!(await readdir(f.dir)).includes('copy.sqlite'));
});
test('a fetch timeout with a misleading code cannot downgrade the transaction',async t=>{
  const f=await fixture(t,e=>{
    if(e.table==='users'&&e.action==='cursor')throw Object.assign(new TypeError(privateText),{proto:{code:'STREAM_EXPIRED'}});
  });
  await assert.rejects(f.copy(),e=>{
    assert.deepEqual(failureFields(e),{code:'UNCLASSIFIED',http_status:null,table:'users'});return true;
  });
  assert.ok(f.events.every(e=>e.connection===1));assert.deepEqual(f.logs,[]);
});
test('untrusted plaintext HTTP error is discarded; only status and catalog table survive',async t=>{
  const f=await fixture(t,e=>e.table==='users'&&e.action==='cursor'?new Response(privateText,{status:503}):undefined);
  await assert.rejects(f.copy(),e=>{
    assert.deepEqual(failureFields(e),{code:'UNCLASSIFIED',http_status:503,table:'users'});return true;
  });
  assert.deepEqual(f.logs,[]);
});
