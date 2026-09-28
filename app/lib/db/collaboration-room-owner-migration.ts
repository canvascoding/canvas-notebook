/** Additive only. Runtime ownership stays disabled until every writer is fenced. */
export const COLLABORATION_ROOM_OWNER_UP_SQL = `
ALTER TABLE collaboration_yjs_states
  ADD COLUMN IF NOT EXISTS room_owner_epoch bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS room_owner_token text,
  ADD COLUMN IF NOT EXISTS room_owner_backend_pid integer,
  ADD COLUMN IF NOT EXISTS room_owner_backend_start text;
`;

/** One statement per call, including prepared-query migration adapters. */
export const COLLABORATION_ROOM_RELEASE_UP_SQL = `
CREATE TABLE IF NOT EXISTS collaboration_room_release_receipts (
  release_id text PRIMARY KEY,
  document_id text NOT NULL,
  workspace_id text NOT NULL,
  organization_id text,
  path text NOT NULL,
  representation text NOT NULL,
  lifecycle_generation bigint NOT NULL,
  schema_version bigint NOT NULL,
  owner_epoch bigint NOT NULL CHECK (owner_epoch > 0),
  owner_token text NOT NULL,
  owner_backend_pid integer NOT NULL,
  owner_backend_start text NOT NULL,
  document_sequence bigint NOT NULL CHECK (document_sequence >= 0),
  persisted_update_hash text NOT NULL,
  persisted_vector_hash text NOT NULL,
  live_update_hash text NOT NULL,
  live_vector_hash text NOT NULL,
  created_at bigint NOT NULL,
  UNIQUE (document_id, owner_epoch)
);
`;
