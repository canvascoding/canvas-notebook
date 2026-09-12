/** Prepared Yjs deltas make a lost mobile HTTP response safe to retry. */
export const MOBILE_NOTEBOOK_OPERATION_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS mobile_notebook_operations (
    operation_id text PRIMARY KEY,
    document_id text NOT NULL REFERENCES collaboration_yjs_states(document_id) ON DELETE CASCADE,
    workspace_id text NOT NULL,
    user_id text NOT NULL,
    lifecycle_generation bigint NOT NULL,
    representation text NOT NULL,
    document_path text NOT NULL,
    fingerprint text NOT NULL,
    base_state_proof text NOT NULL,
    resulting_state_snapshot bytea NOT NULL,
    yjs_update bytea,
    created_at bigint NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_mobile_notebook_operation_document ON mobile_notebook_operations(document_id)`,
] as const;
