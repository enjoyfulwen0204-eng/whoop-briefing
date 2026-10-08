import {AsyncLocalStorage} from 'node:async_hooks';
// Existing v31 lease bookkeeping is not a business-work replay API. These four
// fixed commands accept bound values only: no caller SQL, table, or callback.
const scope=new AsyncLocalStorage();
const commands=Object.freeze({
 insert:'INSERT INTO resource_locks(name,owner,acquired_at,expires_at) VALUES (?,?,?,?)',
 claim:`INSERT INTO resource_locks(name,owner,acquired_at,expires_at) VALUES (?,?,?,?) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,acquired_at=excluded.acquired_at,expires_at=excluded.expires_at WHERE resource_locks.expires_at<=excluded.acquired_at`,
 release:'DELETE FROM resource_locks WHERE name=? AND owner=?',
 releaseExpired:'DELETE FROM resource_locks WHERE name=? AND owner=? AND expires_at<=?',
});
export function inExecutionCoordination(statement){
 const command=scope.getStore();if(!command)return false;
 if(statement===undefined)return true;
 return statement?.sql===command.sql&&JSON.stringify(statement.args)===command.args;
}
export function executeCoordination(client,kind,args){
 const sql=commands[kind];if(!sql||!Array.isArray(args)||args.length!==({insert:4,claim:4,release:2,releaseExpired:3}[kind]))throw Error('EXECUTION_COORDINATION_INVALID');
 const statement={sql,args:[...args]};return scope.run({sql,args:JSON.stringify(statement.args)},()=>client.execute(statement));
}
