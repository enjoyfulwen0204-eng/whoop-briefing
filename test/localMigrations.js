import { runMigrations as migrate } from '../src/migrations.js';
import { fixtureKeys } from './localDb.js';
export * from '../src/migrations.js';
export const runMigrations = (client, options = {}) => migrate(client, { privacyKeys: fixtureKeys, ...options });
