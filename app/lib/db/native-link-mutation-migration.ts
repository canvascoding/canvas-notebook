import type { SqlConnection } from '@/app/lib/db';

/** Standalone, additive and inactive until the mutation coordinator is wired. */
export const NATIVE_LINK_MUTATION_RECEIPT_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS collaboration_native_link_mutation_receipts (
    operation_id text PRIMARY KEY CHECK (length(operation_id) BETWEEN 1 AND 256),
    document_id text NOT NULL REFERENCES collaboration_documents(id),
    workspace_id text NOT NULL, organization_id text, path text NOT NULL,
    representation text NOT NULL CHECK (representation IN ('plain_text','tiptap_xml','tiptap_blocks')),
    lifecycle_generation bigint NOT NULL CHECK (lifecycle_generation > 0),
    schema_version bigint NOT NULL CHECK (schema_version = 1),
    actor_user_id text NOT NULL CHECK (length(actor_user_id) BETWEEN 1 AND 256),
    actor_id text NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 256),
    actor_type text NOT NULL CHECK (actor_type IN ('user','agent','automation','system')),
    actor_session_id text CHECK (actor_session_id IS NULL OR length(actor_session_id) BETWEEN 1 AND 256),
    request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 256),
    request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
    authorized_prepared_proof text NOT NULL CHECK (authorized_prepared_proof ~ '^[a-f0-9]{64}$'),
    before_sequence bigint NOT NULL CHECK (before_sequence >= 0),
    before_state_proof text NOT NULL CHECK (before_state_proof ~ '^yjs-snapshot-sha256-v1:[a-f0-9]{64}$'),
    before_state_vector bytea NOT NULL CHECK (octet_length(before_state_vector) BETWEEN 1 AND 4194304),
    after_sequence bigint NOT NULL CHECK (after_sequence = before_sequence + 1),
    after_state_proof text NOT NULL CHECK (after_state_proof ~ '^yjs-snapshot-sha256-v1:[a-f0-9]{64}$'),
    after_state_vector bytea NOT NULL CHECK (octet_length(after_state_vector) BETWEEN 1 AND 4194304),
    after_state_snapshot bytea NOT NULL CHECK (octet_length(after_state_snapshot) BETWEEN 1 AND 4194304),
    inverse_recipes jsonb NOT NULL CHECK (jsonb_typeof(inverse_recipes) = 'array' AND octet_length(inverse_recipes::text) <= 4194304),
    persisted_at bigint NOT NULL CHECK (persisted_at >= 0),
    UNIQUE NULLS NOT DISTINCT (document_id,actor_user_id,actor_id,actor_type,actor_session_id,request_id)
  )`,
  `CREATE OR REPLACE FUNCTION validate_native_link_mutation_receipt_scope() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'Native link mutation receipts are immutable' USING ERRCODE='55000';
      END IF;
      IF NEW.workspace_id = '' OR NEW.organization_id = '' OR NEW.path = '' OR NEW.path LIKE '/%' OR position(chr(92) IN NEW.path)>0
        OR NEW.after_state_proof <> 'yjs-snapshot-sha256-v1:' || encode(sha256(NEW.after_state_snapshot),'hex')
        OR EXISTS(SELECT 1 FROM unnest(string_to_array(NEW.path,'/')) part WHERE part IN ('','.','..'))
        OR NOT EXISTS(SELECT 1 FROM collaboration_documents d JOIN collaboration_yjs_states s ON s.document_id=d.id
          WHERE d.id=NEW.document_id AND d.status='active' AND d.provider='yjs' AND d.yjs_state_lifecycle='initialized'
            AND d.workspace_id=NEW.workspace_id AND d.path=NEW.path
            AND d.organization_id IS NOT DISTINCT FROM NEW.organization_id
            AND s.status='active' AND s.workspace_id=NEW.workspace_id AND s.path=NEW.path
            AND s.organization_id IS NOT DISTINCT FROM NEW.organization_id
            AND s.representation=NEW.representation AND s.lifecycle_generation=NEW.lifecycle_generation
            AND s.schema_version=NEW.schema_version AND s.document_sequence=NEW.after_sequence
            AND s.state_vector=NEW.after_state_vector AND s.persisted_at=NEW.persisted_at) THEN
        RAISE EXCEPTION 'Native link mutation receipt scope is unavailable' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$`,
  `DO $$ BEGIN
    IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='collaboration_native_link_mutation_receipts'::regclass
      AND tgname='native_link_mutation_receipt_scope') THEN
      CREATE TRIGGER native_link_mutation_receipt_scope BEFORE INSERT OR UPDATE OR DELETE
        ON collaboration_native_link_mutation_receipts FOR EACH ROW EXECUTE FUNCTION validate_native_link_mutation_receipt_scope();
    END IF;
  END $$`,
] as const;

/** The caller owns the schema selection and migration transaction. */
export async function runNativeLinkMutationReceiptMigration(connection: Pick<SqlConnection, 'run'>): Promise<void> {
  for (const statement of NATIVE_LINK_MUTATION_RECEIPT_STATEMENTS) await connection.run(statement);
}
