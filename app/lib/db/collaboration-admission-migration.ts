/** Additive and inactive until lifecycle callers and the fleet gate are ready. */
export const COLLABORATION_ADMISSION_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS collaboration_admission_requests (
    request_id text PRIMARY KEY,
    request_digest text NOT NULL,
    intent_text text NOT NULL,
    status text NOT NULL CHECK (status IN ('reserved', 'draining', 'recovery_required', 'committed', 'cancelled')),
    revision bigint NOT NULL CHECK (revision > 0),
    created_at bigint NOT NULL,
    completed_at bigint
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
    PRIMARY KEY (request_id, document_id)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_collaboration_admission_active_document
    ON collaboration_admission_targets(document_id) WHERE active`,
] as const;
