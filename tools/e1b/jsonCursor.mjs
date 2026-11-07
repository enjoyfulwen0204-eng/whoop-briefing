import {fail} from './rehearsalDiagnostics.mjs';

// 0.10.0 ships the JSON stream/cursor codecs but its HTTP discovery list
// omits the JSON endpoint. Configure only the rehearsal's locked package
// instance. Never resolve via an ancestor's (application) node_modules.
const jsonEndpoint = Object.freeze({
  versionPath:'v3', pipelinePath:'v3/pipeline', cursorPath:'v3/cursor', version:3, encoding:'json',
});
export async function openJsonCursorClient(url, token, guardedFetch) {
  const {checkEndpoints, HttpClient} = await import('./node_modules/@libsql/hrana-client/lib-esm/http/client.js');
  if (checkEndpoints.length === 1 && checkEndpoints[0].versionPath === 'v3-protobuf') {
    checkEndpoints.splice(0, 1, jsonEndpoint);
  }
  if (checkEndpoints.length !== 1 || checkEndpoints[0] !== jsonEndpoint) fail('SNAPSHOT_DRIVER_CONTRACT');
  // The official library still negotiates the endpoint. A non-2xx version
  // response yields v2, which the exporter rejects before issuing any SQL.
  return new HttpClient(url, token, guardedFetch, undefined, 3);
}
