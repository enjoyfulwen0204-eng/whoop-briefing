import {openJsonCursorClient} from './jsonCursor.mjs';
import {fail, failureFields, remoteError} from './rehearsalDiagnostics.mjs';
import {assertJobStartWindow} from './jobChecks.mjs';

export const identifier = name => {
  if (typeof name !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) fail('SNAPSHOT_IDENTIFIER_INVALID');
  return '"' + name + '"';
};

// Callers supply only fixed reads and catalog-derived, quoted table names.
// Transaction delimiters are separate literal run() calls in selectSnapshot.
export function assertSelect(sql) {
  if (typeof sql !== 'string' || !/^SELECT\s/.test(sql) ||
      /;|--|\/\*|\b(?:INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|ATTACH|DETACH|PRAGMA|VACUUM|REPLACE|load_extension)\b/i.test(sql))
    fail('SNAPSHOT_SELECT_ONLY');
  return sql;
}

export function fallbackTimeLeft(now) {
  const at = new Date(now());
  assertJobStartWindow(at);
  const minute = at.getUTCMinutes();
  if (minute < 14 || minute >= 55) fail('SNAPSHOT_FALLBACK_WINDOW_CLOSED');
  const end = at.getUTCHours() === 15 ? 30 : 55; // 23:30 Taipei
  return (end-minute)*60000 - at.getUTCSeconds()*1000 - at.getUTCMilliseconds();
}

export function checkMemory() {
  if (process.memoryUsage.rss() > 768*1024*1024) fail('SNAPSHOT_MEMORY_BOUND');
}

// Only a small JSON error envelope is eligible for code extraction. No
// response text, header, baton or other peer-provided field is propagated.
async function httpFailure(response) {
  let code;
  const reader=response.body?.getReader();
  try {
    if (reader && response.headers.get('content-type')?.split(';')[0].trim()==='application/json') {
      const chunks=[];
      let size=0;
      for (;;) {
        const {done,value}=await reader.read();
        if (done) { code=JSON.parse(Buffer.concat(chunks,size)).code; break; }
        size+=value.byteLength;
        if (size>16384) break;
        chunks.push(value);
      }
    }
  } catch { /* Unknown envelopes yield only the HTTP status. */ }
  finally { await reader?.cancel().catch(()=>{}); }
  return remoteError(code,response.status);
}

// Enforce the bound while bytes arrive, before the JSON decoder can buffer
// a giant metadata response or an unterminated cursor frame as one object.
function boundedResponse(response, cursor, guard) {
  if (!response.body) return response;
  const maxFrame=16*1024*1024;
  let pending=0;
  const body=response.body.pipeThrough(new TransformStream({transform(chunk,controller) {
    guard();
    checkMemory();
    for (let pos=0;pos<chunk.length;) {
      const newline=cursor ? chunk.indexOf(10,pos) : -1;
      const end=newline<0 ? chunk.length : newline+1;
      pending+=end-pos;
      if (pending>maxFrame) fail('SNAPSHOT_RESPONSE_BOUND');
      if (newline>=0) pending=0;
      pos=end;
    }
    controller.enqueue(chunk);
  }}));
  return new Response(body,{status:response.status,headers:response.headers});
}

export async function snapshotConnection({url, token, fetchImpl=globalThis.fetch, openClient=openJsonCursorClient, guard}) {
  const endpoint = new URL(url.replace(/^libsql:/,'https:'));
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password ||
      endpoint.port || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) fail('SNAPSHOT_URL_INVALID');
  let closed=false, status=null;
  const guardedFetch = async request => {
    const target = new URL(request.url);
    if (closed || target.origin !== endpoint.origin || target.username || target.password) fail('SNAPSHOT_NETWORK_DENIED');
    const timeout = guard();
    status=null;
    let response;
    try {
      response=await fetchImpl(request,{redirect:'error',signal:AbortSignal.timeout(timeout)});
    } catch { throw remoteError(undefined,null); }
    status=response.status;
    if (!response.ok && request.method!=='GET') throw await httpFailure(response);
    return boundedResponse(response,target.pathname==='/v3/cursor',guard);
  };
  const client=await openClient(endpoint,token,guardedFetch);
  const stream=client.openStream();
  async function remote(fn) {
    guard();
    try {
      const value=await fn();
      guard();
      return value;
    } catch (error) {
      // Preserve local branded guards. Never treat a local time budget, HTTP
      // status, network exception or text in an error message as transaction expiry.
      const fields=failureFields(error);
      if (fields.code!=='UNCLASSIFIED' || Object.hasOwn(fields,'http_status')) throw error;
      throw remoteError(error?.proto?.code, status);
    }
  }
  return {
    stream, remote,
    async negotiate() {
      if (await remote(()=>client.getVersion()) !== 3) fail('SNAPSHOT_CURSOR_UNAVAILABLE');
    },
    async rows(sql) { return (await remote(()=>stream.query(assertSelect(sql)))).rows; },
    async copyRows(name, columns, insert, onRow) {
      const sql=assertSelect('SELECT * FROM '+identifier(name));
      const cursor=await remote(()=>stream._openCursor({steps:[{stmt:{sql,args:[],namedArgs:[],wantRows:true}}]}));
      let begun=false, ended=false, count=0;
      try {
        for (;;) {
          const entry=await remote(()=>cursor.next());
          if (!entry) break;
          if (entry.type==='error' || entry.type==='step_error') throw remoteError(entry.error?.code,status);
          if (ended) fail('SNAPSHOT_CURSOR_INVALID');
          if (entry.type==='step_begin' && !begun && entry.step===0) {
            if (entry.cols.length!==columns.length || entry.cols.some((c,i)=>c.name!==columns[i])) fail('SNAPSHOT_COLUMNS_CHANGED');
            begun=true;
          } else if (entry.type==='row' && begun && entry.row.length===columns.length) {
            insert.run(...entry.row);
            count++;
            onRow(count);
          } else if (entry.type==='step_end' && begun) {
            if (entry.affectedRowCount!==0) fail('SNAPSHOT_UNEXPECTED_WRITE');
            ended=true;
          } else fail('SNAPSHOT_CURSOR_INVALID');
        }
        if (!ended) fail('SNAPSHOT_INCOMPLETE');
        return count;
      } finally { cursor.close(); }
    },
    close() { closed=true; stream.close(); client.close(); },
  };
}
