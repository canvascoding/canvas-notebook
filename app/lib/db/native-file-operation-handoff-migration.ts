import type { SqlConnection } from '../db';

/** Standalone, additive; no global dispatcher or runtime coordinator installed. */
export const NATIVE_FILE_OPERATION_HANDOFF_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS collaboration_native_file_operation_intents (
    operation_id text PRIMARY KEY CHECK(length(operation_id) BETWEEN 1 AND 256),
    request_id text NOT NULL UNIQUE,
    changes_bundle_proof text NOT NULL CHECK(changes_bundle_proof ~ '^[a-f0-9]{64}$'),
    intent_text text NOT NULL CHECK(octet_length(intent_text) BETWEEN 1 AND 67108864),
    CHECK(changes_bundle_proof=encode(sha256(convert_to(intent_text,'UTF8')),'hex'))
  )`,
  `CREATE TABLE IF NOT EXISTS collaboration_native_file_operation_receipts (
    operation_id text NOT NULL REFERENCES collaboration_native_file_operation_intents(operation_id),
    mutation_id text NOT NULL CHECK(length(mutation_id) BETWEEN 1 AND 256),
    document_id text NOT NULL REFERENCES collaboration_documents(id),
    request_id text NOT NULL REFERENCES collaboration_admission_requests(request_id),
    changes_bundle_proof text NOT NULL CHECK(changes_bundle_proof ~ '^[a-f0-9]{64}$'),
    receipt_text text NOT NULL CHECK(octet_length(receipt_text) BETWEEN 1 AND 6291456),
    receipt_digest text NOT NULL CHECK(receipt_digest=encode(sha256(convert_to(receipt_text,'UTF8')),'hex')),
    after_state_snapshot bytea NOT NULL CHECK(octet_length(after_state_snapshot) BETWEEN 1 AND 4194304),
    PRIMARY KEY(operation_id,mutation_id), UNIQUE(operation_id,document_id)
  )`,
  `CREATE OR REPLACE FUNCTION immutable_native_file_operation_record() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'Native file operation records are immutable' USING ERRCODE='55000'; END $$`,
  `CREATE OR REPLACE FUNCTION validate_native_file_operation_endstate() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE r jsonb; b jsonb; m jsonb; q record; set_proof text; count_receipts bigint;
    BEGIN
      r:=NEW.receipt_text::jsonb;
      SELECT intent_text::jsonb INTO b FROM collaboration_native_file_operation_intents WHERE operation_id=NEW.operation_id;
      IF r->'version' IS DISTINCT FROM '1'::jsonb OR b->'version' IS DISTINCT FROM '1'::jsonb THEN
        RAISE EXCEPTION 'Native file operation version is unavailable' USING ERRCODE='23514';
      END IF;
      SELECT value INTO m FROM jsonb_array_elements(b->'mutations') WHERE value->>'mutationId'=NEW.mutation_id;
      SELECT * INTO q FROM collaboration_admission_requests WHERE request_id=NEW.request_id;
      SELECT count(*),encode(sha256(convert_to('canvas.native-file-receipt-set.v1'||chr(10)||
        string_agg(mutation_id||chr(9)||receipt_digest,chr(10) ORDER BY mutation_id COLLATE "C"),'UTF8')),'hex')
        INTO count_receipts,set_proof FROM collaboration_native_file_operation_receipts WHERE operation_id=NEW.operation_id;
      IF r->>'operationId' IS DISTINCT FROM NEW.operation_id OR r->>'mutationId' IS DISTINCT FROM NEW.mutation_id
        OR r->>'requestId' IS DISTINCT FROM NEW.request_id OR r->>'changesBundleProof' IS DISTINCT FROM NEW.changes_bundle_proof
        OR b->>'operationId' IS DISTINCT FROM NEW.operation_id OR b->>'requestId' IS DISTINCT FROM NEW.request_id
        OR m IS NULL OR r->'source' IS DISTINCT FROM m->'source' OR r->>'lineageId' IS DISTINCT FROM m->>'lineageId'
        OR r->'before' IS DISTINCT FROM m->'before' OR r->>'kind' IS DISTINCT FROM m->>'kind'
        OR r->'actor' IS DISTINCT FROM b->'actor' OR r->>'reviewDigest' IS DISTINCT FROM b->>'reviewDigest'
        OR r->>'action' IS DISTINCT FROM b->>'action' OR q.status IS DISTINCT FROM 'committed'
        OR (q.intent_text::jsonb->>'actionPayloadText')::jsonb->>'changesBundleProof' IS DISTINCT FROM NEW.changes_bundle_proof
        OR q.intent_text::jsonb->>'actorId' IS DISTINCT FROM b#>>'{actor,actorId}'
        OR r#>>'{after,identity,path}' IS DISTINCT FROM COALESCE(m->>'destinationPath',m#>>'{source,path}')
        OR (r#>>'{after,identity,lifecycleGeneration}')::bigint IS DISTINCT FROM
          (m#>>'{source,lifecycleGeneration}')::bigint+(CASE WHEN m->>'kind'='archive' THEN 1 ELSE 0 END)
        OR (r#>>'{after,clock,documentSequence}')::bigint IS DISTINCT FROM
          (m#>>'{before,documentSequence}')::bigint+(CASE WHEN m->'prepared'='null'::jsonb THEN 0 ELSE 1 END)
        OR r#>>'{after,status}' IS DISTINCT FROM (CASE WHEN m->>'kind'='archive' THEN 'archived' ELSE 'active' END)
        OR r#>>'{after,clock,stateProof}' IS DISTINCT FROM COALESCE(m#>>'{prepared,after,stateProof}',m#>>'{before,stateProof}')
        OR (r->>'beforeRegistryStateVersion')::bigint IS DISTINCT FROM (m->>'registryStateVersion')::bigint
        OR (r#>>'{after,registryStateVersion}')::bigint IS DISTINCT FROM (CASE WHEN m->>'kind'='link' THEN (m->>'registryStateVersion')::bigint ELSE 0 END)
        OR q.request_digest IS DISTINCT FROM r->>'requestDigest'
        OR q.outcome_text::jsonb#>>'{result,nativeFileReceiptSetProof}' IS DISTINCT FROM set_proof
        OR count_receipts<>jsonb_array_length(b->'mutations')
        OR r#>>'{source,documentId}' IS DISTINCT FROM NEW.document_id
        OR r#>>'{after,clock,stateProof}' IS DISTINCT FROM 'yjs-snapshot-sha256-v1:'||encode(sha256(NEW.after_state_snapshot),'hex')
        OR r#>>'{projection,status}' IS DISTINCT FROM 'pending' OR r#>>'{projection,filesystemComplete}' IS DISTINCT FROM 'false'
        OR NOT EXISTS(SELECT 1 FROM collaboration_admission_targets t WHERE t.request_id=NEW.request_id
          AND t.document_id=NEW.document_id AND NOT t.active AND t.status='completed' AND t.outcome_snapshot_text IS NOT NULL)
        OR EXISTS(SELECT 1 FROM collaboration_admission_targets t WHERE t.request_id=NEW.request_id
          AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(b->'mutations') mutation
            WHERE mutation#>>'{source,documentId}'=t.document_id)
          AND (t.active OR t.status IS DISTINCT FROM 'completed' OR t.quiescence_text IS NULL
            OR t.outcome_snapshot_text::jsonb IS DISTINCT FROM (t.quiescence_text::jsonb->'current')))
        OR NOT EXISTS(SELECT 1 FROM collaboration_documents d JOIN collaboration_yjs_states s ON s.document_id=d.id
          JOIN file_collaboration_lineages l ON l.id=d.lineage_id JOIN collaboration_file_projections p ON p.document_id=d.id
          WHERE d.id=NEW.document_id AND d.lineage_id=r->>'lineageId' AND d.provider='yjs' AND d.yjs_state_lifecycle='initialized'
            AND d.workspace_id=r#>>'{source,workspaceId}' AND d.organization_id IS NOT DISTINCT FROM r#>>'{source,organizationId}'
            AND d.path=r#>>'{after,identity,path}' AND d.status=r#>>'{after,status}' AND d.state_version=(r#>>'{after,registryStateVersion}')::bigint
            AND l.workspace_id=d.workspace_id AND l.organization_id IS NOT DISTINCT FROM d.organization_id AND l.path=d.path AND l.status=d.status
            AND (d.status='active' AND l.archived_at IS NULL AND l.trash_entry_id IS NULL
              OR d.status='archived' AND l.archived_at IS NOT NULL AND l.trash_entry_id=m->>'trashEntryId')
            AND s.workspace_id=d.workspace_id AND s.organization_id IS NOT DISTINCT FROM d.organization_id AND s.path=d.path AND s.status=d.status
            AND s.representation=r#>>'{source,representation}' AND s.schema_version=(r#>>'{source,schemaVersion}')::bigint
            AND s.lifecycle_generation=(r#>>'{after,identity,lifecycleGeneration}')::bigint
            AND s.document_sequence=(r#>>'{after,clock,documentSequence}')::bigint AND s.persisted_at=(r#>>'{after,clock,persistedAt}')::bigint
            AND encode(sha256(s.yjs_state),'hex')=r#>>'{after,clock,binaryHash}' AND s.state_vector=decode(r#>>'{after,clock,stateVector}','base64')
            AND s.checkpoint_sequence=0 AND s.checkpointed_at IS NULL AND s.canonical_hash IS NULL AND s.serialized_hash IS NULL
            AND p.lifecycle_generation=s.lifecycle_generation AND p.projected_sequence=s.document_sequence AND p.finalized=0
            AND p.revision_id IS NULL AND p.canonical_hash IS NULL AND p.serialized_hash IS NULL) THEN
        RAISE EXCEPTION 'Native file operation endstate is unavailable' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$`,
  `DO $$ BEGIN
    IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='collaboration_native_file_operation_intents'::regclass AND tgname='native_file_intent_immutable') THEN
      CREATE TRIGGER native_file_intent_immutable BEFORE UPDATE OR DELETE ON collaboration_native_file_operation_intents
        FOR EACH ROW EXECUTE FUNCTION immutable_native_file_operation_record();
    END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='collaboration_native_file_operation_receipts'::regclass AND tgname='native_file_receipt_immutable') THEN
      CREATE TRIGGER native_file_receipt_immutable BEFORE UPDATE OR DELETE ON collaboration_native_file_operation_receipts
        FOR EACH ROW EXECUTE FUNCTION immutable_native_file_operation_record();
    END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='collaboration_native_file_operation_receipts'::regclass AND tgname='native_file_receipt_endstate') THEN
      CREATE CONSTRAINT TRIGGER native_file_receipt_endstate AFTER INSERT ON collaboration_native_file_operation_receipts
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_native_file_operation_endstate();
    END IF;
  END $$`,
] as const;

/** Caller owns schema selection and migration transaction. */
export async function runNativeFileOperationHandoffMigration(database: Pick<SqlConnection, 'run'>): Promise<void> {
  for (const statement of NATIVE_FILE_OPERATION_HANDOFF_STATEMENTS) await database.run(statement);
}
