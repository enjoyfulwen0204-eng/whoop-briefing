// Numeric process memory only, no health values, explicit test invocation.
import {PerformanceObserver} from 'node:perf_hooks';import {getHeapStatistics} from 'node:v8';
import {receiverScopeStatistics} from '../src/receiverScopeLifetime.js';
const peak={},base=process.memoryUsage();let gcMs=0,gcCount=0,samples=0;
const sample=()=>{samples++;for(const [k,v] of Object.entries(process.memoryUsage()))peak[k]=Math.max(peak[k]??0,v);};
const observer=new PerformanceObserver(list=>{for(const e of list.getEntries()){gcMs+=e.duration;gcCount++;sample();}});observer.observe({entryTypes:['gc']});
sample();const timer=setInterval(sample,20);timer.unref();
process.once('beforeExit',()=>{clearInterval(timer);sample();observer.disconnect();console.log('RUNTIME_MEMORY '+JSON.stringify({pid:process.pid,platform:process.platform,arch:process.arch,base,peak,end:process.memoryUsage(),kernelPeakRssBytes:process.resourceUsage().maxRSS*1024,constrainedMemoryBytes:process.constrainedMemory(),receiverScopes:receiverScopeStatistics(),gcMs,gcCount,samples,heapLimit:getHeapStatistics().heap_size_limit,manualGc:false,execArgv:process.execArgv}));});
