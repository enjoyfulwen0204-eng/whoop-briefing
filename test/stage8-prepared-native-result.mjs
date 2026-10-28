import {createHash} from 'node:crypto';
import {canonicalJson} from '../src/phase4EntityStore.js';
// Original runner and its persisted canonical result have different property
// insertion order. Hash semantic bytes without changing any signed payload.
export const nativePreparedResultDigest=value=>createHash('sha256').update(canonicalJson(value)).digest('hex');
