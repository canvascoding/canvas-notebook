/** Operational receipts only; scene content remains in collaboration_excalidraw_states. */
export const EXCALIDRAW_SCENE_SERVICE_STATEMENTS = [
  'ALTER TABLE collaboration_excalidraw_states ADD COLUMN IF NOT EXISTS checkpoint_content_hash text',
  'ALTER TABLE collaboration_excalidraw_agent_operations ADD COLUMN IF NOT EXISTS request_fingerprint text',
  `DO $$ DECLARE old_constraint text; BEGIN
    FOR old_constraint IN SELECT conname FROM pg_constraint
      WHERE conrelid = 'collaboration_excalidraw_agent_operations'::regclass
        AND contype = 'u'
        AND pg_get_constraintdef(oid) = 'UNIQUE (document_id, initiated_by_user_id, idempotency_key)'
    LOOP EXECUTE format('ALTER TABLE collaboration_excalidraw_agent_operations DROP CONSTRAINT %I', old_constraint); END LOOP;
  END $$`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_excalidraw_agent_actor_idempotency
    ON collaboration_excalidraw_agent_operations (document_id, initiated_by_user_id, actor_id, idempotency_key)`,
  `CREATE TABLE IF NOT EXISTS collaboration_excalidraw_creates (
    workspace_id text NOT NULL, actor_user_id text NOT NULL, actor_id text NOT NULL,
    idempotency_key text NOT NULL, request_fingerprint text NOT NULL, path text NOT NULL,
    document_id text, file_dev text, file_ino text,
    status text NOT NULL DEFAULT 'preparing' CHECK(status IN ('preparing','completed','failed')),
    created_at bigint NOT NULL, updated_at bigint NOT NULL,
    PRIMARY KEY(workspace_id, actor_user_id, actor_id, idempotency_key)
  )`,
  `CREATE TABLE IF NOT EXISTS collaboration_excalidraw_checkpoint_intents (
    document_id text NOT NULL, lifecycle_generation bigint NOT NULL, scene_sequence bigint NOT NULL,
    content_hash text NOT NULL, file_dev text, file_ino text, created_at bigint NOT NULL,
    PRIMARY KEY(document_id, lifecycle_generation, scene_sequence)
  )`,
  'ALTER TABLE collaboration_excalidraw_checkpoint_intents ADD COLUMN IF NOT EXISTS file_dev text',
  'ALTER TABLE collaboration_excalidraw_checkpoint_intents ADD COLUMN IF NOT EXISTS file_ino text',
  `CREATE TABLE IF NOT EXISTS collaboration_excalidraw_restores (
    workspace_id text NOT NULL, actor_user_id text NOT NULL, actor_id text NOT NULL,
    idempotency_key text NOT NULL, request_fingerprint text NOT NULL,
    document_id text NOT NULL, lineage_id text NOT NULL, target_revision_id text NOT NULL,
    prior_revision_id text NOT NULL, restored_revision_id text NOT NULL,
    lifecycle_generation bigint NOT NULL, scene_sequence bigint NOT NULL, canonical_hash text NOT NULL,
    approved_file_hash text, approved_file_dev text, approved_file_ino text,
    checkpoint_completed boolean NOT NULL DEFAULT false, created_at bigint NOT NULL,
    PRIMARY KEY(workspace_id, actor_user_id, actor_id, idempotency_key)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_excalidraw_restore_checkpoint
    ON collaboration_excalidraw_restores(document_id, lifecycle_generation, scene_sequence)
    WHERE checkpoint_completed = false`,
] as const;
