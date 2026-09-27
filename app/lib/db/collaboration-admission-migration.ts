/** Additive and inactive until lifecycle callers and the fleet gate are ready. */
export const COLLABORATION_ADMISSION_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS collaboration_admission_requests (
    request_id text PRIMARY KEY,
    request_digest text NOT NULL,
    intent_text text NOT NULL,
    status text NOT NULL CHECK (status IN ('reserved', 'draining', 'recovery_required', 'committed', 'cancelled')),
    revision bigint NOT NULL CHECK (revision > 0),
    created_at bigint NOT NULL,
    completed_at bigint,
    outcome_text text
  )`,
  `CREATE TABLE IF NOT EXISTS collaboration_admission_scopes (
    request_id text NOT NULL REFERENCES collaboration_admission_requests(request_id),
    ordinal integer NOT NULL,
    workspace_id text NOT NULL,
    organization_id text,
    path text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('exact', 'subtree')),
    PRIMARY KEY (request_id, ordinal)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_collaboration_admission_scopes_workspace
    ON collaboration_admission_scopes(workspace_id)`,
  `CREATE TABLE IF NOT EXISTS collaboration_admission_targets (
    request_id text NOT NULL REFERENCES collaboration_admission_requests(request_id),
    document_id text NOT NULL,
    snapshot_text text NOT NULL,
    active boolean NOT NULL DEFAULT true,
    status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'draining', 'released', 'recovery_required', 'completed', 'cancelled')),
    release_id text REFERENCES collaboration_room_release_receipts(release_id),
    quiescence_kind text CHECK (quiescence_kind IS NULL OR quiescence_kind IN ('vacant', 'normal_release', 'owner_drain', 'lifecycle_outcome')),
    quiescence_text text,
    source_outcome_request_id text,
    outcome_snapshot_text text,
    outcome_snapshot_digest text,
    PRIMARY KEY (request_id, document_id)
  )`,
  `ALTER TABLE collaboration_admission_targets ADD COLUMN IF NOT EXISTS quiescence_kind text
    CHECK (quiescence_kind IS NULL OR quiescence_kind IN ('vacant', 'normal_release', 'owner_drain', 'lifecycle_outcome'))`,
  `ALTER TABLE collaboration_admission_targets ADD COLUMN IF NOT EXISTS quiescence_text text`,
  `ALTER TABLE collaboration_admission_requests ADD COLUMN IF NOT EXISTS outcome_text text`,
  `ALTER TABLE collaboration_admission_targets ADD COLUMN IF NOT EXISTS source_outcome_request_id text`,
  `ALTER TABLE collaboration_admission_targets ADD COLUMN IF NOT EXISTS outcome_snapshot_text text`,
  `ALTER TABLE collaboration_admission_targets ADD COLUMN IF NOT EXISTS outcome_snapshot_digest text`,
  `DO $migration$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint
      WHERE conrelid = 'collaboration_admission_targets'::regclass
        AND conname = 'collaboration_admission_targets_quiescence_kind_check'
        AND position('lifecycle_outcome' IN pg_get_constraintdef(oid)) = 0) THEN
      ALTER TABLE collaboration_admission_targets DROP CONSTRAINT collaboration_admission_targets_quiescence_kind_check;
      ALTER TABLE collaboration_admission_targets ADD CONSTRAINT collaboration_admission_targets_quiescence_kind_check
        CHECK (quiescence_kind IS NULL OR quiescence_kind IN ('vacant', 'normal_release', 'owner_drain', 'lifecycle_outcome'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
      WHERE conrelid = 'collaboration_admission_targets'::regclass AND conname = 'collaboration_admission_source_outcome_fk') THEN
      ALTER TABLE collaboration_admission_targets ADD CONSTRAINT collaboration_admission_source_outcome_fk
        FOREIGN KEY (source_outcome_request_id, document_id)
        REFERENCES collaboration_admission_targets(request_id, document_id);
    END IF;
  END $migration$`,
  `CREATE INDEX IF NOT EXISTS idx_collaboration_admission_outcome_snapshot
    ON collaboration_admission_targets(document_id, outcome_snapshot_digest)
    WHERE status = 'completed' AND NOT active`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_collaboration_admission_active_document
    ON collaboration_admission_targets(document_id) WHERE active`,
] as const;
