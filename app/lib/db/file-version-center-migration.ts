/**
 * Additive PostgreSQL storage for the File Version & Review Center.
 *
 * The startup migration runs the complete statement batch as one PostgreSQL
 * query. PostgreSQL treats a multi-statement simple query as one implicit
 * transaction, so a failed constraint or index never leaves a partial FVRC
 * schema behind. The down batch exists for migration verification and an
 * explicit operator rollback; normal feature rollback keeps captured data.
 */
export const FILE_VERSION_CENTER_STORAGE_UP_SQL = `
  CREATE UNIQUE INDEX IF NOT EXISTS idx_file_collaboration_lineages_scope_identity
    ON file_collaboration_lineages (id, workspace_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_file_revisions_scope_identity
    ON file_revisions (id, workspace_id, lineage_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_collaboration_documents_scope_identity
    ON collaboration_documents (id, workspace_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_collaboration_agent_operations_scope_identity
    ON collaboration_agent_operations (operation_id, workspace_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_pi_sessions_fvrc_scope_identity
    ON pi_sessions (id, user_id, workspace_id, session_id);

  CREATE TABLE IF NOT EXISTS file_version_blobs (
    blob_id text PRIMARY KEY,
    workspace_id text NOT NULL REFERENCES canvas_workspaces(id) ON DELETE CASCADE,
    content_sha256 text NOT NULL,
    codec text NOT NULL,
    raw_size_bytes bigint NOT NULL,
    stored_size_bytes bigint NOT NULL,
    compressed_content bytea NOT NULL,
    created_at bigint NOT NULL,
    CONSTRAINT file_version_blobs_workspace_hash_unique UNIQUE (workspace_id, content_sha256),
    CONSTRAINT file_version_blobs_scope_identity_unique UNIQUE (blob_id, workspace_id),
    CONSTRAINT file_version_blobs_hash_check CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
    CONSTRAINT file_version_blobs_codec_check CHECK (codec IN ('gzip')),
    CONSTRAINT file_version_blobs_raw_size_check CHECK (raw_size_bytes >= 0 AND raw_size_bytes <= 1048576),
    CONSTRAINT file_version_blobs_stored_size_check CHECK (
      stored_size_bytes > 0
      AND stored_size_bytes <= 1114112
      AND stored_size_bytes = octet_length(compressed_content)
    )
  );
  CREATE INDEX IF NOT EXISTS idx_file_version_blobs_workspace_created
    ON file_version_blobs (workspace_id, created_at, blob_id);

  CREATE TABLE IF NOT EXISTS file_revision_contents (
    revision_id text PRIMARY KEY,
    workspace_id text NOT NULL,
    lineage_id text NOT NULL,
    blob_id text NOT NULL,
    content_format text NOT NULL,
    source text NOT NULL,
    state_vector_hash text,
    created_at bigint NOT NULL,
    CONSTRAINT file_revision_contents_revision_scope_fk
      FOREIGN KEY (revision_id, workspace_id, lineage_id)
      REFERENCES file_revisions (id, workspace_id, lineage_id) ON DELETE CASCADE,
    CONSTRAINT file_revision_contents_lineage_scope_fk
      FOREIGN KEY (lineage_id, workspace_id)
      REFERENCES file_collaboration_lineages (id, workspace_id) ON DELETE RESTRICT,
    CONSTRAINT file_revision_contents_blob_scope_fk
      FOREIGN KEY (blob_id, workspace_id)
      REFERENCES file_version_blobs (blob_id, workspace_id) ON DELETE RESTRICT,
    CONSTRAINT file_revision_contents_format_check
      CHECK (content_format IN ('markdown', 'text', 'structured', 'binary')),
    CONSTRAINT file_revision_contents_source_check
      CHECK (source IN (
        'initial', 'automatic_checkpoint', 'manual', 'agent_apply',
        'restore', 'external_import', 'legacy_guest'
      )),
    CONSTRAINT file_revision_contents_state_vector_hash_check
      CHECK (state_vector_hash IS NULL OR char_length(state_vector_hash) BETWEEN 16 AND 256)
  );
  CREATE INDEX IF NOT EXISTS idx_file_revision_contents_lineage_created
    ON file_revision_contents (lineage_id, created_at, revision_id);
  CREATE INDEX IF NOT EXISTS idx_file_revision_contents_blob
    ON file_revision_contents (blob_id);

  CREATE TABLE IF NOT EXISTS file_change_groups (
    group_id text PRIMARY KEY,
    workspace_id text NOT NULL REFERENCES canvas_workspaces(id) ON DELETE CASCADE,
    user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    source_session_id text NOT NULL,
    pi_session_db_id bigint,
    tool_call_id text NOT NULL,
    payload_hash text NOT NULL,
    operation text NOT NULL,
    status text NOT NULL,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    CONSTRAINT file_change_groups_scope_identity_unique UNIQUE (group_id, workspace_id),
    CONSTRAINT file_change_groups_tool_call_unique
      UNIQUE (user_id, workspace_id, pi_session_db_id, tool_call_id),
    CONSTRAINT file_change_groups_session_scope_fk
      FOREIGN KEY (pi_session_db_id, user_id, workspace_id, source_session_id)
      REFERENCES pi_sessions (id, user_id, workspace_id, session_id) ON DELETE RESTRICT,
    CONSTRAINT file_change_groups_operation_check
      CHECK (operation IN ('write', 'edit_file', 'apply_patch')),
    CONSTRAINT file_change_groups_status_check
      CHECK (status IN ('applied', 'review_required', 'conflict', 'failed', 'mixed')),
    CONSTRAINT file_change_groups_time_check CHECK (updated_at >= created_at),
    CONSTRAINT file_change_groups_id_length_check CHECK (char_length(group_id) BETWEEN 1 AND 128),
    CONSTRAINT file_change_groups_tool_call_length_check CHECK (char_length(tool_call_id) BETWEEN 1 AND 128),
    CONSTRAINT file_change_groups_payload_hash_check CHECK (payload_hash ~ '^[a-f0-9]{64}$')
  );
  ALTER TABLE file_change_groups ALTER COLUMN pi_session_db_id DROP NOT NULL;
  ALTER TABLE file_change_groups ADD COLUMN IF NOT EXISTS payload_hash text;
  UPDATE file_change_groups
    SET payload_hash = md5(group_id || ':' || tool_call_id) || md5(tool_call_id || ':' || group_id)
    WHERE payload_hash IS NULL;
  ALTER TABLE file_change_groups ALTER COLUMN payload_hash SET NOT NULL;
  DO $file_change_groups_payload_hash_constraint$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'file_change_groups_payload_hash_check'
    ) THEN
      ALTER TABLE file_change_groups
        ADD CONSTRAINT file_change_groups_payload_hash_check
        CHECK (payload_hash ~ '^[a-f0-9]{64}$');
    END IF;
  END
  $file_change_groups_payload_hash_constraint$;
  CREATE INDEX IF NOT EXISTS idx_file_change_groups_user_workspace_created
    ON file_change_groups (user_id, workspace_id, created_at DESC, group_id);
  CREATE INDEX IF NOT EXISTS idx_file_change_groups_session_created
    ON file_change_groups (pi_session_db_id, created_at DESC, group_id);

  CREATE TABLE IF NOT EXISTS file_change_group_entries (
    entry_id text PRIMARY KEY,
    change_group_id text NOT NULL,
    workspace_id text NOT NULL,
    ordinal bigint NOT NULL,
    lineage_id text,
    document_id text,
    operation_id text,
    revision_id text,
    path_hint text NOT NULL,
    outcome text NOT NULL,
    additions bigint,
    deletions bigint,
    created_at bigint NOT NULL,
    CONSTRAINT file_change_group_entries_group_scope_fk
      FOREIGN KEY (change_group_id, workspace_id)
      REFERENCES file_change_groups (group_id, workspace_id) ON DELETE CASCADE,
    CONSTRAINT file_change_group_entries_lineage_scope_fk
      FOREIGN KEY (lineage_id, workspace_id)
      REFERENCES file_collaboration_lineages (id, workspace_id) ON DELETE RESTRICT,
    CONSTRAINT file_change_group_entries_document_scope_fk
      FOREIGN KEY (document_id, workspace_id)
      REFERENCES collaboration_documents (id, workspace_id) ON DELETE RESTRICT,
    CONSTRAINT file_change_group_entries_operation_scope_fk
      FOREIGN KEY (operation_id, workspace_id)
      REFERENCES collaboration_agent_operations (operation_id, workspace_id) ON DELETE RESTRICT,
    CONSTRAINT file_change_group_entries_revision_scope_fk
      FOREIGN KEY (revision_id, workspace_id, lineage_id)
      REFERENCES file_revisions (id, workspace_id, lineage_id) ON DELETE RESTRICT,
    CONSTRAINT file_change_group_entries_group_ordinal_unique UNIQUE (change_group_id, ordinal),
    CONSTRAINT file_change_group_entries_ordinal_check CHECK (ordinal >= 0 AND ordinal < 100),
    CONSTRAINT file_change_group_entries_outcome_check
      CHECK (outcome IN ('applied', 'review_required', 'conflict', 'failed')),
    CONSTRAINT file_change_group_entries_counts_check CHECK (
      (additions IS NULL OR additions >= 0)
      AND (deletions IS NULL OR deletions >= 0)
    ),
    CONSTRAINT file_change_group_entries_revision_lineage_check
      CHECK (revision_id IS NULL OR lineage_id IS NOT NULL),
    CONSTRAINT file_change_group_entries_path_check CHECK (
      char_length(path_hint) BETWEEN 1 AND 1024
      AND path_hint !~ '(^/|\\\\|(^|/)\\.\\.?(/|$)|//|[[:cntrl:]])'
    )
  );
  CREATE INDEX IF NOT EXISTS idx_file_change_group_entries_lineage
    ON file_change_group_entries (workspace_id, lineage_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_file_change_group_entries_operation
    ON file_change_group_entries (operation_id) WHERE operation_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_file_change_group_entries_revision
    ON file_change_group_entries (revision_id) WHERE revision_id IS NOT NULL;

  CREATE TABLE IF NOT EXISTS file_agent_review_policies (
    user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    workspace_id text NOT NULL REFERENCES canvas_workspaces(id) ON DELETE CASCADE,
    lineage_id text NOT NULL,
    requested_mode text NOT NULL,
    revision bigint NOT NULL,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    PRIMARY KEY (user_id, workspace_id, lineage_id),
    CONSTRAINT file_agent_review_policies_lineage_scope_fk
      FOREIGN KEY (lineage_id, workspace_id)
      REFERENCES file_collaboration_lineages (id, workspace_id) ON DELETE CASCADE,
    CONSTRAINT file_agent_review_policies_mode_check
      CHECK (requested_mode IN ('review_required', 'safe_direct')),
    CONSTRAINT file_agent_review_policies_revision_check CHECK (revision >= 1),
    CONSTRAINT file_agent_review_policies_time_check CHECK (updated_at >= created_at)
  );
  CREATE INDEX IF NOT EXISTS idx_file_agent_review_policies_workspace_user_updated
    ON file_agent_review_policies (workspace_id, user_id, updated_at DESC);

  CREATE TABLE IF NOT EXISTS file_version_restore_receipts (
    workspace_id text NOT NULL REFERENCES canvas_workspaces(id) ON DELETE CASCADE,
    lineage_id text NOT NULL,
    target_revision_id text NOT NULL,
    initiated_by_user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    idempotency_key text NOT NULL,
    request_hash text NOT NULL,
    status text NOT NULL,
    lease_token text NOT NULL,
    lease_expires_at bigint NOT NULL,
    prior_revision_id text,
    restored_revision_id text,
    result_json text,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    PRIMARY KEY (workspace_id, initiated_by_user_id, idempotency_key),
    CONSTRAINT file_version_restore_receipts_lineage_scope_fk
      FOREIGN KEY (lineage_id, workspace_id)
      REFERENCES file_collaboration_lineages (id, workspace_id) ON DELETE RESTRICT,
    CONSTRAINT file_version_restore_receipts_target_scope_fk
      FOREIGN KEY (target_revision_id, workspace_id, lineage_id)
      REFERENCES file_revisions (id, workspace_id, lineage_id) ON DELETE RESTRICT,
    CONSTRAINT file_version_restore_receipts_prior_scope_fk
      FOREIGN KEY (prior_revision_id, workspace_id, lineage_id)
      REFERENCES file_revisions (id, workspace_id, lineage_id) ON DELETE RESTRICT,
    CONSTRAINT file_version_restore_receipts_restored_scope_fk
      FOREIGN KEY (restored_revision_id, workspace_id, lineage_id)
      REFERENCES file_revisions (id, workspace_id, lineage_id) ON DELETE RESTRICT,
    CONSTRAINT file_version_restore_receipts_status_check
      CHECK (status IN ('prepared', 'completed')),
    CONSTRAINT file_version_restore_receipts_idempotency_check
      CHECK (char_length(idempotency_key) BETWEEN 16 AND 128
        AND idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'),
    CONSTRAINT file_version_restore_receipts_request_hash_check
      CHECK (request_hash ~ '^[a-f0-9]{64}$'),
    CONSTRAINT file_version_restore_receipts_lease_check
      CHECK (char_length(lease_token) BETWEEN 16 AND 128 AND lease_expires_at >= created_at),
    CONSTRAINT file_version_restore_receipts_time_check CHECK (updated_at >= created_at),
    CONSTRAINT file_version_restore_receipts_completion_check CHECK (
      (status = 'prepared' AND restored_revision_id IS NULL AND result_json IS NULL)
      OR (status = 'completed' AND restored_revision_id IS NOT NULL AND result_json IS NOT NULL)
    )
  );
  CREATE INDEX IF NOT EXISTS idx_file_version_restore_receipts_lineage_updated
    ON file_version_restore_receipts (workspace_id, lineage_id, updated_at DESC, idempotency_key);
`;

