/** Additive workspace-level review lane. Full plans are immutable; only lifecycle columns change. */
export const WORKSPACE_OPERATION_REVIEW_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS workspace_file_operation_reviews (
    review_id text PRIMARY KEY,
    plan_id text NOT NULL,
    request_hash text NOT NULL,
    request_json text NOT NULL,
    preview_json text NOT NULL,
    source_workspace_id text NOT NULL,
    destination_workspace_id text NOT NULL,
    actor_user_id text NOT NULL,
    actor_id text NOT NULL,
    actor_session_id text,
    actor_display_name text NOT NULL,
    reviewer_user_id text,
    status text NOT NULL,
    reason_codes_json text NOT NULL,
    operation_id text,
    error_code text,
    trash_entry_ids_json text NOT NULL DEFAULT '[]',
    revision bigint NOT NULL DEFAULT 1,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    CONSTRAINT workspace_file_operation_reviews_plan_check CHECK (plan_id ~ '^[a-f0-9]{64}$'),
    CONSTRAINT workspace_file_operation_reviews_hash_check CHECK (request_hash ~ '^[a-f0-9]{64}$'),
    CONSTRAINT workspace_file_operation_reviews_status_check CHECK
      (status IN ('pending','applying','applied','rejected','stale','failed','needs_recovery','blocked')),
    CONSTRAINT workspace_file_operation_reviews_revision_check CHECK (revision >= 1 AND updated_at >= created_at)
  )`,
  `ALTER TABLE workspace_file_operation_reviews ADD COLUMN IF NOT EXISTS reviewer_user_id text`,
  `CREATE INDEX IF NOT EXISTS idx_workspace_file_operation_reviews_pending
    ON workspace_file_operation_reviews (source_workspace_id, status, created_at DESC)`,
] as const;
