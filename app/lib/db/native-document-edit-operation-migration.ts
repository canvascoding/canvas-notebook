/** Additive private evidence on the EXISTING operation state machine. Legacy
 * rows retain NULL discriminants; there is no retrofit or second job ledger. */
export const NATIVE_DOCUMENT_EDIT_OPERATION_STATEMENTS = [
  'ALTER TABLE collaboration_agent_operations ADD COLUMN IF NOT EXISTS native_edit_original_json jsonb',
  'ALTER TABLE collaboration_agent_operations ADD COLUMN IF NOT EXISTS native_edit_after_json jsonb',
  `CREATE TABLE IF NOT EXISTS collaboration_agent_native_edit_payloads (
    operation_id text PRIMARY KEY REFERENCES collaboration_agent_operations(operation_id) ON DELETE RESTRICT,
    workspace_id text NOT NULL,
    original_proof text NOT NULL CHECK(original_proof ~ '^[a-f0-9]{64}$'),
    after_proof text NOT NULL CHECK(after_proof ~ '^[a-f0-9]{64}$'),
    format text NOT NULL CHECK(format='native-yjs-update-v1'),
    sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
    size_bytes bigint NOT NULL CHECK(size_bytes BETWEEN 1 AND 1048576),
    yjs_update bytea NOT NULL,
    created_at bigint NOT NULL CHECK(created_at>=0),
    CHECK(octet_length(yjs_update)=size_bytes)
  )`,
  `CREATE OR REPLACE FUNCTION canvas_native_edit_operation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF TG_OP='DELETE' THEN
      IF OLD.native_edit_original_json IS NOT NULL THEN
        RAISE EXCEPTION 'Native edit originals are immutable' USING ERRCODE='55000';
      END IF;
      RETURN OLD;
    END IF;
    IF NEW.native_edit_original_json IS NULL THEN
      IF NEW.native_edit_after_json IS NOT NULL OR (TG_OP='UPDATE' AND OLD.native_edit_original_json IS NOT NULL) THEN
        RAISE EXCEPTION 'Native edit evidence requires its original' USING ERRCODE='55000';
      END IF;
      RETURN NEW;
    END IF;
    IF jsonb_typeof(NEW.native_edit_original_json) IS DISTINCT FROM 'object'
      OR octet_length(NEW.native_edit_original_json::text)>32768
      OR NEW.native_edit_original_json->>'kind' IS DISTINCT FROM 'native_document_edit_original'
      OR NEW.native_edit_original_json->>'version' IS DISTINCT FROM '1'
      OR (NEW.native_edit_original_json->>'originalProof' ~ '^[a-f0-9]{64}$') IS NOT TRUE
      OR NEW.native_edit_original_json->'identity'->>'documentId' IS DISTINCT FROM NEW.document_id
      OR NEW.native_edit_original_json->'identity'->>'workspaceId' IS DISTINCT FROM NEW.workspace_id
      OR NEW.native_edit_original_json->'identity'->>'organizationId' IS DISTINCT FROM NEW.organization_id
      OR NEW.native_edit_original_json->'identity'->>'representation' IS DISTINCT FROM NEW.document_representation
      OR NEW.native_edit_original_json->'identity'->>'lifecycleGeneration' IS DISTINCT FROM NEW.document_lifecycle_generation::text
      OR NEW.native_edit_original_json->'identity'->>'schemaVersion' IS DISTINCT FROM NEW.schema_version::text
      OR NEW.native_edit_original_json->'source'->>'path' IS DISTINCT FROM NEW.document_path
      OR NEW.native_edit_original_json->'source'->>'persistedSequence' IS DISTINCT FROM NEW.base_document_sequence::text
      OR NEW.native_edit_original_json->'source'->>'stateVectorHash' IS DISTINCT FROM encode(sha256(NEW.base_state_vector),'hex')
      OR NEW.native_edit_original_json->'actor'->>'userId' IS DISTINCT FROM NEW.initiated_by_user_id
      OR NEW.native_edit_original_json->'actor'->>'actorId' IS DISTINCT FROM NEW.actor_id
      OR NEW.native_edit_original_json->'actor'->>'sessionId' IS DISTINCT FROM NEW.actor_session_id
      OR NEW.operation_type<>'apply' OR NEW.requested_mode<>'direct_apply'
      OR NEW.atomicity<>'all_or_nothing' OR NEW.file_edit_request_json IS NOT NULL
      OR NEW.expected_canonical_hash IS NOT NULL
      OR (TG_OP='INSERT' AND NEW.native_edit_after_json IS NOT NULL) THEN
      RAISE EXCEPTION 'Native edit original scope mismatch' USING ERRCODE='55000';
    END IF;
    IF TG_OP='UPDATE' THEN
      IF OLD.native_edit_original_json IS NULL
        OR NEW.native_edit_original_json IS DISTINCT FROM OLD.native_edit_original_json
        OR ROW(NEW.operation_id,NEW.document_id,NEW.document_path,NEW.document_representation,
          NEW.workspace_id,NEW.organization_id,NEW.document_lifecycle_generation,NEW.schema_version,
          NEW.initiated_by_user_id,NEW.actor_id,NEW.actor_session_id,NEW.agent_run_id,NEW.idempotency_key,
          NEW.run_generation,NEW.payload_hash,NEW.operation_type,NEW.requested_mode,NEW.atomicity,
          NEW.operation_payload,NEW.base_state_vector,NEW.base_document_sequence,NEW.created_at)
          IS DISTINCT FROM ROW(OLD.operation_id,OLD.document_id,OLD.document_path,OLD.document_representation,
          OLD.workspace_id,OLD.organization_id,OLD.document_lifecycle_generation,OLD.schema_version,
          OLD.initiated_by_user_id,OLD.actor_id,OLD.actor_session_id,OLD.agent_run_id,OLD.idempotency_key,
          OLD.run_generation,OLD.payload_hash,OLD.operation_type,OLD.requested_mode,OLD.atomicity,
          OLD.operation_payload,OLD.base_state_vector,OLD.base_document_sequence,OLD.created_at)
        OR (OLD.native_edit_after_json IS NOT NULL AND NEW.native_edit_after_json IS DISTINCT FROM OLD.native_edit_after_json) THEN
        RAISE EXCEPTION 'Native edit original or after evidence changed' USING ERRCODE='55000';
      END IF;
    END IF;
    IF NEW.native_edit_after_json IS NOT NULL THEN
      IF jsonb_typeof(NEW.native_edit_after_json) IS DISTINCT FROM 'object' OR octet_length(NEW.native_edit_after_json::text)>16384
        OR NEW.native_edit_after_json->>'kind' IS DISTINCT FROM 'native_document_edit_after'
        OR NEW.native_edit_after_json->>'version' IS DISTINCT FROM '1'
        OR NEW.native_edit_after_json->>'originalProof' IS DISTINCT FROM NEW.native_edit_original_json->>'originalProof'
        OR NEW.native_edit_after_json->'identity' IS DISTINCT FROM NEW.native_edit_original_json->'identity'
        OR NEW.native_edit_after_json->>'beforeVersion' IS DISTINCT FROM NEW.native_edit_original_json->>'expectedVersion'
        OR NEW.native_edit_after_json->>'appliedAt' IS DISTINCT FROM NEW.applied_at::text
        OR NEW.native_edit_after_json->>'stateVectorHash' IS DISTINCT FROM NEW.resulting_state_vector_hash
        OR (NEW.native_edit_after_json->>'afterProof' ~ '^[a-f0-9]{64}$') IS NOT TRUE
        OR NEW.resulting_state_snapshot IS NULL OR octet_length(NEW.resulting_state_snapshot)=0
        OR NEW.native_edit_after_json->>'stateSnapshotHash' IS DISTINCT FROM encode(sha256(NEW.resulting_state_snapshot),'hex') THEN
        RAISE EXCEPTION 'Native edit after evidence mismatch' USING ERRCODE='55000';
      END IF;
    END IF;
    RETURN NEW;
  END $$`,
  `CREATE OR REPLACE TRIGGER native_edit_operation_guard BEFORE INSERT OR UPDATE OR DELETE
    ON collaboration_agent_operations FOR EACH ROW EXECUTE FUNCTION canvas_native_edit_operation_guard()`,
  `CREATE OR REPLACE FUNCTION canvas_native_edit_payload_guard() RETURNS trigger LANGUAGE plpgsql AS $$
  DECLARE parent collaboration_agent_operations%ROWTYPE;
  BEGIN
    IF TG_OP IN ('UPDATE','DELETE') THEN
      RAISE EXCEPTION 'Native edit payload bytes are immutable' USING ERRCODE='55000';
    END IF;
    SELECT * INTO parent FROM collaboration_agent_operations WHERE operation_id=NEW.operation_id;
    IF NOT FOUND OR parent.workspace_id IS DISTINCT FROM NEW.workspace_id
      OR parent.native_edit_original_json->>'originalProof' IS DISTINCT FROM NEW.original_proof
      OR parent.native_edit_after_json->>'afterProof' IS DISTINCT FROM NEW.after_proof
      OR parent.native_edit_after_json->'history'->>'status' IS DISTINCT FROM 'ready'
      OR parent.native_edit_after_json->'history'->>'format' IS DISTINCT FROM NEW.format
      OR parent.native_edit_after_json->'history'->>'sha256' IS DISTINCT FROM NEW.sha256
      OR parent.native_edit_after_json->'history'->>'sizeBytes' IS DISTINCT FROM NEW.size_bytes::text
      OR encode(sha256(NEW.yjs_update),'hex') IS DISTINCT FROM NEW.sha256 THEN
      RAISE EXCEPTION 'Native edit payload scope mismatch' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END $$`,
  `CREATE OR REPLACE TRIGGER native_edit_payload_guard BEFORE INSERT OR UPDATE OR DELETE
    ON collaboration_agent_native_edit_payloads FOR EACH ROW EXECUTE FUNCTION canvas_native_edit_payload_guard()`,
] as const;
