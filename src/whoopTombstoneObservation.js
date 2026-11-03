// Fixed metadata statement shared with the compatibility batch allowlist.
export const TOMBSTONE_OBSERVATION_SQL = `UPDATE whoop_resource_tombstones
               SET blocked_count = blocked_count + 1, last_blocked_at = ?, updated_at = ?
             WHERE user_id = ? AND resource_type = ? AND resource_id = ? AND state = ?`;
