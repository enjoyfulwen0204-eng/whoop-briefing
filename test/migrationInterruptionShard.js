import assert from 'node:assert/strict';
/** Only the test loop is partitioned. Every original interruption and assertion
 * remains required; the final coverage manifest must union all shards exactly. */
export function migrationInterruptionShard(version,total){
 const rawCount=process.env.PRE_STAGE7_MIGRATION_SHARDS??'1',rawIndex=process.env.PRE_STAGE7_MIGRATION_SHARD_INDEX??'0';
 if(!/^\d+$/.test(rawCount)||!/^\d+$/.test(rawIndex))throw Error('MIGRATION_SHARD_INVALID');
 const count=Number(rawCount),index=Number(rawIndex);
 assert.ok(Number.isSafeInteger(count)&&count>=1&&count<=32&&count<=total);
 assert.ok(Number.isSafeInteger(index)&&index>=0&&index<count);
 if(count>1&&process.env.PRE_STAGE7_MIGRATION_SHARD_INDEX===undefined)throw Error('EXPLICIT_SHARD_INDEX_REQUIRED');
 const stops=Array.from({length:total},(_,i)=>i+1).filter(stop=>(stop-1)%count===index);
 assert.ok(stops.length>0);
 return {stops,complete:()=>console.log('MIGRATION_INTERRUPTION_COVERAGE '+JSON.stringify({version,total,count,index,stops}))};
}
