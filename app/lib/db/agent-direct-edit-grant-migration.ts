/** Additive migration; existing operations receive no direct-edit authority. */
export const AGENT_DIRECT_EDIT_GRANT_STATEMENTS = [
  `ALTER TABLE collaboration_agent_operations ADD COLUMN IF NOT EXISTS direct_edit_grant_id text`,
  `CREATE TABLE IF NOT EXISTS collaboration_agent_direct_edit_grants (
    grant_id text PRIMARY KEY,
    user_id text NOT NULL,
    workspace_id text NOT NULL,
    agent_id text NOT NULL,
    actor_session_id text NOT NULL,
    pi_session_db_id bigint NOT NULL REFERENCES pi_sessions(id) ON DELETE CASCADE,
    document_id text NOT NULL,
    lifecycle_generation bigint NOT NULL,
    created_at bigint NOT NULL,
    expires_at bigint NOT NULL,
    revoked_at bigint
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_direct_edit_grant_active_scope
    ON collaboration_agent_direct_edit_grants
    (user_id, workspace_id, agent_id, actor_session_id, document_id, lifecycle_generation)
    WHERE revoked_at IS NULL`,
  `CREATE TABLE IF NOT EXISTS collaboration_agent_direct_edit_grant_actions (
    user_id text NOT NULL,
    operation_id text NOT NULL,
    idempotency_key text NOT NULL,
    action text NOT NULL CHECK (action IN ('grant', 'revoke')),
    grant_id text REFERENCES collaboration_agent_direct_edit_grants(grant_id) ON DELETE SET NULL,
    created_at bigint NOT NULL,
    PRIMARY KEY (user_id, operation_id, idempotency_key)
  )`,
] as const;
