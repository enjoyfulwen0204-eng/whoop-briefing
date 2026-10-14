import {readFileSync} from 'node:fs';
import {monitorEventLoopDelay,PerformanceObserver} from 'node:perf_hooks';
import {getHeapStatistics} from 'node:v8';
const root='/sys/fs/cgroup/';
const read=name=>readFileSync(root+name,'utf8').trim();
const fields=name=>Object.fromEntries(read(name).split('\n').map(line=>line.split(/\s+/).map((s,i)=>i?Number(s):s)));
export function linuxMetrics(){
 if(process.platform!=='linux'||read('memory.max')!=='536870912'||read('memory.swap.max')!=='0'||read('cpu.max')!=='50000 100000')throw Error('ENFORCED_LINUX_LIMITS_REQUIRED');
 if(global.gc)throw Error('MANUAL_GC_FORBIDDEN');
 const delays=monitorEventLoopDelay({resolution:20});delays.enable();const gc={count:0,totalMs:0,maxMs:0};
 const observer=new PerformanceObserver(list=>{for(const entry of list.getEntries()){gc.count++;gc.totalMs+=entry.duration;gc.maxMs=Math.max(gc.maxMs,entry.duration);}});observer.observe({entryTypes:['gc']});
 let peaks={rss:0,heapUsed:0,external:0,arrayBuffers:0},samples=0;const startCpu=fields('cpu.stat'),start=performance.now();
 const sample=()=>{samples++;const memory=process.memoryUsage();for(const key of Object.keys(peaks))peaks[key]=Math.max(peaks[key],memory[key]);};sample();const timer=setInterval(sample,25);timer.unref();
 const snapshot=()=>{sample();return {linux:process.version,architecture:process.arch,limits:{memoryMax:Number(read('memory.max')),swapMax:read('memory.swap.max'),cpuMax:read('cpu.max'),heapLimit:getHeapStatistics().heap_size_limit},elapsedMs:performance.now()-start,cgroupPeak:Number(read('memory.peak')),cgroupCurrent:Number(read('memory.current')),memoryEvents:fields('memory.events'),cpuDelta:Object.fromEntries(Object.entries(fields('cpu.stat')).map(([k,v])=>[k,v-(startCpu[k]??0)])),processPeaks:peaks,samples,gc:{...gc},eventLoop:{maxMs:delays.max/1e6,p99Ms:delays.percentile(99)/1e6},resourceUsage:process.resourceUsage()};};
 return {snapshot,close(){clearInterval(timer);delays.disable();observer.disconnect();}};
}
