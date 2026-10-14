let root;export function initialize(data){root=data.root;}
export async function load(url,context,next){const result=await next(url,context);if(!url.startsWith(root)||result.format!=='module')return result;let source=String(result.source);
const replace=(before,after)=>{if(source.indexOf(before)<0||source.indexOf(before)!==source.lastIndexOf(before))throw Error('SERVICE_DIAGNOSTIC_SOURCE_MISMATCH');source=source.replace(before,after);};
if(url===root+'stage6CapacityRuntime.js')replace('}catch(error){lastFailure=',"}catch(error){globalThis.__stage6ServiceDiagnostics?.capture(error,'DRAIN_PREPARATION_OR_PUBLICATION');lastFailure=");
if(url===root+'processingTransaction.js')replace('} catch (error) {\n        readMemo.close();',"} catch (error) {\n        globalThis.__stage6ServiceDiagnostics?.capture(error,'PROCESSING_ROOT');readMemo.close();");
return{...result,source};}
