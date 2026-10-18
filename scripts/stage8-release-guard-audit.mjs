/** Diagnostic metadata only. No accepting, ignoring, resetting or repairing a
 * checkout. File contents, stderr, env and untracked names are never emitted. */
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const EVENT='stage8_release_guard_rejected',CONTRACT='stage8-release-guard-rejection-audit-v1';
const MAX_BYTES=512*1024,MAX_ENTRIES=32,MAX_PATH=180,BUDGET_MS=8000;
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const categories=new Set(['PACKAGE_JSON','PACKAGE_LOCK','GITIGNORE','RENDER_CONFIG','NODE_VERSION','NPM_CONFIG','NPM_CACHE','PLATFORM_METADATA','SRC','SCRIPTS','TEST','DOCS','CLOUDFLARE','GITHUB','OTHER']);
const errors=new Set(['HEAD_UNAVAILABLE','STATUS_UNAVAILABLE','TRACKED_SET_UNAVAILABLE','DIFF_METADATA_UNAVAILABLE','STATUS_FORMAT_UNAVAILABLE','AUDIT_UNAVAILABLE']);
const modes=new Set(['MODE_CHANGED','MODE_UNCHANGED','UNKNOWN']);
const contents=new Set(['TEXT_CHANGED','BINARY_CHANGED','NO_TEXT_CHANGE','UNKNOWN']);
const statuses=new Set(['MODIFIED','ADDED','DELETED','RENAMED_OR_COPIED','UNMERGED','TYPE_CHANGED','OTHER']);
const split=buffer=>{const out=[];let from=0;for(let i=0;i<buffer.length;i++)if(buffer[i]===0){out.push(buffer.subarray(from,i));from=i+1;}if(from!==buffer.length)throw Error('FORMAT');return out;};
function category(path){
 const s=path.toString('utf8');
 return s==='package.json'?'PACKAGE_JSON':s==='package-lock.json'?'PACKAGE_LOCK':s==='.gitignore'?'GITIGNORE':s==='render.yaml'?'RENDER_CONFIG':['.node-version','.nvmrc'].includes(s)?'NODE_VERSION':s==='.npmrc'?'NPM_CONFIG':s.startsWith('.npm/')?'NPM_CACHE':s.startsWith('.render/')?'PLATFORM_METADATA':s.startsWith('src/')?'SRC':s.startsWith('scripts/')?'SCRIPTS':s.startsWith('test/')?'TEST':s.startsWith('docs/')?'DOCS':s.startsWith('cloudflare/')?'CLOUDFLARE':s.startsWith('.github/')?'GITHUB':'OTHER';
}
function publicPath(path){const s=path.toString('utf8');return path.length<=MAX_PATH&&Buffer.byteLength(s)===path.length&&/^[A-Za-z0-9._/-]+$/.test(s)&&!s.startsWith('/')&&!s.split('/').some(p=>!p||p==='.'||p==='..')?s:null;}
function statusRows(buffer){
 const rows=[],tokens=split(buffer);if(tokens.length>10000)throw Error('FORMAT');
 for(let i=0;i<tokens.length;i++){
  const t=tokens[i],status=t.subarray(0,2).toString('ascii');if(t.length<4||t[2]!==32||!/^[ MARCUDT?!]{2}$/.test(status)||status.includes('!'))throw Error('FORMAT');
  const untracked=status==='??';if(status.includes('?')&&!untracked)throw Error('FORMAT');
  if(/[RC]/.test(status)){if(!tokens[++i]?.length)throw Error('FORMAT');}
  rows.push({path:t.subarray(3),untracked,staged:!untracked&&status[0]!==' ',unstaged:!untracked&&status[1]!==' ',status:status.includes('U')||['AA','DD'].includes(status)?'UNMERGED':/[RC]/.test(status)?'RENAMED_OR_COPIED':status.includes('D')?'DELETED':status.includes('A')?'ADDED':status.includes('T')?'TYPE_CHANGED':status.includes('M')?'MODIFIED':'OTHER'});
 }return rows;
}
function diffMetadata(buffer){
 const data=new Map(),tokens=split(buffer);if(tokens.length>20000)throw Error('FORMAT');
 for(let i=0;i<tokens.length;i++){
  const text=tokens[i].toString('utf8');
  if(text.startsWith(':')){const m=/^:(\d{6}) (\d{6}) [a-f0-9]{40} [a-f0-9]{40} [A-Z][0-9]*$/.exec(text),path=tokens[++i];if(!m||!path)throw Error('FORMAT');const k=path.toString('hex');data.set(k,{...(data.get(k)??{}),mode:m[1]===m[2]?'MODE_UNCHANGED':'MODE_CHANGED'});}
  else{const a=tokens[i].indexOf(9),b=tokens[i].indexOf(9,a+1);if(a<1||b<a+2)throw Error('FORMAT');const adds=tokens[i].subarray(0,a).toString('ascii'),deletes=tokens[i].subarray(a+1,b).toString('ascii'),path=tokens[i].subarray(b+1);if(!/^(\d+|-)$/.test(adds)||!/^(\d+|-)$/.test(deletes)||!path.length)throw Error('FORMAT');const k=path.toString('hex');data.set(k,{...(data.get(k)??{}),content:adds==='-'||deletes==='-'?'BINARY_CHANGED':Number(adds)||Number(deletes)?'TEXT_CHANGED':'NO_TEXT_CHANGE'});}
 }return data;
}
/** All returned data is diagnostic only and comes from fresh reads AFTER the
 * original guard rejected. It cannot explain a preceding state change away. */
