// Reservation-free unit diagnostics only; no admission, authority or SQL edits.
export async function load(url,context,next){
 const result=await next(url,context);
 if(url!==new URL('../src/phase4Reanalysis.js',import.meta.url).href)return result;
 const anchor="export const stage6ErrorCode=error=>errorCodes.get(error?.code)??'CALCULATION_FAILED';";
 const source=String(result.source);if(source.split(anchor).length!==2)throw Error('FAMILY_DIAGNOSTIC_ANCHOR_REQUIRED');
 return {...result,source:source.replace(anchor,`export const stage6ErrorCode=error=>{globalThis.__familyFailureDiagnostics?.push({type:/^[A-Za-z]{1,40}$/.test(error?.name)?error.name:'Error',code:/^[A-Z0-9_]{1,100}$/.test(error?.code)?error.code:'UNKNOWN',frames:[...String(error?.stack??'').matchAll(/(?:src|test)\\/[A-Za-z0-9_.-]+:[0-9]+:[0-9]+/g)].map(x=>x[0])});return errorCodes.get(error?.code)??'CALCULATION_FAILED';};`)};
}
