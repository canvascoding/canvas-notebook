export const EXCALIDRAW_COPY_IMMUTABLE_FUNCTION = 'canvas_excalidraw_copy_immutable';
export const EXCALIDRAW_COPY_IMMUTABLE_TRIGGER = 'trg_excalidraw_copy_immutable';
export const EXCALIDRAW_COPY_IMMUTABLE_BODY = `
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Scene copy originals are immutable' USING ERRCODE = '55000';
  END IF;
  IF (pg_catalog.to_jsonb(NEW) - ARRAY['birth_json','birth_digest','b2_transaction_id','completed_at'])
      IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - ARRAY['birth_json','birth_digest','b2_transaction_id','completed_at'])
    OR OLD.birth_json IS NOT NULL
    OR NEW.birth_json IS NULL OR NEW.birth_digest IS NULL
    OR NEW.b2_transaction_id IS NULL OR NEW.completed_at IS NULL THEN
    RAISE EXCEPTION 'Scene copy originals are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
`;

/** B1 original intent and its one B2 completion. Scene/asset authority remains
 * in the domain tables; historical recovery reads this immutable ledger only. */
export const EXCALIDRAW_COPY_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS collaboration_excalidraw_copy_receipts (
    workspace_id text NOT NULL,
    operation_id text NOT NULL,
    version integer NOT NULL CHECK (version=1),
    stage_digest text NOT NULL CHECK (stage_digest ~ '^[0-9a-f]{64}$'),
    request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    native_request_fingerprint text NOT NULL CHECK (native_request_fingerprint ~ '^[0-9a-f]{64}$'),
    intent_digest text NOT NULL CHECK (intent_digest ~ '^[0-9a-f]{64}$'),
    intent_json jsonb NOT NULL CHECK (jsonb_typeof(intent_json)='object'),
    b1_transaction_id text NOT NULL CHECK (b1_transaction_id ~ '^[1-9][0-9]{0,31}$'),
    created_at bigint NOT NULL CHECK (created_at>0),
    birth_json jsonb CHECK (birth_json IS NULL OR jsonb_typeof(birth_json)='object'),
    birth_digest text CHECK (birth_digest IS NULL OR birth_digest ~ '^[0-9a-f]{64}$'),
    b2_transaction_id text CHECK (b2_transaction_id IS NULL OR b2_transaction_id ~ '^[1-9][0-9]{0,31}$'),
    completed_at bigint,
    CHECK ((birth_json IS NULL AND birth_digest IS NULL AND b2_transaction_id IS NULL AND completed_at IS NULL)
      OR (birth_json IS NOT NULL AND birth_digest IS NOT NULL AND b2_transaction_id IS NOT NULL AND completed_at IS NOT NULL AND completed_at>0)),
    PRIMARY KEY (workspace_id,operation_id)
  )`,
  `CREATE OR REPLACE FUNCTION ${EXCALIDRAW_COPY_IMMUTABLE_FUNCTION}() RETURNS trigger LANGUAGE plpgsql
    AS $$${EXCALIDRAW_COPY_IMMUTABLE_BODY}$$`,
  `CREATE OR REPLACE TRIGGER ${EXCALIDRAW_COPY_IMMUTABLE_TRIGGER}
    BEFORE UPDATE OR DELETE ON collaboration_excalidraw_copy_receipts
    FOR EACH ROW EXECUTE FUNCTION ${EXCALIDRAW_COPY_IMMUTABLE_FUNCTION}()`,
] as const;