export function collectStage8ReleaseGuardAudit(expectedSha,repository){
 const started=Date.now(),env={...process.env,LC_ALL:'C'};for(const k of Object.keys(env))if(k.startsWith('GIT_'))delete env[k];
 const audit={observation:'FRESH_AFTER_GUARD_REJECTION',headMatches:null,trackedCount:null,stagedCount:null,unstagedCount:null,untrackedCount:null,entries:[],entryLimitReached:false,errors:[]};
 const run=args=>{const remaining=BUDGET_MS-(Date.now()-started);if(remaining<=0)throw Error('BUDGET');return execFileSync('git',['--no-optional-locks','-c','core.fsmonitor=false',...args],{cwd:repository,env,timeout:Math.min(2000,remaining),maxBuffer:MAX_BYTES,stdio:['ignore','pipe','ignore']});};
 if(!/^[a-f0-9]{40}$/.test(expectedSha??'')){audit.errors.push('AUDIT_UNAVAILABLE');return audit;}
 try{const head=run(['rev-parse','HEAD']).toString('ascii').trim();if(!/^[a-f0-9]{40}$/.test(head))throw Error('FORMAT');audit.headMatches=head===expectedSha;}catch{audit.errors.push('HEAD_UNAVAILABLE');}
 let rows;try{rows=statusRows(run(['status','--porcelain=v1','-z','--untracked-files=all']));audit.trackedCount=rows.filter(r=>!r.untracked).length;audit.stagedCount=rows.filter(r=>r.staged).length;audit.unstagedCount=rows.filter(r=>r.unstaged).length;audit.untrackedCount=rows.filter(r=>r.untracked).length;}catch{audit.errors.push('STATUS_UNAVAILABLE');return audit;}
 let tracked=null;try{tracked=new Set(split(run(['ls-tree','--full-tree','-r','-z','--name-only',expectedSha])).map(p=>p.toString('hex')));}catch{audit.errors.push('TRACKED_SET_UNAVAILABLE');}
 let diff=new Map();try{diff=diffMetadata(run(['diff','--no-ext-diff','--no-textconv','--no-renames','--raw','--numstat','--abbrev=40','-z','HEAD','--']));}catch{audit.errors.push('DIFF_METADATA_UNAVAILABLE');}
 audit.entryLimitReached=rows.length>MAX_ENTRIES;
 audit.entries=rows.slice(0,MAX_ENTRIES).map(r=>{const name=!r.untracked&&tracked?.has(r.path.toString('hex'))?publicPath(r.path):null,m=diff.get(r.path.toString('hex'))??{};return {kind:r.untracked?'UNTRACKED':'TRACKED',category:category(r.path),pathSha256:sha(r.path),...(name?{publicPath:name}:{}),status:r.untracked?'OTHER':r.status,mode:r.untracked?'UNKNOWN':m.mode??'UNKNOWN',content:r.untracked?'UNKNOWN':m.content??'UNKNOWN'};});
 return audit;
}
/** A diagnostic failure never replaces or suppresses the original rejection. */
export function emitStage8ReleaseGuardAudit(expectedSha,repository){
 try{const record={event:EVENT,contract:CONTRACT,code:'STAGE8_CLEAN_RELEASE_REQUIRED',diagnosticOnly:true,audit:collectStage8ReleaseGuardAudit(expectedSha,repository)};console.error(JSON.stringify(record));}catch{try{console.error(JSON.stringify({event:EVENT,contract:CONTRACT,code:'STAGE8_CLEAN_RELEASE_REQUIRED',diagnosticOnly:true,audit:{observation:'FRESH_AFTER_GUARD_REJECTION',headMatches:null,trackedCount:null,stagedCount:null,unstagedCount:null,untrackedCount:null,entries:[],entryLimitReached:false,errors:['AUDIT_UNAVAILABLE']}}));}catch{}}
}
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
/** Root's fixed authenticated log reader may use this strict parser. Parsed
 * audit metadata is never a clean-release proof or production capability. */