export const FILE_VERSION_CENTER_STORAGE_DOWN_SQL = `
  DROP TABLE IF EXISTS file_version_restore_receipts;
  DROP TABLE IF EXISTS file_agent_review_policies;
  DROP TABLE IF EXISTS file_change_group_entries;
  DROP TABLE IF EXISTS file_change_groups;
  DROP TABLE IF EXISTS file_revision_contents;
  DROP TABLE IF EXISTS file_version_blobs;
  DROP INDEX IF EXISTS idx_pi_sessions_fvrc_scope_identity;
  DROP INDEX IF EXISTS idx_collaboration_agent_operations_scope_identity;
  DROP INDEX IF EXISTS idx_collaboration_documents_scope_identity;
  DROP INDEX IF EXISTS idx_file_revisions_scope_identity;
  DROP INDEX IF EXISTS idx_file_collaboration_lineages_scope_identity;
`;

type FileVersionCenterMigrationQueryable = {
  query: (sql: string) => Promise<unknown>;
  exec?: (sql: string) => Promise<unknown>;
};

async function executeMigrationBatch(
  postgres: FileVersionCenterMigrationQueryable,
  sql: string,
): Promise<void> {
  if (postgres.exec) {
    await postgres.exec(sql);
    return;
  }
  await postgres.query(sql);
}

export async function runFileVersionCenterStorageMigration(
  postgres: FileVersionCenterMigrationQueryable,
): Promise<void> {
  await executeMigrationBatch(postgres, FILE_VERSION_CENTER_STORAGE_UP_SQL);
}

export async function rollbackFileVersionCenterStorageMigration(
  postgres: FileVersionCenterMigrationQueryable,
): Promise<void> {
  await executeMigrationBatch(postgres, FILE_VERSION_CENTER_STORAGE_DOWN_SQL);
}
