import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const issued = new WeakSet();
/** Explicit application-held keys. No environment fallback, public default,
 * database-stored secret, provider credential reuse, or process-random lookup key. */
export function createPhase4Keys({ lookupKey, auditKey }) {
  const lookup = Buffer.from(lookupKey ?? []), audit = Buffer.from(auditKey ?? []);
  if (lookup.length < 32 || audit.length < 32 || lookup.equals(audit)) throw new Error('phase4_distinct_keys_required');
  const hmac = (key, value) => createHmac('sha256', key).update(JSON.stringify(value)).digest('hex');
  const keys = Object.freeze({
    lookup: tuple => hmac(lookup, tuple),
    newSalt: () => randomBytes(32).toString('hex'),
    digest: (salt, value) => {
      if (typeof salt !== 'string' || !/^[a-f0-9]{64}$/.test(salt)) throw new Error('phase4_hash_context_required');
      return hmac(audit, [salt, value]);
    },
    verifyAttestation: attestation => {
      if (!attestation || typeof attestation.signature !== 'string') return false;
      const { signature, ...envelope } = attestation;
      const expected = Buffer.from(hmac(audit, ['experiment-provenance-v1', envelope]));
      const supplied = Buffer.from(signature);
      return supplied.length === expected.length && timingSafeEqual(supplied, expected);
    },
  });
  issued.add(keys);
  return keys;
}
export function requirePhase4Keys(keys) {
  if (!keys || !issued.has(keys)) throw new Error('phase4_migration_keys_required');
  return keys;
}
