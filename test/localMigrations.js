import { runMigrations as migrate } from '../src/migrations.js';
import { fixtureKeys } from './localDb.js';
import { SCHEMA_VERSION } from '../src/schema.js';
export * from '../src/migrations.js';
export const runMigrations = (client, options = {}) => migrate(client, { targetVersion:SCHEMA_VERSION,privacyKeys: fixtureKeys, ...options });
