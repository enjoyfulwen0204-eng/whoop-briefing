import{verify,createHash}from'node:crypto';import{readFileSync,realpathSync,statSync,readdirSync}from'node:fs';import{join}from'node:path';
import{syntheticPublicKey}from'./stage6SyntheticTrust.mjs';
export const canonical=x=>JSON.stringify(x);
export const digest=x=>createHash('sha256').update(typeof x==='string'?x:canonical(x)).digest('hex');
export const deny=()=>{throw Object.assign(Error('LOCAL_SYNTHETIC_ADMISSION_DENIED'),{code:'BETA_PILOT_DENIED'});};
export function requireReviewMatch(review,{codeSha,manifestDigest,registry}){if(review?.verdict!=='GO'||review.candidateSha!==codeSha||review.manifestContract!=='stage6-local-synthetic-http-v1'||review.manifestDigest!==manifestDigest||registry.pendingDigest!==manifestDigest||registry.approvedDigest!==null&&registry.approvedDigest!==manifestDigest)deny();}
export function requireUnapprovedCampaign(registry){if(registry?.version!==1||registry.maximumAttempts!==4096||registry.approvedDigest!==null)deny();}
export function verifyManifest(envelope,{root,commit,now=Date.now(),reservation=false}={}){
 const m=envelope?.manifest;if(!m||!verify(null,Buffer.from(canonical(m)),syntheticPublicKey,Buffer.from(envelope.signature??'','base64')))deny();
 if(m.profile!=='stage6-local-synthetic-http-v1'||m.version!==1||m.codeSha!==commit||!/^[a-f0-9]{40}$/.test(m.codeSha)||m.maximumAttempts!==4096||m.durationMs!==86400000||m.mode!=='SHADOW'||m.paidProviders!==false||m.network!=='loopback-only'||!Number.isSafeInteger(m.startBefore)||!Number.isSafeInteger(m.issuedAt)||now<m.issuedAt||m.startBefore-m.issuedAt!==3600000||m.expiresAt!==m.startBefore+86400000||now>=m.expiresAt)deny();
 if(!Array.isArray(m.tenants)||m.tenants.length!==4||new Set(m.tenants.map(t=>t.id)).size!==4||m.tenants.some(t=>!/^s6syn-[a-z0-9-]+$/.test(t.id)||t.lifecycleGeneration!==1||!['control','qualification'].includes(t.scope))||m.tenants.filter(t=>t.scope==='qualification').length!==3||m.scopes?.control!==3||m.scopes?.qualification!==4093)deny();
 const u=new URL(m.endpoint);if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||u.port!=='18081'||u.pathname!=='/'||u.search||u.hash||u.username||u.password)deny();
 if(m.database?.path!==realpathSync(m.database?.path??'')||!m.database.path.startsWith('/qualification/physical/dbs/default/')||!/^s6syn-[a-f0-9]{32}$/.test(m.database.id)||!/^[a-f0-9]{64}$/.test(m.database.nonce))deny();
 const s=statSync(m.database.path);if(String(s.dev)!==m.database.device||String(s.ino)!==m.database.inode||!s.isFile())deny();
 const all=[];const scan=p=>{for(const e of readdirSync(join(root,p),{withFileTypes:true})){if(e.isSymbolicLink())deny();const k=p+'/'+e.name;if(e.isDirectory())scan(k);else if(e.isFile())all.push(k);else deny();}};scan('src');scan('test');if(!m.files||Object.keys(m.files).sort().join('\n')!==all.sort().join('\n'))deny();for(const[p,h]of Object.entries(m.files)){if(!/^(src|test)\/[a-zA-Z0-9._/-]+$/.test(p)||p.includes('..')||!/^[a-f0-9]{64}$/.test(h)||digest(readFileSync(join(root,p)).toString())!==h)deny();}
 const hash=digest(m);if(reservation){const a=envelope.approval;if(!a||a.verdict!=='GO'||a.codeSha!==commit||a.manifestDigest!==hash||!/^[a-f0-9]{64}$/.test(a.reviewDigest)||!verify(null,Buffer.from(canonical(a)),syntheticPublicKey,Buffer.from(envelope.approvalSignature??'','base64')))deny();}
 return {manifest:m,manifestDigest:hash};
}
