import { randomUUID } from 'node:crypto';
import Database from 'libsql';
import { Sqlite3Client } from '@libsql/client/sqlite3';

// No application, repository store, migration, capability or health fixture.
const uri=`file:native-stage5-${randomUUID()}?mode=memory&cache=shared`,anchor=new Database(uri);
const client=new Sqlite3Client(uri,{},anchor,'number'),started=performance.now();
await client.execute('CREATE TABLE probe (id INTEGER PRIMARY KEY,value TEXT)');
for(let index=0;index<500;index++) {
  const transaction=await client.transaction('write');
  await transaction.execute({sql:'INSERT INTO probe VALUES (?,?)',args:[index,'synthetic']});
  await transaction.commit();transaction.close();
  if(process.argv.includes('--collect')&&index%25===0)global.gc?.();
}
const rows=(await client.execute('SELECT count(*) n FROM probe')).rows[0].n;
client.close();anchor.close();
if(process.argv.includes('--collect'))global.gc?.();
console.log(JSON.stringify({rows,elapsedMs:performance.now()-started,collect:process.argv.includes('--collect'),
  resources:process.getActiveResourcesInfo()}));
process.on('beforeExit',()=>console.log('NATIVE_PROBE_BEFORE_EXIT'));
