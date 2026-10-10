import {assertProfileRevision,advanceProfileRevision} from './profileRevision.js';
import { requireUserId } from './userContext.js';
import { LOCALES } from './localization.js';

/** One atomic statement per write. Missing row means UNSET, never zh-TW. */
export function createLocaleStore(client,{transaction}={}) {
  const inTransaction=transaction??(fn=>fn());
  return Object.freeze({
    async getLocale(userId) {
      const id = requireUserId(userId, 'getLocale');
      const row = (await client.execute({
        sql: 'SELECT locale FROM user_locales WHERE user_id=?', args: [id],
      })).rows[0];
      if (!row) return null;
      if (!LOCALES.includes(row.locale)) throw new Error('LOCALIZATION_STORED_LOCALE_INVALID');
      return row.locale;
    },
    async setLocale(userId, locale, { now = new Date(),expectedProfileRevision } = {}) {
      const id = requireUserId(userId, 'setLocale');
      if (!LOCALES.includes(locale)) throw new Error('LOCALIZATION_UNSUPPORTED_LOCALE');
      if(typeof transaction!=='function')throw Error('PROFILE_TRANSACTION_REQUIRED');
      return inTransaction(async()=>{
      const revision=await assertProfileRevision(client,id,expectedProfileRevision);
      const at = now.toISOString();
      const result = await client.execute({
        sql: `INSERT INTO user_locales(user_id,locale,created_at,updated_at)
          SELECT id,?,?,? FROM users WHERE id=?
          ON CONFLICT(user_id) DO UPDATE SET locale=excluded.locale,updated_at=excluded.updated_at
          WHERE user_locales.locale<>excluded.locale`,
        args: [locale, at, at, id],
      });
      if (Number(result.rowsAffected ?? 0) === 0 && !(await this.getLocale(id)))
        throw new Error('LOCALIZATION_USER_NOT_FOUND');
      if(result.rowsAffected===1)await advanceProfileRevision(client,id,revision,now);
      return locale;
      });
    },
    async claimLocalePrompt(userId, { now = new Date() } = {}) {
      const id = requireUserId(userId, 'claimLocalePrompt');
      const result = await client.execute({
        sql: `INSERT INTO user_locale_prompts(user_id,prompted_at)
          SELECT id,? FROM users WHERE id=? AND NOT EXISTS
            (SELECT 1 FROM user_locales WHERE user_id=users.id)
          ON CONFLICT(user_id) DO NOTHING`,
        args: [now.toISOString(), id],
      });
      return Number(result.rowsAffected ?? 0) === 1;
    },
    async releaseLocalePrompt(userId) {
      const id = requireUserId(userId, 'releaseLocalePrompt');
      await client.execute({
        sql: 'DELETE FROM user_locale_prompts WHERE user_id=? AND NOT EXISTS (SELECT 1 FROM user_locales WHERE user_id=?)',
        args: [id, id],
      });
    },
  });
}
