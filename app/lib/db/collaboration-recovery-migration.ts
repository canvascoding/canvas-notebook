export const COLLABORATION_RECOVERY_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS collaboration_recovery_state_mutations (
    operation_id text PRIMARY KEY,
    backup_id text NOT NULL UNIQUE,
    kind text NOT NULL CHECK (kind IN ('repair_code_marks', 'archive_orphan')),
    document_id text NOT NULL,
    before_metadata jsonb NOT NULL,
    before_update bytea NOT NULL,
    before_vector bytea NOT NULL,
    after_metadata jsonb NOT NULL,
    after_update_hash text NOT NULL CHECK (after_update_hash ~ '^[0-9a-f]{64}$'),
    after_vector_hash text NOT NULL CHECK (after_vector_hash ~ '^[0-9a-f]{64}$'),
    created_at bigint NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS idx_collaboration_recovery_document ON collaboration_recovery_state_mutations (document_id, created_at)',
] as const;
