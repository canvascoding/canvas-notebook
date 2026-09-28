/** Additive, content-free recovery receipts for workspace path operations. */
export const WORKSPACE_OPERATION_JOURNAL_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS workspace_file_operations (
    operation_id text PRIMARY KEY,
    plan_id text NOT NULL,
    request_hash text NOT NULL,
    request_json text NOT NULL,
    actor_type text NOT NULL,
    actor_id text NOT NULL,
    source_workspace_id text NOT NULL,
    destination_workspace_id text NOT NULL,
    expected_step_count integer NOT NULL,
    status text NOT NULL,
    phase text NOT NULL,
    revision bigint NOT NULL,
    error_code text,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    CONSTRAINT workspace_file_operations_id_check CHECK (char_length(operation_id) BETWEEN 16 AND 128),
    CONSTRAINT workspace_file_operations_plan_check CHECK (plan_id ~ '^[a-f0-9]{64}$'),
    CONSTRAINT workspace_file_operations_request_check CHECK (
      request_hash ~ '^[a-f0-9]{64}$' AND char_length(request_json) BETWEEN 2 AND 65536
    ),
    CONSTRAINT workspace_file_operations_actor_check CHECK (
      actor_type IN ('user', 'agent', 'system') AND char_length(actor_id) BETWEEN 1 AND 256
    ),
    CONSTRAINT workspace_file_operations_workspace_check CHECK (
      char_length(source_workspace_id) BETWEEN 1 AND 256
      AND char_length(destination_workspace_id) BETWEEN 1 AND 256
    ),
    CONSTRAINT workspace_file_operations_count_check CHECK (expected_step_count BETWEEN 1 AND 10000),
    CONSTRAINT workspace_file_operations_status_check CHECK (
      status IN ('prepared', 'running', 'completed', 'failed', 'recovery_required')
    ),
    CONSTRAINT workspace_file_operations_phase_check CHECK (phase IN ('prepared', 'path', 'link', 'completed')),
    CONSTRAINT workspace_file_operations_revision_check CHECK (revision >= 1 AND updated_at >= created_at),
    CONSTRAINT workspace_file_operations_error_check CHECK (
      error_code IS NULL OR char_length(error_code) BETWEEN 1 AND 128
    )
  )`,
  `CREATE INDEX IF NOT EXISTS idx_workspace_file_operations_status
    ON workspace_file_operations (status, updated_at, operation_id)`,
  `CREATE TABLE IF NOT EXISTS workspace_file_operation_steps (
    operation_id text NOT NULL REFERENCES workspace_file_operations(operation_id) ON DELETE CASCADE,
    step_key text NOT NULL,
    phase text NOT NULL,
    status text NOT NULL,
    before_fence text NOT NULL,
    after_fence text NOT NULL,
    backup_ref text,
    receipt_json text,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    PRIMARY KEY (operation_id, step_key),
    CONSTRAINT workspace_file_operation_steps_key_check CHECK (char_length(step_key) BETWEEN 1 AND 1024),
    CONSTRAINT workspace_file_operation_steps_phase_check CHECK (phase IN ('path', 'link')),
    CONSTRAINT workspace_file_operation_steps_status_check CHECK (status IN ('intent', 'applied')),
    CONSTRAINT workspace_file_operation_steps_fence_check CHECK (
      char_length(before_fence) BETWEEN 1 AND 4096 AND char_length(after_fence) BETWEEN 1 AND 4096
    ),
    CONSTRAINT workspace_file_operation_steps_backup_check CHECK (
      backup_ref IS NULL OR char_length(backup_ref) BETWEEN 1 AND 2048
    ),
    CONSTRAINT workspace_file_operation_steps_receipt_check CHECK (
      (status = 'intent' AND receipt_json IS NULL)
      OR (status = 'applied' AND char_length(receipt_json) BETWEEN 2 AND 16384)
    ),
    CONSTRAINT workspace_file_operation_steps_time_check CHECK (updated_at >= created_at)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_workspace_file_operation_steps_phase
    ON workspace_file_operation_steps (operation_id, phase, status)`,
] as const;
