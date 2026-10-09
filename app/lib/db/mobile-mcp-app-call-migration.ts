/** Additive one-shot external calls. No worker can reclaim an executing claim. */
export const MOBILE_MCP_APP_CALL_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS mobile_mcp_app_calls (
    call_id text PRIMARY KEY,
    actor_user_id text NOT NULL,
    auth_session_id text NOT NULL,
    workspace_id text NOT NULL,
    pi_session_db_id bigint NOT NULL REFERENCES pi_sessions(id) ON DELETE CASCADE,
    session_id text NOT NULL,
    agent_id text NOT NULL,
    source_tool_call_id text NOT NULL,
    source_receipt_digest text NOT NULL CHECK (source_receipt_digest ~ '^[a-f0-9]{64}$'),
    connection_id text NOT NULL,
    auth_version bigint NOT NULL CHECK (auth_version >= 1),
    request_id text NOT NULL,
    request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
    request_json text NOT NULL CHECK (octet_length(request_json) <= 65536 AND jsonb_typeof(request_json::jsonb) = 'object'),
    status text NOT NULL CHECK (status IN ('prepared','rejected','executing','completed','failed','unknown')),
    execution_id text,
    execution_deadline_at bigint,
    result_json text CHECK (result_json IS NULL OR (octet_length(result_json) <= 2097152 AND jsonb_typeof(result_json::jsonb) = 'object')),
    error_code text,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    approval_expires_at bigint NOT NULL,
    UNIQUE (actor_user_id, request_id),
    CHECK (updated_at >= created_at AND approval_expires_at > created_at),
    CHECK ((status = 'executing') = (execution_id IS NOT NULL AND execution_deadline_at IS NOT NULL) OR status IN ('completed','unknown','failed'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_mobile_mcp_app_calls_scope
    ON mobile_mcp_app_calls (actor_user_id, auth_session_id, workspace_id, session_id, created_at DESC)`,
] as const;
