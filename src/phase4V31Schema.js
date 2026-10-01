/** Localization only. Absence of a row is the explicit legacy UNSET state. */
export function buildV31() {
  return Object.freeze({
    version: 31,
    ddl: [
      `CREATE TABLE IF NOT EXISTS user_locales (
        user_id TEXT NOT NULL PRIMARY KEY,
        locale TEXT NOT NULL CHECK (locale IN ('zh-TW','en','vi')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id)
      )`,
      `CREATE TABLE IF NOT EXISTS user_locale_prompts (
        user_id TEXT NOT NULL PRIMARY KEY,
        prompted_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id)
      )`,
    ],
  });
}
