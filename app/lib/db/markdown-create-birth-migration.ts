/** Inactive create-only first-projection ledger. The binding is inserted in
 * the SAME transaction as its immutable native-import receipt. */
export const MARKDOWN_CREATE_BIRTH_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS collaboration_markdown_create_births (
    workspace_id text NOT NULL,
    operation_id text NOT NULL,
    document_id text NOT NULL UNIQUE,
    lifecycle_generation bigint NOT NULL CHECK (lifecycle_generation>0),
    claim_id text NOT NULL UNIQUE CHECK (claim_id ~ '^[a-f0-9]{64}$'),
    claim_fingerprint text NOT NULL CHECK (claim_fingerprint ~ '^[a-f0-9]{64}$'),
    request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
    finalized integer NOT NULL DEFAULT 0 CHECK (finalized IN (0,1)),
    revision_id text,
    serialized_hash text CHECK (serialized_hash ~ '^[a-f0-9]{64}$'),
    PRIMARY KEY(workspace_id,operation_id),
    FOREIGN KEY(workspace_id,operation_id) REFERENCES collaboration_markdown_file_import_receipts(workspace_id,operation_id),
    CHECK ((finalized=0 AND revision_id IS NULL AND serialized_hash IS NULL)
      OR (finalized=1 AND length(revision_id) BETWEEN 1 AND 256 AND serialized_hash IS NOT NULL))
  )`,
  `CREATE OR REPLACE FUNCTION validate_markdown_create_birth() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE receipt jsonb;
    BEGIN
      PERFORM set_config('search_path',quote_ident(TG_TABLE_SCHEMA)||', pg_catalog, pg_temp',true);
      IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Markdown birth bindings are retained' USING ERRCODE='55000'; END IF;
      IF TG_OP='UPDATE' THEN
        IF ROW(NEW.workspace_id,NEW.operation_id,NEW.document_id,NEW.lifecycle_generation,NEW.claim_id,NEW.claim_fingerprint,NEW.request_fingerprint)
          IS DISTINCT FROM ROW(OLD.workspace_id,OLD.operation_id,OLD.document_id,OLD.lifecycle_generation,OLD.claim_id,OLD.claim_fingerprint,OLD.request_fingerprint)
          OR OLD.finalized=1 THEN RAISE EXCEPTION 'Markdown birth binding is immutable' USING ERRCODE='55000'; END IF;
        IF NEW.finalized<>1 OR NOT EXISTS(SELECT 1 FROM collaboration_file_projections p JOIN collaboration_yjs_states y ON y.document_id=p.document_id
          WHERE p.document_id=NEW.document_id AND p.lifecycle_generation=NEW.lifecycle_generation AND p.finalized=1
            AND p.revision_id=NEW.revision_id AND p.serialized_hash=NEW.serialized_hash AND y.status='active'
            AND y.lifecycle_generation=NEW.lifecycle_generation AND y.workspace_id=NEW.workspace_id
            AND y.checkpointed_at IS NOT NULL AND y.checkpoint_sequence=p.projected_sequence AND y.serialized_hash=p.serialized_hash)
          THEN RAISE EXCEPTION 'Markdown birth projection is unconfirmed' USING ERRCODE='23514'; END IF;
      ELSE
        SELECT private_result INTO receipt FROM collaboration_markdown_file_import_receipts
          WHERE workspace_id=NEW.workspace_id AND operation_id=NEW.operation_id AND request_fingerprint=NEW.request_fingerprint;
        IF receipt IS NULL OR receipt->'target'->>'documentId' IS DISTINCT FROM NEW.document_id
          OR (receipt->'target'->>'lifecycleGeneration')::bigint IS DISTINCT FROM NEW.lifecycle_generation
          OR NEW.finalized<>0 THEN RAISE EXCEPTION 'Markdown birth receipt is unavailable' USING ERRCODE='23514'; END IF;
      END IF;
      RETURN NEW;
    END $$`,
  `DO $$ BEGIN
    IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='collaboration_markdown_create_births'::regclass AND tgname='markdown_create_birth_guard') THEN
      CREATE TRIGGER markdown_create_birth_guard BEFORE INSERT OR UPDATE OR DELETE ON collaboration_markdown_create_births
        FOR EACH ROW EXECUTE FUNCTION validate_markdown_create_birth();
    END IF;
  END $$`,
] as const;
