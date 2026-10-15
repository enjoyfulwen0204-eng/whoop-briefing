import * as fs from 'node:fs';
import { dirname } from 'node:path';

// A signed approval must never be exposed before its single-campaign registry
// survives a host crash. Any failed write/sync aborts the caller's publication.
export function persistIssuerRegistry(path, registry, io = fs) {
  const next = path + '.next';
  const file = io.openSync(next, 'w', 0o600);
  try {
    io.writeFileSync(file, JSON.stringify(registry));
    io.fsyncSync(file);
  } finally {
    io.closeSync(file);
  }
  io.renameSync(next, path);
  const directory = io.openSync(dirname(path), 'r');
  try {
    io.fsyncSync(directory);
  } finally {
    io.closeSync(directory);
  }
}
