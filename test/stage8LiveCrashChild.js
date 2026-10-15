// Test-only actual process death / lost COMMIT acknowledgment after genuine
// canonical Body persistence. Accept only a disposable synthetic local path.
import Database from 'libsql';import {Sqlite3Client,Sqlite3Transaction} from '@libsql/client/sqlite3';
import {composeDb} from '../src/db.js';import {fixtureKeys} from './localDb.js';import {createStage8LiveProducer} from '../src/stage8LiveProducer.js';
const [filename,action]=process.argv.slice(2);
if(!filename?.includes('/stage8-live-crash-')||!filename.endsWith('/synthetic.db')||!['crash','lost-ack'].includes(action))throw Error('SYNTHETIC_DB_REQUIRED');
const anchor=new Database(filename),client=new Sqlite3Client(filename,{},anchor,'number');let armed=false,fired=false;
client.transaction=async(mode='write')=>{
 await client.execute(mode==='write'?'BEGIN IMMEDIATE':'BEGIN DEFERRED');const tx=new Sqlite3Transaction(anchor,'number'),commit=tx.commit.bind(tx);
 tx.commit=async()=>{await commit();if(armed&&!fired&&anchor.prepare("SELECT count(*) n FROM body_energy_results WHERE execution_mode='LIVE'").get().n){
  fired=true;if(action==='crash')process.exit(99);
  throw Object.assign(Error('SYNTHETIC_LOST_COMMIT_ACK'),{code:'SQLITE_IOERR'});
 }};return tx;
};
const db=composeDb(client,{phase4Keys:fixtureKeys}),producer=await createStage8LiveProducer({db,keys:fixtureKeys,admission:await db.admitRuntime(),userIds:['a'],enabled:()=>true,eligible:id=>id==='a'});
armed=true;
try{await producer.run({userId:'a',requestId:'child-original-request'});throw Error('SYNTHETIC_HOOK_DID_NOT_FIRE');}
catch(error){console.log(JSON.stringify({syntheticOutcome:error.code??error.message,fired}));process.exit(error.code==='COMMIT_INDETERMINATE'&&fired?98:97);}
