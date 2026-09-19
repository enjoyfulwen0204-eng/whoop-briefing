// Positive, closed vocabulary. Arbitrary Error.message/provider text is never
// a diagnostic code, even if it happens to look like an identifier.
const CODES=new Set(['initial_sync_failed','blocked_by_active_tombstone','delete_idempotent_replay',
  'scope_missing','ACCOUNT_INACTIVE','AUTH_REQUIRED','OPERATION_FAILED','ECONNRESET',
  'ECONNREFUSED','ETIMEDOUT','ENOTFOUND','SQLITE_BUSY','ABORT_ERR']);
export const operationalDiagnostic=value=>CODES.has(value)?value:null;
