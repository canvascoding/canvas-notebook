export const COLLABORATION_RECOVERY_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS collaboration_recovery_state_mutations (
    operation_id text PRIMARY KEY,
    backup_id text NOT NULL UNIQUE,
    kind text NOT NULL CHECK (kind IN ('repair_code_marks', 'archive_orphan', 'repair_initial_append')),
    document_id text NOT NULL,
    before_metadata jsonb NOT NULL,
    before_update bytea NOT NULL,
    before_vector bytea NOT NULL,
    after_metadata jsonb NOT NULL,
    after_update_hash text NOT NULL CHECK (after_update_hash ~ '^[0-9a-f]{64}$'),
    after_vector_hash text NOT NULL CHECK (after_vector_hash ~ '^[0-9a-f]{64}$'),
    created_at bigint NOT NULL
  )`,
  `DO $migration$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint
      WHERE conrelid='collaboration_recovery_state_mutations'::regclass
        AND conname='collaboration_recovery_state_mutations_kind_check'
        AND position('repair_initial_append' IN pg_get_constraintdef(oid))=0) THEN
      ALTER TABLE collaboration_recovery_state_mutations DROP CONSTRAINT collaboration_recovery_state_mutations_kind_check;
      ALTER TABLE collaboration_recovery_state_mutations ADD CONSTRAINT collaboration_recovery_state_mutations_kind_check
        CHECK (kind IN ('repair_code_marks', 'archive_orphan', 'repair_initial_append'));
    END IF;
  END $migration$`,
  'CREATE INDEX IF NOT EXISTS idx_collaboration_recovery_document ON collaboration_recovery_state_mutations (document_id, created_at)',
] as const;
