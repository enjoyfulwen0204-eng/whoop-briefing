import {isProxy} from 'node:util/types';
import {metricProducerPageSql} from './phase4MetricProofSql.js';
import {READ_SNAPSHOT_LIMITS} from './processingReadSnapshot.js';
const sql=metricProducerPageSql(true);
const plain=value=>value&&typeof value==='object'&&!isProxy(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const data=(value,key)=>{const descriptor=Object.getOwnPropertyDescriptor(value,key);return descriptor&&Object.hasOwn(descriptor,'value')?descriptor.value:undefined;};
// An exact deterministic ROW DATA query only. This key never admits the NOW
// owner SQL, arbitrary joins, receipt branches, a boolean proof or SHADOW SQL.
// The caller additionally binds the original owned root/context/marker/epoch.
export function metricProducerDataKey(statement,context){
 if(!plain(statement)||!plain(context)||Reflect.ownKeys(statement).length!==2||data(statement,'sql')!==sql
  ||data(context,'executionMode')!=='LIVE'||data(context,'providerRequired')!==true)return null;
 const args=data(statement,'args'),uid=data(context,'userId'),generation=data(context,'inputGeneration');
 if(!Array.isArray(args)||isProxy(args)||Object.getPrototypeOf(args)!==Array.prototype||args.length!==4
  ||Reflect.ownKeys(args).length!==5||typeof uid!=='string'||!uid||uid.length>4096
  ||!Number.isSafeInteger(generation)||generation<1)return null;
 const values=[];for(let i=0;i<4;i++)values.push(data(args,String(i)));
 if(values[0]!==uid||values[1]!=='LIVE'||values[2]!==generation||typeof values[3]!=='string'||values[3].length>4096)return null;
 const key=JSON.stringify(['metric-producer-row-data-v1',sql,values]);
 return Buffer.byteLength(key)<=READ_SNAPSHOT_LIMITS.keyBytes?key:null;
}
