/** Additive only. Runtime ownership stays disabled until every writer is fenced. */
export const COLLABORATION_ROOM_OWNER_UP_SQL = `
ALTER TABLE collaboration_yjs_states
  ADD COLUMN IF NOT EXISTS room_owner_epoch bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS room_owner_token text,
  ADD COLUMN IF NOT EXISTS room_owner_backend_pid integer,
  ADD COLUMN IF NOT EXISTS room_owner_backend_start text;
`;
