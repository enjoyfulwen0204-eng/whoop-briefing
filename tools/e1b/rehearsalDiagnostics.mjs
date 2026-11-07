import {ERASURE_TABLES} from '../../src/erasureCatalog.js';

const issued = new WeakMap();
const codeFormat = /^[A-Z0-9_]{3,64}$/;
// A syntactically valid identifier might still be a name or token. Only
// known protocol codes may cross the logging boundary, even inside a cursor.
const remoteCodes = new Set((
  'STREAM_EXPIRED TRANSACTION_TIMEOUT STREAM_NOT_FOUND STREAM_CLOSED SQL_PARSE_ERROR ' +
  'SQL_INPUT_ERROR BATCH_COND_BAD_STEP STMT_INVALID_ARGS AUTH_JWT_INVALID AUTH_JWT_EXPIRED ' +
  'SQLITE_ERROR SQLITE_INTERNAL SQLITE_PERM SQLITE_ABORT SQLITE_BUSY SQLITE_LOCKED SQLITE_NOMEM ' +
  'SQLITE_READONLY SQLITE_INTERRUPT SQLITE_IOERR SQLITE_CORRUPT SQLITE_NOTFOUND SQLITE_FULL ' +
  'SQLITE_CANTOPEN SQLITE_PROTOCOL SQLITE_EMPTY SQLITE_SCHEMA SQLITE_TOOBIG SQLITE_CONSTRAINT ' +
  'SQLITE_MISMATCH SQLITE_MISUSE SQLITE_NOLFS SQLITE_AUTH SQLITE_RANGE SQLITE_NOTADB ' +
  'SQLITE_ABORT_ROLLBACK SQLITE_BUSY_SNAPSHOT SQLITE_CONSTRAINT_CHECK SQLITE_CONSTRAINT_FOREIGNKEY ' +
  'SQLITE_CONSTRAINT_NOTNULL SQLITE_CONSTRAINT_PRIMARYKEY SQLITE_CONSTRAINT_UNIQUE'
).split(' '));

function knownTable(table) {
  return table === 'sqlite_schema' || (typeof table === 'string' && Object.hasOwn(ERASURE_TABLES, table));
}

export function fail(code) {
  const error = Object.assign(new Error(code), {code});
  if (typeof code === 'string' && codeFormat.test(code)) issued.set(error, {code});
  throw error;
}

export function remoteError(code, status) {
  const safeCode = remoteCodes.has(code) && codeFormat.test(code) ? code : 'UNCLASSIFIED';
  const http_status = Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
  const error = Object.assign(new Error(safeCode), {code:safeCode});
  issued.set(error, {code:safeCode, http_status});
  return error;
}

export function atTable(error, table) {
  if (!(error instanceof Error)) error = new Error();
  if (knownTable(table)) issued.set(error, {...(issued.get(error) ?? {code:'UNCLASSIFIED'}), table});
  return error;
}

export function failureFields(error) {
  if (Object.hasOwn(issued.get(error) ?? {}, 'http_status')) return {...issued.get(error)};
  const classes = [TypeError, RangeError, SyntaxError, ReferenceError, URIError, EvalError, AggregateError];
  const builtin = classes.find(type => error instanceof type);
  return {...(issued.get(error) ?? {code:'UNCLASSIFIED'}), error_class:builtin?.name ?? (error instanceof Error ? 'Error' : 'Unknown')};
}

export function isRemoteExpiry(error) {
  const fields = issued.get(error);
  return fields && Object.hasOwn(fields, 'http_status') &&
    [null,200,400,404,410,408].includes(fields.http_status) &&
    ['STREAM_EXPIRED','TRANSACTION_TIMEOUT'].includes(fields.code);
}
