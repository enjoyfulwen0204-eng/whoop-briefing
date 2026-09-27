// Historical application/serializer bytes stay untouched. Only the test
// connection owner changes: real SQL and the installed transaction executor
// share one live anchor until every statement finalizer has drained.
import { Sqlite3Transaction } from '@libsql/client/sqlite3';

export function ownHistoricalConnection(client,anchor,db,t) {
  const state={connections:1,closeCalls:0,cleanup:'OPEN'};
  globalThis.stage5HistoricalOwnership=state;
  client.transaction=async(mode='write')=>{
    await client.execute(mode==='write'?'BEGIN IMMEDIATE':mode==='read'?'BEGIN DEFERRED':'BEGIN');
    return new Sqlite3Transaction(anchor,'number');
  };
  const drain=async()=>{
    global.gc();await new Promise(resolve=>setImmediate(resolve));
    await new Promise(resolve=>setImmediate(resolve));
  };
  t.after(async()=>{
    state.cleanup='DRAINING';await drain();
    const transactionOpen=anchor.inTransaction;
    db.close();state.closeCalls++;state.connections=Number(anchor.open);
    await drain();state.cleanup=state.connections?'STILL_OPEN':'CLOSED';
    if(transactionOpen)throw Error('HISTORICAL_FIXTURE_UNFINISHED_TRANSACTION');
  });
}
