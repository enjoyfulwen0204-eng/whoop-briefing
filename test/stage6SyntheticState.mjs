import{deny}from'./stage6SyntheticManifest.mjs';
export function requireManifestLifecycle(observed,tenant){if(observed!==tenant?.lifecycleGeneration)deny();}
export function decodeState(raw,{keys,manifestDigest}){
 try{const r=JSON.parse(raw),{signature,...s}=r;if(Object.keys(s).length!==9||s.version!==1||s.manifestDigest!==manifestDigest||!Number.isSafeInteger(s.startAt)||s.endAt-s.startAt!==86400000||!Number.isSafeInteger(s.attempts)||s.attempts<1||s.attempts>4096||!Number.isSafeInteger(s.lastObservedAt)||s.lastObservedAt<s.startAt||typeof s.closed!=='boolean'||Object.keys(s.scopes).sort().join(',')!=='control,qualification'||!Number.isSafeInteger(s.scopes.control)||s.scopes.control<0||s.scopes.control>3||!Number.isSafeInteger(s.scopes.qualification)||s.scopes.qualification<0||s.scopes.qualification>4093||s.scopes.control+s.scopes.qualification!==s.attempts||signature!==keys.lookup(['stage6-local-http-ledger-v1',s])||JSON.stringify(r)!==raw)deny();return s;}catch{deny();}
}
export function nextState(previous,{manifest,manifestDigest,now,scope}){
 if(!Number.isSafeInteger(now)||!['control','qualification'].includes(scope))deny();
 if(!previous&&now>manifest.startBefore)deny();
 const s=previous??{version:1,manifestDigest,databaseId:manifest.database.id,startAt:now,endAt:now+manifest.durationMs,attempts:0,lastObservedAt:now,closed:false,scopes:{control:0,qualification:0}};
 if(s.databaseId!==manifest.database.id||s.closed||now<s.lastObservedAt||now<s.startAt||now>=s.endAt||s.attempts>=manifest.maximumAttempts||s.scopes[scope]>=manifest.scopes[scope])deny();
 return {...s,attempts:s.attempts+1,lastObservedAt:now,scopes:{...s.scopes,[scope]:s.scopes[scope]+1}};
}
export const encodeState=(s,keys)=>JSON.stringify({...s,signature:keys.lookup(['stage6-local-http-ledger-v1',s])});