export function parseStage8ReleaseGuardAuditLog(line){
 if(typeof line!=='string'||Buffer.byteLength(line)>32768)return null;let v;try{v=JSON.parse(line);}catch{return null;}
 if(!exact(v,['event','contract','code','diagnosticOnly','audit'])||v.event!==EVENT||v.contract!==CONTRACT||v.code!=='STAGE8_CLEAN_RELEASE_REQUIRED'||v.diagnosticOnly!==true)return null;
 const a=v.audit;if(!exact(a,['observation','headMatches','trackedCount','stagedCount','unstagedCount','untrackedCount','entries','entryLimitReached','errors'])||a.observation!=='FRESH_AFTER_GUARD_REJECTION'||![null,true,false].includes(a.headMatches)||typeof a.entryLimitReached!=='boolean'||!Array.isArray(a.entries)||a.entries.length>MAX_ENTRIES||!Array.isArray(a.errors)||a.errors.length>errors.size||a.errors.some(e=>!errors.has(e)))return null;
 for(const k of ['trackedCount','stagedCount','unstagedCount','untrackedCount'])if(a[k]!==null&&(!Number.isSafeInteger(a[k])||a[k]<0||a[k]>10000))return null;
 for(const e of a.entries){if(!e||typeof e!=='object'||Array.isArray(e))return null;if(!exact(e,['kind','category','pathSha256','status','mode','content',...(Object.hasOwn(e,'publicPath')?['publicPath']:[])])||!['TRACKED','UNTRACKED'].includes(e.kind)||!categories.has(e.category)||typeof e.pathSha256!=='string'||!/^[a-f0-9]{64}$/.test(e.pathSha256)||!statuses.has(e.status)||!modes.has(e.mode)||!contents.has(e.content))return null;
  if(Object.hasOwn(e,'publicPath')&&(e.kind!=='TRACKED'||typeof e.publicPath!=='string'||publicPath(Buffer.from(e.publicPath))!==e.publicPath||sha(Buffer.from(e.publicPath))!==e.pathSha256||category(Buffer.from(e.publicPath))!==e.category))return null;
  if(e.kind==='UNTRACKED'&&(e.status!=='OTHER'||e.mode!=='UNKNOWN'||e.content!=='UNKNOWN'))return null;
 }return Object.freeze(v);
}
