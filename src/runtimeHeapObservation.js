import {getHeapStatistics} from 'node:v8';
// Actual heap limit of the Node process answering health, not a child worker,
// configured environment, analysis completion proof or capacity qualification.
export function runtimeHeapLimitBytes(){
 try{const value=getHeapStatistics().heap_size_limit;return Number.isSafeInteger(value)&&value>0?value:null;}
 catch{return null;}
}
