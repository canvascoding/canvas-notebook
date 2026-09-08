/** SQLite compatibility schema; PostgreSQL derives these tables from schema.ts. */
export const FILE_GUEST_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS file_guest_invitations (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, path TEXT NOT NULL,
    document_id TEXT NOT NULL, email TEXT NOT NULL, permission TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active', policy_revision INTEGER NOT NULL DEFAULT 1,
    created_by_user_id TEXT NOT NULL REFERENCES user(id), assets_json TEXT NOT NULL DEFAULT '[]',
    expires_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    challenge_id TEXT, challenge_hash TEXT, challenge_expires_at INTEGER,
    challenge_attempts INTEGER NOT NULL DEFAULT 0, challenge_sent_at INTEGER,
    challenge_window_at INTEGER, challenge_send_count INTEGER NOT NULL DEFAULT 0
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_file_guest_active_email
    ON file_guest_invitations(workspace_id, document_id, email) WHERE status = 'active';
  CREATE INDEX IF NOT EXISTS idx_file_guest_document ON file_guest_invitations(document_id, status);
  CREATE TABLE IF NOT EXISTS file_guest_sessions (
    id TEXT PRIMARY KEY, invitation_id TEXT NOT NULL REFERENCES file_guest_invitations(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_file_guest_session_invitation ON file_guest_sessions(invitation_id, expires_at);
  CREATE TABLE IF NOT EXISTS file_guest_versions (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, document_id TEXT NOT NULL,
    lifecycle_generation INTEGER NOT NULL, document_sequence INTEGER NOT NULL,
    content TEXT NOT NULL, content_hash TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_file_guest_version_hash
    ON file_guest_versions(document_id, lifecycle_generation, content_hash);
  CREATE INDEX IF NOT EXISTS idx_file_guest_version_time ON file_guest_versions(document_id, created_at);
`;
