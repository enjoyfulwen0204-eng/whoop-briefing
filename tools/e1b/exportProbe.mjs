import {RECOVERY_PRODUCTION_HOST} from '../../src/recoveryPolicy.js';
import {fail, failureFields} from './rehearsalDiagnostics.mjs';

const redirects = new Set([301, 302, 303, 307, 308]);

// Version discovery uses unauthenticated GET, exactly as the pinned client does.
// An empty cursor handshake distinguishes a missing version route from a missing
// cursor. Its batch has zero steps and cannot contain SQL. Never follow Location.
export async function probeExportProtocol({url, token, fetchImpl = globalThis.fetch, emit}) {
  const origin = 'https://' + RECOVERY_PRODUCTION_HOST;
  const db = new URL(url.replace(/^libsql:/, 'https:'));
  if (db.href !== origin + '/' || !token) fail('SNAPSHOT_PROBE_IDENTITY_INVALID');

  async function inspect(path, options, label) {
    const target = new URL(path, origin);
    const record = {phase:'EXPORT_PROBE', protocol:label, http_status:null,
      redirected:false, redirect_same_origin:false, fetch_threw:false, error_class:null};
    let response;
    try {
      response = await fetchImpl(target, {...options, redirect:'manual', signal:AbortSignal.timeout(8000)});
    } catch (error) {
      record.fetch_threw = true;
      record.error_class = failureFields(error).error_class;
    }
    if (response) {
      try {
        record.http_status = response.status;
        record.redirected = redirects.has(response.status);
        if (record.redirected) {
          const location = response.headers.get('location');
          if (location) {
            try {
              const dest = new URL(location, target);
              record.redirect_same_origin = dest.origin === origin && !dest.username && !dest.password;
            } catch { /* Malformed Location is never trusted. */ }
          }
        }
      } finally {
        await response.body?.cancel();
      }
    }
    emit(record);
    return record;
  }

  const versions = [];
  for (const path of ['v3-protobuf', 'v3']) {
    versions.push(await inspect(path, {method:'GET'}, path));
  }
  if (versions.some(r => r.fetch_threw || r.redirected)) return;
  // These two fixed bodies encode the same empty batch in the two Hrana
  // encodings. The token is used only on the two pinned-origin cursor paths.
  for (const [path, type, body] of [
    ['v3-protobuf', 'application/x-protobuf', Uint8Array.of(0x12, 0x00)],
    ['v3', 'application/json', '{"baton":null,"batch":{"steps":[]}}'],
  ]) {
    await inspect(path + '/cursor', {method:'POST', body,
      headers:{'content-type':type, authorization:'Bearer ' + token}}, path + '-cursor');
  }
}
