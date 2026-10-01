import { requireUserId } from './userContext.js';

/** Names come only from the canonical record for the target internal user. */
export async function displayNameFor(db, userId) {
  const id = requireUserId(userId, 'displayNameFor');
  if (typeof db?.getUser !== 'function') throw new Error('DISPLAY_NAME_AUTHORITY_REQUIRED');
  const user = await db.getUser(id);
  if (!user) return '';
  if (user.id !== id) throw new Error('DISPLAY_NAME_USER_MISMATCH');
  return safeDisplayName(user.displayName);
}

export function safeDisplayName(value) {
  return typeof value === 'string' ? value.trim() : '';
}
