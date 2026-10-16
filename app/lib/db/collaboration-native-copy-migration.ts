export const COLLABORATION_NATIVE_COPY_IMMUTABLE_FUNCTION = 'canvas_native_copy_receipt_immutable';
export const COLLABORATION_NATIVE_COPY_IMMUTABLE_TRIGGER = 'trg_native_copy_receipt_immutable';
export const COLLABORATION_NATIVE_COPY_IMMUTABLE_BODY = `
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Native copy receipts are immutable' USING ERRCODE = '55000';
  END IF;
  IF (pg_catalog.to_jsonb(NEW) - 'publication_status') IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - 'publication_status')
    OR (OLD.publication_status = 'published' AND NEW.publication_status <> 'published')
    OR (OLD.publication_status = 'publication_failed' AND NEW.publication_status = 'native_committed') THEN
    RAISE EXCEPTION 'Native copy receipts are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
`;

/** Native bytes remain in collaboration_yjs_states; this private ledger proves the initial commit across later edits. */
export const COLLABORATION_NATIVE_COPY_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS collaboration_native_copy_receipts (
    workspace_id text NOT NULL,
    operation_id text NOT NULL,
    organization_id text,
    actor_user_id text NOT NULL,
    actor_session_id text,
    version integer NOT NULL CHECK (version=1),
    kind text NOT NULL CHECK (kind IN ('native_clone','native_restore','markdown_import')),
    request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
    scope_paths jsonb NOT NULL CHECK (jsonb_typeof(scope_paths)='array'),
    private_result jsonb NOT NULL CHECK (jsonb_typeof(private_result)='object'),
    publication_status text NOT NULL DEFAULT 'native_committed'
      CHECK (publication_status IN ('native_committed','published','publication_failed')),
    publication_fingerprint text CHECK (publication_fingerprint IS NULL OR publication_fingerprint ~ '^[0-9a-f]{64}$'),
    created_at bigint NOT NULL CHECK (created_at>=0),
    PRIMARY KEY (workspace_id,operation_id)
  )`,
  'CREATE INDEX IF NOT EXISTS idx_collaboration_native_copy_receipts_actor ON collaboration_native_copy_receipts (workspace_id,actor_user_id,created_at)',
  `CREATE OR REPLACE FUNCTION ${COLLABORATION_NATIVE_COPY_IMMUTABLE_FUNCTION}() RETURNS trigger LANGUAGE plpgsql
    AS $$${COLLABORATION_NATIVE_COPY_IMMUTABLE_BODY}$$`,
  `CREATE OR REPLACE TRIGGER ${COLLABORATION_NATIVE_COPY_IMMUTABLE_TRIGGER}
    BEFORE UPDATE OR DELETE ON collaboration_native_copy_receipts
    FOR EACH ROW EXECUTE FUNCTION ${COLLABORATION_NATIVE_COPY_IMMUTABLE_FUNCTION}()`,
] as const;
